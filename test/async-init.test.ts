import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runSessionInit } from "../core/src/session-init.ts";
import { executeShellHook } from "../core/src/shell-hook.ts";
import type { CreateSessionOptions } from "@loom/core/types";
import { normalizeConfig, parseConfig } from "@loom/daemon/config/config";
import { claudeInitHooks } from "../connectors/claude/src/init-hooks.ts";
import { BackgroundTasks, type BackgroundReadResult } from "@loom/aisdk/tools/background";

const options = (cwd: string): CreateSessionOptions => ({
  sessionId: "init-test",
  cwd,
  prompt: "work",
  mode: "default",
  mcpServers: [],
});
const until = async (ready: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 5000;
  while (!(await ready())) {
    assert(Date.now() < end, "Timed out");
    await delay(10);
  }
};

test("async init is opt-in and cannot be applied to other hook events", () => {
  const config = (hook: unknown) => normalizeConfig(parseConfig(JSON.stringify({ hooks: [hook] })));
  assert.equal(config({ on: "workspace_start", run: "install" }).hooks[0]?.async, false);
  assert.equal(
    config({ on: "workspace_start", run: "install", async: true }).hooks[0]?.async,
    true,
  );
  for (const on of ["file_write", "workspace_prepare", ["workspace_start", "turn_end"]]) {
    assert.throws(
      () => config({ on, run: "install", async: true }),
      /async is only supported for workspace_start/,
    );
  }
});

test("blocking init finishes first and only async hooks are handed to the connector", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const opts = {
      ...options(cwd),
      initHooks: {
        env: {},
        hooks: [
          { name: "sync", run: "echo ready > ready", timeoutMs: 1000 },
          { name: "async", run: "echo later > later", timeoutMs: 1000, async: true },
          { name: "bad", run: "echo broken; exit 1", timeoutMs: 1000 },
        ],
      },
    };
    const ready = await runSessionInit(opts, () => {}, new AbortController().signal);
    assert.equal((await Deno.readTextFile(join(cwd, "ready"))).trim(), "ready");
    await assert.rejects(Deno.stat(join(cwd, "later")), Deno.errors.NotFound);
    assert.deepEqual(
      ready.initHooks?.hooks.map((h) => h.name),
      ["async"],
    );
    assert.match(ready.prompt, /broken/);
    assert.equal(opts.initHooks.hooks.length, 3);
    const fallback = await runSessionInit(
      ready,
      () => {},
      new AbortController().signal,
      undefined,
      false,
    );
    assert.equal(fallback.initHooks, undefined);
    assert.equal((await Deno.readTextFile(join(cwd, "later"))).trim(), "later");
    const oneShot = await runSessionInit(
      { ...opts, oneShot: true },
      () => {},
      new AbortController().signal,
    );
    assert.equal(oneShot.initHooks, undefined);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

test("AI SDK init survives interruption, reports completion without consuming output, and closes", async () => {
  const cwd = await Deno.makeTempDir();
  const bg = new BackgroundTasks(cwd);
  try {
    const completed = Promise.withResolvers<BackgroundReadResult>();
    const id = bg.start(
      'while [ ! -f release ]; do sleep 0.02; done; printf "%s" "$INIT_VALUE"; exit 7',
      5000,
      {
        env: { INIT_VALUE: "literal '$value" },
        shell: "sh",
        keepOnInterrupt: true,
        onComplete: completed.resolve,
      },
    );
    const regular = bg.start("sleep 60");
    await bg.stopAll(true);
    assert.equal((await bg.read(regular, { waitMs: 0 })).running, false);
    assert.equal((await bg.read(id, { waitMs: 0 })).running, true);
    await Deno.writeTextFile(join(cwd, "release"), "");
    const report = await completed.promise;
    assert.equal(report.exitCode, 7);
    assert.equal(report.output, "literal '$value");
    assert.equal((await bg.read(id)).output, report.output);
    const closed = Promise.withResolvers<BackgroundReadResult>();
    bg.start("sleep 60", 0, { keepOnInterrupt: true, onComplete: closed.resolve });
    bg.close();
    assert.equal((await closed.promise).running, false);
  } finally {
    bg.close();
    await Deno.remove(cwd, { recursive: true });
  }
});

test("AI SDK init timeout is reported once", async () => {
  const cwd = await Deno.makeTempDir();
  const bg = new BackgroundTasks(cwd);
  try {
    const reports: BackgroundReadResult[] = [];
    bg.start("sleep 60 & wait", 100, { keepOnInterrupt: true, onComplete: (r) => reports.push(r) });
    await until(() => reports.length > 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.timedOut, true);
  } finally {
    bg.close();
    await Deno.remove(cwd, { recursive: true });
  }
});

test("Claude async wrapper preserves shell data, bounds output, and runs only once", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "loom-init-'quoted-" });
  try {
    const run =
      'printf "%s\\n" "$INIT_VALUE" "$LOOM_HOOK_EVENT" "$LOOM_SESSION_ID"; echo once >> count; head -c 12000 /dev/zero; exit 7';
    const init = claudeInitHooks(
      {
        ...options(cwd),
        initHooks: {
          env: { INIT_VALUE: "literal ' $(touch injected)" },
          hooks: [{ name: "quoted ' hook", run, timeoutMs: 2000, async: true }],
        },
      },
      cwd,
    );
    assert.match(init.context, /Initialization is running:/);
    const settings = init.settings;
    const hook = settings.hooks.SessionStart[0]!.hooks[0]!;
    assert.equal(hook.async, true);
    const execute = () =>
      executeShellHook(hook.command, cwd, Deno.env.toObject(), 5000, new AbortController().signal);
    const result = await execute();
    const context = JSON.parse(result.output).hookSpecificOutput.additionalContext;
    assert.match(context, /Initialization failed/);
    assert.equal((await Deno.readTextFile(join(cwd, "0.status"))).trim(), "7");
    const output = await Deno.readTextFile(join(cwd, "0.log"));
    assert(output.startsWith("literal ' $(touch injected)\nworkspace_start\ninit-test"));
    assert.equal((await Deno.stat(join(cwd, "0.log"))).size, 8000);
    await assert.rejects(Deno.stat(join(cwd, "injected")), Deno.errors.NotFound);
    await execute();
    assert.equal((await Deno.readTextFile(join(cwd, "count"))).trim(), "once");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

test("Claude async wrapper enforces its timeout and returns JSON feedback", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const init = claudeInitHooks(
      {
        ...options(cwd),
        initHooks: {
          env: {},
          hooks: [{ name: "slow", run: "sleep 60 & wait", timeoutMs: 100, async: true }],
        },
      },
      cwd,
    );
    const settings = init.settings;
    const result = await executeShellHook(
      settings.hooks.SessionStart[0]!.hooks[0]!.command,
      cwd,
      Deno.env.toObject(),
      5000,
      new AbortController().signal,
    );
    assert.equal(result.timedOut, false);
    assert.match(JSON.parse(result.output).hookSpecificOutput.additionalContext, /timed out/);
    assert.equal((await Deno.readTextFile(join(cwd, "0.status"))).trim(), "124");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
