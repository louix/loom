import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { absurd } from "@loom/core/absurd";
import { makeLogger, setLogFile, type Logger } from "@loom/core/logger";
import { ensureLoomDir, loomPaths, type LoomPaths } from "@loom/core/paths";
import { scaffoldUserConfig, userConfigPath } from "../scaffold.ts";
import { resolveMcpCommand } from "./mcp-fallback.ts";
import {
  lintConfig,
  loadConfig,
  resolveApiKey,
  resolveAgainstRepo,
  type LoomConfig,
} from "../config/config.ts";
import { loadPriceTable, costOf, type PriceTable } from "../config/pricing.ts";
import { LOOM_VERSION } from "@loom/core/version";
import type { HarnessEvent, SessionStatus } from "@loom/core/events";
import {
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type ModelChoice,
  type ProviderInfo,
  type SessionSnapshot,
} from "@loom/core/wire";
import { checkpoint, openDb, type Db } from "../store/db.ts";
import {
  ChildStore,
  CheckpointStore,
  ProviderDefaultStore,
  type UsageDelta,
} from "../store/sessions.ts";
import { ProviderMessageStore } from "../store/provider-messages.ts";
import { SessionEventStore } from "../store/session-events.ts";
import { estimateTokens } from "@loom/core/tokens";
import { EventLog } from "./event-log.ts";
import { Registry } from "./registry.ts";
import { RpcDispatcher, RpcError, type RpcContext } from "./rpc.ts";
import { SocketServer } from "./server.ts";
import { runStartupHygiene, type HygieneReport } from "./hygiene.ts";
import { SessionManager } from "./session-manager.ts";
import { cheapModelFor, generateTitle } from "./titler.ts";
import { WorktreeManager } from "./worktrees.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import type { ConnectorManifest } from "@loom/core/connector";
import {
  isSessionMode,
  normalizeSessionMode,
  type CreateSessionOptions,
  type McpServerHandle,
  type PermissionDecision,
  type PlanDecision,
  type SessionMode,
} from "@loom/core/types";
import { acquirePidfile, IdleTimer, releasePidfile, type PidfileInfo } from "./lifecycle.ts";

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
const probeOpenAiModels = async (baseUrl: string, apiKey: string): Promise<string[]> => {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(8_000), // a black-hole base_url must not hang the RPC
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((x): x is string => typeof x === "string")
    .sort();
};

