import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DaemonSnapshot,
  Frame,
  HelloResult,
  PushFrame,
  RequestFrame,
  ResponseFrame,
  StatePush,
} from "@loom/core/wire";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "@loom/core/wire";
import {
  loadableFailed,
  loadableIdle,
  loadableLoaded,
  loadablePending,
  type Loadable,
} from "@loom/core/loadable";

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
  clientId?: string;
}

type PushListener = (frame: PushFrame) => void;
type StateListener = (info?: unknown) => void;
type SnapshotListener = (state: ClientState) => void;

/**
 * Why the client holds no current snapshot and won't get one by waiting. Both
 * are terminal: the transport gave up, or the two ends can't speak to each
 * other at all.
 */
export type ConnectionError =
  | { readonly kind: "protocol_mismatch"; readonly daemon: number; readonly client: number }
  | { readonly kind: "connect_failed"; readonly message: string };

export const showConnectionError = (e: ConnectionError): string =>
  e.kind === "protocol_mismatch"
    ? `daemon speaks wire protocol v${e.daemon}, this client is v${e.client} — upgrade`
    : e.message;

/**
 * Marks a handshake failure that reconnecting cannot fix, so the reconnect loop
 * stops instead of dialling an incompatibility forever. A symbol rather than a
 * message match: the error crosses the wire from the daemon in one direction
 * and is raised locally in the other, and only one of those has a shape we own.
 */
const FATAL: unique symbol = Symbol("loom.fatalConnectionError");

const mkFatal = (e: ConnectionError): Error =>
  Object.assign(new Error(showConnectionError(e)), { [FATAL]: e });

const fatalOf = (err: unknown): ConnectionError | null => {
  if (typeof err !== "object" || err === null || !(FATAL in err)) return null;
  return (err as { [FATAL]: ConnectionError })[FATAL];
};

/** Does `err` carry the daemon's RPC error code `code`? (`#settle` copies the
 *  wire error's `code` / `data` onto the rejection it raises.) */
const isRpcCode = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** The daemon's own protocol version off a `protocol_mismatch` rejection.
 *  0 when it didn't say — rendered as "v0", still unmistakably a mismatch. */
const daemonVersionOf = (err: unknown): number => {
  const data = (err as { data?: unknown } | null)?.data;
  const v =
    typeof data === "object" && data !== null ? (data as { daemon?: unknown }).daemon : null;
  return typeof v === "number" ? v : 0;
};

/**
 * The client's view of daemon state. `idle` before {@link LoomClient.connect}
 * runs, `pending` while connecting or reconnecting, `data` for as long as a
 * snapshot is current, `error` when no amount of waiting will produce one.
 */
export type ClientState = Loadable<ConnectionError, DaemonSnapshot>;

const encoder = new TextEncoder();

/** Write every byte of `data`, looping on the partial writes `Deno.Conn`'s
 *  `write()` may return (its contract, like any `Deno.Writer`, is "at least
 *  one byte or an error," not "all of it"). */
const writeAll = async (conn: Deno.Conn, data: Uint8Array): Promise<void> => {
  let off = 0;
  while (off < data.length) {
    off += await conn.write(off === 0 ? data : data.subarray(off));
  }
};

/**
 * Thin client for the Loom daemon. Handles connect-or-spawn, the `hello`
 * handshake, request/response correlation, and — for long-lived uses like
 * `loom tail` — automatic reconnect with `sinceSeq` gap replay.
 */
export class LoomClient {
  readonly clientId: string;
  #opts: Required<ConnectOptions>;
  #sock: Deno.Conn | null = null;
  #readLoop: Promise<void> | null = null;
  #buf = "";
  #decoder = new TextDecoder();
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #pushListeners = new Set<PushListener>();
  #stateListeners = new Map<string, Set<StateListener>>();
  #lastSeq = 0;
  #closed = false;
  /**
   * A handshake failure no reconnect can fix, latched on first sight. While
   * set, the reconnect loop does not run and a dropped socket keeps the `error`
   * state rather than falling back to `pending` — the two builds cannot be made
   * to agree by waiting, so saying "reconnecting…" would be a lie.
   */
  #fatal: ConnectionError | null = null;
  /**
   * Bumped on every `#attach`. Every socket callback carries the generation it
   * was started under and no-ops when it no longer matches, so a read, a close
   * or a response from a socket the reconnect loop has already superseded
   * cannot touch current state. Lifecycle bookkeeping, not a wire revision.
   */
  #generation = 0;
  /**
   * Serializes writes on the current socket — `writeAll` can return after a
   * *partial* write, so two concurrent requests would interleave their halves
   * and corrupt both frames. Reset per socket in `#attach`, so a write queued
   * against a dead socket can't hold up the new one.
   */
  #writeChain: Promise<void> = Promise.resolve();
  #helloDone = false;
  #preHelloQueue: Array<PushFrame | StatePush> = [];
  /** The daemon epoch from the last hello — a change means it restarted. */
  #daemonEpoch: string | null = null;
  daemonInfo: HelloResult["daemon"] | null = null;

