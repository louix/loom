import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig } from "@loom/daemon/config/config";
import { LoomClient } from "@loom/client";
import type { PushFrame, SessionSnapshot } from "@loom/core/wire";
import { writtenPaths } from "@loom/core/tool-paths";
import { lintConfig, normalizeConfig } from "@loom/daemon/config/config";
import { HookRunner, matchGlob } from "@loom/daemon/daemon/hooks";
import { makeLogger } from "@loom/core/logger";
import type { FakeProvider } from "@loom/connector-mock";
import { makeHarness } from "@loom/harness";

const cfg = (toml: string) => normalizeConfig(parseConfig(toml || "{}"));

const until = async (ready: () => boolean | Promise<boolean>): Promise<void> => {
  const end = Date.now() + 3000;
  while (!(await ready())) {
    assert.ok(Date.now() < end, "timed out waiting for hook");
    await delay(10);
  }
};

// --- writtenPaths -------------------------------------------------------------

test("writtenPaths names the file for every connector's editor, and nothing for a read", () => {
  assert.deepEqual(writtenPaths("Write", { file_path: "/a/b.ts" }), ["/a/b.ts"]);
  assert.deepEqual(writtenPaths("Edit", { file_path: "/a/b.ts" }), ["/a/b.ts"]);
  assert.deepEqual(writtenPaths("MultiEdit", { file_path: "/a/b.ts" }), ["/a/b.ts"]);
  // the aisdk engine's lowercase tools, and an MCP tool arriving namespaced
  assert.deepEqual(writtenPaths("edit", { path: "src/x.ts" }), ["src/x.ts"]);
  assert.deepEqual(writtenPaths("mcp__tilth__tilth_edit", { path: "src/x.ts" }), ["src/x.ts"]);
  // reads and searches write nothing — a lint hook must not fire on them
  for (const name of ["Read", "Grep", "Bash", "mcp__tilth__tilth_read"]) {
    assert.deepEqual(writtenPaths(name, { file_path: "/a/b.ts" }), [], name);
  }
});

test("writtenPaths unpacks tilth_write's batch, de-duplicated", () => {
  const input = { files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }, { junk: 1 }] };
  assert.deepEqual(writtenPaths("mcp__tilth__tilth_write", input), ["a.ts", "b.ts"]);
  // a batch write with no usable entries is "not a write", not "wrote nothing"
  assert.deepEqual(writtenPaths("mcp__tilth__tilth_write", { files: [] }), []);
  assert.deepEqual(writtenPaths("Write", "not an object"), []);
  assert.deepEqual(writtenPaths("NotebookEdit", { notebook_path: "a.ipynb" }), ["a.ipynb"]);
  assert.deepEqual(writtenPaths("apply_patch", { changes: [{ path: "a.ts" }, { path: "b.ts" }] }), [
    "a.ts",
    "b.ts",
  ]);
});

