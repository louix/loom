import { ipcPermissions } from "@loom/core/network-permissions";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DaemonSnapshot,
  HelloResult,
  PushFrame,
  RequestFrame,
  ResponseFrame,
  StatePush,
} from "@loom/core/wire";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "@loom/core/wire";
import { isHelloResult, isPushFrame, isResponseFrame, isStatePush } from "@loom/core/wire-decode";
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
   * Absolute path to the `loomd` entry script, run with filesystem/process grants and access only to the daemon Unix socket
   * when `autospawn` fires. Required unless `autospawn` is false.
   */
  daemonEntry?: string;
  /** Spawn a daemon if none is listening. Default true. */
  autospawn?: boolean;
  /** Reconnect with a fresh snapshot if the connection drops. Default true. */
  reconnect?: boolean;
  clientId?: string;
  /**
   * How long each connection waits for the daemon's opening snapshot once the
   * handshake has succeeded, in ms. Default 10s. A test seam: a daemon that
   * deliberately never sends one shouldn't take the full production deadline
   * to prove it.
   */
  firstSnapshotMs?: number;
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

/**
 * The reply never came back, so whether the daemon ran the request is unknown
 * from here — a dropped connection and a timeout are the same fact. Nothing
 * that mutates a session may be retried on one of these.
 */
export const isAmbiguousFailure = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "disconnected" || code === "timeout";
};

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
 * One connection attempt: the socket, and everything whose lifetime is exactly
 * that socket's.
 *
 * The frame buffer, the decoder, the write chain and the pre-hello queue used
 * to be fields on the client, reset field by field whenever a socket was
 * installed — so every new one of them was a thing to remember to reset, and
 * forgetting spliced a dead connection's bytes into a live one's frame stream.
 * Here they are simply gone with the object.
 *
 * Late asynchronous work asks `client.#attempt === mine` rather than comparing
 * a counter to a field: one identity check, and the thing it identifies is the
 * thing that owns the state the work would touch.
 */
class Attempt {
  readonly sock: Deno.Conn;
  /** Resolves once the socket is gone and its pending work has been settled.
   *  The supervisor waits on this; nothing else decides what happens next. */
  readonly closed: Promise<void>;
  /** The read loop, so `close()` can await a clean stop. */
  readLoop: Promise<void> = Promise.resolve();
  buf = "";
  decoder = new TextDecoder();
  /**
   * Serializes writes on this socket — `writeAll` can return after a *partial*
   * write, so two concurrent requests would interleave their halves and
   * corrupt both frames. Per attempt, so a write queued against a dead socket
   * cannot hold up the next one.
   */
  writes: Promise<void> = Promise.resolve();
  helloDone = false;
  /** Pushes that arrived before `hello` returned, replayed in order once it
   *  did. Bounded: a handshake that never completes must not let a chatty
   *  daemon grow this without limit. */
  preHello: Array<PushFrame | StatePush> = [];
  #finish!: () => void;

  constructor(sock: Deno.Conn) {
    this.sock = sock;
    this.closed = new Promise<void>((resolve) => {
      this.#finish = resolve;
    });
  }

  /** Drop the socket. Idempotent — the read loop's `finally` reports the close
   *  exactly once regardless of who asked for it. */
  dispose(): void {
    try {
      this.sock.close();
    } catch {
      // already gone
    }
  }

  /** The socket is gone and its pending work is settled. */
  finish(): void {
    this.#finish();
  }
}

/**
 * Thin client for the Loom daemon. Handles connect-or-spawn, the `hello`
 * handshake, request/response correlation, and — for long-lived uses like
 * `loom tail` — automatic reconnect with a fresh fleet snapshot.
 */
export class LoomClient {
  readonly clientId: string;
  #opts: Required<ConnectOptions>;
  /**
   * The live connection attempt, or none. Exactly one exists at a time: the
   * supervisor disposes an attempt before opening another, and the identity of
   * this field is what every socket callback checks itself against.
   */
  #attempt: Attempt | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #pushListeners = new Set<PushListener>();
  #stateListeners = new Map<string, Set<StateListener>>();
  #closed = false;
  /**
   * A handshake failure no reconnect can fix, latched on first sight. While
   * set, the supervisor does not retry and a dropped socket keeps the `error`
   * state rather than falling back to `pending` — the two builds cannot be made
   * to agree by waiting, so saying "reconnecting…" would be a lie.
   */
  #fatal: ConnectionError | null = null;
  daemonInfo: HelloResult["daemon"] | null = null;
  /** Cuts a backoff sleep short when `close()` lands during one. */
  #wake: () => void = () => {};