  #state: ClientState = loadableIdle;
  #snapshotListeners = new Set<SnapshotListener>();

  private constructor(opts: ConnectOptions) {
    this.clientId = opts.clientId ?? `cli-${Deno.pid}-${randomUUID().slice(0, 8)}`;
    this.#opts = {
      autospawn: true,
      reconnect: true,
      daemonEntry: "",
      clientId: this.clientId,
      ...opts,
    };
  }

  static async connect(opts: ConnectOptions): Promise<LoomClient> {
    const c = new LoomClient(opts);
    c.#setState(loadablePending);
    try {
      await c.#dial(opts.autospawn ?? true);
      await c.#handshake(undefined);
    } catch (err) {
      // `#handshake` already installed the precise error for a protocol
      // mismatch; anything else is the transport failing to come up at all.
      if (c.#state.tag !== "error") {
        c.#setState(
          loadableFailed({
            kind: "connect_failed",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      throw err;
    }
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
              // Tagged like the disconnect rejection below and for the same
              // reason: the daemon may have run this to completion, so a caller
              // that mutates state must not retry on it.
              if (this.#pending.delete(id))
                reject(
                  Object.assign(new Error(`request timed out: ${method}`), { code: "timeout" }),
                );
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
    this.#send(frame);
    return p as Promise<T>;
  }

  /** Queue one frame on the current socket's write chain. Fire-and-forget: a
   *  failure means the connection is dying, which the read loop is already
   *  about to discover and route through `#onSocketClose`. */
  #send(frame: RequestFrame): void {
    const sock = this.#sock;
    if (!sock) return;
    const bytes = encoder.encode(JSON.stringify(frame) + "\n");
    this.#writeChain = this.#writeChain.then(() =>
      this.#sock === sock ? writeAll(sock, bytes).catch(() => {}) : undefined,
    );
  }

  /** The current authoritative daemon state. */
  getState(): ClientState {
    return this.#state;
  }

  /**
   * Observe {@link getState}. Fires immediately with the current value, then on
   * every change. Returns an unsubscribe.
   */
  subscribe(fn: SnapshotListener): () => void {
    this.#snapshotListeners.add(fn);
    fn(this.#state);
    return () => this.#snapshotListeners.delete(fn);
  }

  #setState(next: ClientState): void {
    this.#state = next;
    for (const l of this.#snapshotListeners) {
      try {
        l(next);
      } catch {
        /* listener errors are their own problem */
      }
    }
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
    const sock = this.#sock;
    this.#sock = null;
    if (!sock) return;
    try {
      sock.close();
    } catch {
      // already gone
    }
    await this.#readLoop;
  }

  /**
   * Test hook: sever the transport without marking the client closed, so the
   * reconnect path (with `sinceSeq` gap replay) runs. Not for production use.
   */
  dropForTest(): void {
    try {
      this.#sock?.close();
    } catch {
      // already gone
    }
  }

  // -------------------------------------------------------------------------
  // connection management
  // -------------------------------------------------------------------------

  async #dial(autospawn: boolean): Promise<void> {
    try {
      this.#sock = await tryConnect(this.#opts.sockPath);
    } catch (err) {
      if (!autospawn || !isRetryableConnectError(err)) throw err;
      await this.#spawnDaemon();
      this.#sock = await this.#connectWithRetry();
    }
    this.#attach(this.#sock);
  }

  async #spawnDaemon(): Promise<void> {
    const entry = this.#opts.daemonEntry;
    if (!entry) throw new Error("LoomClient: autospawn needs `daemonEntry` (path to loomd)");
    // Re-invoking the running interpreter needs an explicit `run -A`: unlike
    // `node <file>`, bare `deno <file>` runs with no permissions by default.
    const child = spawn(Deno.execPath(), ["run", "-A", entry, "--repo", this.#opts.repoRoot], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  async #connectWithRetry(): Promise<Deno.Conn> {
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

  #attach(sock: Deno.Conn): void {
    // Fresh socket ⇒ fresh pre-hello buffer. A previous handshake that failed
    // (timeout, socket dropped again) would otherwise leave frames from the
    // dead connection here for the next successful `#handshake` to drain.
    this.#preHelloQueue = [];
    this.#buf = "";
    this.#decoder = new TextDecoder();
    this.#writeChain = Promise.resolve();
    this.#readLoop = this.#runReadLoop(sock, ++this.#generation);
  }

  async #runReadLoop(sock: Deno.Conn, gen: number): Promise<void> {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await sock.read(buf);
        if (n === null) break; // remote closed cleanly (EOF)
        // A read that lands after the reconnect loop moved on belongs to a
        // socket whose state has already been re-baselined — decoding it into
        // the live buffer would splice a dead connection's bytes into the new
        // one's frame stream.
        if (gen !== this.#generation) return;
        this.#ingest(sock, this.#decoder.decode(buf.subarray(0, n), { stream: true }));
      }
    } catch {
      // surfaced via close, same as the old socket 'error' no-op handler
    } finally {
      this.#onSocketClose(gen);
    }
  }

  #ingest(sock: Deno.Conn, chunk: string): void {
    this.#buf += chunk;
    // Symmetric with the daemon's `Connection.#ingest`: a frame (or a stream
    // with no newline) past the cap means a daemon bug or a corrupt stream —
    // drop the socket and let the reconnect path re-baseline rather than grow
    // the buffer without bound.
    if (this.#buf.length > MAX_FRAME_BYTES) {
      this.#buf = "";
      try {
        sock.close();
      } catch {
        // already gone
      }
      return;
    }
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
        // Bounded: a handshake that never completes must not let a chatty
        // daemon grow this without limit before the reconnect loop gives up.
        if (this.#preHelloQueue.length < 20_000) this.#preHelloQueue.push(frame);
        return;
      }
      this.#route(frame);
    }
    // "req" frames from the daemon are not part of the M1 protocol; ignore.
  }

  #route(frame: PushFrame | StatePush): void {
    // A snapshot lives outside the seq-stamped stream: no gap detection, no
    // replay, no merge — it simply replaces whatever we held.
    if (frame.type === "state") {
      this.#setState(loadableLoaded(frame.state));
      return;
    }
    this.#deliverPush(frame);
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
    // The daemon issues seqs strictly contiguously. A jump means a frame went
    // missing — an unparseable line dropped in `#ingest`, or a bug — and our
    // seq view now has a hole no future `sinceSeq` will ever fill. Re-baseline.
    if (frame.type !== "resync" && this.#lastSeq > 0 && frame.seq > this.#lastSeq + 1) {
      void this.#resync("seq gap");
      return;
    }
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

  /** Record a mismatch and raise it as terminal. Reconnecting cannot make two
   *  incompatible builds agree, so this is an `error` the UI surfaces rather
   *  than a `pending` spinner that never resolves. */
  #mismatch(daemonVersion: number): Error {
    const e: ConnectionError = {
      kind: "protocol_mismatch",
      daemon: daemonVersion,
      client: PROTOCOL_VERSION,
    };
    this.#fatal = e;
    this.#setState(loadableFailed(e));
    return mkFatal(e);
  }

  async #handshake(sinceSeq: number | undefined): Promise<void> {
    this.#helloDone = false;
    let result: HelloResult;
    try {
      result = await this.request<HelloResult>("hello", {
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
        ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      });
    } catch (err) {
      // The daemon refused our version outright. It reports its own in the
      // error's `data`; an older daemon that didn't send one leaves us saying
      // "unknown", which still reads as an incompatibility rather than a drop.
      if (!isRpcCode(err, "protocol_mismatch")) throw err;
      throw this.#mismatch(daemonVersionOf(err));
    }
    // The daemon rejects a mismatched request version, but a future lenient
    // daemon on a changed frame shape would slip through — check both ways.
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw this.#mismatch(result.protocolVersion);
    }
    // A different epoch across a reconnect ⇒ the daemon restarted: its seq and
    // in-memory version counters reset, so any replay it offered against our
    // stale sinceSeq is meaningless. Re-baseline and tell the app to resync.
    const restarted = this.#daemonEpoch !== null && this.#daemonEpoch !== result.daemon.epoch;
    this.#daemonEpoch = result.daemon.epoch;
    this.daemonInfo = result.daemon;
    if (restarted || sinceSeq === undefined || !result.replaying) {
      this.#lastSeq = result.seq;
    }
    this.#helloDone = true;
    const queued = this.#preHelloQueue;
    this.#preHelloQueue = [];
    // On a restart, drop any "replayed" frames from the old seq space.
    for (const f of queued) {
      if (restarted && f.type !== "state" && f.seq <= result.seq) continue;
      this.#route(f);
    }
    if (restarted) this.#fire("resync", { reason: "daemon restarted" });
  }

  #onSocketClose(gen: number): void {
    // A superseded socket closing is expected bookkeeping, not a disconnect:
    // firing the reconnect path again here would tear down the live socket the
    // reconnect loop just installed.
    if (gen !== this.#generation) return;
    this.#sock = null;
    // The daemon may still run an in-flight `session.create` / `session.compact`
    // to completion — the caller can't know. Tag the rejection so it can choose
    // to reconcile (poll, or wait for the next snapshot) rather than
    // treat it as a hard failure.
    for (const [, waiter] of this.#pending) {
      waiter.reject(
        Object.assign(
          new Error(
            "connection dropped before the daemon replied — the operation may have completed",
          ),
          { code: "disconnected" },
        ),
      );
    }
    this.#pending.clear();
    if (this.#fatal !== null) {
      // The `error` is already installed and is the truth; nothing about the
      // socket going away afterwards changes it.
      this.#fire("close");
      return;
    }
    if (this.#closed || !this.#opts.reconnect) {
      // A deliberate close is not a failure — nothing is being asked for any
      // more, so the state goes back to `idle`. A drop with reconnect off is,
      // since no snapshot will ever arrive.
      this.#setState(
        this.#closed
          ? loadableIdle
          : loadableFailed({ kind: "connect_failed", message: "connection dropped" }),
      );
      this.#fire("close");
      return;
    }
    // The snapshot we hold describes a daemon we are no longer talking to.
    this.#setState(loadablePending);
    this.#fire("disconnect");
    void this.#reconnectLoop();
  }

  async #reconnectLoop(): Promise<void> {
    let waitMs = 100;
    while (!this.#closed && this.#fatal === null) {
      try {
        // Try to connect first; only fork a daemon when nothing is listening
        // (mirrors #dial) — otherwise a briefly-unreachable daemon makes us
        // spawn a doomed loomd per iteration.
        let sock: Deno.Conn;
        try {
          sock = await tryConnect(this.#opts.sockPath);
        } catch (err) {
          if (!this.#opts.autospawn || !isRetryableConnectError(err)) throw err;
          await this.#spawnDaemon();
          sock = await this.#connectWithRetry();
        }
        this.#sock = sock;
        this.#attach(sock);
        await this.#handshake(this.#lastSeq);
        this.#fire("reconnect", { lastSeq: this.#lastSeq });
        return;
      } catch (err) {
        // A version incompatibility is not a transient failure. Retrying it
        // would leave the UI flickering between "reconnecting" and the real
        // error forever, and re-spawn a daemon it still cannot talk to.
        if (fatalOf(err)) return;
        // Full-ish jitter so a fleet of clients (TUI + `loom tail` + CLI) that
        // dropped together don't retry — and re-spawn a daemon — in lockstep.
        await delay(waitMs / 2 + Math.random() * (waitMs / 2));
        waitMs = Math.min(waitMs * 2, 4000);
      }
    }
  }

  async #resync(reason: string): Promise<void> {
    // The daemon says our seq is unrecoverable (buffer rolled, or it
    // restarted). Re-baseline from a fresh hello rather than carrying a stale
    // `#lastSeq` forward; the listener re-reads the transcript, which is the
    // only thing with a gap in it.
    try {
      const result = await this.request<HelloResult>("hello", {
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
      });
      this.daemonInfo = result.daemon;
      this.#daemonEpoch = result.daemon.epoch; // keep it fresh so the next handshake doesn't false-detect a restart
      // Monotonic: live frames delivered while this `hello` was in flight may
      // already have advanced `#lastSeq` past the fresh head — keeping the
      // higher value means the next reconnect's `sinceSeq` doesn't re-request
      // frames we already processed (there is no seq de-dupe on delivery).
      if (result.seq > this.#lastSeq) this.#lastSeq = result.seq;
      // The daemon pushes a fresh snapshot from its `hello` handler, so state
      // re-baselines itself — there is nothing to refetch here.
    } catch {
      /* the reconnect loop will try again */
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

/** `ENOENT` (nothing at the path) or `ECONNREFUSED` (a stale socket file, no
 *  one listening) — both mean "worth trying autospawn," unlike a permission
 *  error or anything else. */
const isRetryableConnectError = (err: unknown): boolean =>
  err instanceof Deno.errors.NotFound || err instanceof Deno.errors.ConnectionRefused;

const tryConnect = (sockPath: string): Promise<Deno.Conn> =>
  Deno.connect({ transport: "unix", path: sockPath });
