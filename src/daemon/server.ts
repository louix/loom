import { connect, createServer, type Server } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { makeLogger } from "@loom/core/logger";
import type { Frame, PushFrame } from "@loom/core/wire";
import { Connection } from "./connection.ts";
import type { RpcDispatcher } from "./rpc.ts";

const log = makeLogger("server");

export interface SocketServerOptions {
  sockPath: string;
  dispatcher: RpcDispatcher;
  /** Called whenever the count of push-subscribed clients changes. */
  onClientCountChange?: (count: number) => void;
}

/**
 * The daemon's Unix-domain-socket front door. Accepts many concurrent client
 * connections, routes `req` frames through the dispatcher, and fans `push`
 * frames out to every subscribed connection.
 */
export class SocketServer {
  #opts: SocketServerOptions;
  #server: Server | null = null;
  #conns = new Set<Connection>();

  constructor(opts: SocketServerOptions) {
    this.#opts = opts;
  }

  async listen(): Promise<void> {
    const { sockPath } = this.#opts;
    // A leftover socket file is either stale (unclean exit) or a live daemon.
    // Probe before removing it so two daemons never race for the same repo.
    if (existsSync(sockPath)) {
      if (await isSocketLive(sockPath)) {
        throw Object.assign(new Error(`another daemon is listening on ${sockPath}`), {
          code: "EADDRINUSE",
        });
      }
      try {
        unlinkSync(sockPath);
      } catch {
        // fall through — listen() will report the real problem
      }
    }

    const server = createServer((socket) => {
      const conn = new Connection(
        socket,
        (frame, c) => this.#onFrame(frame, c),
        (c) => this.#onClose(c),
      );
      this.#conns.add(conn);
      log.debug("client connected", { conn: conn.id, total: this.#conns.size });
    });
    this.#server = server;

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.removeListener("error", reject);
        try {
          chmodSync(sockPath, 0o600);
        } catch {
          // non-fatal; directory perms already constrain access
        }
        log.info("listening", { sock: sockPath });
        resolve();
      });
    });
  }

  #onFrame(frame: Frame, conn: Connection): void {
    if (frame.kind !== "req") return; // clients only send requests
    void this.#opts.dispatcher.handle(frame, { conn }).then((res) => conn.respond(res));
  }

  #onClose(conn: Connection): void {
    const wasSubscribed = conn.subscribed;
    this.#conns.delete(conn);
    log.debug("client disconnected", { conn: conn.id, total: this.#conns.size });
    if (wasSubscribed) this.#emitClientCount();
  }

  /** Mark a connection as wanting the push stream and report the new count. */
  subscribe(conn: Connection): void {
    if (conn.subscribed) return;
    conn.subscribed = true;
    this.#emitClientCount();
  }

  broadcast(frame: PushFrame): void {
    for (const conn of this.#conns) conn.push(frame);
  }

  /** Push-subscribed client count. */
  get clientCount(): number {
    let n = 0;
    for (const c of this.#conns) if (c.subscribed) n++;
    return n;
  }

  get connectionCount(): number {
    return this.#conns.size;
  }

  #emitClientCount(): void {
    this.#opts.onClientCountChange?.(this.clientCount);
  }

  async close(): Promise<void> {
    for (const conn of this.#conns) conn.close();
    this.#conns.clear();
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = null;
    const { sockPath } = this.#opts;
    if (existsSync(sockPath)) {
      try {
        unlinkSync(sockPath);
      } catch {
        // best effort
      }
    }
  }
}

/** Does something actually accept connections on this socket path right now? */
function isSocketLive(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(sockPath);
    const done = (live: boolean) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}
