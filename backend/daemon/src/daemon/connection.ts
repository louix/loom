import type { Socket } from "node:net";
import { makeLogger } from "@loom/core/logger";
import type { Frame, PushFrame, ResponseFrame } from "@loom/core/wire";

const log = makeLogger("conn");

/** Reject any single frame larger than this (bytes) to bound memory. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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
    if (!this.subscribed) return;
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
