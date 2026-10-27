/**
 * Real-VM, credential-free smoke test for host TCP forwarding.
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
      hostPorts: enabled ? [host.addr.port] : [],
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
        if (${enabled}) {
          const conn = await Deno.connect({ hostname: "127.0.0.1", port: ${host.addr.port} });
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
          await denied(${host.addr.port});
        }
        console.log("PASS: " + (${enabled} ? "ADB framing forwarded; ungranted port refused" : "forward absent without grant"));
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
    } finally {
      await vm.close();
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
