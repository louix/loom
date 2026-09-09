import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { bootId, processIdentity, stopProcess } from "../runtime/src/session-vm/process.ts";
import { recoverSessionVm } from "../runtime/src/session-vm/recovery.ts";
import { lockSessionState, writeRecoveryFile } from "../runtime/src/session-vm/persistence.ts";
import {
  sessionVmDirectory,
  withStoppedSessionVm,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
const fixture = async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-recovery-test-" });
  const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-session-vm-" });
  const record = {
    version: 1,
    token: crypto.randomUUID(),
    state,
    sessionDirectory: dir,
    gitSocket: join(state, "git.sock"),
    smolvm: "/nix/store/00000000000000000000000000000000-smolvm/bin/smolvm",
    recovery: { version: 1, bootId: await bootId(), processes: [], reaped: false },
  };
  await Deno.mkdir(join(dir, "profile"));
  await Deno.writeTextFile(join(dir, "profile/history"), "keep");
  await Deno.mkdir(join(state, "private"));
  await Deno.writeTextFile(join(state, "private/auth.json"), "disposable");
  const save = async () => {
    await writeRecoveryFile(state, "owner.json", {
      token: record.token,
      bootId: record.recovery.bootId,
    });
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
test("previous-boot recovery retains history and never executes the old reaper", async () => {
  const f = await fixture();
  try {
    f.record.recovery.bootId = crypto.randomUUID();
    await f.save();
    assert.equal(await recoverSessionVm(f.dir), true);
    assert.equal(await recoverSessionVm(f.dir), false);
    await assert.rejects(Deno.stat(f.state), Deno.errors.NotFound);
    assert.equal(await Deno.readTextFile(join(f.dir, "profile/history")), "keep");
  } finally {
    await f.close();
  }
});
test("missing current-boot state fails closed; reboot or a durable reaped marker permits recovery", async () => {
  for (const reaped of [false, true]) {
    const f = await fixture();
    try {
      f.record.recovery.reaped = reaped;
      await f.save();
      await Deno.remove(f.state, { recursive: true });
      if (reaped) assert.equal(await recoverSessionVm(f.dir), true);
      else {
        await assert.rejects(recoverSessionVm(f.dir), /shutdown cannot be confirmed/);
        f.record.recovery.bootId = crypto.randomUUID();
        await writeRecoveryFile(f.dir, "active.json", f.record);
        assert.equal(await recoverSessionVm(f.dir), true);
      }
    } finally {
      await f.close();
    }
  }
});
test("failed reaping still revokes credentials and retains recovery metadata for retry", async () => {
  const f = await fixture();
  try {
    await assert.rejects(recoverSessionVm(f.dir), /cleanup incomplete/);
    await assert.rejects(Deno.stat(join(f.state, "private")), Deno.errors.NotFound);
    assert((await Deno.stat(join(f.dir, "active.json"))).isFile);
    f.record.recovery.reaped = true;
    await f.save();
    await recoverSessionVm(f.dir);
  } finally {
    await f.close();
  }
});
test("mismatched ownership and substituted paths are never removed", async () => {
  const f = await fixture();
  try {
    f.record.recovery.bootId = crypto.randomUUID();
    await f.save();
    await writeRecoveryFile(f.state, "owner.json", {
      token: "someone-else",
      bootId: f.record.recovery.bootId,
    });
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
test("process start-time mismatch leaves the process alive; matching identity is reaped", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise(()=>{})"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    const identity = await processIdentity(child.pid);
    assert(identity);
    await stopProcess({ ...identity, start: String(BigInt(identity.start) + 1n) });
    assert(await processIdentity(child.pid));
    await stopProcess(identity);
    await child.status;
    assert.equal(await processIdentity(child.pid), undefined);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /*gone*/
    }
    await child.status;
  }
});
test("destructive actions retain the same ownership lock until they finish", async () => {
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

test("a crash after removing the ownership stamp can finish removing an empty reaped directory", async () => {
  const f = await fixture();
  try {
    f.record.recovery.reaped = true;
    await f.save();
    await Deno.remove(join(f.state, "private"), { recursive: true });
    await Deno.remove(join(f.state, "owner.json"));
    assert.equal(await recoverSessionVm(f.dir), true);
    await assert.rejects(Deno.stat(f.state), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});

test("verified helper group cleanup also stops native descendants", async () => {
  const { spawn } = await import("node:child_process");
  const parent = spawn(
    Deno.execPath(),
    [
      "eval",
      'const child=new Deno.Command(Deno.execPath(),{args:["eval","await new Promise(()=>{})"],stdout:"null",stderr:"null"}).spawn();console.log(child.pid);await child.status;',
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
  const pid = Number(
    await new Promise<string>((resolve, reject) => {
      parent.stdout.once("data", (data) => resolve(String(data).trim()));
      parent.once("error", reject);
    }),
  );
  const owner = await processIdentity(parent.pid!);
  const descendant = await processIdentity(pid);
  assert(owner && descendant);
  assert.equal(owner.group, owner.pid);
  assert.equal(descendant.group, owner.group);
  try {
    await stopProcess(owner);
    await exited;
    assert.equal(await processIdentity(pid), undefined);
  } finally {
    await stopProcess(descendant);
    await stopProcess(owner);
    await exited;
  }
});