  #state: ClientState = loadableIdle;
  #snapshotListeners = new Set<SnapshotListener>();

  private constructor(opts: ConnectOptions) {
    this.clientId = opts.clientId ?? `cli-${Deno.pid}-${randomUUID().slice(0, 8)}`;
    this.#opts = {
      autospawn: true,
      reconnect: true,
      daemonEntry: "",
      clientId: this.clientId,
      // The daemon subscribes and enqueues its opening snapshot in one
      // synchronous step *before* answering `hello`, so in the ordinary case
      // that frame is already buffered when the handshake returns. This only
      // bounds a daemon that answered and then sent nothing.
      firstSnapshotMs: 10_000,
      ...opts,
    };
  }

  static async connect(opts: ConnectOptions): Promise<LoomClient> {
    const c = new LoomClient(opts);
    c.#setState(loadablePending);
    let first: Attempt;
    try {
      // The same opening path a reconnect uses. The only difference is what
      // `connect()` does with a failure: it throws, where the supervisor backs
      // off and tries again.
      first = await c.#open();
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
    c.#supervise(first);
    return c;
  }

  /** Every connection becomes ready only after its authoritative snapshot. */
  async #awaitFirstSnapshot(attempt: Attempt): Promise<void> {
    if (this.#state.tag === "data") return;
    const ready = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => ready.reject(new Error("daemon completed the handshake but sent no state snapshot")),
      this.#opts.firstSnapshotMs,
    );
    const off = this.subscribe((state) => {
      if (state.tag === "data") ready.resolve();
      else if (state.tag === "error") ready.reject(new Error(showConnectionError(state.error)));
    });
    try {
      await Promise.race([
        ready.promise,
        attempt.closed.then(() => {
          throw new Error("connection dropped before the state snapshot");
        }),
      ]);
    } finally {
      clearTimeout(timer);
      off();
    }
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
    "session.send": 120_000, // A cold send includes provider/VM resume.
  };

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.#attempt) throw new Error("not connected");
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

  /**
   * Queue one frame on the current attempt's write chain. A failure means part
   * of a frame may be on the wire with no way to tell the daemon so: the frame
   * is never retried (a mutation would then run twice) and nothing more is
   * written onto a stream we know has lost bytes. Dropping the socket routes
   * the rest through `#onSocketClose`, which rejects everything outstanding as
   * `disconnected` — the "may have completed" answer, which is the truth here.
   */
  #send(frame: RequestFrame): void {
    const a = this.#attempt;
    if (!a) return;
    const bytes = encoder.encode(JSON.stringify(frame) + "\n");
    a.writes = a.writes.then(() =>
      this.#attempt === a ? writeAll(a.sock, bytes).catch(() => a.dispose()) : undefined,
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

  /** Events: "disconnect" (transport dropped), "reconnect" (fresh snapshot ready), "close". */
  on(event: "disconnect" | "reconnect" | "close", fn: StateListener): () => void {
    let set = this.#stateListeners.get(event);
    if (!set) {
      set = new Set();
      this.#stateListeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Closing while reconnecting has no socket to drop, so nothing else would
    // move the state off `pending` — leaving a client the caller has finished
    // with still saying "reconnecting…". A latched protocol mismatch is the
    // truth and outlives the close.
    if (this.#fatal === null) this.#setState(loadableIdle);
    // Cut a backoff sleep short; the supervisor then sees `#closed` and stops.
    // It is deliberately not awaited: it may be inside a dial that takes as
    // long as a spawned daemon takes to listen, and nobody waiting on `close()`
    // should wait for that. `#open` closes a socket handed back after this.
    this.#wake();
    const a = this.#attempt;
    if (!a) return;
    // Left installed on purpose: `#onSocketClose` is what rejects everything
    // still outstanding as `disconnected`, and a request in flight when the
    // caller closed us deserves that answer rather than its own timeout.
    a.dispose();
    await a.readLoop;
  }

  /**
   * Test hook: sever the transport without marking the client closed, so the
   * reconnect path fetches a fresh snapshot. Not for production use.
   */
  dropForTest(): void {
    this.#attempt?.dispose();
  }

  // -------------------------------------------------------------------------
  // connection management
  // -------------------------------------------------------------------------

  /**
   * Open one connection: dial (spawning a daemon if nothing is listening),
   * install the attempt, validate the handshake and await the fresh snapshot.
   * The same path serves the first connection and every reconnect.
   *
   * Every failure disposes what it built. Nothing partial is left installed for
   * the next attempt to inherit.
   */
  async #open(): Promise<Attempt> {
    let sock: Deno.Conn;
    try {
      sock = await tryConnect(this.#opts.sockPath);
    } catch (err) {
      if (!this.#opts.autospawn || !isRetryableConnectError(err)) throw err;
      sock = await this.#spawnDaemon();
    }
    // Dialling takes as long as it takes, and `close()` can land in the middle
    // of it. A socket handed back after that is not a connection — installing
    // it would reopen a client the caller has finished with.
    if (this.#closed || this.#fatal !== null) {
      try {
        sock.close();
      } catch {
        // already gone
      }
      throw new Error("client closed while connecting");
    }
    const a = new Attempt(sock);
    this.#setState(loadablePending);
    this.#attempt = a;
    a.readLoop = this.#runReadLoop(a);
    try {
      await this.#handshake(a);
      await this.#awaitFirstSnapshot(a);
    } catch (err) {
      // The socket may still be up (a mismatch is an answer, not a drop), and a
      // half-open attempt is exactly what the next one must not inherit.
      a.dispose();
      await a.readLoop;
      throw err;
    }
    // It dropped again while the handshake was in flight, so this connection is
    // already over — `#onSocketClose` has told the supervisor, and reporting
    // success here would announce one that no longer exists.
    if (this.#attempt !== a) throw new Error("connection dropped during the handshake");
    return a;
  }

  async #spawnDaemon(): Promise<Deno.Conn> {
    const entry = this.#opts.daemonEntry;
    if (!entry) throw new Error("LoomClient: autospawn needs `daemonEntry` (path to loomd)");
    const dir = dirname(this.#opts.sockPath);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "daemon-startup.log");
    // A file survives client exit without keeping a stderr pipe (or the client)
    // alive. Preserve failures that occur before the daemon's logger starts.
    const stderr = openSync(logPath, "w", 0o600);
    const child = (() => {
      try {
        return spawn(
          Deno.execPath(),
          [
            "run",
            "--cached-only",
            "--frozen",
            "--node-modules-dir=manual",
            ...ipcPermissions(this.#opts.sockPath),
            entry,
            "--repo",
            this.#opts.repoRoot,
          ],
          {
            detached: true,
            stdio: ["ignore", "ignore", stderr],
          },
        );
      } finally {
        closeSync(stderr);
      }
    })();
    let spawnError: Error | undefined;
    child.once("error", (err) => {
      spawnError = err;
    });
    child.unref();
    let waitMs = 25;
    for (let i = 0; i < 40; i++) {
      try {
        return await tryConnect(this.#opts.sockPath);
      } catch {
        if (spawnError) throw spawnError;
        // Exit 3 means another launcher won the daemon lock; keep dialing it.
        if ((child.exitCode !== null && child.exitCode !== 3) || child.signalCode !== null) {
          const detail = readFileSync(logPath, "utf8").trim();
          throw new Error(
            `daemon failed to start (${child.signalCode ?? `exit ${child.exitCode}`}):\n${detail}\nStartup log: ${logPath}`,
          );
        }
        await delay(waitMs);
        waitMs = Math.min(waitMs * 1.5, 500);
      }
    }
    throw new Error(`daemon did not come up on ${this.#opts.sockPath}; see ${logPath}`);
  }

  async #runReadLoop(a: Attempt): Promise<void> {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await a.sock.read(buf);
        if (n === null) break; // remote closed cleanly (EOF)
        // A read that lands after this attempt was superseded belongs to a
        // socket whose state has already been re-baselined — decoding it would
        // splice a dead connection's bytes into the live one's frame stream.
        if (this.#attempt !== a) return;
        this.#ingest(a, a.decoder.decode(buf.subarray(0, n), { stream: true }));
      }
    } catch {
      // surfaced via close, same as the old socket 'error' no-op handler
    } finally {
      this.#onSocketClose(a);
    }
  }

  #ingest(a: Attempt, chunk: string): void {
    a.buf += chunk;
    // Symmetric with the daemon's `Connection.#ingest`: a frame (or a stream
    // with no newline) past the cap means a daemon bug or a corrupt stream —
    // drop the socket and let the reconnect path re-baseline rather than grow
    // the buffer without bound.
    if (a.buf.length > MAX_FRAME_BYTES) {
      a.buf = "";
      a.dispose();
      return;
    }
    let nl: number;
    while ((nl = a.buf.indexOf("\n")) !== -1) {
      const line = a.buf.slice(0, nl).trim();
      a.buf = a.buf.slice(nl + 1);
      if (line === "") continue;
      // Also symmetric with the daemon: a line we cannot read, or one whose
      // shape we cannot route, is not a frame to skip past. The stream has
      // already lost something we would never learn about, so drop the socket
      // and re-baseline from a fresh snapshot instead of carrying on with a
      // hole in it.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        a.buf = "";
        a.dispose();
        return;
      }
      if (!this.#onFrame(a, parsed)) {
        a.buf = "";
        a.dispose();
        return;
      }
    }
  }

  /** False when the frame is one this client cannot account for — an unknown
   *  discriminant, an unaddressable response, or a malformed snapshot. The
   *  daemon never sends `req` frames, so one of those counts too. */
  #onFrame(a: Attempt, frame: unknown): boolean {
    if (isResponseFrame(frame)) {
      this.#settle(frame);
      return true;
    }
    if (isStatePush(frame) || isPushFrame(frame)) {
      if (!a.helloDone) {
        // Bounded: a handshake that never completes must not let a chatty
        // daemon grow this without limit before the reconnect loop gives up.
        if (a.preHello.length >= 20_000) return false;
        a.preHello.push(frame);
        return true;
      }
      this.#route(frame);
      return true;
    }
    return false;
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

  async #handshake(a: Attempt): Promise<void> {
    a.helloDone = false;
    let raw: unknown;
    try {
      raw = await this.request<unknown>("hello", {
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
      });
    } catch (err) {
      // The daemon refused our version outright. It reports its own in the
      // error's `data`; an older daemon that didn't send one leaves us saying
      // "unknown", which still reads as an incompatibility rather than a drop.
      if (!isRpcCode(err, "protocol_mismatch")) throw err;
      throw this.#mismatch(daemonVersionOf(err));
    }
    // A well-formed hello reporting a version we can't speak is a mismatch,
    // handled below. A hello whose *shape* is wrong is not that — we cannot
    // even read which version it claims, so it's a transport failure the
    // reconnect loop may retry.
    if (!isHelloResult(raw)) throw new Error("daemon sent a malformed hello result");
    const result: HelloResult = raw;
    // The daemon rejects a mismatched request version, but a future lenient
    // daemon on a changed frame shape would slip through — check both ways.
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw this.#mismatch(result.protocolVersion);
    }
    this.daemonInfo = result.daemon;
    a.helloDone = true;
    const queued = a.preHello;
    a.preHello = [];
    for (const frame of queued) this.#route(frame);
  }

  /**
   * The socket for `a` is gone. This *reports*; it does not decide. Deciding
   * what happens next — reconnect, give up, or nothing because the caller
   * closed us — belongs to the supervisor, and a close that started its own
   * reconnect is what let a drop during a handshake run two openings at once.
   */
  #onSocketClose(a: Attempt): void {
    // A superseded socket closing is expected bookkeeping, not a disconnect.
    if (this.#attempt !== a) {
      a.finish();
      return;
    }
    this.#attempt = null;
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
    a.finish();
  }

  /**
   * The connection's whole life after the first one is up: wait for the live
   * attempt to close, say what that means, and — if anything is still to be
   * gained by it — open another. Exactly one of these runs per client, so
   * there is one place that opens a connection and one place that decides to.
   */
  #supervise(first: Attempt): void {
    void this.#run(first).catch(() => {
      // Every failure inside is already reflected in the state; a rejected
      // supervisor would only surface as an unhandled rejection.
    });
  }

  async #run(first: Attempt): Promise<void> {
    let attempt: Attempt | null = first;
    for (;;) {
      await attempt.closed;
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

      attempt = null;
      let waitMs = 100;
      while (attempt === null) {
        if (this.#closed || this.#fatal !== null) return;
        try {
          attempt = await this.#open();
        } catch (err) {
          // A version incompatibility is not a transient failure. Retrying it
          // would leave the UI flickering between "reconnecting" and the real
          // error forever, and re-spawn a daemon it still cannot talk to.
          if (fatalOf(err)) return;
          if (this.#closed) return;
          // Full-ish jitter so a fleet of clients (TUI + `loom tail` + CLI)
          // that dropped together don't retry — and re-spawn a daemon — in
          // lockstep.
          await this.#backoff(waitMs);
          waitMs = Math.min(waitMs * 2, 4000);
        }
      }
      this.#fire("reconnect");
    }
  }

  /** Sleep, unless `close()` lands first — a client the caller has finished
   *  with must not hold the process up for the rest of a 4-second backoff. */
  #backoff(waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          this.#wake = () => {};
          resolve();
        },
        waitMs / 2 + Math.random() * (waitMs / 2),
      );
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = () => {};
        resolve();
      };
    });
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
