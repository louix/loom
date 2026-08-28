import { randomUUID } from "node:crypto";
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
    const frame = this.#events.append({ kind: "push", type: "event", event });
    this.#server.broadcast(frame);
    return frame.seq;
  }

  #emitSessionUpdated(session: SessionSnapshot, by?: string): void {
    const frame = this.#events.append({
      kind: "push",
      type: "session_updated",
      session,
      version: this.#registry.version(session.id),
      ...(by !== undefined ? { by } : {}),
    });
    this.#server.broadcast(frame);
  }

  #onActivityChange(why: string): void {
    this.#log.debug("activity change", { why, busy: this.#isBusy() });
    this.#idle.poke(this.#isBusy());
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

    d.register("session.list", () => this.#registry.listSorted());

    d.register("session.get", (params) => {
      const id = reqString(params, "id");
      const s = this.#registry.get(id);
      if (!s) throw new RpcError("not_found", `no such session: ${id}`);
      return s;
    });

    d.register("session.history", (params) => {
      const id = reqString(params, "id");
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      return this.#registry.store.statusHistory(id);
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
      sessions: this.#registry.listSorted(),
      seq: head,
      replaying,
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
