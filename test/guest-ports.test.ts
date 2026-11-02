// test-run: own-process — owns and rebinds loopback listeners.
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  AUTO_HOST_PORTS,
  isAutoHostPort,
  normalizeGuestPorts,
  normalizeHostPorts,
  normalizePortForwards,
  showGuestPort,
} from "../core/src/host-ports.ts";
import { readPublishedPorts, startPublishedPorts } from "../runtime/src/session-vm/publish-port.ts";

Deno.test("automatic host ports normalize independently and keep exact-port compatibility", () => {
  assert.deepEqual(normalizeGuestPorts([{ guest: 3000 }, { guest: 3001 }, { guest: 3000 }, 8080]), [
    { guest: 3000 },
    { guest: 3001 },
    { guest: 8080, host: 8080 },
  ]);
  assert.throws(() => normalizeHostPorts([{ guest: 3000 }]));
  for (const entry of [
    { guest: 0 },
    { guest: 3000, host: 0 },
    { guest: 3128 },
    { guest: 3000, host: null },
  ])
    assert.throws(() => normalizeGuestPorts([entry]));
  assert.throws(() => normalizePortForwards([5037], [{ guest: 5037 }]), /overlap/);
});

Deno.test("concurrent sessions get distinct retained ports and resume reuses or replaces a preference", async () => {
  const dir = await Deno.makeTempDir();
  const batches: Awaited<ReturnType<typeof startPublishedPorts>>[] = [];
  try {
    const first = await startPublishedPorts(dir, [{ guest: 3000 }, { guest: 3001 }]);
    batches.push(first);
    const mappings = first.map((p) => p.mapping);
    await Deno.writeTextFile(join(dir, "guest-ports.json"), JSON.stringify(mappings));
    const saved = await readPublishedPorts(dir);
    const concurrent = await startPublishedPorts(dir, [{ guest: 3000 }, { guest: 3001 }], saved);
    batches.push(concurrent);
    assert.equal(new Set([...first, ...concurrent].map((p) => p.mapping.host)).size, 4);
    for (const p of [...first, ...concurrent]) {
      assert.equal(p.relay.addr.hostname, "127.0.0.1");
      assert.equal(p.relay.addr.port, p.mapping.host);
      assert.throws(
        () => Deno.listen({ hostname: "127.0.0.1", port: p.mapping.host }),
        Deno.errors.AddrInUse,
      );
    }
    await Promise.all(first.map((p) => p.relay.close()));
    const resumed = await startPublishedPorts(dir, [{ guest: 3000 }, { guest: 3001 }], saved);
    batches.push(resumed);
    assert.deepEqual(
      resumed.map((p) => p.mapping),
      mappings,
    );
    assert.deepEqual(
      await startPublishedPorts(dir, [], saved),
      [],
      "removed grants do not reopen old mappings",
    );
  } finally {
    await Promise.all(batches.flat().map((p) => p.relay.close()));
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("automatic ports stay in the ephemeral range and ignore leftover fixed preferences", async () => {
  const dir = await Deno.makeTempDir();
  const batches: Awaited<ReturnType<typeof startPublishedPorts>>[] = [];
  try {
    const outside = AUTO_HOST_PORTS.min - 1;
    const ports = await startPublishedPorts(
      dir,
      [{ guest: 8081 }, { guest: 3000 }, { guest: 3001 }],
      [{ guest: 8081, host: outside }],
    );
    batches.push(ports);
    for (const { mapping } of ports) assert(isAutoHostPort(mapping.host), `${mapping.host}`);
  } finally {
    await Promise.all(batches.flat().map((p) => p.relay.close()));
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fixed mappings take precedence over automatic preferences and host targets are excluded", async () => {
  const dir = await Deno.makeTempDir();
  const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = reservation.addr.port;
  reservation.close();
  const batches: Awaited<ReturnType<typeof startPublishedPorts>>[] = [];
  try {
    const mixed = await startPublishedPorts(
      dir,
      [{ guest: 3000 }, { guest: 3001, host: port }],
      [{ guest: 3000, host: port }],
    );
    batches.push(mixed);
    assert.equal(mixed.find((p) => p.mapping.guest === 3001)!.mapping.host, port);
    assert.notEqual(mixed.find((p) => p.mapping.guest === 3000)!.mapping.host, port);
    await Promise.all(mixed.map((p) => p.relay.close()));
    const excluded = await startPublishedPorts(
      dir,
      [{ guest: 3000 }],
      [{ guest: 3000, host: port }],
      [port],
    );
    batches.push(excluded);
    assert.notEqual(excluded[0]!.mapping.host, port);
  } finally {
    await Promise.all(batches.flat().map((p) => p.relay.close()));
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a later fixed-port conflict releases earlier listeners", async () => {
  const dir = await Deno.makeTempDir();
  const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = reservation.addr.port;
  const occupied = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  reservation.close();
  try {
    await assert.rejects(
      startPublishedPorts(dir, [
        { guest: 3000, host: port },
        { guest: 3001, host: occupied.addr.port },
      ]),
      /occupied or unavailable/,
    );
    const reused = Deno.listen({ hostname: "127.0.0.1", port });
    reused.close();
  } finally {
    occupied.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("guest port addresses are IPv4 literals and part of a mapping's identity", () => {
  assert.deepEqual(normalizeGuestPorts([{ guest: 8081, address: "0.0.0.0" }]), [
    { guest: 8081, address: "0.0.0.0" },
  ]);
  for (const address of ["localhost", "::", "0.0.0.0:8081", ""])
    assert.throws(() => normalizeGuestPorts([{ guest: 8081, address }]));
  assert.throws(
    () => normalizeGuestPorts([{ guest: 8081 }, { guest: 8081, address: "0.0.0.0" }]),
    /conflicting mappings/,
  );
  assert.throws(() => normalizeHostPorts([{ host: 5037, guest: 5037, address: "0.0.0.0" }]));
});

Deno.test("an addressed automatic port binds that address, lists LAN addresses and is preferred only for it", async () => {
  const dir = await Deno.makeTempDir();
  const batches: Awaited<ReturnType<typeof startPublishedPorts>>[] = [];
  try {
    const [wild] = await startPublishedPorts(dir, [{ guest: 8081, address: "0.0.0.0" }]);
    batches.push([wild!]);
    assert.equal(wild!.relay.addr.hostname, "0.0.0.0");
    assert.equal(wild!.mapping.address, "0.0.0.0");
    assert(isAutoHostPort(wild!.mapping.host));
    assert(wild!.mapping.lan!.every((a) => !a.startsWith("127.")));
    const saved = [wild!.mapping];
    await wild!.relay.close();
    const [loopback] = await startPublishedPorts(dir, [{ guest: 8081 }], saved);
    batches.push([loopback!]);
    assert.equal(loopback!.relay.addr.hostname, "127.0.0.1");
    assert.equal(loopback!.mapping.address, undefined);
    assert.equal(loopback!.mapping.lan, undefined);
    assert.notEqual(loopback!.mapping.host, wild!.mapping.host);
    await loopback!.relay.close();
    const [again] = await startPublishedPorts(dir, [{ guest: 8081, address: "0.0.0.0" }], saved);
    batches.push([again!]);
    assert.equal(again!.mapping.host, wild!.mapping.host);
  } finally {
    await Promise.all(batches.flat().map((p) => p.relay.close().catch(() => {})));
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("showGuestPort names the bound address and, for a wildcard, where to reach it", () => {
  assert.equal(
    showGuestPort({ guest: 8081, host: 41234 }),
    "guest 127.0.0.1:8081 → host 127.0.0.1:41234",
  );
  assert.equal(
    showGuestPort({ guest: 8081, host: 41234, address: "192.168.88.111" }),
    "guest 127.0.0.1:8081 → host 192.168.88.111:41234",
  );
  assert.equal(
    showGuestPort({
      guest: 8081,
      host: 41234,
      address: "0.0.0.0",
      lan: ["192.168.88.111", "10.0.0.5"],
    }),
    "guest 127.0.0.1:8081 → host 0.0.0.0:41234 (192.168.88.111:41234, 10.0.0.5:41234)",
  );
});
