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
  #listener: Deno.UnixListener | null = null;
  #acceptLoop: Promise<void> | null = null;
  #conns = new Set<Connection>();

  constructor(opts: SocketServerOptions) {
    this.#opts = opts;
  }

  async listen(): Promise<void> {
    const { sockPath } = this.#opts;

    // Bind first, then react to `AddrInUse` — no `exists` → `probe` → `unlink`
    // → `bind` window where a second daemon can unlink/rebind over the first.
    let listener: Deno.UnixListener;
    try {
      listener = Deno.listen({ transport: "unix", path: sockPath });
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
      // Something holds the path. A live daemon → bail; a stale socket file from
      // an unclean exit → clear it and try once more.
      if (existsSync(sockPath) && (await isSocketLive(sockPath))) {
        throw Object.assign(new Error(`another daemon is listening on ${sockPath}`), {
          code: "EADDRINUSE",
        });
      }
      try {
        unlinkSync(sockPath);
      } catch {
        // fall through — the retry will report the real problem
      }
      listener = Deno.listen({ transport: "unix", path: sockPath });
    }
    this.#listener = listener;

    this.#acceptLoop = (async () => {
      try {
        for await (const conn of listener) {
          const c = new Connection(
            conn,
            (frame, cc) => this.#onFrame(frame, cc),
            (cc) => this.#onClose(cc),
          );
          this.#conns.add(c);
          log.debug("client connected", { conn: c.id, total: this.#conns.size });
        }
      } catch (err) {
        // The loop only throws on a genuine accept-time failure (EMFILE/ENFILE
        // under fd pressure, say); `listener.close()` ends it cleanly instead.
        // A crashed accept loop is a dead daemon, so log loudly but don't throw
        // into an unhandled rejection.
        log.error("accept loop failed", { err: String(err) });
      }
    })();

    try {
      chmodSync(sockPath, 0o600);
    } catch {
      // non-fatal; directory perms already constrain access
    }
    log.info("listening", { sock: sockPath });
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
    const listener = this.#listener;
    if (!listener) return;
    listener.close();
    await this.#acceptLoop;
    this.#listener = null;
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
const isSocketLive = (sockPath: string): Promise<boolean> => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (live: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(live);
    };
    Deno.connect({ transport: "unix", path: sockPath }).then(
      (conn) => {
        conn.close();
        done(true);
      },
      () => done(false),
    );
    setTimeout(() => done(false), 500).unref();
  });
};
