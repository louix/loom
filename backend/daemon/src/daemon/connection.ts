import { makeLogger } from "@loom/core/logger";
import {
  MAX_FRAME_BYTES,
  type Frame,
  type PushFrame,
  type ResponseFrame,
  type StatePush,
} from "@loom/core/wire";

const log = makeLogger("conn");

/**
 * The minimal `Deno.Conn` surface `Connection` needs — narrow on purpose so
 * tests can fake it without a real unix socket. `Deno.Conn` satisfies this
 * structurally.
 */
export interface FramedConn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

/**
 * Ceiling on a connection's unwritten backlog. A client that stops reading
 * its socket (suspended laptop, SIGSTOP'd TUI, a frontend wedged in a render
 * loop) leaves `write()` calls unresolved without bound — each one waits on
 * kernel socket-buffer space that never frees. Past this we drop the
 * connection — it can reconnect and gap-replay from the ring buffer.
 */
const PUSH_BACKLOG_LIMIT_BYTES = 8 * 1024 * 1024;

/** Write every byte of `data`, looping on the partial writes `Deno.Conn`'s
 *  `write()` may return (its contract, like any `Deno.Writer`, is "at least
 *  one byte or an error," not "all of it"). */
const writeAll = async (conn: FramedConn, data: Uint8Array): Promise<void> => {
  let off = 0;
  while (off < data.length) {
    off += await conn.write(off === 0 ? data : data.subarray(off));
  }
};

let nextConnId = 1;

/**
 * One client connection. Owns newline-delimited JSON framing in both
 * directions and a per-connection push subscription flag.
 */
export class Connection {
  readonly id: number = nextConnId++;
  readonly conn: FramedConn;

  /** Set once the client completes the `hello` handshake. */
  clientId: string | null = null;
  /** True while this connection wants the server -> client push stream. */
  subscribed = false;

  #buf = "";
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #onFrame: (frame: Frame, conn: Connection) => void;
  #onClose: (conn: Connection) => void;
  #closed = false;
  /** Bytes queued or handed to `write()` but not yet written — the Deno-side
   *  analogue of Node's `socket.writableLength`. */
  #backlogBytes = 0;
  /**
   * Serializes writes on this socket. `writeAll` can return after a *partial*
   * write, so two concurrent calls would interleave their halves and corrupt
   * both frames on the wire. Every frame chains on the previous one, which is
   * also what makes `#backlogBytes` mean "not yet on the socket".
   */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(
    conn: FramedConn,
    onFrame: (frame: Frame, conn: Connection) => void,
    onClose: (conn: Connection) => void,
  ) {
    this.conn = conn;
    this.#onFrame = onFrame;
    this.#onClose = onClose;
    void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await this.conn.read(buf);
        if (n === null) break; // remote closed cleanly (EOF)
        this.#ingest(this.#decoder.decode(buf.subarray(0, n), { stream: true }));
      }
    } catch (err) {
      log.debug("socket error", { conn: this.id, err: String(err) });
    } finally {
      this.#handleClose();
    }
  }

  #ingest(chunk: string): void {
    this.#buf += chunk;
    if (this.#buf.length > MAX_FRAME_BYTES) {
      log.warn("frame too large, dropping connection", { conn: this.id });
      this.close();
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
        log.warn("unparseable frame", { conn: this.id });
        continue;
      }
      try {
        this.#onFrame(frame, this);
      } catch (err) {
        log.error("frame handler threw", { conn: this.id, err: String(err) });
      }
    }
  }

  #write(obj: Frame): void {
    if (this.#closed) return;
    const bytes = this.#encoder.encode(JSON.stringify(obj) + "\n");
    this.#backlogBytes += bytes.length;
    // The `catch` before the `finally` keeps the chain resolved, so one failed
    // frame doesn't reject every frame queued behind it.
    this.#writeChain = this.#writeChain
      .then(() => (this.#closed ? undefined : writeAll(this.conn, bytes)))
      .catch((err: unknown) => {
        // A failed write means this connection has already lost bytes: whatever
        // the client has is a prefix of the truth and nothing will tell it so.
        // Drop the socket rather than keep pushing onto a stream we know is
        // broken — the client reconnects and re-baselines from a fresh snapshot.
        log.debug("write failed, dropping connection", { conn: this.id, err: String(err) });
        this.close();
      })
      .finally(() => {
        this.#backlogBytes -= bytes.length;
      });
  }

  respond(frame: ResponseFrame): void {
    this.#write(frame);
  }

  /**
   * A complete state snapshot. Unlike {@link push} this is not subject to the
   * backlog ceiling — a client behind on state is exactly the client that needs
   * the current snapshot, and each one supersedes the last, so the queue can
   * never grow past the frames already counted against `#backlogBytes`.
   */
  pushState(frame: StatePush): void {
    if (!this.subscribed || this.#closed) return;
    this.#write(frame);
  }

  push(frame: PushFrame): void {
    if (!this.subscribed || this.#closed) return;
    if (this.#backlogBytes > PUSH_BACKLOG_LIMIT_BYTES) {
      log.warn("client not draining its socket — dropping connection", {
        conn: this.id,
        backlog: this.#backlogBytes,
      });
      this.close();
      return;
    }
    this.#write(frame);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.conn.close();
    } catch {
      // already gone
    }
  }

  #handleClose(): void {
    if (this.#closed) {
      this.#onClose(this);
      return;
    }
    this.#closed = true;
    this.#onClose(this);
  }
}
