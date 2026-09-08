/** HTTPS CONNECT capability: the guest supplies no IP addresses or DNS settings. */
export const startEgress = (socket: string, report: (host: string, allowed: boolean) => void) => {
  const listener = Deno.listen({ transport: "unix", path: socket });
  const active = new Set<Deno.Conn>();
  const tasks = new Set<Promise<void>>();
  const close = (conn: Deno.Conn) => {
    active.delete(conn);
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
  const serve = async (client: Deno.Conn) => {
    let upstream: Deno.Conn | undefined;
    const timer = setTimeout(() => close(client), 10_000);
    try {
      const buffer = new Uint8Array(8192);
      let size = 0,
        end = -1;
      while (end < 0 && size < buffer.length) {
        const n = await client.read(buffer.subarray(size));
        if (n === null) return;
        size += n;
        end = new TextDecoder().decode(buffer.subarray(0, size)).indexOf("\r\n\r\n");
      }
      const header = new TextDecoder().decode(buffer.subarray(0, size));
      const authority = /^CONNECT ([^\s]+) HTTP\/1\.[01]\r\n/.exec(header)?.[1];
      const allowed = end >= 0 && authority === "api.anthropic.com:443";
      // Log only a bounded authority, never headers, credentials or payloads.
      report(
        (authority ?? "invalid CONNECT").replace(/[^a-zA-Z0-9.:[\]-]/g, "?").slice(0, 200),
        allowed,
      );
      if (!allowed) {
        await write(client, encoder.encode("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
        return;
      }
      upstream = await Deno.connect({ hostname: "api.anthropic.com", port: 443 });
      active.add(upstream);
      clearTimeout(timer);
      await write(client, encoder.encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
      if (size > end + 4) await write(upstream, buffer.subarray(end + 4, size));
      await Promise.race([
        client.readable.pipeTo(upstream.writable, { preventClose: true }),
        upstream.readable.pipeTo(client.writable, { preventClose: true }),
      ]);
    } catch {
      /* Peer closure or unavailable allowed API. */
    } finally {
      clearTimeout(timer);
      close(client);
      if (upstream) close(upstream);
    }
  };
  const serving = (async () => {
    try {
      for await (const client of listener) {
        if (active.size >= 64) {
          close(client);
          continue;
        }
        active.add(client);
        const task = serve(client);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.BadResource)) throw e;
    }
  })();
  return {
    close: async () => {
      listener.close();
      for (const conn of active) close(conn);
      await serving;
      await Promise.allSettled(tasks);
    },
  };
};
