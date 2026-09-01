import type { Socket } from "node:net";
import { makeLogger } from "@loom/core/logger";
import { MAX_FRAME_BYTES, type Frame, type PushFrame, type ResponseFrame } from "@loom/core/wire";

const log = makeLogger("conn");

/**
 * Ceiling on a connection's unflushed write buffer. A client that stops reading
 * its socket (suspended laptop, SIGSTOP'd TUI, a frontend wedged in a render
 * loop) lets Node queue push frames in memory without bound. Past this we drop
 * the connection — it can reconnect and gap-replay from the ring buffer.
 */
const PUSH_BACKLOG_LIMIT_BYTES = 8 * 1024 * 1024;

let nextConnId = 1;

/**
 * One client connection. Owns newline-delimited JSON framing in both
 * directions and a per-connection push subscription flag.
 */
export class Connection {
  readonly id: number = nextConnId++;
  readonly socket: Socket;

  /** Set once the client completes the `hello` handshake. */
  clientId: string | null = null;
  /** True while this connection wants the server -> client push stream. */
  subscribed = false;

  #buf = "";
  #onFrame: (frame: Frame, conn: Connection) => void;
  #onClose: (conn: Connection) => void;
  #closed = false;

  constructor(
    socket: Socket,
    onFrame: (frame: Frame, conn: Connection) => void,
    onClose: (conn: Connection) => void,
  ) {
    this.socket = socket;
    this.#onFrame = onFrame;
    this.#onClose = onClose;

    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#ingest(chunk));
    socket.on("error", (err) => log.debug("socket error", { conn: this.id, err: String(err) }));
    socket.on("close", () => this.#handleClose());
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
    try {
      this.socket.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      log.debug("write failed", { conn: this.id, err: String(err) });
    }
  }

  respond(frame: ResponseFrame): void {
    this.#write(frame);
  }

  push(frame: PushFrame): void {
    if (!this.subscribed || this.#closed) return;
    // A client that isn't draining its socket backs frames up in Node's write
    // buffer with no cap. Drop it once that crosses the ceiling — reconnect +
    // `sinceSeq` replay recovers whatever it missed.
    if (this.socket.writableLength > PUSH_BACKLOG_LIMIT_BYTES) {
      log.warn("client not draining its socket — dropping connection", {
        conn: this.id,
        backlog: this.socket.writableLength,
      });
      this.close();
      return;
    }
    this.#write(frame);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.end();
    this.socket.destroy();
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