test("same-named hooks run independently and overlapping writes retain every path", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp" });
  const output = join(dir, "output");
  const started = join(dir, "started");
  const release = join(dir, "release");
  const other = join(dir, "other");
  const runner = new HookRunner({
    repoRoot: dir,
    log: makeLogger("test"),
    onFeedback: async () => assert.fail("notification sent feedback"),
    onNotice: () => {},
  });
  const session = {
    id: "s",
    title: null,
    provider: "fake",
    model: null,
    status: "running",
    worktree: dir,
    branch: null,
  };
  runner.setHooks(
    cfg(`{
  "hooks": [
    {
      "on": "file_write",
      "run": "sh -c 'touch ${started}; while ! test -e ${release}; do sleep 0.01; done; echo \\"$LOOM_FILE\\" >> ${output}'"
    },
    {
      "on": "file_write",
      "run": "sh -c 'touch ${other}'"
    }
  ]
}`).hooks,
  );
  try {
    runner.fire("file_write", session, { files: [join(dir, "a.ts")] });
    await until(() => existsSync(started) && existsSync(other));
    runner.fire("file_write", session, { files: [join(dir, "b.ts"), join(dir, "a.ts")] });
    runner.fire("file_write", session, { files: [join(dir, "b.ts")] });
    writeFileSync(release, "");
    await until(
      () => existsSync(output) && readFileSync(output, "utf8").trim().split("\n").length === 3,
    );
    assert.deepEqual(
      readFileSync(output, "utf8").trim().split("\n"),
      ["a.ts", "b.ts", "a.ts"].map((p) => join(dir, p)),
    );
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test("a failing turn_end notification never starts another agent turn", async () => {
  let notices = 0;
  const runner = new HookRunner({
    repoRoot: "/tmp",
    log: makeLogger("test"),
    onFeedback: async () => assert.fail("notification sent feedback"),
    onNotice: () => {
      notices++;
    },
  });
  runner.setHooks(
    cfg(`{
  "hooks": [
    {
      "on": "turn_end",
      "run": "exit 1"
    }
  ]
}`).hooks,
  );
  try {
    runner.turnEnded({
      id: "s",
      title: null,
      provider: "fake",
      model: null,
      status: "idle",
      worktree: null,
      branch: null,
    });
    await until(() => notices === 1);
  } finally {
    runner.close();
  }
});

test("waiting, removal, reload, and shutdown invalidate feedback waiting for delivery", async () => {
  for (const action of ["waiting", "removal", "reload", "shutdown"]) {
    const delivery = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const runner = new HookRunner({
      repoRoot: "/tmp",
      log: makeLogger("test"),
      runSession: async () => ({ code: 1, output: "", timedOut: false }),
      onFeedback: async (_id, _text, pending) => {
        signal = pending;
        await delivery.promise;
      },
      onNotice: () => {},
    });
    runner.setHooks(
      cfg(`{
  "hooks": [
    {
      "kind": "check",
      "on": "turn_end",
      "run": "exit 1"
    }
  ]
}`).hooks,
    );
    const session = {
      id: "s",
      title: null,
      provider: "fake",
      model: null,
      status: "idle",
      worktree: null,
      branch: null,
    };
    try {
      runner.turnEnded(session);
      await until(() => signal !== undefined);
      switch (action) {
        case "waiting":
          runner.waiting(session, "permission");
          break;
        case "removal":
          runner.forget(session.id);
          break;
        case "reload":
          runner.setHooks([]);
          break;
        case "shutdown":
          runner.close();
          break;
      }
      assert.equal(signal?.aborted, true, action);
    } finally {
      delivery.resolve();
      runner.close();
    }
  }
});

test("interrupt kills a pending checker and prevents feedback from restarting the session", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp" });
  const started = join(dir, "started"),
    release = join(dir, "release"),
    completed = join(dir, "completed");
  const h = await makeHarness({
    config: `{
  "hooks": [
    {
      "kind": "check",
      "on": "file_write",
      "run": "touch ${started}; while ! test -e ${release}; do sleep 0.01; done; touch ${completed}; echo bad; exit 1"
    }
  ]
}`,
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      prompt: "edit",
      provider: "fake",
    });
    const f = ((await h.daemon.providers.get("fake")) as FakeProvider).session(s.id)!;
    f.emit({ type: "tool_call", id: "w", name: "Write", input: { file_path: "a.ts" } });
    f.emit({ type: "tool_result", id: "w", ok: true, output: "ok" });
    await until(() => existsSync(started));
    await c.request("session.interrupt", { id: s.id });
    writeFileSync(release, "");
    await delay(150);
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id: s.id })).status.kind,
      "interrupted",
    );
    assert.ok(!existsSync(completed), "cancelled command must not continue editing files");
  } finally {
    await c.close();
    await h.cleanup();
    await Deno.remove(dir, { recursive: true });
  }
});

// --- matchGlob ----------------------------------------------------------------

test("matchGlob: * stops at a separator, ** crosses it, and ** / matches zero dirs", () => {
  assert.ok(matchGlob("*.ts", "a.ts"));
  assert.ok(!matchGlob("*.ts", "src/a.ts"), "* must not cross a separator");
  assert.ok(matchGlob("**/*.ts", "src/deep/a.ts"));
  assert.ok(matchGlob("**/*.ts", "a.ts"), "**/ also matches zero directories");
  assert.ok(!matchGlob("**/*.ts", "a.js"));
  assert.ok(matchGlob("/home/u/dev/**", "/home/u/dev/loom"));
  assert.ok(!matchGlob("/home/u/dev/**", "/home/u/other"));
  // a plain path is an equality test, and regex metacharacters are literal
  assert.ok(matchGlob("/home/u/a.b", "/home/u/a.b"));
  assert.ok(!matchGlob("/home/u/a.b", "/home/u/axb"));
});

// --- [[hooks]] parsing --------------------------------------------------------

test("[[hooks]] parses a full entry; `on` takes a bare string or a list", () => {
  const c = cfg(`{
  "hooks": [
    {
      "name": "lint",
      "on": [
        "turn_end",
        "file_write"
      ],
      "run": "deno task lint",
      "project": "/tmp/x",
      "match": [
        "**/*.ts"
      ],
      "timeout": 5
    },
    {
      "on": "waiting",
      "run": "notify-send loom"
    }
  ]
}`);
  assert.equal(c.hooks.length, 2);
  const lint = c.hooks[0]!;
  assert.deepEqual(lint.on, ["turn_end", "file_write"]);
  assert.equal(lint.run, "deno task lint");
  assert.equal(lint.project, "/tmp/x");
  assert.deepEqual(lint.match, ["**/*.ts"]);
  assert.equal(lint.timeoutMs, 5_000);
  const notify = c.hooks[1]!;
  assert.deepEqual(notify.on, ["waiting"]);
  assert.equal(notify.name, "notify-send", "name defaults to run's first word");
  assert.equal(notify.timeoutMs, 30_000, "default timeout");
  assert.deepEqual(notify.match, []);
  assert.equal(notify.project, "", "no project = every repo");
});

