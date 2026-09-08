/** Fixed loopback MCP capability. No guest-selected host, port, or DNS input. */
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";
export interface McpRelay {
  port: number;
  guestPort: number;
}
export const startMcpRelay = (path: string, port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP port");
  const listener = Deno.listen({ transport: "unix", path });
  const active = new Map<Deno.Conn, () => void>();
  const tasks = new Set<Promise<void>>();
  const close = (c: Deno.Conn) => {
    try {
      c.close();
    } catch {
      /*closed*/
    }
  };
  const serve = async (client: Deno.Conn) => {
    const abort = new AbortController();
    const upstream = createConnection({ host: "127.0.0.1", port, signal: abort.signal });
    const stop = () => {
      abort.abort();
      upstream.destroy();
      close(client);
    };
    active.set(client, stop);
    const timer = setTimeout(stop, 10_000);
    try {
      await new Promise<void>((resolve, reject) => {
        upstream.once("connect", resolve);
        upstream.once("error", reject);
      });
      clearTimeout(timer);
      await Promise.race([
        client.readable.pipeTo(Writable.toWeb(upstream) as WritableStream<Uint8Array>, {
          preventClose: true,
          signal: abort.signal,
        }),
        (Readable.toWeb(upstream) as ReadableStream<Uint8Array>).pipeTo(client.writable, {
          preventClose: true,
          signal: abort.signal,
        }),
      ]);
    } catch {
      /*capability or peer closed*/
    } finally {
      clearTimeout(timer);
      stop();
      active.delete(client);
    }
  };
  const serving = (async () => {
    try {
      for await (const client of listener) {
        if (active.size >= 32) {
          close(client);
          continue;
        }
        const task = serve(client);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        listener.close();
        for (const stop of active.values()) stop();
        await serving;
        await Promise.allSettled(tasks);
      })()),
  };
};
