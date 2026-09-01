import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  EventPush,
  Frame,
  HelloResult,
  PushFrame,
  RequestFrame,
  ResponseFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import { PROTOCOL_VERSION } from "@loom/core/wire";

export interface ConnectOptions {
  repoRoot: string;
  sockPath: string;
  /**
   * Absolute path to the `loomd` entry script, run as `node <daemonEntry> --repo …`
   * when `autospawn` fires. Required unless `autospawn` is false.
   */
  daemonEntry?: string;
  /** Spawn a daemon if none is listening. Default true. */
  autospawn?: boolean;
  /** Reconnect (with gap replay) if the connection drops. Default true. */
  reconnect?: boolean;
  /**
   * On the first attach, ask the daemon to replay its whole buffered push
   * stream (`sinceSeq: 0`) instead of starting from the live head. Lets a
   * client that just launched — the TUI — show the history the running daemon
   * still holds. Default false; falls back to a `resync` if the buffer rolled.
   */
  replayHistory?: boolean;
  clientId?: string;
}

type PushListener = (frame: PushFrame) => void;
type StateListener = (info?: unknown) => void;

/**
 * Thin client for the Loom daemon. Handles connect-or-spawn, the `hello`
 * handshake, request/response correlation, and — for long-lived uses like
 * `loom tail` — automatic reconnect with `sinceSeq` gap replay.
 */
export class LoomClient {
  readonly clientId: string;
  #opts: Required<ConnectOptions>;
  #sock: Socket | null = null;
  #buf = "";
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #pushListeners = new Set<PushListener>();
  #stateListeners = new Map<string, Set<StateListener>>();
  #lastSeq = 0;
  #closed = false;
  #helloDone = false;
  #preHelloQueue: PushFrame[] = [];
  /** The daemon epoch from the last hello — a change means it restarted. */
  #daemonEpoch: string | null = null;
  /** Bounded ring of every event frame seen — lets a late subscriber backfill. */
  #eventLog: EventPush[] = [];
  #eventLogCap = 5000;

  sessions: SessionSnapshot[] = [];
  daemonInfo: HelloResult["daemon"] | null = null;