const AISDK_SYSTEM = [
  "You are a coding agent working in a git worktree under Loom, a fleet supervisor.",
  "Work autonomously toward the user's goal: inspect the repo before changing it, make focused edits, and explain what you did concisely.",
  "You have a large context window — read whole files rather than fragments, and prefer a few substantial edits over many tiny ones.",
  "Make the smallest change that fully covers the request. Don't edit README or other docs unless the task explicitly asks for a docs change, and don't refactor code the task didn't name.",
  "Before you commit, run the project's typecheck and tests and read the output — don't assume it passed. If a test you added fails or is flaky, fix the root cause or follow how the existing tests assert; never loosen an assertion just to get a green run. When you assert on rendered terminal output, match the visible token loosely (e.g. /\\[plan\\]/) — not exact spacing, column position, or adjacency between coloured spans.",
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
  /** Connector packages this daemon can load, keyed by package name. Supplied by the CLI. */
  connectors: ConnectorManifest;
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
  #checkpoints: CheckpointStore;
  #pmsgs: ProviderMessageStore;
  #sessionEvents: SessionEventStore;
  #providerDefaults: ProviderDefaultStore;
  /** Claude's CLI-reported model catalog, discovered once at start-up. */
  #claudeChoices: ModelChoice[] | null = null;
  /** Last text sent to each live session — the undo picker's turn snippets. */
  readonly #lastSend = new Map<string, string>();
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
  #configWatchers: FSWatcher[] = [];
  #reloadTimer: NodeJS.Timeout | null = null;
  #tilthFallbackLogged = false;
  /** Sessions with an auto-title one-shot in flight (fire-once guard). */
  #titling = new Set<string>();
  /** In-flight auto-title jobs — awaited at shutdown so their one-shot titler
   *  sessions (untracked by SessionManager) don't outlive the daemon. */
  readonly #titleJobs = new Set<Promise<void>>();

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

    // First real launch on a machine with no user config: leave an annotated
    // starter at ~/.config/loom/config.toml. Skipped for standalone (test /
    // embedded) daemons so an isolated XDG dir stays empty.
    if (!this.#standalone) {
      const created = scaffoldUserConfig();
      if (created) this.#log.info("wrote a starter config", { path: created });
    }
    this.config = loadConfig(this.paths.config, userConfigPath());
    this.#pricing = loadPriceTable(resolveAgainstRepo(opts.repoRoot, this.config.pricing.table));
    const dbPath = resolveAgainstRepo(opts.repoRoot, this.config.db);
    this.#db = openDb(dbPath);
    this.#registry = new Registry(this.#db);
    this.#children = new ChildStore(this.#db);
    this.#checkpoints = new CheckpointStore(this.#db);
    this.#pmsgs = new ProviderMessageStore(this.#db);
    this.#sessionEvents = new SessionEventStore(this.#db);
    this.#providerDefaults = new ProviderDefaultStore(this.#db);
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
    this.#providers = new ProviderRegistry(this.config, this.#pmsgs, opts.connectors);
    this.#sessions = new SessionManager({
      emitEvent: (ev) => {
        if (ev.type === "compact" && !this.#stopping) {
          // A compaction rewrote the transcript; the absolute message offsets
          // stored in the checkpoints no longer point anywhere sane, so undo
          // past a compaction isn't recoverable — drop them.
          this.#checkpoints.truncate(ev.sessionId, 0);
        }
        this.emitEvent(ev);
      },
      onStatus: (id, status, reason) => this.#onDerivedStatus(id, status, reason),
      onUsage: (id, delta) => {
        if (this.#stopping) return;
        const snap = this.#registry.addUsage(id, this.#priceUsage(id, delta));
        this.#emitSessionUpdated(snap, undefined, { git: false }); // no git shell-out per usage tick
      },
      onResult: (id, ok) => {
        if (this.#stopping || !ok) return;
        this.#recordCheckpoint(id);
        const job = this.#maybeAutoTitle(id).catch((err) => {
          this.#log.debug("auto-title job failed", { id, err: String(err) });
        });
        this.#titleJobs.add(job);
        void job.finally(() => this.#titleJobs.delete(job));
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
      onMode: (id, mode) => {
        if (this.#stopping) return;
        const snap = this.#registry.setFields(id, { mode });
        this.#emitSessionUpdated(snap);
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

    await this.#resolveAutoModels();
    await this.#resolveClaudeModels();
    // Lint after detection so an auto-detect provider that resolved fine isn't
    // flagged — only a genuine failure (endpoint unreachable / no `/models`) is.
    for (const warning of lintConfig(this.config)) this.#log.warn("config", { warning });

    await this.#server.listen();

    this.#watchConfig();
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
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    for (const w of this.#configWatchers) w.close();
    this.#configWatchers = [];
    for (const [sig, fn] of this.#signalHandlers) process.removeListener(sig, fn);
    this.#signalHandlers = [];

    await this.#sessions.shutdown();
    // Give in-flight auto-title jobs (one-shot titler sessions live outside the
    // SessionManager) a brief window to finish before the DB closes under them.
    if (this.#titleJobs.size > 0) {
      await Promise.race([
        Promise.allSettled(this.#titleJobs),
        new Promise((r) => setTimeout(r, 2_000).unref()),
      ]);
    }
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
    // `status_changed` is redundant with `status_history`; `compact_progress`
    // is a heartbeat the TUI never renders (see `applyPush` in the frontend
    // model) — skip both so the durable log only holds what a client would
    // ever actually backfill.
    if (event.type !== "status_changed" && event.type !== "compact_progress") {
      this.#sessionEvents.append(event.sessionId, frame.seq, event);
    }
    this.#server.broadcast(frame);
    return frame.seq;
  }

  #emitSessionUpdated(session: SessionSnapshot, by?: string, opts: { git?: boolean } = {}): void {
    if (this.#stopping) return;
    const frame = this.#events.append({
      kind: "push",
      type: "session_updated",
      session: this.#enrich(session, opts.git ?? true),
      version: this.#registry.version(session.id),
      ...(by !== undefined ? { by } : {}),
    });
    this.#server.broadcast(frame);
  }

  #emitSessionRemoved(id: string): void {
    if (this.#stopping) return;
    const frame = this.#events.append({ kind: "push", type: "session_removed", sessionId: id });
    this.#server.broadcast(frame);
  }

  /** A daemon-level advisory for the operator (config reload feedback). */
  #emitNotice(text: string, tone: "info" | "warn"): void {
    if (this.#stopping) return;
    this.#server.broadcast(this.#events.append({ kind: "push", type: "notice", text, tone }));
  }

  /**
   * Overlay runtime-only facts on a stored snapshot: git facts, sub-agents,
   * cache TTL. `withGit` false skips the ~6 synchronous `git` calls — used for
   * the per-`usage` update stream during a turn, where git state can't change.
   */
  #enrich(s: SessionSnapshot, withGit = true): SessionSnapshot {
    let out = s;
    const subs = this.#sessions.subagentsOf(s.id);
    if (subs.length > 0) out = { ...out, subagents: subs };
    const rateLimits = this.#sessions.rateLimitsOf(s.id);
    if (Object.keys(rateLimits).length > 0) out = { ...out, rateLimits };
    const ttlMinutes = s.provider === "claude" ? this.#cacheTtlMinutes : 0;
    if (ttlMinutes !== out.cache.ttlMinutes) {
      out = { ...out, cache: { ...out.cache, ttlMinutes } };
    }
    // An in-place session works in the repo root; show that dir's git state.
    const gitPath = out.worktree ?? (out.inPlace ? this.repoRoot : null);
    if (gitPath) {
      // `withGit` false (the per-usage stream) still carries the last-known
      // facts so the TUI's git line doesn't collapse to "no worktree" mid-turn.
      const git = withGit
        ? this.#worktrees.facts(gitPath, out.baseBranch)
        : this.#worktrees.cachedFacts(gitPath);
      if (git) out = { ...out, git };
    }
    return out;
  }

  get #cacheTtlMinutes(): number {
    const ttl = this.config.providers.claude.promptCacheTtl;
    switch (ttl) {
      case "1h":
        return 60;
      case "5m":
        return 5;
      case "":
        return 0;
      default:
        return absurd(ttl);
    }
  }

  /**
   * Fill `model` / `models` for aisdk profiles that configured neither, by
   * probing `{base_url}/models`. Best-effort and bounded — a black-hole
   * endpoint logs a warning and leaves the profile model-less (session creation
   * on it then fails with a clear message). Mutates `this.config` in place so
   * the registry (which reads the profile by reference) sees the result.
   */
  async #resolveAutoModels(): Promise<void> {
    const pending = Object.entries(this.config.providers.aisdk).filter(([, p]) => p.autoModels);
    if (pending.length === 0) return;
    await Promise.all(
      pending.map(async ([id, p]) => {
        try {
          const models = await probeOpenAiModels(p.baseUrl, resolveApiKey(p));
          if (models.length === 0) throw new Error("endpoint returned no models");
          p.models = models;
          p.model = models[0] ?? "";
          p.autoModels = false;
          this.#log.info("auto-detected models", {
            provider: id,
            count: models.length,
            model: p.model,
          });
        } catch (err) {
          this.#log.warn("model auto-detection failed — set `model` / `models` for this provider", {
            provider: id,
            baseUrl: p.baseUrl,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  /**
   * Ask the Claude CLI for its model catalog once at start-up, so `M` / `⌥p`
   * offer real choices without a hard-coded list. Skipped when the user pinned
   * `[providers.claude] models`, in standalone/test daemons, or when the
   * provider has no `listModels`. Best-effort and bounded — a failure just
   * leaves the list empty and `#providerList` falls back to the single pin.
   */
  async #resolveClaudeModels(): Promise<void> {
    if (this.#standalone) return;
    if (this.config.providers.claude.models.length > 0) return;
    try {
      const provider = await this.#providers.get("claude");
      if (!provider.listModels) return;
      const models = await Promise.race([
        provider.listModels(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timed out after 10s")), 10_000).unref?.(),
        ),
      ]);
      if (models.length === 0) return;
      this.#claudeChoices = models.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        ...(m.context ? { context: m.context } : {}),
      }));
      this.config.providers.claude.models = this.#claudeChoices.map((c) => c.id);
      this.#log.info("claude models discovered", { count: models.length });
    } catch (err) {
      this.#log.warn(
        "claude model discovery failed — set `[providers.claude] models` to pin a list",
        {
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  /** Configured providers for the TUI's creation flow / model switcher. */
  #providerList(): ProviderInfo[] {
    const def = this.#defaultProviderId();
    const mode = this.#defaultMode();
    const claude = this.config.providers.claude;
    const claudeModelPin = claude.model ? [claude.model] : [];
    const out: ProviderInfo[] = [
      {
        id: "claude",
        // Discovered catalog if we have it, else the single configured pin so
        // the picker isn't empty.
        models: claude.models.length ? claude.models : claudeModelPin,
        ...(this.#claudeChoices ? { modelChoices: this.#claudeChoices } : {}),
        defaultModel: this.#defaultModelFor("claude"),
        defaultMode: mode,
        tag: "claude",
        color: "",
        isDefault: def === "claude",
      },
    ];
    let i = 0;
    for (const [id, p] of Object.entries(this.config.providers.aisdk)) {
      out.push({
        id,
        models: p.models,
        defaultModel: this.#defaultModelFor(id),
        defaultMode: mode,
        tag: p.tag || id,
        color: p.color || (PROVIDER_PALETTE[i % PROVIDER_PALETTE.length] ?? ""),
        isDefault: def === id,
      });
      i += 1;
    }
    return out;
  }

  /**
   * The provider a new session uses when the caller names none: the last
   * provider a session was created with (persisted in `meta`), else the
   * configured `default_provider`. A remembered provider that's no longer
   * configured is ignored.
   */
  #defaultProviderId(): string {
    const remembered = this.#providerDefaults.provider();
    if (remembered && this.#providers.has(remembered)) return remembered;
    return this.#providers.defaultId;
  }

  /**
   * The permission mode a new session uses when the caller names none: the
   * last mode a session was created with (persisted in `meta`), else `default`
   * (manual).
   */
  #defaultMode(): SessionMode {
    const remembered = this.#providerDefaults.mode();
    return remembered && isSessionMode(remembered) ? remembered : "default";
  }

  /**
   * The model a new session on `providerId` uses when the caller names none:
   * the last model run on it (persisted in `meta`), else a config `model` pin,
   * else the first auto-detected model. A remembered model that has dropped out
   * of the provider's detected list is ignored.
   */
  #defaultModelFor(providerId: string): string {
    if (providerId === "claude") {
      const c = this.config.providers.claude;
      const remembered = this.#providerDefaults.model("claude");
      if (remembered && (c.models.length === 0 || c.models.includes(remembered))) return remembered;
      return c.model || c.models[0] || "";
    }
    const p = this.config.providers.aisdk[providerId];
    if (!p) return "";
    const remembered = this.#providerDefaults.model(providerId);
    if (remembered && (p.models.length === 0 || p.models.includes(remembered))) return remembered;
    return p.model || p.models[0] || "";
  }

  /**
   * Re-instantiate the adapter for a session that isn't currently live (a
   * daemon restart left it `interrupted`, or its last turn ended). Caller must
   * have checked `!#sessions.has(id)`. Returns the fresh snapshot; the caller
   * emits `session_updated`.
   */
  async #reviveSession(id: string): Promise<SessionSnapshot> {
    const row = this.#registry.get(id);
    if (!row) throw new RpcError("not_found", `no such session: ${id}`);
    if (row.status === "done") throw new RpcError("bad_request", "session is done");
    const providerRef = this.#registry.store.providerRef(id);
    if (!providerRef)
      throw new RpcError("bad_request", "session has no provider ref to resume from");
    if (!this.#providers.has(row.provider)) {
      throw new RpcError("bad_request", `unknown provider: ${row.provider}`);
    }
    const mode: SessionMode = isSessionMode(row.mode) ? row.mode : "default";
    // If the model this session ran on has since dropped out of the endpoint's
    // list, revive on the current default instead of failing the first turn.
    let model = row.model;
    const prof = this.config.providers.aisdk[row.provider];
    if (prof && model && prof.models.length > 0 && !prof.models.includes(model)) {
      const swap = this.#defaultModelFor(row.provider);
      if (swap && swap !== model) {
        this.#emitNotice(
          `${row.provider}: model "${model}" is no longer offered — resuming ${id.slice(0, 8)} on "${swap}"`,
          "warn",
        );
        this.#registry.setFields(id, { model: swap });
        model = swap;
      }
    }
    try {
      await this.#sessions.resume(await this.#providers.get(row.provider), {
        sessionId: id,
        providerRef,
        cwd: row.worktree ?? this.repoRoot,
        mode,
        mcpServers: this.#mcpHandles(),
        ...(model ? { model } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError("provider_error", `could not resume session: ${message}`);
    }
    return this.#registry.setStatus(id, "running", "resumed");
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

    this.#titling.add(id);
    try {
      const provider = await this.#providers.get(snap.provider);
      if (!provider.capabilities.oneShot) return;
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

  #isAisdk(providerId: string): boolean {
    return this.config.providers.aisdk[providerId] !== undefined;
  }

  /** Snapshot a completed turn so it can be rewound / forked from later. */
  #recordCheckpoint(id: string): void {
    const snap = this.#registry.get(id);
    if (!snap || snap.turns <= 0) return;
    const forkPoint = this.#isAisdk(snap.provider) ? String(this.#pmsgs.count(id)) : "";
    const userText = (this.#lastSend.get(id) ?? snap.title ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    this.#checkpoints.record(id, {
      turn: snap.turns,
      providerRef: this.#registry.store.providerRef(id) ?? "",
      forkPoint,
      userText,
    });
  }

  /** ~cost to re-prime an aisdk transcript truncated to `keepMessages` (a cache write). */
  #rewindCostUsd(model: string | null, keepMessages: number, id: string): number {
    const keep = Math.min(Math.max(0, keepMessages), this.#pmsgs.count(id));
    if (keep <= 0) return 0;
    const tokens = estimateTokens(this.#pmsgs.load(id).slice(0, keep));
    return (
      costOf(this.#pricing, model, { input: 0, output: 0, cacheRead: 0, cacheWrite: tokens }) ?? 0
    );
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
      .some(
        (s) => s.status === "running" || s.status === "starting" || s.status === "awaiting_input",
      );
  }

  // -------------------------------------------------------------------------
  // live config reload
  // -------------------------------------------------------------------------

  /** Watch the repo and user config files for changes; debounce into a reload. */
  #watchConfig(): void {
    const dirs = new Set<string>();
    for (const file of [this.paths.config, userConfigPath()]) {
      const dir = dirname(file);
      if (dirs.has(dir) || !existsSync(dir)) continue;
      dirs.add(dir);
      try {
        const w = watch(dir, (_evt, name) => {
          if (name && name.toString() === "config.toml") this.#scheduleReload();
        });
        w.unref();
        this.#configWatchers.push(w);
      } catch (err) {
        this.#log.warn("config watch failed", { dir, err: String(err) });
      }
    }
  }

  #scheduleReload(): void {
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      this.#reloadConfig();
    }, 250);
    this.#reloadTimer.unref();
  }

  /**
   * Re-read config on the fly. Fields that only steer *new* sessions or a timer
   * are hot-applied; a change to the provider set / base branch / dirs / buffer
   * size / mcp list needs a restart, so the operator gets a nudge instead.
   */
  #reloadConfig(): void {
    if (this.#stopping) return;
    let next: LoomConfig;
    try {
      next = loadConfig(this.paths.config, userConfigPath());
    } catch (err) {
      this.#log.warn("config reload failed — keeping the running config", { err: String(err) });
      this.#emitNotice("config has a syntax error — kept the running one", "warn");
      return;
    }
    const before = this.config;
    if (JSON.stringify(next) === JSON.stringify(before)) return;

    // Hot-apply: these are read afresh when a session starts, or drive a timer.
    this.config.worktree = next.worktree;
    this.config.notify = next.notify;
    this.config.titles = next.titles;
    if (next.daemon.idleShutdownMinutes !== before.daemon.idleShutdownMinutes) {
      this.config.daemon = {
        ...this.config.daemon,
        idleShutdownMinutes: next.daemon.idleShutdownMinutes,
      };
      this.#idle.setMinutes(next.daemon.idleShutdownMinutes);
      this.#idle.poke(this.#isBusy());
    }

    for (const warning of lintConfig(this.config)) this.#log.warn("config", { warning });

    const needsRestart =
      JSON.stringify(next.providers) !== JSON.stringify(before.providers) ||
      next.baseBranch !== before.baseBranch ||
      next.worktreeDir !== before.worktreeDir ||
      next.db !== before.db ||
      next.runIsolation !== before.runIsolation ||
      next.daemon.eventBufferSize !== before.daemon.eventBufferSize ||
      JSON.stringify(next.mcp) !== JSON.stringify(before.mcp);

    this.#log.info("config reloaded", { needsRestart });
    this.#emitNotice(
      needsRestart
        ? "config changed — press R to restart the daemon and apply provider / mcp changes"
        : "config reloaded",
      needsRestart ? "warn" : "info",
    );
  }

  // -------------------------------------------------------------------------
  // RPC handlers
  // -------------------------------------------------------------------------

  #registerHandlers(): void {
    const d = this.#dispatcher;

    d.register("hello", (params, ctx) => this.#hHello(params, ctx));

    d.register("ping", (params) => {
      const nonce = isObj(params) ? params["nonce"] : undefined;
      return {
        nonce: nonce ?? null,
        pid: process.pid,
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
      };
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
      if (id === "claude") {
        try {
          const provider = await this.#providers.get("claude");
          const discovered = await provider.listModels?.();
          const models = discovered
            ? discovered.map((m) => m.id)
            : this.config.providers.claude.models;
          return { models };
        } catch (err) {
          throw new RpcError(
            "provider_error",
            `could not list models: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const profile = this.config.providers.aisdk[id];
      if (!profile) throw new RpcError("not_found", `no aisdk provider: ${id}`);
      // Only OpenAI-compatible endpoints have a uniform `/models`; for the
      // native SDKs just hand back the configured list.
      if (profile.sdk !== "openai") return { models: profile.models };
      try {
        return { models: await probeOpenAiModels(profile.baseUrl, resolveApiKey(profile)) };
      } catch (err) {
        throw new RpcError(
          "provider_error",
          `could not list models: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    d.register("config.check", () => ({ warnings: lintConfig(this.config) }));

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

    // The durable counterpart to the cross-session `EventLog` ring — lets a
    // client backfill a session's own history once it's fallen out of that
    // ring (busy neighbour sessions, or a daemon restart).
    d.register("session.events", (params) => {
      const id = reqString(params, "id");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      const p = isObj(params) ? params : {};
      const limit = typeof p["limit"] === "number" ? p["limit"] : 500;
      return this.#sessionEvents.list(id, { limit });
    });

    // --- session control (Claude adapter, milestone 2) --------------------

    d.register("session.create", async (params) => {
      const p = isObj(params) ? params : {};
      const prompt = typeof p["prompt"] === "string" ? (p["prompt"] as string).trim() : "";
      if (prompt === "") throw new RpcError("bad_request", "prompt is required");

      const providerId =
        typeof p["provider"] === "string" && this.#providers.has(p["provider"] as string)
          ? (p["provider"] as string)
          : this.#defaultProviderId();
      const mode: SessionMode = normalizeSessionMode(p["mode"]) ?? this.#defaultMode();
      const aisdkProfile = this.config.providers.aisdk[providerId];
      const explicitModel = typeof p["model"] === "string" ? (p["model"] as string) : null;
      // Tell the operator once when the model we'd have reused has dropped out of
      // the endpoint's list since it last ran (item: "handle when the default is
      // no longer there").
      if (!explicitModel && aisdkProfile) {
        const remembered = this.#providerDefaults.model(providerId);
        if (
          remembered &&
          aisdkProfile.models.length > 0 &&
          !aisdkProfile.models.includes(remembered)
        ) {
          this.#emitNotice(
            `${providerId}: last model "${remembered}" is no longer offered — using ${
              this.#defaultModelFor(providerId) || "the provider default"
            }`,
            "warn",
          );
        }
      }
      const model = explicitModel ?? (this.#defaultModelFor(providerId) || null);
      if (aisdkProfile && !model) {
        throw new RpcError(
          "bad_request",
          `provider "${providerId}" has no model — auto-detection from ${aisdkProfile.baseUrl}/models ` +
            "failed; set `model` / `models` in the config, or pass an explicit model",
        );
      }
      const parentId = typeof p["parentId"] === "string" ? (p["parentId"] as string) : null;
      if (parentId && !this.#registry.get(parentId)) {
        throw new RpcError("not_found", `no such parent session: ${parentId}`);
      }

      const id = randomUUID();

      // By default each session gets its own worktree + branch off the
      // configured base. `[worktree] enabled = false` (or a per-session
      // `worktree: false`) runs it in the repo working dir instead — no branch
      // isolation, concurrent sessions can collide, hard-fork unavailable.
      const wantWorktree =
        typeof p["worktree"] === "boolean"
          ? (p["worktree"] as boolean)
          : this.config.worktree.enabled;
      let wt: { path: string; branch: string; baseRef: string } | null = null;
      if (wantWorktree) {
        try {
          wt = this.#worktrees.create(prompt, id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new RpcError("worktree_error", `could not create worktree: ${message}`);
        }
      }
      const cwd = wt ? wt.path : this.repoRoot;

      this.#registry.create({
        id,
        provider: providerId,
        model,
        mode,
        parentId,
        title: prompt.slice(0, 200),
        worktree: wt ? wt.path : null,
        branch: wt ? wt.branch : null,
        baseBranch: wt ? wt.baseRef : this.config.baseBranch,
        ...(wt ? {} : { inPlace: true }),
      });

      // Remember what this session was created with, so the next `new`
      // defaults here without any of it being pinned in config.
      if (model && (aisdkProfile || providerId === "claude")) {
        this.#providerDefaults.remember(providerId, model);
      }
      this.#providerDefaults.rememberProvider(providerId);
      this.#providerDefaults.rememberMode(mode);

      const isClaude = providerId === "claude";
      const isAisdk = this.config.providers.aisdk[providerId] !== undefined;
      const mcpHandles = this.#mcpHandles();
      const aisdkSystem = mcpHandles.length > 0 ? `${AISDK_SYSTEM}\n\n${TOOL_STEER}` : AISDK_SYSTEM;
      const opts: CreateSessionOptions = {
        sessionId: id,
        cwd,
        prompt,
        mode,
        mcpServers: mcpHandles,
        disableTools: this.config.providers.claude.disableBuiltin,
        settingSources: this.config.providers.claude.settingSources,
        ...(isClaude ? { loomServer: true, systemPromptAppend: TOOL_STEER } : {}),
        ...(isAisdk ? { loomServer: true, systemPromptAppend: aisdkSystem } : {}),
        ...(model ? { model } : {}),
        ...(parentId ? { parentId } : {}),
      };

      this.#lastSend.set(id, prompt);
      try {
        await this.#sessions.create(await this.#providers.get(providerId), opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Nothing ran in the worktree — reclaim it now (gc only touches `done`
        // rows, so an `error` row's tree would leak forever). Keep the row as
        // a record of the failure, with no worktree. (An in-place session has
        // no tree to reclaim.)
        if (wt) {
          try {
            this.#worktrees.remove(wt.path, { force: true });
          } catch {
            /* best effort */
          }
          this.#registry.setFields(id, { worktree: null });
        }
        this.#registry.setStatus(id, "error", message.slice(0, 120));
        throw new RpcError("provider_error", `could not start session: ${message}`);
      }

      // The opening prompt is a user message like any follow-up — put it on the
      // event stream so it's in the log / transcript and survives a reconnect
      // (clients no longer local-echo it).
      this.emitEvent({
        type: "user_message",
        sessionId: id,
        ts: Date.now(),
        text: prompt,
        injected: false,
      });

      const snap = this.#registry.mustGet(id);
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("session-created");
      return snap;
    });

    d.register("session.resume", async (params) => {
      const id = reqString(params, "id");
      if (this.#sessions.has(id)) throw new RpcError("conflict", "session is already running");
      const snap = await this.#reviveSession(id);
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("session-resumed");
      return snap;
    });

    d.register("session.send", async (params) => {
      const id = reqString(params, "id");
      const text = reqString(params, "text");
      // A cold session (daemon restarted, or a turn that ended) is brought back
      // transparently — `send` is the one verb for "talk to this session", it
      // doesn't need a separate resume step.
      if (!this.#sessions.has(id)) {
        await this.#reviveSession(id);
        this.#onActivityChange("session-resumed");
      }
      const { injected } = await this.#sessions.send(id, text);
      // Always emit the message so every client renders it from one source
      // (clients don't local-echo sends). `injected: true` = it landed in a
      // live turn (aisdk splices after the current tool result; Claude queues
      // for the next boundary); false = it started a fresh turn.
      this.emitEvent({ type: "user_message", sessionId: id, ts: Date.now(), text, injected });
      // Only the text that *starts* a turn is the checkpoint / auto-title seed.
      if (!injected) this.#lastSend.set(id, text);
      return { ...this.#registry.mustGet(id), injected };
    });

    d.register("session.checkpoints", (params) => {
      const id = reqString(params, "id");
      const snap = this.#registry.get(id);
      if (!snap) throw new RpcError("not_found", `no such session: ${id}`);
      const model = snap.model;
      return this.#checkpoints.list(id).map((cp) => ({
        turn: cp.turn,
        userText: cp.userText,
        createdAt: cp.createdAt,
        rewindCostUsd: this.#isAisdk(snap.provider)
          ? this.#rewindCostUsd(model, Number(cp.forkPoint) || 0, id)
          : 0,
      }));
    });

    d.register("session.rewind", async (params) => {
      const id = reqString(params, "id");
      const toTurn = Number((isObj(params) ? params : {})["toTurn"]);
      const snap = this.#registry.get(id);
      if (!snap) throw new RpcError("not_found", `no such session: ${id}`);
      if (!this.#isAisdk(snap.provider)) {
        throw new RpcError(
          "bad_request",
          "rewind is aisdk-only for now (Claude support is fork-tree F3)",
        );
      }
      if (snap.turns <= 1) {
        throw new RpcError("bad_request", "this session has no earlier turn to rewind to");
      }
      if (!Number.isInteger(toTurn) || toTurn < 1 || toTurn >= snap.turns) {
        throw new RpcError("bad_request", `toTurn must be 1..${snap.turns - 1}`);
      }
      if (!["idle", "interrupted", "error"].includes(snap.status)) {
        // rewind() awaits the in-flight #turn, which for a running / parked
        // session never settles until it's interrupted → the RPC would hang.
        throw new RpcError("bad_request", "interrupt the session before rewinding it");
      }
      const cp = this.#checkpoints.at(id, toTurn);
      if (!cp) throw new RpcError("not_found", `no checkpoint at turn ${toTurn}`);
      const keep = Number(cp.forkPoint) || 0;

      // Truncate the bookkeeping first so whichever path emits the snapshot
      // below carries the new turn count.
      this.#checkpoints.truncate(id, toTurn);
      this.#registry.store.setTurns(id, toTurn);

      if (this.#sessions.has(id)) {
        // SessionManager.rewind → #set(idle, "rewind") already broadcasts the
        // session_updated; don't re-emit it here.
        await this.#sessions.rewind(id, keep);
        this.emitEvent({ type: "rewind", sessionId: id, ts: Date.now(), toTurn });
        return this.#registry.mustGet(id);
      }

      // Not live: truncate the store directly and drive the status ourselves.
      this.#pmsgs.replaceFrom(id, keep, []);
      this.emitEvent({ type: "rewind", sessionId: id, ts: Date.now(), toTurn });
      const updated = this.#registry.setStatus(id, "idle", "rewind");
      this.#emitSessionUpdated(updated, clientLabel(params));
      return updated;
    });

    d.register("session.fork", async (params) => {
      const id = reqString(params, "id");
      const parent = this.#registry.get(id);
      if (!parent) throw new RpcError("not_found", `no such session: ${id}`);
      if (!this.#isAisdk(parent.provider)) {
        throw new RpcError(
          "bad_request",
          "hard fork is aisdk-only for now (Claude support is fork-tree F3)",
        );
      }
      if (parent.inPlace) {
        throw new RpcError(
          "bad_request",
          "the parent runs in-place (no worktree) — hard fork needs an isolated branch",
        );
      }
      if (!["idle", "interrupted", "done", "error"].includes(parent.status)) {
        // Forking mid-turn copies a transcript whose last message is an
        // assistant tool-call with no tool_result yet — the fork's first
        // request would 400 on most endpoints.
        throw new RpcError("bad_request", "the parent is mid-turn — interrupt it before forking");
      }
      const p = isObj(params) ? params : {};
      const forkPrompt = typeof p["prompt"] === "string" ? (p["prompt"] as string).trim() : "";

      const newId = randomUUID();
      let wt;
      try {
        wt = this.#worktrees.create(
          `${parent.title ?? id} fork`,
          newId,
          parent.branch ?? undefined,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new RpcError("worktree_error", `could not create the fork's worktree: ${m}`);
      }

      // Everything past the worktree is torn down together on any failure so a
      // failed fork doesn't leave an orphan worktree / branch / row / rows.
      try {
        this.#registry.create({
          id: newId,
          provider: parent.provider,
          model: parent.model,
          parentId: id,
          title: `${(parent.title ?? "session").slice(0, 180)} (fork)`,
          worktree: wt.path,
          branch: wt.branch,
          baseBranch: wt.baseRef,
        });
        this.#registry.setFields(newId, { forkTurn: parent.turns, providerRef: newId });
        this.#pmsgs.copyTo(id, newId);

        const mode: SessionMode = isSessionMode(parent.mode) ? parent.mode : "default";
        await this.#sessions.resume(await this.#providers.get(parent.provider), {
          sessionId: newId,
          providerRef: newId,
          cwd: wt.path,
          mode,
          mcpServers: this.#mcpHandles(),
          ...(parent.model ? { model: parent.model } : {}),
        });
      } catch (err) {
        await this.#sessions.close(newId).catch(() => {});
        let removed = false;
        try {
          this.#worktrees.remove(wt.path, { force: true });
          removed = true;
        } catch (rmErr) {
          this.#log.warn("fork cleanup: could not remove the worktree", {
            id: newId,
            path: wt.path,
            err: rmErr instanceof Error ? rmErr.message : String(rmErr),
          });
        }
        if (removed) {
          this.#registry.store.delete(newId); // cascades provider_messages / checkpoints
        } else {
          // The tree is still on disk — keep the row (worktree path intact) and
          // mark it error so a later `session.gc { id }` can still reclaim it,
          // rather than deleting the row and orphaning the directory.
          this.#registry.setStatus(newId, "error", "fork start failed");
        }
        this.#lastSend.delete(newId);
        const m = err instanceof Error ? err.message : String(err);
        throw new RpcError("provider_error", `could not start the fork: ${m}`);
      }

      this.#registry.setStatus(newId, "idle", "forked");
      if (forkPrompt) {
        this.#lastSend.set(newId, forkPrompt);
        await this.#sessions.send(newId, forkPrompt);
      }
      const snap = this.#registry.mustGet(newId);
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("session-forked");
      return snap;
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
      if (p["decision"] !== "allow" && p["decision"] !== "deny") {
        throw new RpcError("bad_request", `decision must be "allow" or "deny"`);
      }
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
      const mode = normalizeSessionMode(params && (params as Record<string, unknown>)["mode"]);
      if (!mode) {
        throw new RpcError("bad_request", "mode must be one of manual|plan|acceptEdits|auto");
      }
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.setMode(id, mode);
      const snap = this.#registry.setFields(id, { mode });
      // A deliberate switch is also "the last mode used" for the next new session.
      this.#providerDefaults.rememberMode(mode);
      this.#emitSessionUpdated(snap, clientLabel(params));
      return snap;
    });

    d.register("session.setModel", async (params) => {
      const id = reqString(params, "id");
      const model = reqString(params, "model");
      const row = this.#registry.get(id);
      if (!row) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.setModel(id, model);
      const snap = this.#registry.setFields(id, { model });
      // A deliberate switch is also "the last model used" for this provider.
      if (row.provider === "claude" || this.config.providers.aisdk[row.provider]) {
        this.#providerDefaults.remember(row.provider, model);
      }
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

    d.register("session.markDone", async (params) => {
      const id = reqString(params, "id");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.interrupt(id).catch(() => {});
      this.#lastSend.delete(id);
      const snap = this.#registry.setStatus(id, "done", "marked_done");
      this.emitEvent({
        type: "status_changed",
        sessionId: id,
        status: "done",
        ts: Date.now(),
        reason: "marked_done",
      });
      this.#emitSessionUpdated(snap, clientLabel(params));
      this.#onActivityChange("marked-done");
      return this.#enrich(snap);
    });

    // remove: delete a session row for good — its worktree and its stored
    // transcript / history / checkpoints go with it (child tables cascade).
    // The branch is left alone (like `gc`) unless `deleteBranch` is set. An
    // in-place session shares the repo working dir, so its "worktree" is never
    // removed and it has no branch to delete.
    d.register("session.remove", async (params) => {
      const id = reqString(params, "id");
      const p = isObj(params) ? params : {};
      const alsoBranch = p["deleteBranch"] === true;
      const s = this.#registry.get(id);
      if (!s) throw new RpcError("not_found", `no such session: ${id}`);
      if (this.#sessions.has(id)) await this.#sessions.close(id).catch(() => {});
      this.#lastSend.delete(id);
      if (s.worktree) {
        try {
          this.#worktrees.remove(s.worktree, { force: true });
        } catch (err) {
          this.#log.warn("session.remove", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      let branchDeleted = false;
      if (alsoBranch && s.branch && !s.inPlace) {
        this.#worktrees.prune(); // release the worktree's hold on the branch first
        branchDeleted = this.#worktrees.deleteBranch(s.branch);
      }
      this.#registry.remove(id);
      this.#emitSessionRemoved(id);
      this.#worktrees.prune();
      this.#onActivityChange("session-removed");
      return { removed: id, branchDeleted };
    });

    // gc: remove worktrees for sessions marked done. Branches are never
    // auto-deleted; the session row is retained as a record (spec §6).
    d.register("session.gc", (params) => {
      const p = isObj(params) ? params : {};
      const only = typeof p["id"] === "string" ? (p["id"] as string) : null;
      const force = p["force"] === true;
      // Bulk sweep: `done` only (an `error` session may still be resumable).
      // An explicit `id` may also target an `error` row — that's how a fork
      // whose worktree-remove failed on the error path gets reclaimed.
      const eligible = (status: string): boolean =>
        only ? status === "done" || status === "error" : status === "done";
      if (only) {
        const s = this.#registry.get(only);
        if (!s) throw new RpcError("not_found", `no such session: ${only}`);
        if (!eligible(s.status)) {
          throw new RpcError("bad_request", `session ${only} is ${s.status} — nothing to gc`);
        }
      }
      const removed: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      for (const s of this.#registry.list()) {
        if (!eligible(s.status) || !s.worktree) continue;
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
        typeof p["status"] === "string" &&
        (VALID_STATUSES as string[]).includes(p["status"] as string)
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
      const reason =
        isObj(params) && typeof params["reason"] === "string" ? (params["reason"] as string) : null;
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
      // `ts` is "when the daemon observed the event" — a caller-supplied one
      // doesn't get to win.
      const event = { ...raw, ts: Date.now() } as unknown as HarnessEvent;
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
      // Push synchronously (the connection is already subscribed): a
      // setImmediate deferral let a live frame from the poll phase interleave
      // ahead of the replayed older ones. The client buffers everything until
      // its hello response lands, so ordering is preserved.
      if (rolled) {
        ctx.conn.push({
          kind: "push",
          seq: head,
          type: "resync",
          reason: "event buffer rolled past requested seq",
        });
      } else if (frames.length > 0) {
        replaying = true;
        for (const f of frames) ctx.conn.push(f);
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
        epoch: this.epoch,
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
      const { command, args, note } = resolveMcpCommand(m.command);
      if (note && !this.#tilthFallbackLogged) {
        this.#log.info("mcp command resolved", { name: m.name, note });
        this.#tilthFallbackLogged = true;
      }
      return { name: m.name, spec: { transport: "stdio", command, args } };
    });
  }
}

// ---------------------------------------------------------------------------
// param helpers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => {
  return v !== null && typeof v === "object" && !Array.isArray(v);
};

const reqString = (params: unknown, key: string): string => {
  if (!isObj(params) || typeof params[key] !== "string" || params[key] === "") {
    throw new RpcError("bad_request", `missing required string param: ${key}`);
  }
  return params[key] as string;
};

const clientLabel = (params: unknown): string | undefined => {
  if (isObj(params) && typeof params["by"] === "string") return params["by"] as string;
  return undefined;
};
