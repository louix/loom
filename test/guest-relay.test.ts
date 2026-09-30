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

Deno.test("guest relay survives transient accept failures and forwards later connections", async () => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const socket = state + "/bridge.sock";
  const bridge = Deno.listen({ transport: "unix", path: socket });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const accept = listener.accept.bind(listener);
  const failures = [
    new Deno.errors.NotConnected("Transport endpoint is not connected"),
    new Deno.errors.ConnectionAborted(),
    new Deno.errors.ConnectionReset(),
    new Deno.errors.Interrupted(),
  ];
  let injected = 0;
  listener.accept = () => {
    const error = failures[injected++];
    return error ? Promise.reject(error) : accept();
  };
  const relay = startGuestRelay(listener, socket);
  const failed = relay.finished.then(() => {
    throw new Error("Relay stopped unexpectedly");
  });
  // Observe a rejection even while connecting or cleaning up.
  void failed.catch(() => {});
  let client: Deno.Conn | undefined;
  let peer: Deno.Conn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Relay did not recover")), 5000);
  });
  try {
    client = await Deno.connect({ hostname: "127.0.0.1", port: listener.addr.port });
    peer = await Promise.race([bridge.accept(), failed, expired]);
    assert(injected >= failures.length);
    await client.write(new Uint8Array([42]));
    const bytes = new Uint8Array(1);
    assert.equal(await Promise.race([peer.read(bytes), failed, expired]), 1);
    assert.equal(bytes[0], 42);
    await peer.write(new Uint8Array([43]));
    assert.equal(await Promise.race([client.read(bytes), failed, expired]), 1);
    assert.equal(bytes[0], 43);
  } finally {
    clearTimeout(timer);
    await relay.close();
    client?.close();
    peer?.close();
    bridge.close();
    await Deno.remove(state, { recursive: true });
  }
});

Deno.test("guest relay can close during repeated transient accept failures", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let attempts = 0;
  const retried = Promise.withResolvers<void>();
  listener.accept = () => {
    if (++attempts === 2) retried.resolve();
    return Promise.reject(new Deno.errors.NotConnected());
  };
  const relay = startGuestRelay(listener, "/unused");
  await Promise.race([retried.promise, relay.finished]);
  await relay.close();
  await relay.finished;
  assert.equal(attempts, 2);
});

Deno.test("guest relay still reports non-transient accept failures", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const error = new Deno.errors.PermissionDenied("listener failure");
  listener.accept = () => Promise.reject(error);
  const relay = startGuestRelay(listener, "/unused");
  await assert.rejects(relay.finished, (caught) => caught === error);
  await assert.rejects(relay.close(), (caught) => caught === error);
});
