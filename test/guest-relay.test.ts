import assert from "node:assert/strict";
import { startGuestRelay, relayDiagnosticLimit } from "../runtime/src/session-vm/guest-relay.ts";
import { EGRESS_CONNECTION_LIMIT } from "../runtime/src/session-vm/relay-limits.ts";
import { type RelayDiagnostic } from "../core/src/relay-diagnostic.ts";

interface RelayFixture {
  limit: number;
  report?: (info: RelayDiagnostic) => void;
}

/** A guest relay in front of a bridge listener that keeps every peer it accepts. */
const mkRelayFixture = async ({ limit, report }: RelayFixture) => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const socket = `${state}/bridge.sock`;
  const bridge = Deno.listen({ transport: "unix", path: socket });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const relay = startGuestRelay(listener, socket, limit, {
    kind: "egress",
    ...(report ? { report } : {}),
  });
  const clients: Deno.Conn[] = [];
  const peers: Deno.Conn[] = [];
  let changed = Promise.withResolvers<void>();
  const accepting = (async () => {
    try {
      for await (const peer of bridge) {
        peers.push(peer);
        changed.resolve();
        changed = Promise.withResolvers<void>();
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  })();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("Relay stalled")), 5000);
  });
  void expired.catch(() => {});
  return {
    clients,
    peers,
    connect: async () => {
      const client = await Deno.connect({ hostname: "127.0.0.1", port: listener.addr.port });
      clients.push(client);
      return client;
    },
    /** Waits until the bridge has accepted `count` peers. */
    bridged: async (count: number) => {
      while (peers.length < count) await Promise.race([changed.promise, expired]);
    },
    /** Resolves with what the client reads first: data, end of stream or a reset. */
    read: (client: Deno.Conn) =>
      Promise.race([
        client.read(new Uint8Array(1)).then(
          (count) => (count === null ? "closed" : "data"),
          (error) => {
            if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
            return "closed";
          },
        ),
        expired,
      ]),
    close: async () => {
      clearTimeout(deadline);
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
    },
  };
};

const assertForwards = async (client: Deno.Conn, peer: Deno.Conn) => {
  const bytes = new Uint8Array(1);
  await client.write(new Uint8Array([42]));
  assert.equal(await peer.read(bytes), 1);
  assert.equal(bytes[0], 42);
  await peer.write(new Uint8Array([43]));
  assert.equal(await client.read(bytes), 1);
  assert.equal(bytes[0], 43);
};

Deno.test("guest egress relay forwards a client while 32 idle tunnels stay open", async () => {
  // given
  const f = await mkRelayFixture({ limit: EGRESS_CONNECTION_LIMIT });
  try {
    for (let i = 0; i < 32; i++) await f.connect();
    await f.bridged(32);
    // when
    const client = await f.connect();
    await f.bridged(33);
    // then
    await assertForwards(client, f.peers[32]!);
  } finally {
    await f.close();
  }
});

Deno.test("guest relay refuses a client over its limit at once and reports it", async () => {
  // given
  const records: RelayDiagnostic[] = [];
  const f = await mkRelayFixture({ limit: 4, report: (info) => records.push(info) });
  try {
    for (let i = 0; i < 4; i++) await f.connect();
    await f.bridged(4);
    // when
    const started = performance.now();
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await f.read(await f.connect()));
    // then
    assert.deepEqual(outcomes, ["closed", "closed", "closed", "closed", "closed"]);
    assert(performance.now() - started < 1000, "refusal must not wait for a timeout");
    assert.equal(f.peers.length, 4, "refused clients must not open bridge sockets");
    assert.deepEqual(
      records.map((r) => [r.event, r.refused, r.active]),
      [
        ["refused", 1, 4],
        ["refused", 2, 4],
        ["refused", 4, 4],
      ],
    );
    assert(records.every((r) => r.kind === "egress"));
  } finally {
    await f.close();
  }
});

