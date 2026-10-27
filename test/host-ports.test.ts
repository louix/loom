import assert from "node:assert/strict";
import { join } from "node:path";
import { normalizeHostPorts } from "../core/src/host-ports.ts";
import { loadConfig, normalizeConfig } from "../backend/daemon/src/config/config.ts";
import { convertLoomConfig } from "../cli/src/config-convert.ts";
import {
  parseEnvironmentUser,
  parseProjectEnvironment,
  resolveEnvironmentConfig,
} from "../environment-config/src/resolution.ts";
import { startLoopbackRelay } from "../runtime/src/session-vm/mcp-relay.ts";
import { startGuestRelay } from "../runtime/src/session-vm/guest-relay.ts";

Deno.test("host ports validate exact TCP ports and reject internal listener collisions", () => {
  assert.deepEqual(normalizeHostPorts(undefined), []);
  assert.deepEqual(normalizeHostPorts([5037, 5037, 65535, 1]), [5037, 65535, 1]);
  for (const ports of [[0], [-1], [65536], [1.5], ["5037"], [true], "5037", null])
    assert.throws(() => normalizeHostPorts(ports));
  for (const port of [3128, 3129]) assert.throws(() => normalizeHostPorts([port]), /conflicts/);
  assert.throws(() => normalizeHostPorts([5037], [5037]), /conflicts/);
});

Deno.test("Loom global host ports are inherited, replaced or cleared per repo", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "config.jsonc");
  const raw = {
    session: { isolation: { network: { host_ports: [5037] } } },
    repos: [
      { path: join(root, "override"), session: { isolation: { network: { host_ports: [6000] } } } },
      { path: join(root, "disabled"), session: { isolation: { network: { host_ports: [] } } } },
    ],
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(raw));
    assert.deepEqual(loadConfig(root, path).isolation.hostPorts, [5037]);
    assert.deepEqual(loadConfig(join(root, "override"), path).isolation.hostPorts, [6000]);
    assert.deepEqual(loadConfig(join(root, "disabled"), path).isolation.hostPorts, []);
    assert.throws(
      () => normalizeConfig({ session: { isolation: { network: { host_ports: [65536] } } } }),
      /host_ports/,
    );
    assert.throws(
      () => normalizeConfig({ session: { isolation: { network: { host_ports: [3128] } } } }),
      /conflicts/,
    );
    const converted = convertLoomConfig(raw, path);
    const user = parseEnvironmentUser(JSON.stringify(converted.user));
    const project = parseProjectEnvironment('{"version":1}');
    for (const [repo, expected] of [
      [root, [5037]],
      [join(root, "override"), [6000]],
      [join(root, "disabled"), []],
    ] as const)
      assert.deepEqual(resolveEnvironmentConfig(project, user, [repo]).hostPorts, expected);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("environment host ports are host authority, never project requests", () => {
  const project = parseProjectEnvironment('{"version":1}');
  const user = parseEnvironmentUser(
    JSON.stringify({
      version: 1,
      access: { network: { host_ports: [5037] } },
      repos: [{ path: "/disabled", access: { network: { host_ports: [] } } }],
    }),
  );
  assert.deepEqual(resolveEnvironmentConfig(project, user, ["/other"]).hostPorts, [5037]);
  assert.deepEqual(resolveEnvironmentConfig(project, user, ["/disabled"]).hostPorts, []);
  assert.throws(
    () => parseProjectEnvironment('{"version":1,"access":{"network":{"host_ports":[5037]}}}'),
    /host_ports/,
  );
  assert.throws(
    () => parseEnvironmentUser('{"version":1,"access":{"network":{"host_ports":[0]}}}'),
    /host_ports/,
  );
});

const readExactly = async (conn: Deno.Conn, size: number) => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const count = await conn.read(bytes.subarray(offset));
    assert.notEqual(count, null);
    offset += count!;
  }
  return bytes;
};

Deno.test("host port bridge forwards raw TCP both ways and disconnects on shutdown", async () => {
  const dir = await Deno.makeTempDir();
  const socket = join(dir, "forward.sock");
  const host = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const relay = startLoopbackRelay(socket, host.addr.port);
  const endpoint = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const guest = startGuestRelay(endpoint, socket, 32, { kind: "host_port", report() {} });
  let client: Deno.TcpConn | undefined, upstream: Deno.TcpConn | undefined;
  try {
    client = await Deno.connect({ hostname: "127.0.0.1", port: endpoint.addr.port });
    upstream = await host.accept();
    // ADB wire request, followed by arbitrary binary response: no HTTP handshake.
    const request = new TextEncoder().encode("000chost:version");
    await client.write(request);
    assert.deepEqual(await readExactly(upstream, request.length), request);
    const response = new Uint8Array([0, 255, 13, 10, 128, 1]);
    await upstream.write(response);
    assert.deepEqual(await readExactly(client, response.length), response);
    await relay.close();
    assert.equal(await client.read(new Uint8Array(1)), null);
  } finally {
    await guest.close();
    await relay.close();
    for (const conn of [client, upstream]) {
      try {
        conn?.close();
      } catch {
        /* already closed */
      }
    }
    host.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("host port forwarding refuses an older runtime before launching a VM", async () => {
  const { launchSessionVm } = await import("../runtime/src/session-vm/launch.ts");
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "standalone-environment-version"), "2");
    await assert.rejects(
      launchSessionVm({
        workspace: dir,
        artifact: dir,
        smolvm: Deno.execPath(),
        environmentOnly: true,
        hostPorts: [5037],
      }),
      /Host port forwarding requires a rebuilt session runtime/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
