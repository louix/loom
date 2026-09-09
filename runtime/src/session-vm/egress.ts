/** HTTPS CONNECT capability: the guest supplies no IP addresses or DNS settings. */
import { normalizeExtraHosts } from "./network-policy.ts";
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";

interface Tunnel {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}
// Aborting destroys the socket, including while DNS lookup/connect is pending.
const dialHost = (signal: AbortSignal, host: string): Promise<Tunnel> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 443, signal });
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
        writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
        close: () => socket.destroy(),
      }),
    );
  });
export const startEgress = (
  socket: string,
  report: (host: string, allowed: boolean) => void,
  options: {
    extraAllowedHosts?: string[];
    providerHosts?: string[];
    timeoutMs?: number;
    maxConnections?: number;
    dial?: (signal: AbortSignal, host: string) => Promise<Tunnel>;
  } = {},
) => {
  const permitted = new Set(
    [
      ...normalizeExtraHosts(options.providerHosts ?? ["api.anthropic.com"]),
      ...normalizeExtraHosts(options.extraAllowedHosts),
    ].map((host) => `${host}:443`),
  );
  const listener = Deno.listen({ transport: "unix", path: socket });
  const active = new Map<Deno.Conn, AbortController>();
  const tasks = new Set<Promise<void>>();
  const close = (conn: Deno.Conn) => {
    try {
      conn.close();
    } catch {
      /* closed */
    }
  };
  const write = async (conn: Deno.Conn, bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
  };
  const encoder = new TextEncoder();
  const serve = async (client: Deno.Conn, controller: AbortController) => {
    let upstream: Tunnel | undefined;
    const abort = () => {
      controller.abort();
      close(client);
      upstream?.close();
    };
    const timer = setTimeout(abort, options.timeoutMs ?? 10_000);
    try {
      const buffer = new Uint8Array(8192);
      let size = 0,
        end = -1;
      while (end < 0 && size < buffer.length) {
        const n = await client.read(buffer.subarray(size));
        if (n === null) return;
        size += n;
        // HTTP CONNECT headers are ASCII; offsets must refer to bytes, not UTF-16.
        for (let i = 0; i + 3 < size; i++)
          if (
            buffer[i] === 13 &&
            buffer[i + 1] === 10 &&
            buffer[i + 2] === 13 &&
            buffer[i + 3] === 10
          ) {
            end = i;
            break;
          }
      }
      const header = new TextDecoder().decode(buffer.subarray(0, end < 0 ? size : end + 4));
      const authority = /^CONNECT ([^\s]+) HTTP\/1\.[01]\r\n/.exec(header)?.[1]?.toLowerCase();
      const allowed = end >= 0 && authority !== undefined && permitted.has(authority);
      report(
        (authority ?? "invalid CONNECT").replace(/[^a-zA-Z0-9.:[\]-]/g, "?").slice(0, 200),
        allowed,
      );
      if (!allowed) {
        await write(client, encoder.encode("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
        return;
      }
      upstream = await (options.dial ?? dialHost)(controller.signal, authority!.slice(0, -4));
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      await write(client, encoder.encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
      if (size > end + 4) {
        const writer = upstream.writable.getWriter();
        try {
          await writer.write(buffer.subarray(end + 4, size));
        } finally {
          writer.releaseLock();
        }
      }
      await Promise.race([
        client.readable.pipeTo(upstream.writable, {
          preventClose: true,
          signal: controller.signal,
        }),
        upstream.readable.pipeTo(client.writable, {
          preventClose: true,
          signal: controller.signal,
        }),
      ]);
    } catch {
      /* Peer closure, cancellation or unavailable API. */
    } finally {
      clearTimeout(timer);
      abort();
      active.delete(client);
    }
  };
  const serving = (async () => {
    try {
      for await (const client of listener) {
        if (active.size >= (options.maxConnections ?? 32)) {
          close(client);
          continue;
        }
        const controller = new AbortController();
        active.set(client, controller);
        const task = serve(client, controller);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.BadResource)) throw e;
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        listener.close();
        for (const [client, controller] of active) {
          controller.abort();
          close(client);
        }
        await serving;
        await Promise.allSettled(tasks);
      })()),
  };
};
