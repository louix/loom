import assert from "node:assert/strict";
import { test } from "node:test";
import { HookRunner, hookSessionOf } from "../backend/daemon/src/daemon/hooks.ts";
import { runSessionCommand } from "../backend/daemon/src/daemon/session-command.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { SessionSnapshot } from "../core/src/wire.ts";

test("checks enter the session VM for mounted worktrees and private clones", async () => {
  for (const checkout of ["worktree", "clone"] as const) {
    const session = {
      id: "vm",
      isolation: "vm",
      checkout,
      inPlace: false,
      worktree: "/host/worktree",
      title: null,
      provider: "fake",
      model: null,
      branch: null,
      status: { kind: "idle" },
    } as SessionSnapshot;
    const calls: Record<string, string>[] = [];
    const errors: string[] = [];
    const runner = new HookRunner({
      repoRoot: "/host/repo",
      log: makeLogger("test"),
      onFeedback: async (_id, text) => {
        errors.push(text);
      },
      onNotice: (text) => {
        errors.push(text);
      },
      runSession: (_session, command, env, timeoutMs, signal) =>
        runSessionCommand({
          session,
          command,
          env,
          timeoutMs,
          signal,
          repoRoot: "/host/repo",
          localEnvironment: () => assert.fail("VM check read the host environment"),
          runGuest: async (snap, cmd, timeout, stop, overrides) => {
            assert.equal(snap, session);
            assert.equal(cmd, "project-only-tool");
            assert.equal(timeout, 30000);
            assert.equal(stop.aborted, false);
            calls.push(overrides);
            return { code: 0, output: "", timedOut: false };
          },
        }),
    });
    runner.setHooks(
      normalizeConfig({ hooks: [{ kind: "check", on: "file_write", run: "project-only-tool" }] })
        .hooks,
    );
    try {
      const hookSession = hookSessionOf(session);
      const cwd = hookSession.guestCwd ?? session.worktree!;
      runner.fire("file_write", hookSession, { files: [cwd + "/a.ts"] });
      const deadline = Date.now() + 3000;
      while (runner.isRunning(session.id)) {
        assert.ok(Date.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(errors, []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.LOOM_WORKTREE, cwd);
      assert.equal(calls[0]!.LOOM_FILE, cwd + "/a.ts");
      assert.equal(calls[0]!.PATH, undefined, "host PATH must not overwrite guest activation");
    } finally {
      runner.close();
    }
  }
});

test("session commands support local in-place sessions and fail without their environment", async () => {
  const cwd = await Deno.makeTempDir();
  const session = {
    id: "local",
    isolation: "local",
    inPlace: true,
    worktree: null,
  } as SessionSnapshot;
  const options = {
    session,
    repoRoot: cwd,
    command: 'printf "%s/%s" "$PWD" "$LOOM_HOOK"',
    env: { LOOM_HOOK: "check" },
    timeoutMs: 1000,
    signal: new AbortController().signal,
    localEnvironment: () => ({ set: { LOOM_HOOK: "wrong" }, unset: [] }),
    runGuest: async () => assert.fail("local command entered VM"),
  };
  try {
    const result = await runSessionCommand(options);
    assert.equal(result.code, 0);
    assert.equal(result.output, cwd + "/check");
    await assert.rejects(
      runSessionCommand({
        ...options,
        localEnvironment: () => {
          throw new Error("environment unavailable");
        },
      }),
      /environment unavailable/,
    );
    await assert.rejects(
      runSessionCommand({
        ...options,
        session: { ...session, inPlace: false },
      }),
      /workspace is unavailable/,
    );
    await assert.rejects(
      runSessionCommand({
        ...options,
        session: { ...session, isolation: "vm" },
        runGuest: async () => {
          throw new Error("VM stopped");
        },
      }),
      /VM stopped/,
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