test("[[hooks]] rejects invalid entries and clamps timeout", () => {
  assert.throws(
    () =>
      cfg(`{
  "hooks": [
    {
      "on": "turn_end"
    }
  ]
}`),
    /run/,
  );
  assert.throws(
    () =>
      cfg(`{
  "hooks": [
    {
      "run": "x"
    }
  ]
}`),
    /on/,
  );
  assert.throws(
    () =>
      cfg(`{
  "hooks": [
    {
      "on": "typo",
      "run": "x"
    }
  ]
}`),
    /on/,
  );
  assert.throws(
    () =>
      cfg(`{
  "hooks": [
    {
      "on": [
        "waiting",
        "typo"
      ],
      "run": "x"
    }
  ]
}`),
    /on/,
  );
  assert.throws(
    () =>
      cfg(`{
  "hooks": [
    {
      "kind": "check",
      "on": "waiting",
      "run": "x"
    }
  ]
}`),
    /check hook/,
  );
  assert.throws(
    () =>
      cfg(`{
  "hooks": [
    {
      "kind": "typo",
      "on": "waiting",
      "run": "x"
    }
  ]
}`),
    /kind/,
  );
  // de-duped, so a repeated event doesn't double-fire
  assert.deepEqual(
    cfg(`{
  "hooks": [
    {
      "on": [
        "waiting",
        "waiting"
      ],
      "run": "x"
    }
  ]
}`).hooks[0]?.on,
    ["waiting"],
  );
  assert.equal(
    cfg(`{
  "hooks": [
    {
      "on": "waiting",
      "run": "x",
      "timeout": 0
    }
  ]
}`).hooks[0]?.timeoutMs,
    1_000,
  );
  assert.equal(
    cfg(`{
  "hooks": [
    {
      "on": "waiting",
      "run": "x",
      "timeout": 99999
    }
  ]
}`).hooks[0]?.timeoutMs,
    3_600_000,
  );
});