Deno.test("guest relay reuses a slot released by either end", async () => {
  // given
  const f = await mkRelayFixture({ limit: 2 });
  try {
    for (const [index, closing] of (["client", "peer", "client", "peer"] as const).entries()) {
      const client = await f.connect();
      await f.bridged(index + 1);
      const peer = f.peers[index]!;
      await assertForwards(client, peer);
      // when
      (closing === "client" ? client : peer).close();
      // then
      assert.equal(await f.read(closing === "client" ? peer : client), "closed");
    }
  } finally {
    await f.close();
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
  const records: RelayDiagnostic[] = [];
  const forwarded = Promise.withResolvers<void>();
  const relay = startGuestRelay(listener, socket, 32, {
    kind: "mcp",
    index: 2,
    report(info) {
      records.push(info);
      if (info.event === "forwarded") forwarded.resolve();
    },
  });
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
    assert.deepEqual(
      records.filter((r) => r.event === "accept_error").map((r) => r.consecutive),
      [1, 2, 4],
    );
    assert.equal(records.at(-1)?.event, "accepted");
    assert.equal(records.at(-1)?.consecutive, 0);
    assert(records.every((r) => r.kind === "mcp" && r.index === 2 && !r.stopping));
    await client.write(new Uint8Array([42]));
    const bytes = new Uint8Array(1);
    assert.equal(await Promise.race([peer.read(bytes), failed, expired]), 1);
    assert.equal(bytes[0], 42);
    assert(!records.some((r) => r.event === "forwarded"), "one-way traffic is not recovery");
    await peer.write(new Uint8Array([43]));
    assert.equal(await Promise.race([client.read(bytes), failed, expired]), 1);
    assert.equal(bytes[0], 43);
    await Promise.race([forwarded.promise, failed, expired]);
    assert.equal(records.at(-1)?.failures, 4);
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
  const relay = startGuestRelay(listener, "/unused", 1);
  await Promise.race([retried.promise, relay.finished]);
  await relay.close();
  await relay.finished;
  assert.equal(attempts, 2);
});

Deno.test("guest relay still reports non-transient accept failures", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const error = new Deno.errors.PermissionDenied("listener failure");
  listener.accept = () => Promise.reject(error);
  const relay = startGuestRelay(listener, "/unused", 1);
  await assert.rejects(relay.finished, (caught) => caught === error);
  await assert.rejects(relay.close(), (caught) => caught === error);
});

Deno.test("relay caps routine diagnostics but preserves persistent failure and shutdown", async () => {
  const records: RelayDiagnostic[] = [];
  let attempts = 0;
  let closed = 0;
  const error = new Deno.errors.NotConnected("secret-token");
  const listener = {
    accept() {
      attempts++;
      if (attempts <= 40 && attempts % 2 === 0) return Promise.resolve({ close() {} } as Deno.Conn);
      return Promise.reject(error);
    },
    close() {
      closed++;
    },
  } as unknown as Deno.Listener;
  const relay = startGuestRelay(listener, "/nonexistent-loom-test-bridge", 1, {
    kind: "egress",
    maxAcceptFailures: 3,
    report: (info) => records.push(info),
  });
  await assert.rejects(relay.finished, (caught) => caught === error);
  assert.equal(attempts, 43);
  assert.equal(records.length, relayDiagnosticLimit + 2);
  assert.equal(records.at(-2)?.event, "suppressed");
  assert.equal(records.at(-1)?.event, "accept_exhausted");
  assert.equal(records.at(-1)?.consecutive, 3);
  assert.equal(records.at(-1)?.failures, 23);
  assert((records.at(-1)?.suppressed ?? 0) > 1);
  assert(!JSON.stringify(records).includes("secret-token"));
  await assert.rejects(relay.close(), (caught) => caught === error);
  assert.equal(closed, 1);
  assert.equal(records.at(-1)?.event, "closed");
  assert.equal(records.at(-1)?.stopping, true);
});

Deno.test("successful accept racing shutdown closes the accepted connection", async () => {
  const accepted = Promise.withResolvers<Deno.Conn>();
  let clientClosed = false;
  const listener = {
    accept: () => accepted.promise,
    close() {},
  } as unknown as Deno.Listener;
  const relay = startGuestRelay(listener, "/unused", 1);
  const closing = relay.close();
  accepted.resolve({
    close() {
      clientClosed = true;
    },
  } as unknown as Deno.Conn);
  await closing;
  assert(clientClosed);
});
