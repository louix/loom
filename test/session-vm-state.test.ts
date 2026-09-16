import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  assertNoActiveVm,
  finishSessionState,
  lockSessionState,
} from "../runtime/src/session-vm/persistence.ts";
import {
  sessionVmDirectory,
  stoppedSessionVm,
  vmResumeBlockedReason,
  pruneRepositorySessionDisks,
  recoverRepositoryVms,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
import { startMcpRelay } from "../runtime/src/session-vm/mcp-relay.ts";

test("VM resume preflight blocks both isolation changes without touching history", async () => {
  const root = await Deno.makeTempDir();
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  try {
    const ref = "12345678-1234-1234-1234-123456789abc";
    assert.equal(vmResumeBlockedReason(root, "host", ref, false), undefined);
    assert.match(vmResumeBlockedReason(root, "host", ref, true)!, /Fork/);
    const dir = join(sessionVmDirectory(root, "guest"), "profile/projects/loom-session");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, `${ref}.jsonl`), "history");
    assert.equal(vmResumeBlockedReason(root, "guest", ref, true), undefined);
    assert.match(vmResumeBlockedReason(root, "guest", ref, false)!, /without VM/);
    assert.equal(await Deno.readTextFile(join(dir, `${ref}.jsonl`)), "history");
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});

test("persistent VM ownership blocks cleanup and preserves a newer owner's marker", async () => {
  const root = await Deno.makeTempDir();
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  const dir = sessionVmDirectory(root, "session-1");
  let lock: Deno.FsFile | undefined;
  try {
    assert.throws(() => sessionVmDirectory(root, "../escape"));
    lock = await lockSessionState(dir);
    await Deno.mkdir(join(dir, "profile"));
    await Deno.writeTextFile(join(dir, "profile/history"), "retained");
    await Deno.mkdir(join(dir, "disks"));
    await Deno.writeTextFile(join(dir, "disks/storage.raw"), "retained disk");
    await Deno.writeTextFile(join(dir, "active.json"), JSON.stringify({ token: "first" }));
    await assert.rejects(stoppedSessionVm(root, "session-1", true), /still running/);
    lock.close();
    lock = undefined;
    await assert.rejects(stoppedSessionVm(root, "session-1", true), /manual recovery required/);
    await finishSessionState(dir, "other");
    await assert.rejects(assertNoActiveVm(dir), /cleanup is incomplete/);
    await finishSessionState(dir, "first");
    await stoppedSessionVm(root, "session-1");
    assert.equal(await Deno.readTextFile(join(dir, "profile/history")), "retained");
    await assert.rejects(Deno.stat(join(dir, "disks")), Deno.errors.NotFound);
    await stoppedSessionVm(root, "session-1", true);
    await assert.rejects(Deno.stat(join(dir, "profile")), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(join(dir, "disks")), Deno.errors.NotFound);
    assert((await Deno.stat(join(dir, "owner.lock"))).isFile);
  } finally {
    lock?.close();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});

test("MCP socket forwards to its fixed loopback endpoint and shutdown disconnects clients", async () => {
  const dir = await Deno.makeTempDir();
  const host = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const relay = startMcpRelay(join(dir, "mcp.sock"), host.addr.port);
  let client: Deno.UnixConn | undefined, upstream: Deno.TcpConn | undefined;
  try {
    client = await Deno.connect({ transport: "unix", path: join(dir, "mcp.sock") });
    upstream = await host.accept();
    await client.write(new TextEncoder().encode("request with bearer header"));
    const buf = new Uint8Array(100);
    const size = await upstream.read(buf);
    assert.equal(new TextDecoder().decode(buf.subarray(0, size!)), "request with bearer header");
    await upstream.write(new TextEncoder().encode("response"));
    assert.equal(new TextDecoder().decode(buf.subarray(0, (await client.read(buf))!)), "response");
    await relay.close();
    assert.equal(await client.read(buf), null);
  } finally {
    await relay.close();
    for (const conn of [client, upstream])
      try {
        conn?.close();
      } catch {
        /*closed*/
      }
    host.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test("session disk pruning preserves live VMs, recovery state, symlink targets and history", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  let owner: Deno.FsFile | undefined;
  const makeSession = async (id: string) => {
    const dir = sessionVmDirectory(root, id);
    await Deno.mkdir(join(dir, "disks"), { recursive: true });
    await Deno.writeTextFile(join(dir, "disks/storage.raw"), "disk data");
    await Deno.mkdir(join(dir, "profile"));
    await Deno.writeTextFile(join(dir, "profile/history"), "conversation");
    return dir;
  };
  try {
    const stopped = await makeSession("stopped");
    const live = await makeSession("live");
    const crashed = await makeSession("crashed");
    const outside = await makeSession("outside");
    owner = await lockSessionState(live);
    await Deno.writeTextFile(join(crashed, "active.json"), "{}");
    await Deno.mkdir(join(stopped, ".disk-init-abandoned"));
    await Deno.writeTextFile(join(stopped, ".disk-init-abandoned/storage.raw"), "partial copy");
    await Deno.symlink("/missing-runtime", join(stopped, "disk-runtime-root"));
    await Deno.writeTextFile(join(stopped, "unrelated"), "keep");

    // Use a target outside the scanned session directory for the symlink check.
    const target = join(root, "outside");
    await Deno.rename(outside, target);
    await Deno.symlink(target, sessionVmDirectory(root, "linked"));
    assert.deepEqual(await pruneRepositorySessionDisks(root), {
      sessionDisksRemoved: 1,
      sessionDisksRetained: 3,
    });
    for (const dir of [live, crashed, target]) {
      assert.equal(await Deno.readTextFile(join(dir, "disks/storage.raw")), "disk data");
    }
    for (const name of ["disks", ".disk-init-abandoned", "disk-runtime-root"]) {
      await assert.rejects(Deno.lstat(join(stopped, name)), Deno.errors.NotFound);
    }
    assert.equal(await Deno.readTextFile(join(stopped, "profile/history")), "conversation");
    assert.equal(await Deno.readTextFile(join(stopped, "unrelated")), "keep");
    assert((await Deno.stat(join(stopped, "owner.lock"))).isFile);

    owner.close();
    owner = undefined;
    assert.equal((await pruneRepositorySessionDisks(root)).sessionDisksRemoved, 1);
    assert.equal((await pruneRepositorySessionDisks(root)).sessionDisksRemoved, 0);
  } finally {
    owner?.close();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});

test("startup migrates stopped session disks without marking the session interrupted", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  try {
    const dir = sessionVmDirectory(root, "old-session");
    await Deno.mkdir(join(dir, "disks"), { recursive: true });
    await Deno.writeTextFile(join(dir, "disks/storage.raw"), "legacy disk");
    await Deno.mkdir(join(dir, "profile"));
    await Deno.writeTextFile(join(dir, "profile/history"), "conversation");
    const errors: unknown[] = [];
    assert.equal((await recoverRepositoryVms(root, (_, error) => errors.push(error))).size, 0);
    assert.deepEqual(errors, []);
    await assert.rejects(Deno.stat(join(dir, "disks")), Deno.errors.NotFound);
    assert.equal(await Deno.readTextFile(join(dir, "profile/history")), "conversation");
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});
