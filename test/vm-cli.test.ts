import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerVm,
  listVms,
  inspectVm,
  resolveVm,
  stopVm,
  removeVm,
  type VmRecord,
} from "../runtime/src/session-vm/inventory.ts";
import { writeRecoveryFile } from "../runtime/src/session-vm/persistence.ts";
import { vmCommand, formatVmList } from "../cli/src/vm.ts";

const fixture = async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = join(root, "inventory");
  const record = (id = crypto.randomUUID(), repo = join(root, "repo")): VmRecord => ({
    version: 1,
    id,
    repo,
    kind: "session",
    sessionId: "session",
    provider: "claude",
    workload: "waiting",
    state: "running",
    createdAt: new Date().toISOString(),
    stoppedAt: null,
    observedAt: new Date().toISOString(),
    source: "owner",
    error: null,
    paths: {
      workspace: repo,
      runtime: "/runtime",
      state: join(root, id + "-state"),
      session: join(root, "session"),
      profile: join(root, "session/profile"),
      backend: null,
      base: null,
    },
  });
  return { root, home, record };
};

Deno.test("missing ownership locks are reported and never recreated by removal", async () => {
  const f = await fixture();
  const r = f.record();
  const owner = await registerVm(r, f.home);
  try {
    await owner.finish();
    await Deno.remove(join(f.home, ".locks", r.id));
    assert.equal((await inspectVm(r.id, f.home)).state, "unknown");
    await assert.rejects(removeVm(r.id, f.home), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(join(f.home, ".locks", r.id)), Deno.errors.NotFound);
    assert((await Deno.stat(join(f.home, r.id, "record.json"))).isFile);
  } finally {
    await owner.finish();
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("VM inventory is read-only, global, filterable and uses unambiguous instance prefixes", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await listVms(undefined, f.home), { version: 1, vms: [], errors: [] });
    await assert.rejects(Deno.stat(f.home), Deno.errors.NotFound);
    const a = f.record("aaaaaaaa-1111-1111-1111-111111111111");
    const b = f.record("aaaaaaaa-2222-2222-2222-222222222222", join(f.root, "other"));
    const first = await registerVm(a, f.home);
    const second = await registerVm(b, f.home);
    try {
      assert.equal((await listVms(undefined, f.home)).vms.length, 2);
      assert.equal((await listVms(a.repo, f.home)).vms.length, 1);
      await assert.rejects(resolveVm("aaaaaaaa", undefined, f.home), /Ambiguous/);
      assert.equal((await resolveVm("aaaaaaaa", b.repo, f.home)).id, b.id);
      assert.equal((await inspectVm(a.id, f.home)).state, "running");
      await assert.rejects(removeVm(a.id, f.home), /live process/);
      const before = await Deno.readTextFile(join(f.home, a.id, "record.json"));
      await listVms(undefined, f.home);
      assert.equal(await Deno.readTextFile(join(f.home, a.id, "record.json")), before);
      assert.match(formatVmList([a], true), /STATE DIRECTORY/);
      assert.match(formatVmList([a]), /claude \/ waiting/);
    } finally {
      await first.finish();
      await second.finish();
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("live VM stop waits for owner cleanup; removing its record preserves history and worktree", async () => {
  const f = await fixture();
  const r = f.record();
  const owner = await registerVm(r, f.home);
  try {
    await Deno.mkdir(r.paths.state);
    await Deno.mkdir(r.paths.profile!, { recursive: true });
    await Deno.mkdir(r.repo);
    await Deno.writeTextFile(join(r.paths.profile!, "history"), "conversation");
    await Deno.writeTextFile(join(r.repo, "changes"), "uncommitted");
    let stops = 0;
    owner.serve(
      async () => {
        stops++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        await Deno.remove(r.paths.state);
        await owner.finish();
      },
      async () => ({ state: "running", workload: "waiting" }),
    );
    const stopped = await stopVm(r.id, f.home, 3000);
    assert.equal(stopped.state, "stopped");
    assert.equal(stops, 1);
    await stopVm(r.id, f.home);
    const replacement = f.record();
    const next = await registerVm(replacement, f.home);
    try {
      await removeVm(r.id, f.home);
      await assert.rejects(registerVm(r, f.home), Deno.errors.AlreadyExists);
      assert.equal((await inspectVm(replacement.id, f.home)).state, "running");
      assert.equal(await Deno.readTextFile(join(r.paths.profile!, "history")), "conversation");
      assert.equal(await Deno.readTextFile(join(r.repo, "changes")), "uncommitted");
    } finally {
      await next.finish();
    }
  } finally {
    await owner.finish();
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("preparation instances support cancellation and unresponsive owners are never removed", async () => {
  const f = await fixture();
  const r = { ...f.record(), kind: "prepare" as const, sessionId: null, provider: null };
  const owner = await registerVm(r, f.home);
  try {
    await assert.rejects(stopVm(r.id, f.home, 10), /Timed out/);
    await assert.rejects(removeVm(r.id, f.home), /live process/);
    let cancelled = false;
    owner.serve(
      async () => {
        cancelled = true;
        await owner.finish();
      },
      async () => ({ state: "starting" }),
    );
    assert.equal((await stopVm(r.id, f.home, 3000)).state, "stopped");
    assert(cancelled);
  } finally {
    await owner.finish();
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("orphan recovery rejects replacement bindings, missing evidence and symlinked session state", async () => {
  const f = await fixture();
  const r = f.record();
  const owner = await registerVm(r, f.home);
  try {
    await owner.finish(new Error("cleanup interrupted"));
    assert.equal((await inspectVm(r.id, f.home)).state, "orphaned");
    const outside = join(f.root, "outside");
    await Deno.mkdir(outside);
    await Deno.writeTextFile(join(outside, "keep"), "history");
    await Deno.symlink(outside, r.paths.session!);
    await assert.rejects(stopVm(r.id, f.home), /Unsafe VM inventory directory/);
    assert.equal(await Deno.readTextFile(join(outside, "keep")), "history");
    await Deno.remove(r.paths.session!);
    await Deno.mkdir(r.paths.session!);
    await Deno.mkdir(r.paths.state);
    await assert.rejects(stopVm(r.id, f.home), /Missing recovery binding/);
    await assert.rejects(removeVm(r.id, f.home), /must be stopped/);
    await writeRecoveryFile(r.paths.session!, "active.json", {
      version: 1,
      token: crypto.randomUUID(),
      state: "/tmp/loom-session-vm-fixture",
      sessionDirectory: r.paths.session,
      smolvm: "/nix/store/" + "a".repeat(32) + "-backend/bin/smolvm",
      recovery: { version: 3, ready: true, reaped: false },
    });
    await assert.rejects(stopVm(r.id, f.home), /different VM instance/);
    await Deno.remove(join(r.paths.session!, "active.json"));
    await Deno.remove(r.paths.state);
    assert.equal((await stopVm(r.id, f.home)).state, "stopped");
    await removeVm(r.id, f.home);
    assert.equal((await listVms(undefined, f.home)).vms.length, 0);
  } finally {
    await owner.finish();
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("bad inventory rows are reported without hiding readable VMs or following symlinks", async () => {
  const f = await fixture();
  const r = f.record();
  const owner = await registerVm(r, f.home);
  try {
    const bad = crypto.randomUUID();
    await Deno.mkdir(join(f.home, bad));
    await Deno.writeTextFile(join(f.home, bad, "record.json"), "{");
    const link = crypto.randomUUID();
    await Deno.symlink(r.repo, join(f.home, link));
    const result = await listVms(undefined, f.home);
    assert.equal(result.vms.length, 1);
    assert.equal(result.errors.length, 2);
    assert.equal((await resolveVm(r.id, undefined, f.home)).id, r.id);
    await assert.rejects(resolveVm(r.id.slice(0, 8), undefined, f.home), /metadata|JSON|directory/);
  } finally {
    await owner.finish();
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("VM CLI validates arguments and has individual command help", async () => {
  for (const command of ["prepare", "list", "inspect", "stop", "rm", "prune"])
    assert.match(await vmCommand(["vm", command, "--help"]), new RegExp("loom vm " + command));
  for (const args of [
    ["list", "extra"],
    ["stop"],
    ["rm", "a", "b"],
    ["list", "--dry-run"],
    ["prepare", "--json"],
    ["stop", "a", "--force"],
    ["list", "--provider", "claude"],
    ["pause", "a"],
  ])
    await assert.rejects(vmCommand(["vm", ...args]));
});

Deno.test("VM CLI lists outside a repo without starting a daemon, and rejects the removed command", async () => {
  const f = await fixture();
  try {
    const cli = fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url));
    const config = fileURLToPath(new URL("../deno.json", import.meta.url));
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--cached-only", "--config", config, "-A", "--deny-net", cli, ...args],
        cwd: f.root,
        env: { XDG_STATE_HOME: join(f.root, "xdg") },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const result = await run(["vm", "list", "--json"]);
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)).vms, []);
    await assert.rejects(Deno.stat(join(f.root, ".loom")), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(join(f.root, "xdg")), Deno.errors.NotFound);
    const old = await run(["environment", "prepare"]);
    assert.notEqual(old.code, 0);
    assert.match(new TextDecoder().decode(old.stderr), /Use loom vm/);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
