import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import type { FakeProvider } from "@loom/connector-mock";
import type { SessionSnapshot } from "@loom/core/wire";
import type { SessionShell } from "../core/src/shell.ts";
import { shellEnvironment } from "../runtime/src/session-vm/shell.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

test("shell leases select the workspace, protect it, and release on exit or disconnect", async () => {
  const h = await makeHarness();
  const connect = () =>
    LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
      reconnect: false,
    });
  const c = await connect();
  const other = await connect();
  try {
    for (const worktree of [false, true]) {
      const s = await c.request<SessionSnapshot>("session.create", {
        provider: "fake",
        prompt: "work",
        worktree,
      });
      ((await h.daemon.providers.get("fake")) as FakeProvider).session(s.id)!.finishTurn();
      for (let n = 0; n < 100 && h.daemon.registry.get(s.id)?.status.kind === "starting"; n++)
        await delay(10);
      const target = await c.request<SessionShell>("session.openShell", { id: s.id });
      assert.equal(target.cwd, worktree ? s.worktree : h.repoRoot);
      assert.equal(target.isolation, "local");
      assert.equal(target.vm, undefined);
      await assert.rejects(
        other.request("session.closeShell", { token: target.token }),
        /another connection/,
      );
      for (const method of ["session.markDone", "session.remove"])
        await assert.rejects(other.request(method, { id: s.id, force: true }), /open shells/);
      const second = await c.request<SessionShell>("session.openShell", { id: s.id });
      await c.request("session.closeShell", { token: target.token });
      await assert.rejects(other.request("session.markDone", { id: s.id }), /open shells/);
      await c.request("session.closeShell", { token: second.token });
      await other.request("session.markDone", { id: s.id });
      if (worktree)
        await assert.rejects(c.request("session.openShell", { id: s.id }), /no workspace/);
    }
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "disconnect",
    });
    ((await h.daemon.providers.get("fake")) as FakeProvider).session(s.id)!.finishTurn();
    for (let n = 0; n < 100 && h.daemon.registry.get(s.id)?.status.kind === "starting"; n++)
      await delay(10);
    await c.request("session.openShell", { id: s.id });
    await c.close();
    for (let attempt = 0; ; attempt++) {
      try {
        await other.request("session.remove", { id: s.id });
        break;
      } catch (error) {
        if (attempt === 50) throw error;
        await delay(10);
      }
    }
    await assert.rejects(other.request("session.openShell", { id: "missing" }), /no such session/);
  } finally {
    await c.close();
    await other.close();
    await h.cleanup();
  }
});

test("VM shell targets use the existing VM for both checkout layouts and never fall back to host", async () => {
  const stateRoot = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-shell-test-" });
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", stateRoot);
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    for (const worktree of [false, true]) {
      const s = await c.request<SessionSnapshot>("session.create", {
        provider: "fake",
        prompt: "vm",
        worktree,
      });
      ((await h.daemon.providers.get("fake")) as FakeProvider).session(s.id)!.finishTurn();
      for (let n = 0; n < 100 && h.daemon.registry.get(s.id)?.status.kind === "starting"; n++)
        await delay(10);
      h.daemon.db.prepare("UPDATE sessions SET isolation = ? WHERE id = ?").run("vm", s.id);
      await assert.rejects(c.request("session.openShell", { id: s.id }), /VM is not running/);
      const dir = sessionVmDirectory(h.repoRoot, s.id);
      await Deno.mkdir(dir, { recursive: true });
      const record = {
        version: 1,
        token: crypto.randomUUID(),
        sessionDirectory: dir,
        state: "/tmp/loom-session-vm-test",
        smolvm: "/nix/store/00000000000000000000000000000000-smolvm/bin/smolvm",
        workspace: await Deno.realPath(s.worktree ?? h.repoRoot),
        recovery: { version: 3, ready: true, reaped: false },
      };
      await Deno.writeTextFile(join(dir, "active.json"), JSON.stringify(record));
      const target = await c.request<SessionShell>("session.openShell", { id: s.id });
      assert.equal(target.isolation, "vm");
      assert.equal(target.vm?.executable, record.smolvm);
      assert.deepEqual(target.vm?.args.slice(0, 8), [
        "machine",
        "exec",
        "--name",
        "loom-session",
        "-i",
        "-t",
        "-w",
        record.workspace,
      ]);
      assert.equal(target.vm?.env.HOME, join(record.state, "home"));
      await c.request("session.closeShell", { token: target.token });
      record.workspace = "/wrong-workspace";
      await Deno.writeTextFile(join(dir, "active.json"), JSON.stringify(record));
      await assert.rejects(c.request("session.openShell", { id: s.id }), /different workspace/);
      await Deno.remove(join(dir, "active.json"));
    }
  } finally {
    await c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(stateRoot, { recursive: true });
  }
});

test("guest shell environment round-trips shell metacharacters without executing them", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const value = "quotes ' and \" plus $(touch injected) `touch injected`\nnext line";
    const file = join(dir, "env.sh");
    await Deno.writeTextFile(
      file,
      shellEnvironment({ EXAMPLE: value, TERM: "wrong", "BAD;KEY": "no", PWD: "/wrong" }),
    );
    const output = await new Deno.Command("/bin/sh", {
      args: ["-c", '. "$1"; printf "%s" "$EXAMPLE"; test "$TERM" = terminal', "shell-test", file],
      env: { TERM: "terminal" },
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success);
    assert.equal(new TextDecoder().decode(output.stdout), value);
    await assert.rejects(Deno.stat(join(dir, "injected")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