  private constructor(opts: ConnectOptions) {
    this.clientId = opts.clientId ?? `cli-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.#opts = {
      autospawn: true,
      reconnect: true,
      replayHistory: false,
      daemonEntry: "",
      clientId: this.clientId,
      ...opts,
    };
  }

  static async connect(opts: ConnectOptions): Promise<LoomClient> {
    const c = new LoomClient(opts);
    await c.#dial(opts.autospawn ?? true);
    await c.#handshake(c.#opts.replayHistory ? 0 : undefined);
    return c;
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /** Methods whose daemon-side work can legitimately exceed the default (e.g.
   *  a slow MCP stdio handshake). `session.compact` summarises the whole
   *  transcript in one completion — minutes on a long history — so it gets the
   *  same 15-minute ceiling the provider aborts at (`SUMMARISE_TIMEOUT_MS`);
   *  `compact_progress` heartbeats show it's alive in the meantime. */
  static #SLOW_METHODS: Record<string, number> = {
    "session.compact": 15 * 60_000,
    "session.create": 120_000,
    "session.fork": 120_000,
    "session.resume": 120_000,
  };

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#sock) throw new Error("not connected");
    const id = this.#nextId++;
    const limit = timeoutMs ?? LoomClient.#SLOW_METHODS[method] ?? 30_000;
    const frame: RequestFrame = {
      kind: "req",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const p = new Promise<unknown>((resolve, reject) => {
      const timer =
        limit > 0
          ? setTimeout(() => {
              if (this.#pending.delete(id)) reject(new Error(`request timed out: ${method}`));
            }, limit)
          : null;
      this.#pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
    });
    this.#sock.write(JSON.stringify(frame) + "\n");
    return p as Promise<T>;
  }

  onPush(fn: PushListener): () => void {
    this.#pushListeners.add(fn);
    return () => this.#pushListeners.delete(fn);
  }

  /** Events: "disconnect" (transport dropped, reconnect starting), "reconnect", "resync", "close". */
  on(event: "disconnect" | "reconnect" | "resync" | "close", fn: StateListener): () => void {
    let set = this.#stateListeners.get(event);
    if (!set) {
      set = new Set();
      this.#stateListeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /**
   * Every event frame received so far (bounded), oldest first. A client that
   * subscribes with {@link onPush} after the initial `hello` replay can seed
   * itself from this; de-dupe live frames against it by `seq`.
   */
  get bufferedEvents(): readonly EventPush[] {
    return this.#eventLog;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const sock = this.#sock;
    this.#sock = null;
    if (!sock) return;
    await new Promise<void>((resolve) => {
      sock.once("close", () => resolve());
      sock.destroy();
    });
  }

  /**
   * Test hook: sever the transport without marking the client closed, so the
   * reconnect path (with `sinceSeq` gap replay) runs. Not for production use.
   */
  dropForTest(): void {
    this.#sock?.destroy();
  }

  // -------------------------------------------------------------------------
  // connection management
  // -------------------------------------------------------------------------

  async #dial(autospawn: boolean): Promise<void> {
    try {
      this.#sock = await tryConnect(this.#opts.sockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!autospawn || (code !== "ENOENT" && code !== "ECONNREFUSED")) throw err;
      await this.#spawnDaemon();
      this.#sock = await this.#connectWithRetry();
    }
    this.#attach(this.#sock);
  }

  async #spawnDaemon(): Promise<void> {
    const entry = this.#opts.daemonEntry;
    if (!entry) throw new Error("LoomClient: autospawn needs `daemonEntry` (path to loomd)");
    const child = spawn(process.execPath, [entry, "--repo", this.#opts.repoRoot], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  async #connectWithRetry(): Promise<Socket> {
    let waitMs = 25;
    for (let i = 0; i < 40; i++) {
      try {
        return await tryConnect(this.#opts.sockPath);
      } catch {
        await delay(waitMs);
        waitMs = Math.min(waitMs * 1.5, 500);
      }
    }
    throw new Error(`daemon did not come up on ${this.#opts.sockPath}`);
  }

  #attach(sock: Socket): void {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.#ingest(chunk));
    sock.on("close", () => this.#onSocketClose());
    sock.on("error", () => {
      /* surfaced via close */
    });
  }

  #ingest(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line === "") continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue;
      }
      this.#onFrame(frame);
    }
  }

  #onFrame(frame: Frame): void {
    if (frame.kind === "res") {
      this.#settle(frame);
    } else if (frame.kind === "push") {
      if (!this.#helloDone) {
        this.#preHelloQueue.push(frame);
        return;
      }
      this.#deliverPush(frame);
    }
    // "req" frames from the daemon are not part of the M1 protocol; ignore.
  }

  #settle(frame: ResponseFrame): void {
    const waiter = this.#pending.get(frame.id);
    if (!waiter) return;
    this.#pending.delete(frame.id);
    if (frame.ok) waiter.resolve(frame.result);
    else
      waiter.reject(
        Object.assign(new Error(frame.error.message), {
          code: frame.error.code,
          data: frame.error.data,
        }),
      );
  }

  #deliverPush(frame: PushFrame): void {
    if (frame.seq > this.#lastSeq) this.#lastSeq = frame.seq;
    if (frame.type === "resync") {
      void this.#resync(frame.reason);
      return;
    }
    if (frame.type === "event") {
      this.#eventLog.push(frame);
      if (this.#eventLog.length > this.#eventLogCap) {
        this.#eventLog.splice(0, this.#eventLog.length - this.#eventLogCap);
      }
    }
    for (const l of this.#pushListeners) {
      try {
        l(frame);
      } catch {
        /* listener errors are their own problem */
      }
    }
  }

  async #handshake(sinceSeq: number | undefined): Promise<void> {
    this.#helloDone = false;
    const result = await this.request<HelloResult>("hello", {
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.clientId,
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    });
    // The daemon rejects a mismatched request version, but a future lenient
    // daemon on a changed frame shape would slip through — check both ways.
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `daemon speaks wire protocol v${result.protocolVersion}, this client is v${PROTOCOL_VERSION} — upgrade`,
      );
    }
    // A different epoch across a reconnect ⇒ the daemon restarted: its seq and
    // in-memory version counters reset, so any replay it offered against our
    // stale sinceSeq is meaningless. Re-baseline and tell the app to resync.
    const restarted = this.#daemonEpoch !== null && this.#daemonEpoch !== result.daemon.epoch;
    this.#daemonEpoch = result.daemon.epoch;
    this.daemonInfo = result.daemon;
    this.sessions = result.sessions;
    if (restarted || sinceSeq === undefined || !result.replaying) {
      this.#lastSeq = result.seq;
    }
    if (restarted) this.#eventLog = [];
    this.#helloDone = true;
    const queued = this.#preHelloQueue;
    this.#preHelloQueue = [];
    // On a restart, drop any "replayed" frames from the old seq space.
    for (const f of queued) {
      if (restarted && f.seq <= result.seq) continue;
      this.#deliverPush(f);
    }
    if (restarted) this.#fire("resync", { reason: "daemon restarted" });
  }

  #onSocketClose(): void {
    this.#sock = null;
    for (const [, waiter] of this.#pending) waiter.reject(new Error("connection closed"));
    this.#pending.clear();
    if (this.#closed || !this.#opts.reconnect) {
      this.#fire("close");
      return;
    }
    this.#fire("disconnect");
    void this.#reconnectLoop();
  }

  async #reconnectLoop(): Promise<void> {
    let waitMs = 100;
    while (!this.#closed) {
      try {
        // Try to connect first; only fork a daemon when nothing is listening
        // (mirrors #dial) — otherwise a briefly-unreachable daemon makes us
        // spawn a doomed loomd per iteration.
        try {
          this.#sock = await tryConnect(this.#opts.sockPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (!this.#opts.autospawn || (code !== "ENOENT" && code !== "ECONNREFUSED")) throw err;
          await this.#spawnDaemon();
          this.#sock = await this.#connectWithRetry();
        }
        this.#attach(this.#sock);
        await this.#handshake(this.#lastSeq);
        this.#fire("reconnect", { lastSeq: this.#lastSeq });
        return;
      } catch {
        // Full-ish jitter so a fleet of clients (TUI + `loom tail` + CLI) that
        // dropped together don't retry — and re-spawn a daemon — in lockstep.
        await delay(waitMs / 2 + Math.random() * (waitMs / 2));
        waitMs = Math.min(waitMs * 2, 4000);
      }
    }
  }

  async #resync(reason: string): Promise<void> {
    // The daemon says our seq is unrecoverable (buffer rolled, or it
    // restarted). Discard the local event-log gap and re-baseline from a
    // fresh hello rather than carrying a stale #lastSeq / version view.
    this.#eventLog = [];
    try {
      const result = await this.request<HelloResult>("hello", {
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
      });
      this.daemonInfo = result.daemon;
      this.#daemonEpoch = result.daemon.epoch; // keep it fresh so the next handshake doesn't false-detect a restart
      this.sessions = result.sessions;
      this.#lastSeq = result.seq;
    } catch {
      try {
        this.sessions = await this.request<SessionSnapshot[]>("session.list");
      } catch {
        /* will retry on next reconnect */
      }
    }
    this.#fire("resync", { reason });
  }

  #fire(event: string, info?: unknown): void {
    const set = this.#stateListeners.get(event);
    if (!set) return;
    for (const l of set) {
      try {
        l(info);
      } catch {
        /* ignore */
      }
    }
  }
}

const tryConnect = (sockPath: string): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
};
