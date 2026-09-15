/** Storage acceptance against the pinned smolvm. No provider credentials/network.
 * Run: deno run -A scripts/test-session-disk-vm.ts /nix/store/.../bin/smolvm
 * Exercises ephemeral CoW disks, independent writes and host worktree persistence.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { vmEnvironment } from "../runtime/src/packaged/vm.ts";
import { attachDiskTemplates } from "../runtime/src/packaged/disk-templates.ts";
import {
  attachSessionDisks,
  createSessionDisks,
  copyDisk,
  sessionDiskSizes,
} from "../runtime/src/session-vm/disks.ts";

const [binary] = Deno.args;
assert(binary, "Pass the pinned smolvm executable");
assert.equal(Deno.args.length, 1, "Pass only the smolvm executable");
const smolvm = await Deno.realPath(binary);
// Keep Unix socket paths short on macOS as well as Linux.
const root = await Deno.realPath(await Deno.makeTempDir({ dir: "/tmp", prefix: "ld-" }));
const started = performance.now();
const phase = (message: string) =>
  console.log(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${message}`);
const name = "storage-check";
const states: string[] = [];
const command = async (state: string, args: string[]) => {
  const result = await new Deno.Command(smolvm, {
    args,
    clearEnv: true,
    env: vmEnvironment(state),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, `${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
};
const machine = (state: string, action: string, ...args: string[]) =>
  command(state, ["machine", action, "--name", name, ...args]);
const exec = (state: string, script: string) =>
  machine(state, "exec", "--", "/bin/sh", "-ec", script);
const create = async (id: string, workspace: string) => {
  const state = join(root, id);
  await Deno.mkdir(state, { mode: 0o700 });
  states.push(state);
  await attachDiskTemplates(state, smolvm);
  await machine(
    state,
    "create",
    "--cpus",
    "1",
    "--mem",
    "2048",
    // Explicit non-default sizes use the documented raw-disk fallback in 1.8.1.
    // Default Linux disks are qcow2 and cannot be independently copied this way.
    ...sessionDiskSizes,
    "-v",
    `${workspace}:/workspace`,
    "-w",
    "/workspace",
  );
  return { state, disks: await machine(state, "data-dir") };
};
const copyDisks = async (source: string, target: string) => {
  await Deno.mkdir(target, { recursive: true });
  for (const stem of ["storage", "overlay"]) {
    const from = join(source, `${stem}.raw`);
    const to = join(target, `${stem}.raw`);
    assert((await Deno.lstat(from)).isFile, "Expected a self-contained raw disk");
    // Only call with stopped machines; never hard-link a writable disk.
    for (const path of [to, join(target, `${stem}.qcow2`)]) {
      await Deno.remove(path).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    await copyDisk(from, to);
    await Deno.copyFile(join(source, `${stem}.formatted`), join(target, `${stem}.formatted`));
    const info = await stat(to);
    assert(info.blocks * 512 < info.size / 4, "Disk copy lost sparseness");
  }
};
try {
  const first = join(root, "worktree-a");
  const second = join(root, "worktree-b");
  await Deno.mkdir(first);
  await Deno.mkdir(second);
  await Deno.writeTextFile(join(first, "identity"), "first\n");
  await Deno.writeTextFile(join(second, "identity"), "second\n");
  phase("Creating and warming the source VM");
  const source = await create("source", first);
  await machine(source.state, "start");
  await exec(
    source.state,
    'test "$(cat /workspace/identity)" = first; echo cached > /storage/dependency; echo rooted > /root/persistent; sync',
  );
  await machine(source.state, "stop");
  phase("Restarting the source VM");
  await machine(source.state, "start");
  assert.equal(
    await exec(source.state, "cat /storage/dependency /root/persistent"),
    "cached\nrooted",
  );
  await machine(source.state, "stop");

  phase("Saving the immutable base");
  const base = join(root, "base");
  await copyDisks(source.disks, base);
  for (const stem of ["storage", "overlay"]) await Deno.chmod(join(base, `${stem}.raw`), 0o400);
  phase("Creating two small writable overlays");
  const left = await create("left", second);
  const right = await create("right", second);
  const overlay = async (vm: typeof left, from: string) => {
    const dir = join(vm.state, "disks");
    await createSessionDisks(dir, from, smolvm);
    if (Deno.build.os === "linux") {
      for (const stem of ["storage", "overlay"])
        assert((await stat(join(dir, `${stem}.qcow2`))).size < 1024 * 1024);
    }
    await attachSessionDisks(dir, vm.disks, vm.state);
  };
  await overlay(left, base);
  await overlay(right, base);
  await machine(left.state, "start");
  await exec(
    left.state,
    'test "$(cat /storage/dependency)" = cached; test "$(cat /root/persistent)" = rooted; test "$(cat /workspace/identity)" = second; echo left > /storage/dependency; echo dirty > /workspace/dirty; sync',
  );
  await machine(right.state, "start");
  assert.equal(
    await exec(right.state, "cat /storage/dependency /root/persistent"),
    "cached\nrooted",
  );
  await machine(left.state, "stop");
  await machine(left.state, "start");
  assert.equal(await exec(left.state, "cat /storage/dependency /workspace/dirty"), "left\ndirty");
  assert.equal(await Deno.readTextFile(join(second, "dirty")), "dirty\n");
  await assert.rejects(Deno.stat(join(first, "dirty")), Deno.errors.NotFound);
  phase("Refreshing the base and discarding the stopped session disks");
  await machine(left.state, "stop");
  await machine(right.state, "stop");
  await machine(source.state, "start");
  await exec(source.state, "echo refreshed > /storage/dependency; sync");
  await machine(source.state, "stop");
  const refreshed = join(root, "refreshed");
  await copyDisks(source.disks, refreshed);
  for (const stem of ["storage", "overlay"])
    await Deno.chmod(join(refreshed, `${stem}.raw`), 0o400);
  // Removing the published name cannot destroy a launch's read-only backing bytes.
  await Deno.remove(base, { recursive: true });
  await machine(right.state, "start");
  assert.equal(await exec(right.state, "cat /storage/dependency"), "cached");
  await machine(left.state, "delete", "--force");
  states.splice(states.indexOf(left.state), 1);
  await Deno.remove(left.state, { recursive: true });
  const resumed = await create("resumed", second);
  await overlay(resumed, refreshed);
  await machine(resumed.state, "start");
  assert.equal(
    await exec(resumed.state, "cat /storage/dependency /workspace/dirty /workspace/identity"),
    "refreshed\ndirty\nsecond",
  );
  phase(
    "Passed: tiny CoW disks, independent writes, retained backing bytes, base refresh, and dirty host worktree persistence",
  );
} finally {
  // Do not remove disk files unless shutdown/deletion was confirmed.
  const cleanup = await Promise.allSettled(
    states.map(async (state) => {
      await machine(state, "stop");
      await machine(state, "delete", "--force");
    }),
  );
  if (cleanup.some((r) => r.status === "rejected")) {
    console.error(`Cleanup incomplete; retained state at ${root}`);
    for (const result of cleanup) if (result.status === "rejected") console.error(result.reason);
    Deno.exitCode = 1;
  } else {
    await Deno.remove(root, { recursive: true });
  }
}
