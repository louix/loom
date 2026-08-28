import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { makeLogger, setLogFile, type Logger } from "../util/logger.ts";
import { ensureLoomDir, loomPaths, type LoomPaths } from "../util/paths.ts";
import { loadConfig, resolveAgainstRepo, type LoomConfig } from "../config/config.ts";
import { LOOM_VERSION } from "../version.ts";
import type { HarnessEvent, SessionStatus } from "../protocol/events.ts";
import {
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type SessionSnapshot,
} from "../protocol/wire.ts";
import { checkpoint, openDb, type Db } from "../store/db.ts";
import { ChildStore } from "../store/sessions.ts";
import { EventLog } from "./event-log.ts";
import { Registry } from "./registry.ts";
import { RpcDispatcher, RpcError, type RpcContext } from "./rpc.ts";
import { SocketServer } from "./server.ts";
import { runStartupHygiene, type HygieneReport } from "./hygiene.ts";
import { SessionManager } from "./session-manager.ts";
import { WorktreeManager } from "./worktrees.ts";
import { ProviderRegistry } from "../provider/registry.ts";
import {
  isSessionMode,
  type CreateSessionOptions,
  type McpServerHandle,
  type PermissionDecision,
  type SessionMode,
} from "../provider/types.ts";
import {
  acquirePidfile,
  IdleTimer,
  releasePidfile,
  type PidfileInfo,
} from "./lifecycle.ts";

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
  #pidfile: PidfileInfo | null = null;
  #standalone: boolean;
  #hygiene: HygieneReport | null = null;

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

    this.config = loadConfig(this.paths.config);
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
    this.#providers = new ProviderRegistry(this.config);
    this.#sessions = new SessionManager({
      emitEvent: (ev) => {
        this.emitEvent(ev);
      },
      onStatus: (id, status, reason) => this.#onDerivedStatus(id, status, reason),
      onUsage: (id, delta) => {
        if (this.#stopping) return;
        this.#emitSessionUpdated(this.#registry.addUsage(id, delta));
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

  /** Fill in per-session git facts from its worktree (spec §6). Cached briefly. */
  #enrich(s: SessionSnapshot): SessionSnapshot {
    if (!s.worktree) return s;
    const git = this.#worktrees.facts(s.worktree, s.baseBranch);
    return git ? { ...s, git } : s;
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
            : null;
      const parentId = typeof p["parentId"] === "string" ? (p["parentId"] as string) : null;
      if (parentId && !this.#registry.get(parentId)) {
        throw new RpcError("not_found", `no such parent session: ${parentId}`);
      }

      const id = randomUUID();
      const budget = this.#readBudget(p["budget"]);

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

      const opts: CreateSessionOptions = {
        sessionId: id,
        cwd: wt.path,
        prompt,
        mode,
        mcpServers: this.#mcpHandles(),
        disableTools: this.config.providers.claude.disableBuiltin,
        settingSources: this.config.providers.claude.settingSources,
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
        await this.#sessions.create(this.#providers.get(providerId), opts);
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
        await this.#sessions.resume(this.#providers.get(row.provider), {
          sessionId: id,
          providerRef,
          cwd: row.worktree ?? this.repoRoot,
          mode,
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
