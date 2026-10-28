/**
 * Real-VM, credential-free test of bidirectional TCP forwarding and remapping.
 * deno run -A scripts/test-host-ports-vm.ts SESSION_RUNTIME /path/to/smolvm
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { launchEnvironmentVm } from "../runtime/src/session-vm/environment-launch.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass SESSION_RUNTIME and an absolute SMOLVM path");
const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-host-ports-vm-" });
Deno.env.set("XDG_STATE_HOME", join(root, "state"));
const workspace = join(root, "workspace");
await Deno.mkdir(workspace);
const host = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const ungranted = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
const publishedPort = reservation.addr.port;
reservation.close();
const adbGuestPort = 15037;
const webGuestPort = 3000;
const peers = new Set<Deno.Conn>();
const tasks = new Set<Promise<void>>();
const readExactly = async (conn: Deno.Conn, size: number) => {
  const buffer = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const n = await conn.read(buffer.subarray(offset));
    if (n === null) throw new Error("Unexpected EOF");
    offset += n;
  }
  return buffer;
};
const serving = (async () => {
  try {
    for await (const peer of host) {
      peers.add(peer);
      const task = (async () => {
        try {
          // ADB smart-socket framing, including its length prefix.
          const request = await readExactly(peer, 16);
          assert.equal(new TextDecoder().decode(request), "000chost:version");
          await peer.write(new TextEncoder().encode("OKAY00040029"));
          // Keep the connection open until the guest or VM closes it.
          await peer.read(new Uint8Array(1));
        } finally {
          peers.delete(peer);
          peer.close();
        }
      })();
      tasks.add(task);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.BadResource)) throw error;
  }
})();
const inventory = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
const deno = inventory.find((path) => /-deno-[0-9]/.test(path)) + "/bin/deno";
try {
  for (const enabled of [true, false]) {
    const vm = await launchEnvironmentVm({
      workspace,
      artifact,
      smolvm,
      hostPorts: enabled ? [{ host: host.addr.port, guest: adbGuestPort }] : [],
      guestPorts: enabled ? [{ host: publishedPort, guest: webGuestPort }] : [],
      onProgress: (message) => console.error(message),
    });
    try {
      await vm.ready;
      const source = `
        const denied = async (port) => {
          try {
            const conn = await Deno.connect({ hostname: "127.0.0.1", port });
            conn.close();
            throw new Error("Unexpected access to " + port);
          } catch (error) {
            if (!(error instanceof Deno.errors.ConnectionRefused)) throw error;
          }
        };
        await denied(${ungranted.addr.port});
        await denied(${host.addr.port});
        if (${enabled}) {
          const conn = await Deno.connect({ hostname: "127.0.0.1", port: ${adbGuestPort} });
          await conn.write(new TextEncoder().encode("000chost:version"));
          const reply = new Uint8Array(12);
          let offset = 0;
          while (offset < reply.length) {
            const n = await conn.read(reply.subarray(offset));
            if (n === null) throw new Error("Unexpected EOF");
            offset += n;
          }
          if (new TextDecoder().decode(reply) !== "OKAY00040029") throw new Error("Bad response");
          conn.close();
        } else {
          await denied(${adbGuestPort});
        }
        console.log("PASS: " + (${enabled} ? "ADB framing remapped; ungranted and original ports refused" : "forward absent without grant"));
      `;
      const result = await new Deno.Command(smolvm, {
        args: [
          "machine",
          "exec",
          "--name",
          sessionVmName,
          "--timeout",
          "30s",
          "--",
          deno,
          "eval",
          source,
        ],
        clearEnv: true,
        env: vmEnvironment(vm.binding.state),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      console.log(new TextDecoder().decode(result.stdout).trim());
      if (enabled) {
        const conflict = await launchEnvironmentVm({
          workspace,
          artifact,
          smolvm,
          guestPorts: [{ host: publishedPort, guest: webGuestPort }],
        });
        try {
          await assert.rejects(conflict.ready, /guest_ports host listener/);
        } finally {
          await conflict.close();
        }
        console.log("PASS: occupied host port fails startup clearly");
        const server: Promise<Deno.CommandOutput> = new Deno.Command(smolvm, {
          args: [
            "machine",
            "exec",
            "--name",
            sessionVmName,
            "--timeout",
            "30s",
            "--",
            deno,
            "eval",
            `
            const server = Deno.serve({ hostname: "127.0.0.1", port: ${webGuestPort}, onListen() {} }, async (request) => {
              const body = await request.arrayBuffer();
              setTimeout(() => server.shutdown(), 100);
              return new Response(body, { headers: { "x-loom-test": "guest" } });
            });
            await server.finished;
          `,
          ],
          clearEnv: true,
          env: vmEnvironment(vm.binding.state),
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const body = new Uint8Array([0, 255, 1, 128, 10]);
        let reply: Response | undefined;
        const deadline = Date.now() + 20_000;
        while (!reply && Date.now() < deadline) {
          try {
            reply = await fetch(`http://127.0.0.1:${publishedPort}/`, {
              method: "POST",
              body,
              signal: AbortSignal.timeout(2000),
            });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        assert(reply, "Published web server was not reachable");
        assert.equal(reply.headers.get("x-loom-test"), "guest");
        assert.deepEqual(new Uint8Array(await reply.arrayBuffer()), body);
        const finished = await server;
        assert.equal(finished.code, 0, new TextDecoder().decode(finished.stderr));
        console.log("PASS: host reached guest-loopback web server on a remapped port");
      } else {
        await assert.rejects(
          Deno.connect({ hostname: "127.0.0.1", port: publishedPort }),
          Deno.errors.ConnectionRefused,
        );
        console.log("PASS: guest port is not published without a grant");
      }
    } finally {
      await vm.close();
      const released = Deno.listen({ hostname: "127.0.0.1", port: publishedPort });
      released.close();
      console.log("PASS: VM shutdown released the host listener");
    }
  }
} finally {
  host.close();
  ungranted.close();
  for (const peer of peers) peer.close();
  await serving;
  await Promise.all(tasks);
  await Deno.remove(root, { recursive: true });
}
