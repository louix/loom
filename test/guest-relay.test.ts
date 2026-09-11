import assert from "node:assert/strict";
import { startGuestRelay } from "../runtime/src/session-vm/guest-relay.ts";

Deno.test("guest relay queues bursts before dialing the bridge and releases slots on either EOF", async () => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const socket = `${state}/bridge.sock`;
  const bridge = Deno.listen({ transport: "unix", path: socket });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const relay = startGuestRelay(listener, socket, 4);
  const clients: Deno.Conn[] = [];
  const peers: Deno.Conn[] = [];
  let accepted = 0;
  let changed = Promise.withResolvers<void>();
  const accepting = (async () => {
    try {
      for await (const peer of bridge) {
        peers.push(peer);
        accepted++;
        changed.resolve();
        changed = Promise.withResolvers<void>();
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("Relay burst stalled")), 10_000);
  });
  const until = async (count: number) => {
    while (accepted < count) await Promise.race([changed.promise, expired]);
  };
  try {
    // All clients connect before any bridge peer is allowed to finish.
    for (let i = 0; i < 64; i++)
      clients.push(await Deno.connect({ hostname: "127.0.0.1", port: listener.addr.port }));
    await until(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(accepted, 4, "queued clients must not open bridge sockets");
    for (let i = 0; i < clients.length; i++) {
      await until(i + 1);
      // Verify bidirectional forwarding even after reusing connection slots.
      await clients[i]!.write(new Uint8Array([42]));
      const bytes = new Uint8Array(1);
      assert.equal(await peers[i]!.read(bytes), 1);
      assert.equal(bytes[0], 42);
      await peers[i]!.write(new Uint8Array([43]));
      assert.equal(await clients[i]!.read(bytes), 1);
      assert.equal(bytes[0], 43);
      if (i % 2 === 0) {
        clients[i]!.close();
        assert.equal(await peers[i]!.read(bytes), null);
      } else {
        peers[i]!.close();
        assert.equal(await clients[i]!.read(bytes), null);
      }
    }
    assert.equal(accepted, clients.length);
  } finally {
    clearTimeout(deadline);
    await relay.close();
    await relay.close();
    bridge.close();
    await accepting;
    for (const conn of [...clients, ...peers]) {
      try {
        conn.close();
      } catch {
        /* Already closed. */
      }
    }
    await Deno.remove(state, { recursive: true });
  }
});
