/** Bound connections before opening the guest-to-host socket bridge. */
export const startGuestRelay = (listener: Deno.Listener, socket: string, maxConnections = 32) => {
  if (!Number.isInteger(maxConnections) || maxConnections < 1)
    throw new Error("Relay connection limit must be a positive integer");
  const clients = new Set<Deno.Conn>();
  const tasks = new Set<Promise<void>>();
  let stopped = false;
  const close = (conn: Deno.Conn) => {
    try {
      conn.close();
    } catch {
      /* Already closed. */
    }
  };
  const relay = async (client: Deno.Conn) => {
    let host: Deno.Conn | undefined;
    const controller = new AbortController();
    let pipes: Promise<void>[] = [];
    try {
      host = await Deno.connect({ transport: "unix", path: socket });
      if (stopped) return;
      pipes = [
        client.readable.pipeTo(host.writable, {
          preventClose: true,
          signal: controller.signal,
        }),
        host.readable.pipeTo(client.writable, {
          preventClose: true,
          signal: controller.signal,
        }),
      ];
      await Promise.race(pipes);
    } catch {
      /* Endpoint closed or unavailable. */
    } finally {
      controller.abort();
      close(client);
      if (host) close(host);
      await Promise.allSettled(pipes);
      clients.delete(client);
    }
  };
  const serving = (async () => {
    try {
      while (!stopped) {
        // Leave excess clients in the listener backlog instead of creating
        // vsock connections that the host egress limit immediately rejects.
        if (tasks.size >= maxConnections) await Promise.race(tasks);
        if (stopped) break;
        const client = await listener.accept();
        clients.add(client);
        const task = relay(client);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } catch (error) {
      if (!stopped) throw error;
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    finished: serving,
    close: () =>
      (closing ??= (async () => {
        stopped = true;
        listener.close();
        for (const client of clients) close(client);
        await serving;
        await Promise.allSettled(tasks);
      })()),
  };
};
