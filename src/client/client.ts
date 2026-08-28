import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Frame,
  HelloResult,
  PushFrame,
  RequestFrame,
  ResponseFrame,
  SessionSnapshot,
} from "../protocol/wire.ts";
import { PROTOCOL_VERSION } from "../protocol/wire.ts";

const LOOMD_ENTRY = fileURLToPath(new URL("../cli/loomd.ts", import.meta.url));

export interface ConnectOptions {
  repoRoot: string;
  sockPath: string;
  /** Spawn a daemon if none is listening. Default true. */
  autospawn?: boolean;
  /** Reconnect (with gap replay) if the connection drops. Default true. */
  reconnect?: boolean;
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

  sessions: SessionSnapshot[] = [];
  daemonInfo: HelloResult["daemon"] | null = null;

  private constructor(opts: ConnectOptions) {
    this.clientId = opts.clientId ?? `cli-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.#opts = {
      autospawn: true,
      reconnect: true,
      clientId: this.clientId,
      ...opts,
    };
  }

  static async connect(opts: ConnectOptions): Promise<LoomClient> {
    const c = new LoomClient(opts);
    await c.#dial(opts.autospawn ?? true);
    await c.#handshake(undefined);
    return c;
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.#sock) throw new Error("not connected");
    const id = this.#nextId++;
    const frame: RequestFrame = { kind: "req", id, method, ...(params !== undefined ? { params } : {}) };
    const p = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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

  async close(): Promise<void> {
    this.#closed = true;
    this.#sock?.destroy();
    this.#sock = null;
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
    const child = spawn(process.execPath, [LOOMD_ENTRY, "--repo", this.#opts.repoRoot], {
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
    else waiter.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code, data: frame.error.data }));
  }

  #deliverPush(frame: PushFrame): void {
    if (frame.seq > this.#lastSeq) this.#lastSeq = frame.seq;
    if (frame.type === "resync") {
      void this.#resync(frame.reason);
      return;
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
    this.daemonInfo = result.daemon;
    this.sessions = result.sessions;
    if (sinceSeq === undefined || !result.replaying) {
      this.#lastSeq = result.seq;
    }
    this.#helloDone = true;
    const queued = this.#preHelloQueue;
    this.#preHelloQueue = [];
    for (const f of queued) this.#deliverPush(f);
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
        if (this.#opts.autospawn) await this.#spawnDaemon();
        this.#sock = await this.#connectWithRetry();
        this.#attach(this.#sock);
        await this.#handshake(this.#lastSeq);
        this.#fire("reconnect", { lastSeq: this.#lastSeq });
        return;
      } catch {
        await delay(waitMs);
        waitMs = Math.min(waitMs * 2, 4000);
      }
    }
  }

  async #resync(reason: string): Promise<void> {
    try {
      this.sessions = await this.request<SessionSnapshot[]>("session.list");
    } catch {
      /* will retry on next reconnect */
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

function tryConnect(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}