test("lintConfig flags a hook command that isn't on PATH and a match that can't apply", () => {
  const c = cfg(`{
  "hooks": [
    {
      "on": "waiting",
      "run": "definitely-not-a-real-binary --toast"
    },
    {
      "name": "dead-filter",
      "on": "waiting",
      "match": [
        "**/*.ts"
      ],
      "run": "sh -c true"
    }
  ]
}`);
  const warnings = lintConfig(c, {}).join("\n");
  assert.match(warnings, /definitely-not-a-real-binary` is not on the daemon's PATH/);
  assert.match(warnings, /dead-filter.*match.* does nothing for waiting/s);
  // shell builtins aren't on PATH but always run
  assert.deepEqual(
    lintConfig(
      {
        ...cfg(`{"hooks": [{"on": "waiting", "run": "export FOO=1 && foo"}]}`),
        claudeProfiles: [],
      },
      {},
    ),
    [],
  );
  // a pipeline / absolute path is the user's business — not probed
  assert.deepEqual(
    lintConfig(
      { ...cfg(`{"hooks": [{"on": "waiting", "run": "X=1 foo | bar"}]}`), claudeProfiles: [] },
      {},
    ),
    [],
  );
});

// --- end to end ---------------------------------------------------------------

/** Absolute path a hook can touch to prove it ran, plus the hook's `run` line. */
const marker = (path: string, extra = ""): string =>
  `sh -c 'printf "%s %s\\n" "$LOOM_HOOK_EVENT" "$LOOM_FILES" >> ${path}' ${extra}`.trim();

test("a turn_end hook runs with the turn's written files in $LOOM_FILES", async () => {
  const log = join(await Deno.makeTempDir(), "fired.log");
  const hh = await makeHarness({
    config: JSON.stringify({ hooks: [{ name: "marker", on: "turn_end", run: marker(log) }] }),
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "edit something",
      provider: "fake",
    });
    const wt = snap.worktree as string;
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);

    // a successful write tool is recorded; a *failed* one must not be
    fs?.emit({ type: "tool_call", id: "1", name: "Write", input: { file_path: "src/a.ts" } });
    fs?.emit({ type: "tool_result", id: "1", ok: true, output: "ok" });
    fs?.emit({ type: "tool_call", id: "2", name: "Edit", input: { file_path: "src/denied.ts" } });
    fs?.emit({ type: "tool_result", id: "2", ok: false, output: "denied" });
    // …and a read is not a write at all
    fs?.emit({ type: "tool_call", id: "3", name: "Read", input: { file_path: "src/b.ts" } });
    fs?.emit({ type: "tool_result", id: "3", ok: true, output: "…" });
    await delay(60);
    fs?.finishTurn();
    await delay(250);

    const fired = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(fired.length, 1, `expected one turn_end run, got ${JSON.stringify(fired)}`);
    assert.equal(fired[0], `turn_end ${join(wt, "src/a.ts")}`);
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a waiting hook fires when the turn blocks, with the reason in the environment", async () => {
  const log = join(await Deno.makeTempDir(), "waiting.log");
  const run = `sh -c 'printf "%s/%s\\n" "$LOOM_HOOK_EVENT" "$LOOM_AWAIT_REASON" >> ${log}'`;
  const hh = await makeHarness({
    config: JSON.stringify({ hooks: [{ name: "toast", on: ["waiting", "permission"], run }] }),
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "ask me",
      provider: "fake",
    });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    fs?.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "rm" } });
    await delay(250);

    const fired = readFileSync(log, "utf8").trim().split("\n").sort();
    // both the specific `permission` hook and the catch-all `waiting` one fire
    assert.deepEqual(fired, ["permission/permission", "waiting/permission"]);
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a failing write hook sends its output to the agent, once per distinct failure", async () => {
  const hh = await makeHarness({
    config: `{"hooks": [{"kind": "check", "name": "lint", "on": "turn_end", "run": "sh -c 'echo a.ts:1 no semicolon; exit 1'"}]}`,
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const userMsgs: string[] = [];
    c.onPush((f: PushFrame) => {
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "write code",
      provider: "fake",
    });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    await delay(40);
    userMsgs.length = 0; // drop the opening-prompt echo

    fs?.emit({ type: "assistant_text", text: "done" });
    await delay(20);
    fs?.finishTurn();
    await delay(300);
    assert.equal(userMsgs.length, 1, JSON.stringify(userMsgs));
    assert.match(userMsgs[0] ?? "", /\[loom\] The `lint` hook exited 1/);
    assert.match(userMsgs[0] ?? "", /a\.ts:1 no semicolon/);

    // the same failure again is not re-sent — the agent has already been told
    userMsgs.length = 0;
    fs?.emit({ type: "assistant_text", text: "still broken" });
    await delay(20);
    fs?.finishTurn();
    await delay(300);
    assert.deepEqual(userMsgs, [], "an unchanged failure must not re-nag");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("`project` scopes a hook to one repo, and hooks hot-apply on a config edit", async () => {
  const log = join(await Deno.makeTempDir(), "scoped.log");
  const hh = await makeHarness({
    config: JSON.stringify({
      hooks: [{ on: "turn_end", project: "/nowhere/else", run: `touch ${log}` }],
    }),
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    assert.equal(hh.daemon.config.hooks.length, 1, "parsed, but not for this repo");
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "go",
      provider: "fake",
    });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    fs?.finishTurn();
    await delay(250);
    assert.ok(!existsSync(log), "a hook for another project must not fire");

    // Re-point it at this repo; config changes are polled every 250ms.
    writeFileSync(
      hh.configPath,
      JSON.stringify({ hooks: [{ on: "turn_end", project: hh.repoRoot, run: `touch ${log}` }] }),
    );
    await delay(600);
    fs?.emit({ type: "assistant_text", text: "again" });
    await delay(20);
    fs?.finishTurn();
    await delay(300);
    assert.ok(existsSync(log), "the reloaded hook fires without a restart");
  } finally {
    await c.close();
    await hh.cleanup();
  }
});

test("a hook that hangs is killed at its timeout, and the agent hears why", async () => {
  const hh = await makeHarness({
    // `sleep` outlives the timeout; the kill has to reach it, not just the `sh`.
    config: `{"hooks": [{"kind": "check", "name": "slow", "on": "turn_end", "run": "sleep 60", "timeout": 1}]}`,
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    const userMsgs: string[] = [];
    c.onPush((f: PushFrame) => {
      if (f.type === "event" && (f.event as { type?: string }).type === "user_message") {
        userMsgs.push((f.event as { text: string }).text);
      }
    });
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "go",
      provider: "fake",
    });
    const fs = ((await hh.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    await delay(40);
    userMsgs.length = 0;
    fs?.finishTurn();
    await delay(1_800);
    assert.equal(userMsgs.length, 1, JSON.stringify(userMsgs));
    assert.match(userMsgs[0] ?? "", /`slow` hook timed out after 1000ms/);
  } finally {
    await c.close();
    await hh.cleanup();
  }
});
