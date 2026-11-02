/**
 * Credential-free real VM check: concurrent automatic forwards and resume preferences.
 * deno run -A scripts/test-auto-guest-ports-vm.ts SESSION_RUNTIME /path/to/smolvm
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { launchEnvironmentVm } from "../runtime/src/session-vm/environment-launch.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass SESSION_RUNTIME and an absolute SMOLVM path");
const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-auto-ports-vm-" });
Deno.env.set("XDG_STATE_HOME", join(root, "state"));
const workspace = join(root, "workspace");
await Deno.mkdir(workspace);
const inventory = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
const deno = inventory.find((path) => /-deno-[0-9]/.test(path)) + "/bin/deno";
const machines: Awaited<ReturnType<typeof launchEnvironmentVm>>[] = [];
let blocker: Deno.TcpListener | undefined;
const launch = async (id: string) => {
  const vm = await launchEnvironmentVm({
    workspace,
    artifact,
    smolvm,
    sessionDirectory: join(root, id),
    guestPorts: [{ guest: 3000 }],
    onProgress: (message) => console.error(id + ": " + message),
  });
  machines.push(vm);
  await vm.ready;
  const ports = (await vm.status()).guestPorts;
  assert.equal(ports?.length, 1);
  assert.equal(ports![0]!.guest, 3000);
  assert(ports![0]!.host > 0);
  return { vm, port: ports![0]!.host };
};
const checkHttp = async ({ vm, port }: Awaited<ReturnType<typeof launch>>, label: string) => {
  const child = new Deno.Command(smolvm, {
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
      const mappings = JSON.parse(await Deno.readTextFile("/run/loom/private/guest-ports.json"));
      if (mappings[0].host !== ${port}) throw new Error("Guest mapping disagrees with host status");
      const server = Deno.serve({ hostname: "127.0.0.1", port: 3000, onListen() {} }, () => {
        setTimeout(() => server.shutdown(), 100);
        return new Response(${JSON.stringify(label)});
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
  let response: Response | undefined;
  const deadline = Date.now() + 20_000;
  try {
    while (!response && Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert(response, "Published HTTP service did not become reachable");
    assert.equal(await response.text(), label);
  } finally {
    const result = await child;
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  }
};
try {
  const first = await launch("first");
  const second = await launch("second");
  assert.notEqual(first.port, second.port);
  await Promise.all([checkHttp(first, "first"), checkHttp(second, "second")]);
  console.log(
    "PASS: two concurrent VMs serve guest port 3000 through distinct automatic host ports",
  );
  await first.vm.close();
  const resumed = await launch("first");
  assert.equal(resumed.port, first.port);
  await checkHttp(resumed, "resumed");
  console.log("PASS: resume reuses the previous host port");
  await resumed.vm.close();
  blocker = Deno.listen({ hostname: "127.0.0.1", port: first.port });
  const moved = await launch("first");
  assert.notEqual(moved.port, first.port);
  assert.notEqual(moved.port, second.port);
  await checkHttp(moved, "moved");
  console.log("PASS: occupied previous port falls back and guest metadata reports the new mapping");
} finally {
  await Promise.all(machines.map((vm) => vm.close()));
  blocker?.close();
  await Deno.remove(root, { recursive: true });
}
