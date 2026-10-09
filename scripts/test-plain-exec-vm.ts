/** Plain command execution through the isolation library, without any agent or session layer. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { ExecutionLeases } from "@loom/isolation/execution-leases";
import { plainExec } from "../runtime/src/session-vm/plain-exec.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass a rebuilt session runtime and smolvm");
const root = await Deno.realPath(await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-plain-" }));
// Keep this run's VM inventory out of the user's.
Deno.env.set("XDG_STATE_HOME", join(root, "xdg-state"));
const workspace = join(root, "workspace");
const state = join(root, "state");
await Deno.mkdir(workspace);
await Deno.mkdir(state);
const decode = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);
const vmStates = async () => {
  const states = new Set<string>();
  for await (const entry of Deno.readDir("/tmp"))
    if (/^loom-(?:session-vm|svm)-/.test(entry.name)) states.add(join("/tmp", entry.name));
  return states;
};
/** Own processes still referencing a path in argv or environment. */
const processesUsing = async (paths: string[]) => {
  const found: string[] = [];
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name) || Number(entry.name) === Deno.pid) continue;
    for (const file of ["cmdline", "environ"]) {
      const text = await Deno.readTextFile(join("/proc", entry.name, file)).catch(() => "");
      if (paths.some((path) => text.includes(path))) found.push(entry.name + " " + file);
    }
  }
  return found;
};
const assertCleaned = async (environment: string, leases: ExecutionLeases, before: Set<string>) => {
  assert(leases.lastActivity(environment) > 0, "the command held an execution lease");
  assert.equal(leases.has(environment), false, "execution lease released");
  assert.deepEqual(await Array.fromAsync(Deno.readDir(state)), [], "environment state removed");
  const { vms, errors } = await listVms(workspace);
  assert.deepEqual(errors, []);
  assert.equal(vms.length, 1, "one VM per run");
  const vm = vms[0]!;
  assert.equal(vm.state, "stopped");
  assert.equal(vm.error, null);
  assert.equal(vm.sessionId, environment);
  await assert.rejects(Deno.lstat(vm.paths.state), Deno.errors.NotFound, "VM runtime state reaped");
  assert.deepEqual(
    [...(await vmStates())].filter((path) => !before.has(path)),
    [],
  );
  assert.deepEqual(await processesUsing([vm.paths.state, join(state, environment)]), []);
  await Deno.remove(join(root, "xdg-state"), { recursive: true });
};

try {
  {
    const before = await vmStates();
    const leases = new ExecutionLeases();
    const progress: string[] = [];
    const result = await plainExec({
      workspace,
      stateRoot: state,
      artifact,
      smolvm,
      argv: ["sh", "-c", "echo hi; exit 3"],
      stdout: "piped",
      stderr: "piped",
      leases,
      onProgress: (message) => progress.push(message),
    });
    assert.equal(decode(result.stdout), "hi\n", decode(result.stderr) + progress.join("\n"));
    assert.equal(result.code, 3);
    assert.equal(result.signal, null);
    await assertCleaned(result.environment, leases, before);
  }
  {
    // Literal argv, workspace visibility in both directions, and no default egress.
    await Deno.writeTextFile(join(workspace, "input.txt"), "from host\n");
    const before = await vmStates();
    const leases = new ExecutionLeases();
    const result = await plainExec({
      workspace,
      stateRoot: state,
      artifact,
      smolvm,
      argv: [
        "sh",
        "-c",
        'printf "%s\\n" "$@"; cat input.txt; echo from guest > output.txt; ' +
          "command -v curl >/dev/null || echo curl-missing; " +
          "if curl -sS --max-time 10 https://example.com >/dev/null 2>&1; then echo egress-open; fi",
        "loom",
        "two words",
        "$(touch injected)",
        "*",
      ],
      stdout: "piped",
      stderr: "piped",
      leases,
    });
    assert.equal(result.code, 0, decode(result.stderr));
    assert.equal(decode(result.stdout), "two words\n$(touch injected)\n*\nfrom host\n");
    assert.equal(await Deno.readTextFile(join(workspace, "output.txt")), "from guest\n");
    await assert.rejects(Deno.lstat(join(workspace, "injected")), Deno.errors.NotFound);
    await assertCleaned(result.environment, leases, before);
  }
  console.log(
    "Passed: exit status, separate stdout, literal argv, workspace mount, denied egress, and lease/VM/process/state cleanup",
  );
} finally {
  await Deno.remove(root, { recursive: true });
}
