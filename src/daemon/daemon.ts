import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { makeLogger, setLogFile, type Logger } from "../util/logger.ts";
import { ensureLoomDir, loomPaths, userConfigPath, type LoomPaths } from "../util/paths.ts";
import { loadConfig, resolveAgainstRepo, type LoomConfig } from "../config/config.ts";
import { loadPriceTable, costOf, type PriceTable } from "../config/pricing.ts";
import { LOOM_VERSION } from "../version.ts";
import type { HarnessEvent, SessionStatus } from "../protocol/events.ts";
import {
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type ProviderInfo,
  type SessionSnapshot,
} from "../protocol/wire.ts";
import { checkpoint, openDb, type Db } from "../store/db.ts";
import { ChildStore, type UsageDelta } from "../store/sessions.ts";
import { EventLog } from "./event-log.ts";
import { Registry } from "./registry.ts";
import { RpcDispatcher, RpcError, type RpcContext } from "./rpc.ts";
import { SocketServer } from "./server.ts";
import { runStartupHygiene, type HygieneReport } from "./hygiene.ts";
import { SessionManager } from "./session-manager.ts";
import { cheapModelFor, generateTitle } from "./titler.ts";
import { WorktreeManager } from "./worktrees.ts";
import { ProviderRegistry } from "../provider/registry.ts";
import {
  isSessionMode,
  type CreateSessionOptions,
  type McpServerHandle,
  type PermissionDecision,
  type PlanDecision,
  type SessionMode,
} from "../provider/types.ts";
import {
  acquirePidfile,
  IdleTimer,
  releasePidfile,
  type PidfileInfo,
} from "./lifecycle.ts";

/**
 * Appended to the Claude system prompt for every session (spec §11.4). Steers
 * the agent onto the mounted MCP tools: tilth for file writes/edits, fff for
 * search (its Grep / Glob are disabled outright), and the in-process `loom`
 * server for committing and for asking the user when blocked.
 */
const TOOL_STEER = [
  "This session runs under Loom. Prefer the mounted MCP tools over the built-ins:",
  "- Use tilth for editing files — `tilth_write` to create or replace a file, `tilth_edit` for in-place edits. Do not use the built-in Write/Edit for changes you intend to keep.",
  "- Use fff to find files and search code. The built-in Grep and Glob are disabled.",
  "- When you have a coherent set of changes, call the `commit` tool to record them; don't shell out to git.",
  "- If you are blocked on a decision only the user can make, call `ask_user` rather than guessing or stopping.",
].join("\n");

/**
 * System prompt for aisdk (OpenAI-compatible) sessions. There is no
 * "claude_code" base preset to append to, so this stands alone; it is followed
 * by {@link TOOL_STEER} when MCP servers are mounted.
 */
/** Auto-assigned Fleet-row id colours for aisdk providers, in config order. */
const PROVIDER_PALETTE = ["cyan", "magenta", "yellow", "green", "blue", "red"];

/** `GET {base_url}/models` → sorted model ids (OpenAI list shape). */
async function probeOpenAiModels(baseUrl: string, apiKeyEnv: string): Promise<string[]> {
  const key = apiKeyEnv ? (process.env[apiKeyEnv] ?? "") : "";
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((x): x is string => typeof x === "string")
    .sort();
}

const AISDK_SYSTEM = [
  "You are a coding agent working in a git worktree under Loom, a fleet supervisor.",
  "Work autonomously toward the user's goal: inspect the repo before changing it, make focused edits, and explain what you did concisely.",
  "You have tools for reading and editing files, searching, and committing. Call them rather than guessing file contents.",
  "Some tool calls need the user's approval — if one is denied, adapt instead of retrying it unchanged.",
  "When you are blocked on a decision only the user can make, use `ask_user`.",
].join("\n");

const VALID_STATUSES: readonly SessionStatus[] = [
  "starting",
  "awaiting_input",
  "running",
  "interrupted",
  "idle",
  "error",
  "done",
];

export interface DaemonStartOptions {
  repoRoot: string;
  /** Skip pidfile acquisition and signal handlers (used by tests). */
  standalone?: boolean;
}

export class Daemon {
  readonly repoRoot: string;
  readonly paths: LoomPaths;
  readonly config: LoomConfig;
  readonly epoch: string = randomUUID();
  readonly startedAt: number = Date.now();

