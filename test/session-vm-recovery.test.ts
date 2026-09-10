import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { recoverSessionVm } from "../runtime/src/session-vm/recovery.ts";
import { lockSessionState, writeRecoveryFile } from "../runtime/src/session-vm/persistence.ts";
import {
  sessionVmDirectory,
  withStoppedSessionVm,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
const fixture = async () => {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-recovery-test-" }),
  );
  const state = await Deno.realPath(
    await Deno.makeTempDir({
      dir: "/tmp",
      prefix: Deno.build.os === "darwin" ? "loom-svm-" : "loom-session-vm-",
    }),
  );
  const record = {
    version: 1,
    token: crypto.randomUUID(),
    state,
    sessionDirectory: dir,
    gitSocket: join(state, "git-bridge-test/git.sock"),
    smolvm: "/nix/store/00000000000000000000000000000000-smolvm/bin/smolvm",
    recovery: { version: 2, ready: true, reaped: false },
  };
  await Deno.mkdir(join(dir, "profile"));
  await Deno.writeTextFile(join(dir, "profile/history"), "keep");
  await Deno.mkdir(join(dir, "disks"));
  await Deno.writeTextFile(join(dir, "disks/storage.raw"), "keep disk");
  await Deno.mkdir(join(state, "private"));
  await Deno.writeTextFile(join(state, "private/auth.json"), "disposable");
  await Deno.writeTextFile(join(state, "git-bridge-test.stopped"), "");
  const save = async () => {
    await writeRecoveryFile(state, "owner.json", { token: record.token });
    await writeRecoveryFile(dir, "active.json", record);
  };
  await save();
  return {
    dir,
    state,
    record,
    save,
    close: async () => {
      for (const path of [dir, state])
        await Deno.remove(path, { recursive: true }).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
    },
  };
};
test("confirmed cleanup is retryable and retains history", async () => {
  const f = await fixture();
  try {
    f.record.recovery.reaped = true;
    await f.save();
    assert.equal(await recoverSessionVm(f.dir), true);
    assert.equal(await recoverSessionVm(f.dir), false);
    await assert.rejects(Deno.stat(f.state), Deno.errors.NotFound);
    assert.equal(await Deno.readTextFile(join(f.dir, "profile/history")), "keep");
    assert.equal(await Deno.readTextFile(join(f.dir, "disks/storage.raw")), "keep disk");
  } finally {
    await f.close();
  }
});
test("missing state is blocked unless shutdown was already confirmed", async () => {
  const f = await fixture();
  try {
    await Deno.remove(f.state, { recursive: true });
    await assert.rejects(recoverSessionVm(f.dir), /shutdown cannot be confirmed/);
    f.record.recovery.reaped = true;
    await writeRecoveryFile(f.dir, "active.json", f.record);
    assert.equal(await recoverSessionVm(f.dir), true);
  } finally {
    await f.close();
  }
});
test("failed reaping still revokes credentials and keeps the marker", async () => {
  const f = await fixture();
  try {
    await assert.rejects(recoverSessionVm(f.dir), /cleanup incomplete/);
    await assert.rejects(Deno.stat(join(f.state, "private")), Deno.errors.NotFound);
    assert((await Deno.stat(join(f.dir, "active.json"))).isFile);
  } finally {
    await f.close();
  }
});
test("interrupted startup stays blocked even with a Git shutdown acknowledgement", async () => {
  const f = await fixture();
  try {
    f.record.recovery.ready = false;
    await f.save();
    await assert.rejects(recoverSessionVm(f.dir), /startup was interrupted/);
    assert((await Deno.stat(join(f.dir, "active.json"))).isFile);
  } finally {
    await f.close();
  }
});
test("mismatched ownership and substituted paths are never removed", async () => {
  const f = await fixture();
  try {
    f.record.recovery.reaped = true;
    await f.save();
    await writeRecoveryFile(f.state, "owner.json", { token: "another-owner" });
    await assert.rejects(recoverSessionVm(f.dir), /another owner/);
    assert((await Deno.stat(join(f.state, "private/auth.json"))).isFile);
    await f.save();
    await Deno.remove(join(f.state, "private"), { recursive: true });
    await Deno.symlink(join(f.dir, "profile"), join(f.state, "private"));
    await assert.rejects(recoverSessionVm(f.dir), /real directory/);
    assert.equal(await Deno.readTextFile(join(f.dir, "profile/history")), "keep");
    await Deno.remove(join(f.dir, "active.json"));
    await Deno.writeTextFile(join(f.dir, "active.json"), "{");
    await assert.rejects(recoverSessionVm(f.dir));
  } finally {
    await f.close();
  }
});
test("destructive actions retain their ownership lock until they finish", async () => {
  const root = await Deno.makeTempDir();
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  const dir = sessionVmDirectory(root, "locked");
  try {
    (await lockSessionState(dir)).close();
    await withStoppedSessionVm(root, "locked", async () => {
      await assert.rejects(lockSessionState(dir), /still running/);
    });
    (await lockSessionState(dir)).close();
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});
test("a crash after removing the stamp can finish removing an empty reaped directory", async () => {
  const f = await fixture();
  try {
    f.record.recovery.reaped = true;
    await f.save();
    for await (const e of Deno.readDir(f.state))
      await Deno.remove(join(f.state, e.name), { recursive: true });
    assert.equal(await recoverSessionVm(f.dir), true);
    await assert.rejects(Deno.stat(f.state), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});