  #log: Logger;
  #db: Db;
  #registry: Registry;
  #children: ChildStore;
  #events: EventLog;
  #server: SocketServer;
  #dispatcher: RpcDispatcher;
  #providers: ProviderRegistry;
  #sessions: SessionManager;
  #worktrees: WorktreeManager;
  #idle: IdleTimer;
  #pricing: PriceTable;
  #pidfile: PidfileInfo | null = null;
  #standalone: boolean;
  #hygiene: HygieneReport | null = null;
  /** Sessions with an auto-title one-shot in flight (fire-once guard). */
  #titling = new Set<string>();

  #stopping = false;
  #closed: Promise<void>;
  #resolveClosed!: () => void;
  #signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  private constructor(opts: DaemonStartOptions) {
    this.repoRoot = opts.repoRoot;
    this.#standalone = opts.standalone ?? false;
    this.paths = loomPaths(opts.repoRoot);
    ensureLoomDir(this.paths);
    setLogFile(this.paths.log);
    this.#log = makeLogger("daemon");

    this.config = loadConfig(this.paths.config, userConfigPath());
    this.#pricing = loadPriceTable(resolveAgainstRepo(opts.repoRoot, this.config.pricing.table));
    const dbPath = resolveAgainstRepo(opts.repoRoot, this.config.db);
    this.#db = openDb(dbPath);
    this.#registry = new Registry(this.#db);
    this.#children = new ChildStore(this.#db);
    this.#events = new EventLog(this.config.daemon.eventBufferSize);
    this.#dispatcher = new RpcDispatcher();
    this.#server = new SocketServer({
      sockPath: this.paths.sock,
      dispatcher: this.#dispatcher,
      onClientCountChange: (n) => this.#onActivityChange(`clients=${n}`),
    });
    this.#worktrees = new WorktreeManager({
      repoRoot: opts.repoRoot,
      treesDir: resolveAgainstRepo(opts.repoRoot, this.config.worktreeDir),
      hooksDir: join(this.paths.dir, "hooks"),
      baseBranch: this.config.baseBranch,
      log: this.#log.child("worktrees"),
    });
    this.#providers = new ProviderRegistry(this.config, this.#db);
    this.#sessions = new SessionManager({
      emitEvent: (ev) => {
        this.emitEvent(ev);
      },
      onStatus: (id, status, reason) => this.#onDerivedStatus(id, status, reason),
      onUsage: (id, delta) => {
        if (this.#stopping) return;
        const snap = this.#registry.addUsage(id, this.#priceUsage(id, delta));
        this.#emitSessionUpdated(snap);
        this.#enforceBudget(snap);
      },
      onResult: (id, ok) => {
        if (this.#stopping || !ok) return;
        void this.#maybeAutoTitle(id);
      },
      onSubagents: (id) => {
        if (this.#stopping) return;
        const snap = this.#registry.get(id);
        if (snap) this.#emitSessionUpdated(snap);
      },
      onProviderRef: (id, ref) => {
        if (this.#stopping) return;
        this.#registry.setFields(id, { providerRef: ref });
      },
      log: this.#log.child("sessions"),
    });
    this.#idle = new IdleTimer(this.config.daemon.idleShutdownMinutes, () => {
      this.#log.info("idle shutdown");
      void this.stop("idle");
    });
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });

    this.#registerHandlers();
  }

  static async start(opts: DaemonStartOptions): Promise<Daemon> {
    const d = new Daemon(opts);
    await d.#bringUp();
    return d;
  }

  get db(): Db {
    return this.#db;
  }
  get registry(): Registry {
    return this.#registry;
  }
  get events(): EventLog {
    return this.#events;
  }
  get providers(): ProviderRegistry {
    return this.#providers;
  }
  get sessions(): SessionManager {
    return this.#sessions;
  }
  get sockPath(): string {
    return this.paths.sock;
  }
  get hygieneReport(): HygieneReport | null {
    return this.#hygiene;
  }

  whenClosed(): Promise<void> {
    return this.#closed;
  }

  // -------------------------------------------------------------------------
  // bring-up / tear-down
  // -------------------------------------------------------------------------

  async #bringUp(): Promise<void> {
    if (!this.#standalone) {
      this.#pidfile = acquirePidfile(this.paths.pid, this.epoch);
    }

    this.#hygiene = runStartupHygiene({
      paths: this.paths,
      registry: this.#registry,
      children: this.#children,
      epoch: this.epoch,
      log: this.#log.child("hygiene"),
    });
    // A restart that interrupted sessions must tell any reconnecting client.
    for (const id of this.#hygiene.interruptedSessions) {
      this.#emitSessionUpdated(this.#registry.mustGet(id));
    }

    await this.#server.listen();

    if (!this.#standalone) this.#installSignalHandlers();
    this.#idle.poke(this.#isBusy());

    this.#log.info("daemon up", {
      pid: process.pid,
      epoch: this.epoch,
      repo: this.repoRoot,
      sock: this.paths.sock,
      version: LOOM_VERSION,
    });
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopping) return this.#closed;
    this.#stopping = true;
    this.#log.info("daemon stopping", { reason });

    this.#idle.stop();
    for (const [sig, fn] of this.#signalHandlers) process.removeListener(sig, fn);
    this.#signalHandlers = [];

    await this.#sessions.shutdown();
    await this.#server.close();
    try {
      checkpoint(this.#db);
      this.#db.close();
    } catch (err) {
      this.#log.warn("db close failed", { err: String(err) });
    }
    if (this.#pidfile) releasePidfile(this.paths.pid);

    this.#log.info("daemon stopped", { reason });
    this.#resolveClosed();
    return this.#closed;
  }

  #installSignalHandlers(): void {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const fn = () => {
        void this.stop(sig);
      };
      process.on(sig, fn);
      this.#signalHandlers.push([sig, fn]);
    }
  }

  // -------------------------------------------------------------------------
  // event / update fan-out
  // -------------------------------------------------------------------------

  emitEvent(event: HarnessEvent): number {
    if (this.#stopping) return this.#events.head;
    const frame = this.#events.append({ kind: "push", type: "event", event });
    this.#server.broadcast(frame);
    return frame.seq;
  }

  #emitSessionUpdated(session: SessionSnapshot, by?: string): void {
    if (this.#stopping) return;
    const frame = this.#events.append({
      kind: "push",
      type: "session_updated",
      session: this.#enrich(session),
      version: this.#registry.version(session.id),
      ...(by !== undefined ? { by } : {}),
    });
    this.#server.broadcast(frame);
  }

  /** Overlay runtime-only facts on a stored snapshot: git facts, sub-agents, cache TTL. */
  #enrich(s: SessionSnapshot): SessionSnapshot {
    let out = s;
    const subs = this.#sessions.subagentsOf(s.id);
    if (subs.length > 0) out = { ...out, subagents: subs };
    const ttlMinutes = s.provider === "claude" ? this.#cacheTtlMinutes : 0;
    if (ttlMinutes !== out.cache.ttlMinutes) {
      out = { ...out, cache: { ...out.cache, ttlMinutes } };
    }
    if (out.worktree) {
      const git = this.#worktrees.facts(out.worktree, out.baseBranch);
      if (git) out = { ...out, git };
    }
    return out;
  }

  get #cacheTtlMinutes(): number {
    const ttl = this.config.providers.claude.promptCacheTtl;
    return ttl === "1h" ? 60 : ttl === "5m" ? 5 : 0;
  }

  /** Configured providers for the TUI's creation flow / model switcher. */
  #providerList(): ProviderInfo[] {
    const def = this.#providers.defaultId;
    const out: ProviderInfo[] = [
      { id: "claude", models: [], tag: "claude", color: "", isDefault: def === "claude" },
    ];
    let i = 0;
    for (const [id, p] of Object.entries(this.config.providers.aisdk)) {
      out.push({
        id,
        models: p.models,
        tag: p.tag || id,
        color: p.color || (PROVIDER_PALETTE[i % PROVIDER_PALETTE.length] ?? ""),
        isDefault: def === id,
      });
      i += 1;
    }
    return out;
  }

  #enrichAll(list: SessionSnapshot[]): SessionSnapshot[] {
    return list.map((s) => this.#enrich(s));
  }

  /** A status transition the session manager derived from the event stream. */
  #onDerivedStatus(id: string, status: SessionStatus, reason: string | null): void {
    if (this.#stopping) return;
    const snap = this.#registry.setStatus(id, status, reason);
    this.emitEvent({
      type: "status_changed",
      sessionId: id,
      status,
      ts: Date.now(),
      ...(reason !== null ? { reason } : {}),
    });
    this.#emitSessionUpdated(snap);
    this.#onActivityChange(`status:${status}`);
  }

  /**
   * After a session's first successful turn, replace the clipped-prompt title
   * with a model-generated summary — unless the user has already renamed it.
   */
  async #maybeAutoTitle(id: string): Promise<void> {
    if (!this.config.titles.enabled || this.#titling.has(id)) return;
    const snap = this.#registry.get(id);
    if (!snap || snap.turns !== 1 || !snap.title) return;
    if (this.#registry.store.titleLocked(id)) return;
    if (!this.#providers.has(snap.provider)) return;
    const provider = await this.#providers.get(snap.provider);
    if (!provider.capabilities.oneShot) return;

    this.#titling.add(id);
    try {
      const title = await generateTitle({
        provider,
        prompt: snap.title,
        cwd: snap.worktree ?? this.repoRoot,
        log: this.#log.child("titler"),
        ...(this.config.titles.model
          ? { model: this.config.titles.model }
          : (() => {
              const m =
                this.config.providers.aisdk[snap.provider]?.titleModel ||
                cheapModelFor(snap.provider);
              return m ? { model: m } : {};
            })()),
      });
      if (!title || this.#stopping) return;
      if (this.#registry.store.titleLocked(id)) return; // raced with a manual rename
      this.#emitSessionUpdated(this.#registry.setFields(id, { title }));
    } catch (err) {
      this.#log.debug("auto-title failed", { id, err: String(err) });
    } finally {
      this.#titling.delete(id);
    }
  }

  /**
   * Recompute a usage delta's dollar cost from the local price table when the
   * session's model is priced there; otherwise keep the provider's figure. Tags
   * the delta with `costSource` so a client can flag an estimate.
   */
  #priceUsage(id: string, delta: UsageDelta): UsageDelta {
    const tokens =
      (delta.input ?? 0) + (delta.output ?? 0) + (delta.cacheRead ?? 0) + (delta.cacheWrite ?? 0);
    if (tokens <= 0) return delta; // a bare { turns: 1 } — nothing to price
    const model = this.#registry.get(id)?.model ?? null;
    const tableCost = costOf(this.#pricing, model, {
      input: delta.input ?? 0,
      output: delta.output ?? 0,
      cacheRead: delta.cacheRead ?? 0,
      cacheWrite: delta.cacheWrite ?? 0,
    });
    if (tableCost != null) return { ...delta, costUsd: tableCost, costSource: "table" };
    if ((delta.costUsd ?? 0) > 0) return { ...delta, costSource: "provider" };
    return delta;
  }

  /**
   * Compare a session's running totals to its budget. Soft breach → mark
   * `warned` and keep going; hard breach → mark `halted` and interrupt. A
   * raised cap (`session.setBudget`) resets the state so this fires again.
   */
  #enforceBudget(snap: SessionSnapshot): void {
    if (this.#stopping || snap.budgetState === "halted") return;
    const b = snap.budget;
    if (b.maxCostUsd == null && b.maxTokens == null && b.maxTurns == null) return;
    const tokens = snap.usage.input + snap.usage.output + snap.usage.cacheRead + snap.usage.cacheWrite;
    const breached =
      (b.maxCostUsd != null && snap.costUsd >= b.maxCostUsd) ||
      (b.maxTokens != null && tokens >= b.maxTokens) ||
      (b.maxTurns != null && snap.turns >= b.maxTurns);
    if (!breached) return;

    if (this.config.budget.onBreach === "hard") {
      this.#emitSessionUpdated(this.#registry.setFields(snap.id, { budgetState: "halted" }));
      if (this.#sessions.has(snap.id)) {
        void this.#sessions.haltForBudget(snap.id).catch((err) => {
          this.#log.warn("budget halt failed", { id: snap.id, err: String(err) });
        });
      }
    } else if (snap.budgetState !== "warned") {
      this.#emitSessionUpdated(this.#registry.setFields(snap.id, { budgetState: "warned" }));
    }
  }

  #onActivityChange(why: string): void {
    if (this.#stopping) return;
    const busy = this.#isBusy();
    this.#log.debug("activity change", { why, busy });
    this.#idle.poke(busy);
  }

  #isBusy(): boolean {
    if (this.#server.clientCount > 0) return true;
    return this.#registry
      .list()
      .some((s) => s.status === "running" || s.status === "starting" || s.status === "awaiting_input");
  }

  // -------------------------------------------------------------------------
  // RPC handlers
  // -------------------------------------------------------------------------

  #registerHandlers(): void {
    const d = this.#dispatcher;

    d.register("hello", (params, ctx) => this.#hHello(params, ctx));

    d.register("ping", (params) => {
      const nonce = isObj(params) ? params["nonce"] : undefined;
      return { nonce: nonce ?? null, pid: process.pid, startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt };
    });

    d.register("daemon.status", () => ({
      pid: process.pid,
      epoch: this.epoch,
      version: LOOM_VERSION,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      repoRoot: this.repoRoot,
      sessions: this.#registry.list().length,
      runningSessions: this.#sessions.count,
      providers: this.#providers.live().map((p) => p.id),
      loomTools: ["ask_user", "commit"],
      mcpMounts: this.config.mcp.map((m) => m.name),
      clients: this.#server.clientCount,
      connections: this.#server.connectionCount,
      eventSeq: this.#events.head,
      eventBuffer: this.#events.size,
      hygiene: this.#hygiene,
    }));

    d.register("daemon.shutdown", () => {
      setImmediate(() => void this.stop("rpc"));
      return { ok: true };
    });

    d.register("pricing.reload", () => {
      this.#pricing = loadPriceTable(resolveAgainstRepo(this.repoRoot, this.config.pricing.table));
      return { models: [...this.#pricing.keys()] };
    });

    d.register("providers.list", () => this.#providerList());

    d.register("providers.probeModels", async (params) => {
      const id = reqString(params, "id");
      const profile = this.config.providers.aisdk[id];
      if (!profile) throw new RpcError("not_found", `no aisdk provider: ${id}`);
      // Only OpenAI-compatible endpoints have a uniform `/models`; for the
      // native SDKs just hand back the configured list.
      if (profile.sdk !== "openai") return { models: profile.models };
      try {
        return { models: await probeOpenAiModels(profile.baseUrl, profile.apiKeyEnv) };
      } catch (err) {
        throw new RpcError("provider_error", `could not list models: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    d.register("session.list", () => this.#enrichAll(this.#registry.listSorted()));

    d.register("session.get", (params) => {
      const id = reqString(params, "id");
      const s = this.#registry.get(id);
      if (!s) throw new RpcError("not_found", `no such session: ${id}`);
      return this.#enrich(s);
    });

    d.register("session.history", (params) => {
      const id = reqString(params, "id");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      return this.#registry.store.statusHistory(id);
    });

    // --- session control (Claude adapter, milestone 2) --------------------

    d.register("session.create", async (params) => {
      const p = isObj(params) ? params : {};
      const prompt = typeof p["prompt"] === "string" ? (p["prompt"] as string).trim() : "";
      if (prompt === "") throw new RpcError("bad_request", "prompt is required");

      const providerId =
        typeof p["provider"] === "string" && this.#providers.has(p["provider"] as string)
          ? (p["provider"] as string)
          : this.#providers.defaultId;
      const mode: SessionMode = isSessionMode(p["mode"]) ? p["mode"] : "default";
      const model =
        typeof p["model"] === "string"
          ? (p["model"] as string)
          : providerId === "claude"
            ? this.config.providers.claude.model
            : (this.config.providers.aisdk[providerId]?.model ?? null);
      const parentId = typeof p["parentId"] === "string" ? (p["parentId"] as string) : null;
      if (parentId && !this.#registry.get(parentId)) {
        throw new RpcError("not_found", `no such parent session: ${parentId}`);
      }

      const id = randomUUID();
      // An explicit budget wins; otherwise fall back to the configured soft cap.
      const budget =
        this.#readBudget(p["budget"]) ??
        (this.config.budget.defaultMaxCostUsd > 0
          ? { maxCostUsd: this.config.budget.defaultMaxCostUsd }
          : null);

      // Each session gets its own worktree + branch off the configured base.
      let wt;
      try {
        wt = this.#worktrees.create(prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcError("worktree_error", `could not create worktree: ${message}`);
      }

      this.#registry.create({
        id,
        provider: providerId,
        model,
        mode,
        parentId,
        title: prompt.slice(0, 200),
        worktree: wt.path,
        branch: wt.branch,
        baseBranch: wt.baseRef,
        ...(budget ? { budget } : {}),
      });

      const isClaude = providerId === "claude";
      const isAisdk = this.config.providers.aisdk[providerId] !== undefined;
      const mcpHandles = this.#mcpHandles();
      const aisdkSystem =
        mcpHandles.length > 0 ? `${AISDK_SYSTEM}\n\n${TOOL_STEER}` : AISDK_SYSTEM;
      const opts: CreateSessionOptions = {
        sessionId: id,
        cwd: wt.path,
        prompt,
        mode,
        mcpServers: mcpHandles,
        disableTools: this.config.providers.claude.disableBuiltin,
        settingSources: this.config.providers.claude.settingSources,
        ...(isClaude ? { loomServer: true, systemPromptAppend: TOOL_STEER } : {}),
        ...(isAisdk ? { loomServer: true, systemPromptAppend: aisdkSystem } : {}),
        ...(model ? { model } : {}),
        ...(parentId ? { parentId } : {}),
        ...(budget
          ? {
              budget: {
                ...(budget.maxTokens != null ? { maxTokens: budget.maxTokens } : {}),
                ...(budget.maxCostUsd != null ? { maxCostUsd: budget.maxCostUsd } : {}),
                ...(budget.maxTurns != null ? { maxTurns: budget.maxTurns } : {}),
              },
            }
          : {}),
      };

      try {
        await this.#sessions.create(await this.#providers.get(providerId), opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#registry.setStatus(id, "error", message.slice(0, 120));
        throw new RpcError("provider_error", `could not start session: ${message}`);
      }

      const snap = this.#registry.mustGet(id);
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("session-created");
      return snap;
    });

    d.register("session.resume", async (params) => {
      const id = reqString(params, "id");
      const row = this.#registry.get(id);
      if (!row) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) throw new RpcError("conflict", "session is already running");
      const providerRef = this.#registry.store.providerRef(id);
      if (!providerRef) throw new RpcError("bad_request", "session has no provider ref to resume from");
      if (!this.#providers.has(row.provider)) {
        throw new RpcError("bad_request", `unknown provider: ${row.provider}`);
      }
      const mode: SessionMode = isSessionMode(row.mode) ? row.mode : "default";
      try {
        await this.#sessions.resume(await this.#providers.get(row.provider), {
          sessionId: id,
          providerRef,
          cwd: row.worktree ?? this.repoRoot,
          mode,
          mcpServers: this.#mcpHandles(),
          ...(row.model ? { model: row.model } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcError("provider_error", `could not resume session: ${message}`);
      }
      const snap = this.#registry.setStatus(id, "running", "resumed");
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("session-resumed");
      return snap;
    });

    d.register("session.send", async (params) => {
      const id = reqString(params, "id");
      const text = reqString(params, "text");
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      await this.#sessions.send(id, text);
      return this.#registry.mustGet(id);
    });

    d.register("session.interrupt", async (params) => {
      const id = reqString(params, "id");
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      await this.#sessions.interrupt(id);
      return this.#registry.mustGet(id);
    });

    d.register("session.compact", async (params) => {
      const id = reqString(params, "id");
      const p = isObj(params) ? params : {};
      const instructions =
        typeof p["instructions"] === "string" && p["instructions"].trim() !== ""
          ? (p["instructions"] as string).trim()
          : undefined;
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      await this.#sessions.compact(id, instructions);
      return this.#registry.mustGet(id);
    });

    d.register("session.respondPermission", async (params) => {
      const id = reqString(params, "id");
      const requestId = reqString(params, "requestId");
      const p = isObj(params) ? params : {};
      const behavior = p["decision"] === "allow" ? "allow" : "deny";
      const decision: PermissionDecision =
        behavior === "allow"
          ? {
              behavior: "allow",
              ...(isObj(p["updatedInput"]) ? { updatedInput: p["updatedInput"] } : {}),
            }
          : {
              behavior: "deny",
              ...(typeof p["message"] === "string" ? { message: p["message"] as string } : {}),
            };
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      return this.#sessions.respondToPermission(id, requestId, decision);
    });

    // Resolve an outstanding `plan_review` (milestone 8).
    d.register("session.respondPlan", async (params) => {
      const id = reqString(params, "id");
      const requestId = reqString(params, "requestId");
      const p = isObj(params) ? params : {};
      const action = p["action"];
      let decision: PlanDecision;
      if (action === "implement" || action === "implement_fresh") {
        decision = { action };
      } else if (action === "revise") {
        const plan = typeof p["plan"] === "string" ? (p["plan"] as string) : "";
        if (plan.trim() === "") throw new RpcError("bad_request", "revise needs a non-empty plan");
        decision = { action: "revise", plan };
      } else if (action === "discuss") {
        const message = typeof p["message"] === "string" ? (p["message"] as string) : "";
        if (message.trim() === "") throw new RpcError("bad_request", "discuss needs a message");
        decision = { action: "discuss", message };
      } else {
        throw new RpcError(
          "bad_request",
          "action must be implement | implement_fresh | revise | discuss",
        );
      }
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      return this.#sessions.respondToPlan(id, requestId, decision);
    });

    // Answer an outstanding `ask_user` question (loom MCP server, milestone 4).
    d.register("session.answer", async (params) => {
      const id = reqString(params, "id");
      const requestId = reqString(params, "requestId");
      const text = reqString(params, "text");
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      return this.#sessions.answerQuestion(id, requestId, text);
    });

    d.register("session.setMode", async (params) => {
      const id = reqString(params, "id");
      if (!isSessionMode(params && (params as Record<string, unknown>)["mode"])) {
        throw new RpcError("bad_request", "mode must be one of default|plan|acceptEdits|auto");
      }
      const mode = (params as Record<string, unknown>)["mode"] as SessionMode;
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.setMode(id, mode);
      const snap = this.#registry.setFields(id, { mode });
      this.#emitSessionUpdated(snap, clientLabel(params));
      return snap;
    });

    d.register("session.setModel", async (params) => {
      const id = reqString(params, "id");
      const model = reqString(params, "model");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.setModel(id, model);
      const snap = this.#registry.setFields(id, { model });
      this.#emitSessionUpdated(snap, clientLabel(params));
      return snap;
    });

    d.register("session.setTitle", (params) => {
      const id = reqString(params, "id");
      const title = reqString(params, "title").trim().slice(0, 200);
      if (title === "") throw new RpcError("bad_request", "title must not be empty");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      // A manual rename pins the title — the auto-titler won't touch it again.
      const snap = this.#registry.setFields(id, { title, titleLocked: true });
      this.#emitSessionUpdated(snap, clientLabel(params));
      return this.#enrich(snap);
    });

    d.register("session.setBudget", (params) => {
      const id = reqString(params, "id");
      const p = isObj(params) ? params : {};
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      const pos = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
      const maxCostUsd = pos(p["maxCostUsd"]);
      const maxTokens = pos(p["maxTokens"]);
      const maxTurns = pos(p["maxTurns"]);
      if (maxCostUsd === undefined && maxTokens === undefined && maxTurns === undefined) {
        throw new RpcError("bad_request", "provide at least one of maxCostUsd / maxTokens / maxTurns");
      }
      // Raising a cap clears warned / halted; the enforcer re-arms on it.
      const snap = this.#registry.setFields(id, {
        ...(maxCostUsd !== undefined ? { budgetMaxCostUsd: maxCostUsd } : {}),
        ...(maxTokens !== undefined ? { budgetMaxTokens: maxTokens } : {}),
        ...(maxTurns !== undefined ? { budgetMaxTurns: maxTurns } : {}),
        budgetState: "ok",
      });
      this.#emitSessionUpdated(snap, clientLabel(params));
      return this.#enrich(snap);
    });

    d.register("session.markDone", async (params) => {
      const id = reqString(params, "id");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.interrupt(id).catch(() => {});
      const snap = this.#registry.setStatus(id, "done", "marked_done");
      this.emitEvent({ type: "status_changed", sessionId: id, status: "done", ts: Date.now(), reason: "marked_done" });
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("marked-done");
      return this.#enrich(snap);
    });

    // gc: remove worktrees for sessions marked done. Branches are never
    // auto-deleted; the session row is retained as a record (spec §6).
    d.register("session.gc", (params) => {
      const p = isObj(params) ? params : {};
      const only = typeof p["id"] === "string" ? (p["id"] as string) : null;
      const force = p["force"] === true;
      const removed: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const s of this.#registry.list()) {
        if (s.status !== "done" || !s.worktree) continue;
        if (only && s.id !== only) continue;
        try {
          this.#worktrees.remove(s.worktree, { force });
          const snap = this.#registry.setFields(s.id, { worktree: null });
          this.#emitSessionUpdated(snap, clientLabel(params));
          removed.push(s.id);
        } catch (err) {
          failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.#worktrees.prune();
      return { removed, failed };
    });

    // --- development / test hooks (no provider adapter yet) -----------------

    d.register("session.createStub", (params) => {
      const p = isObj(params) ? params : {};
      const id = randomUUID();
      const prompt = typeof p["prompt"] === "string" ? (p["prompt"] as string) : null;
      this.#registry.create({
        id,
        provider: typeof p["provider"] === "string" ? (p["provider"] as string) : "stub",
        model: typeof p["model"] === "string" ? (p["model"] as string) : null,
        mode: typeof p["mode"] === "string" ? (p["mode"] as string) : "default",
        parentId: typeof p["parentId"] === "string" ? (p["parentId"] as string) : null,
        title: prompt,
      });
      const status: SessionStatus =
        typeof p["status"] === "string" && (VALID_STATUSES as string[]).includes(p["status"] as string)
          ? (p["status"] as SessionStatus)
          : "idle";
      const reason = typeof p["reason"] === "string" ? (p["reason"] as string) : null;
      const snap = this.#registry.setStatus(id, status, reason);
      this.emitEvent({
        type: "status_changed",
        sessionId: id,
        status,
        ts: Date.now(),
        ...(reason !== null ? { reason } : {}),
      });
      this.#emitSessionUpdated(snap);
      this.#onActivityChange("stub-created");
      return snap;
    });

    d.register("session.setStatus", (params) => {
      const id = reqString(params, "id");
      const status = reqString(params, "status");
      if (!(VALID_STATUSES as string[]).includes(status)) {
        throw new RpcError("bad_request", `invalid status: ${status}`);
      }
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      const reason = isObj(params) && typeof params["reason"] === "string" ? (params["reason"] as string) : null;
      const snap = this.#registry.setStatus(id, status as SessionStatus, reason);
      this.emitEvent({
        type: "status_changed",
        sessionId: id,
        status: status as SessionStatus,
        ts: Date.now(),
        ...(reason !== null ? { reason } : {}),
      });
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("set-status");
      return snap;
    });

    d.register("dev.emit", (params) => {
      const raw = isObj(params) ? params["event"] : undefined;
      if (!isObj(raw) || typeof raw["sessionId"] !== "string" || typeof raw["type"] !== "string") {
        throw new RpcError("bad_request", "event must be an object with sessionId and type");
      }
      const event = { ts: Date.now(), ...raw } as unknown as HarnessEvent;
      const seq = this.emitEvent(event);
      return { seq };
    });
  }

  #hHello(params: unknown, ctx: RpcContext): HelloResult {
    const p = (isObj(params) ? params : {}) as Partial<HelloParams>;
    if (p.protocolVersion !== undefined && p.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        "protocol_mismatch",
        `client protocol ${p.protocolVersion} != daemon ${PROTOCOL_VERSION}`,
      );
    }
    ctx.conn.clientId = typeof p.clientId === "string" ? p.clientId : `anon-${ctx.conn.id}`;

    // Subscribe synchronously so no frame appended from here on is missed.
    this.#server.subscribe(ctx.conn);

    const sinceSeq = typeof p.sinceSeq === "number" ? p.sinceSeq : undefined;
    const head = this.#events.head;
    let replaying = false;
    if (sinceSeq !== undefined) {
      const { frames, rolled } = this.#events.since(sinceSeq);
      if (rolled) {
        setImmediate(() =>
          ctx.conn.push({ kind: "push", seq: head, type: "resync", reason: "event buffer rolled past requested seq" }),
        );
      } else if (frames.length > 0) {
        replaying = true;
        setImmediate(() => {
          for (const f of frames) ctx.conn.push(f);
        });
      }
    }

    this.#onActivityChange("hello");

    return {
      protocolVersion: PROTOCOL_VERSION,
      daemon: {
        pid: process.pid,
        version: LOOM_VERSION,
        startedAt: this.startedAt,
        repoRoot: this.repoRoot,
      },
      sessions: this.#enrichAll(this.#registry.listSorted()),
      seq: head,
      replaying,
    };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** Vendor-neutral MCP handles from config; mounted into every session. */
  #mcpHandles(): McpServerHandle[] {
    return this.config.mcp.map((m) => {
      const parts = m.command.split(/\s+/).filter((s) => s.length > 0);
      const command = parts[0] ?? m.command;
      return {
        name: m.name,
        spec: { transport: "stdio", command, args: parts.slice(1) },
      };
    });
  }

  #readBudget(
    raw: unknown,
  ): { maxTokens?: number | null; maxCostUsd?: number | null; maxTurns?: number | null } | null {
    if (!isObj(raw)) return null;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const maxTokens = num(raw["maxTokens"]);
    const maxCostUsd = num(raw["maxCostUsd"]);
    const maxTurns = num(raw["maxTurns"]);
    if (maxTokens === undefined && maxCostUsd === undefined && maxTurns === undefined) return null;
    return {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// param helpers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function reqString(params: unknown, key: string): string {
  if (!isObj(params) || typeof params[key] !== "string" || params[key] === "") {
    throw new RpcError("bad_request", `missing required string param: ${key}`);
  }
  return params[key] as string;
}

function clientLabel(params: unknown): string | undefined {
  if (isObj(params) && typeof params["by"] === "string") return params["by"] as string;
  return undefined;
}
