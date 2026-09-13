import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createProvider, codeModeInstructions } from "@loom/connector-chatgpt";
import { ChatGPTCatalog } from "@loom/connector-chatgpt/catalog";
import { resolveCodexHome } from "@loom/connector-chatgpt/codex-home";
import { discoverCodexModels } from "@loom/connector-chatgpt/discovery";
import { CodexRpcClient } from "@loom/connector-chatgpt/rpc";
import { makeLogger } from "@loom/core/logger";
import type { PlanDecision } from "@loom/core/types";
import { writtenPaths } from "@loom/core/tool-paths";
import { policy } from "@loom/runtime/policy";
import {
  approvalsReviewerFor,
  CodexAppServerSession,
  mcpConfig,
} from "@loom/connector-chatgpt/app-server";
import {
  spawnCodex,
  type CodexLaunchSpec,
  type CodexLauncher,
} from "@loom/connector-chatgpt/launch";
import { localToolDispatcher } from "@loom/connector-chatgpt/tool-dispatch";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

test("ChatGPT file changes report paths and correlated success or failure", async () => {
  for (const status of ["completed", "failed", "declined"]) {
    const changes = [{ path: "/tmp/a.ts", kind: { type: "update" }, diff: "" }];
    Deno.env.set(
      "LOOM_TEST_PRE_NOTIFICATION",
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "fileChange", id: "edit-1", status, changes } },
      }),
    );
    let session: CodexAppServerSession | undefined;
    try {
      session = await CodexAppServerSession.start(
        {
          sessionId: "file-change-test",
          cwd: "/tmp",
          prompt: "go",
          mode: "default",
          mcpServers: [],
        },
        {
          dir: "/tmp/loom-codex-file-change",
          authJsonPath: "/tmp/loom-codex-file-change/auth.json",
        },
        FAKE_CODEX,
      );
      let paths: string[] = [];
      for await (const ev of session.events()) {
        if (ev.type === "tool_call" && ev.id === "edit-1") paths = writtenPaths(ev.name, ev.input);
        if (ev.type === "tool_result" && ev.id === "edit-1") {
          assert.deepEqual(paths, ["/tmp/a.ts"]);
          assert.equal(ev.ok, status === "completed");
          break;
        }
      }
    } finally {
      await session?.close();
      Deno.env.delete("LOOM_TEST_PRE_NOTIFICATION");
    }
  }
});

const repo = (): {
  root: string;
  git: (...a: string[]) => string;
  cleanup: () => Promise<void>;
} => {
  const root = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "user.email", "loom+chatgpt@localhost");
  git("config", "user.name", "Loom (chatgpt)");
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("ChatGPT provider capabilities reflect a Codex-owned thread, not a Loom-owned transcript", () => {
  const provider = createProvider({
    id: "chatgpt",
    config: { authPath: "/definitely/not/auth.json" },
    logger: makeLogger("test"),
  });
  assert.equal(provider.capabilities.forking, false);
  assert.equal(provider.capabilities.rewind, false);
  assert.equal(provider.capabilities.ownsTranscript, false);
  assert.equal(provider.capabilities.liveModelSwitch, false);
  assert.equal(provider.capabilities.liveModeSwitch, true);
  assert.equal(provider.capabilities.compaction, true);
  // Code Mode's `thread/compact/start` accepts no instruction payload.
  assert.equal(provider.capabilities.compactionInstructions, false);
});

test("createProvider rejects the obsolete direct-backend base_url setting", () => {
  assert.throws(
    () =>
      createProvider({
        id: "chatgpt",
        config: { authPath: "/definitely/not/auth.json", baseUrl: "https://example.invalid" },
        logger: makeLogger("test"),
      }),
    /base_url.*is not supported anymore/,
  );
});

test("codeModeInstructions only mentions the loom tools actually mounted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-codemode-"));
  try {
    const mounted = codeModeInstructions(dir, true, true, null);
    assert.match(mounted, /call the `commit` tool/);
    assert.match(mounted, /`status` tool reprints this root/);
    assert.match(mounted, /call `ask_user`/);

    const unmounted = codeModeInstructions(dir, false, false, null);
    assert.doesNotMatch(unmounted, /call the `commit` tool/);
    assert.doesNotMatch(unmounted, /`status` tool reprints this root/);
    assert.doesNotMatch(unmounted, /call `ask_user`/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codeModeInstructions never mentions ask_user when askUserMounted is false, even with commit/status mounted (the resume case)", async () => {
  // `resumeSession` always passes `askUserMounted: false` regardless of
  // `mountsLoomTools` — a resumed thread created before ask_user existed
  // genuinely doesn't have it registered, and Loom has no way to tell that
  // case apart from a newer thread that does. Under-claiming is safe.
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-codemode-resume-"));
  try {
    const resumed = codeModeInstructions(dir, true, false, null);
    assert.match(resumed, /call the `commit` tool/);
    assert.match(resumed, /`status` tool reprints this root/);
    assert.doesNotMatch(resumed, /call `ask_user`/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codeModeInstructions splices in the caller's repoInstructions instead of reading LOOM.md itself", async () => {
  // A directory with no `.loom/LOOM.md` on disk at all — proves the text
  // below reached the output only because it was passed in, not because the
  // connector went and read the filesystem (which is the whole point of
  // threading `repoInstructions` through instead of calling `loomInstructions`
  // locally: only the daemon knows the `cwd`-then-repoRoot fallback).
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-codemode-noloommd-"));
  try {
    const withInstructions = codeModeInstructions(
      dir,
      true,
      true,
      "# from the repo root fallback\n\ndo the thing",
    );
    assert.match(withInstructions, /from the repo root fallback/);

    const withoutInstructions = codeModeInstructions(dir, true, true, null);
    assert.doesNotMatch(withoutInstructions, /from the repo root fallback/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ChatGPTCatalog does not read credentials until list() is called", () => {
  // Constructing it must not touch ~/.codex/auth.json: a user should be able
  // to configure Loom before running `codex login`, then get the actionable
  // auth error only when the catalog is actually fetched.
  const catalog = new ChatGPTCatalog(resolveCodexHome({ authPath: "/definitely/not/auth.json" }));
  assert.ok(catalog);
});

test("ChatGPTCatalog auth errors are actionable and never fall back to an API key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-noauth-"));
  try {
    const catalog = new ChatGPTCatalog(resolveCodexHome({ configDir: dir }));
    await assert.rejects(() => catalog.list(), /codex login/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Code Mode serializes command and HTTP MCP mounts into app-server config", () => {
  assert.equal(
    mcpConfig([
      { name: "tilth", spec: { transport: "stdio", command: "tilth", args: ["--mcp", "--edit"] } },
      { name: "remote", spec: { transport: "http", url: "https://example.invalid/mcp" } },
    ]),
    '{ "tilth" = { command = "tilth", args = ["--mcp", "--edit"] }, "remote" = { url = "https://example.invalid/mcp" } }',
  );
});

test("Code Mode routes auto-mode approvals through Codex's automatic reviewer", () => {
  assert.equal(approvalsReviewerFor("auto"), "auto_review");
  assert.equal(approvalsReviewerFor("acceptEdits"), "user");
  assert.equal(approvalsReviewerFor("default"), "user");
  assert.equal(approvalsReviewerFor("plan"), "user");
});

test("resolveCodexHome: config_dir, then auth_path's parent, then CODEX_HOME, then ~/.codex", () => {
  assert.equal(resolveCodexHome({ env: {} }).dir.endsWith("/.codex"), true);
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "/from/env" } }).dir, "/from/env");
  assert.deepEqual(resolveCodexHome({ authPath: "/custom/auth.json", env: {} }), {
    dir: "/custom",
    authJsonPath: "/custom/auth.json",
  });
  assert.deepEqual(resolveCodexHome({ configDir: "/explicit", env: { CODEX_HOME: "/ignored" } }), {
    dir: "/explicit",
    authJsonPath: "/explicit/auth.json",
  });
  // Agreeing config_dir + auth_path is fine.
  assert.deepEqual(resolveCodexHome({ configDir: "/same", authPath: "/same/auth.json", env: {} }), {
    dir: "/same",
    authJsonPath: "/same/auth.json",
  });
});

test("resolveCodexHome resolves a relative config_dir/auth_path to an absolute path", () => {
  const cwd = process.cwd();
  assert.equal(resolveCodexHome({ configDir: "./codex", env: {} }).dir, join(cwd, "codex"));
  const relative = resolveCodexHome({ authPath: "./codex/auth.json", env: {} });
  assert.equal(relative.dir, join(cwd, "codex"));
  assert.equal(relative.authJsonPath, join(cwd, "codex", "auth.json"));
});

test("resolveCodexHome rejects a disagreeing config_dir/auth_path pair and a misnamed auth_path", () => {
  assert.throws(
    () => resolveCodexHome({ configDir: "/a", authPath: "/b/auth.json", env: {} }),
    /disagree/,
  );
  assert.throws(
    () => resolveCodexHome({ authPath: "/custom/credentials.json", env: {} }),
    /must name an auth\.json file/,
  );
});

test("CodexRpcClient enforces a request deadline and rejects pending requests on close", async () => {
  const { proc } = fakeProcess();
  const rpc = new CodexRpcClient(proc as never, { requestTimeoutMs: 20 });
  await assert.rejects(rpc.request("test/hang", {}), /timed out after 20ms/);
  const pending = rpc.request("another/call", {});
  rpc.close();
  await assert.rejects(pending, /codex app-server closed/);
  assert.equal(rpc.closed, true);
});

test("CodexRpcClient answers an unclaimed server request with an explicit unsupported-request error", async () => {
  const { proc, stdout, written } = fakeProcess();
  new CodexRpcClient(proc as never);
  stdout.write(`${JSON.stringify({ id: 42, method: "some/unknown/method", params: {} })}\n`);
  await new Promise((r) => setImmediate(r)); // let readline's async "line" event land
  const reply = JSON.parse(written[written.length - 1] as string) as {
    id: number;
    error: { code: number; message: string };
  };
  assert.equal(reply.id, 42);
  assert.equal(reply.error.code, -32601);
  assert.match(reply.error.message, /unsupported request: some\/unknown\/method/);
});

test("discoverCodexModels paginates model/list, keeping the account's hidden flag on each row", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-home-test",
    authJsonPath: "/tmp/loom-codex-home-test/auth.json",
  };
  const models = await discoverCodexModels({ cliPath: FAKE_CODEX, codexHome });
  assert.deepEqual(models, [
    {
      id: "gpt-5.6-sol",
      hidden: false,
      label: "GPT-5.6-Sol",
      supportsEffort: true,
      effortLevels: ["low", "high"],
      defaultEffort: "low",
    },
    { id: "gpt-5.6-hidden", hidden: true },
  ]);
});

test("discovery and session startup spawn the app-server with the same resolved CODEX_HOME", async () => {
  const dir = "/tmp/loom-codex-home-echo-test";
  const proc = spawn(FAKE_CODEX, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...Deno.env.toObject(), CODEX_HOME: dir },
  });
  const rpc = new CodexRpcClient(proc);
  try {
    const result = (await rpc.requestStartup("initialize", {})) as { codexHome: string };
    assert.equal(result.codexHome, dir);
  } finally {
    rpc.close();
  }
});

test("CodexAppServerSession.start/.resume and discoverCodexModels launch through the injected launcher", async () => {
  // The launcher is the one seam that actually turns an executable +
  // environment + cwd + state location into a running process — proving all
  // three call sites (`start`, `resume`, `discoverCodexModels`) go through
  // it, with the expected explicit fields, rather than each spawning
  // independently.
  const codexHome = {
    dir: "/tmp/loom-codex-launch-injected",
    authJsonPath: "/tmp/loom-codex-launch-injected/auth.json",
  };
  const specs: CodexLaunchSpec[] = [];
  const launch: CodexLauncher = (spec) => {
    specs.push(spec);
    return spawnCodex(spec);
  };

  const started = await CodexAppServerSession.start(
    { sessionId: "s1", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
    codexHome,
    FAKE_CODEX,
    undefined,
    false,
    undefined,
    launch,
  );
  await started.close();
  assert.equal(specs.length, 1);
  assert.equal(specs[0]?.cliPath, FAKE_CODEX);
  assert.equal(specs[0]?.cwd, "/tmp");
  assert.equal(specs[0]?.codexHome, codexHome);
  assert.equal(specs[0]?.env["CODEX_HOME"], codexHome.dir);

  const resumed = await CodexAppServerSession.resume(
    { sessionId: "s2", providerRef: "fake-thread-1", cwd: "/tmp" },
    codexHome,
    FAKE_CODEX,
    undefined,
    false,
    undefined,
    launch,
  );
  await resumed.close();
  assert.equal(specs.length, 2);
  assert.equal(specs[1]?.cliPath, FAKE_CODEX);

  const models = await discoverCodexModels({ cliPath: FAKE_CODEX, codexHome, launch });
  assert.ok(models.length > 0);
  assert.equal(specs.length, 3);
  assert.equal(specs[2]?.args[0], "app-server");
  assert.equal(specs[2]?.codexHome, codexHome);
});

test("resume() forwards the ref's systemPromptAppend as developerInstructions on thread/resume", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-resume-test",
    authJsonPath: "/tmp/loom-codex-resume-test/auth.json",
  };

  const withInstructions = await CodexAppServerSession.resume(
    {
      sessionId: "s1",
      providerRef: "fake-thread-1",
      cwd: "/tmp",
      systemPromptAppend: "resumed-instructions-marker",
    },
    codexHome,
    FAKE_CODEX,
  );
  assert.equal(withInstructions.providerRef, "fake-thread-1-with-instructions");
  await withInstructions.close();

  const withoutInstructions = await CodexAppServerSession.resume(
    { sessionId: "s2", providerRef: "fake-thread-1", cwd: "/tmp" },
    codexHome,
    FAKE_CODEX,
  );
  assert.equal(withoutInstructions.providerRef, "fake-thread-1");
  await withoutInstructions.close();
});

/** Polls `dir` until it has an entry, for asserting a killed child process's
 *  exit handler actually ran (see `LOOM_TEST_EXIT_MARKER_DIR` in the fixture). */
const waitForMarker = async (dir: string, timeoutMs = 2000): Promise<string[]> => {
  const { readdir } = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await readdir(dir);
    if (entries.length > 0) return entries;
    if (Date.now() > deadline) return entries;
    await delay(20);
  }
};

/** Polls for `path` to exist and be non-empty, for the tool-call result file
 *  the fixture writes asynchronously (see `LOOM_TEST_TOOL_CALL_RESULT_FILE`). */
const waitForFile = async (path: string, timeoutMs = 2000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(path, "utf8");
      if (content) return content;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(20);
  }
};

/** Polls for `path` to exist (any content, including empty) — for a marker
 *  file the fixture touches (e.g. `LOOM_TEST_INTERRUPT_MARKER_FILE`), where
 *  `waitForFile`'s "non-empty" check would never be satisfied. */
const waitForExists = async (path: string, timeoutMs = 500): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return true;
    } catch {
      // not there yet
    }
    if (Date.now() > deadline) return false;
    await delay(20);
  }
};

test("a failed thread/start closes the app-server process instead of leaking it", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "loom-codex-exit-"));
  const codexHome = {
    dir: "/tmp/loom-codex-fail-test",
    authJsonPath: "/tmp/loom-codex-fail-test/auth.json",
  };
  try {
    Deno.env.set("LOOM_TEST_FAIL_STARTUP", "1");
    Deno.env.set("LOOM_TEST_EXIT_MARKER_DIR", markerDir);
    await assert.rejects(
      () =>
        CodexAppServerSession.start(
          { sessionId: "s1", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
          codexHome,
          FAKE_CODEX,
        ),
      /forced thread\/start failure/,
    );
    assert.equal(
      (await waitForMarker(markerDir)).length,
      1,
      "the spawned process should have exited",
    );
  } finally {
    Deno.env.delete("LOOM_TEST_FAIL_STARTUP");
    Deno.env.delete("LOOM_TEST_EXIT_MARKER_DIR");
    await rm(markerDir, { recursive: true, force: true });
  }
});

test("a failed thread/resume closes the app-server process instead of leaking it", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "loom-codex-exit-"));
  const codexHome = {
    dir: "/tmp/loom-codex-fail-test",
    authJsonPath: "/tmp/loom-codex-fail-test/auth.json",
  };
  try {
    Deno.env.set("LOOM_TEST_FAIL_STARTUP", "1");
    Deno.env.set("LOOM_TEST_EXIT_MARKER_DIR", markerDir);
    await assert.rejects(
      () =>
        CodexAppServerSession.resume(
          { sessionId: "s1", providerRef: "fake-thread-1", cwd: "/tmp" },
          codexHome,
          FAKE_CODEX,
        ),
      /forced thread\/resume failure/,
    );
    assert.equal(
      (await waitForMarker(markerDir)).length,
      1,
      "the spawned process should have exited",
    );
  } finally {
    Deno.env.delete("LOOM_TEST_FAIL_STARTUP");
    Deno.env.delete("LOOM_TEST_EXIT_MARKER_DIR");
    await rm(markerDir, { recursive: true, force: true });
  }
});

test("a non-ChatGPT authenticated account is rejected without leaking the process", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "loom-codex-exit-"));
  const codexHome = {
    dir: "/tmp/loom-codex-account-test",
    authJsonPath: "/tmp/loom-codex-account-test/auth.json",
  };
  try {
    Deno.env.set("LOOM_TEST_ACCOUNT_TYPE", "apiKey");
    Deno.env.set("LOOM_TEST_EXIT_MARKER_DIR", markerDir);
    await assert.rejects(
      () =>
        CodexAppServerSession.start(
          { sessionId: "s1", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
          codexHome,
          FAKE_CODEX,
        ),
      /not authenticated with a ChatGPT subscription account.*apiKey/,
    );
    assert.equal(
      (await waitForMarker(markerDir)).length,
      1,
      "the spawned process should have exited",
    );
  } finally {
    Deno.env.delete("LOOM_TEST_ACCOUNT_TYPE");
    Deno.env.delete("LOOM_TEST_EXIT_MARKER_DIR");
    await rm(markerDir, { recursive: true, force: true });
  }
});

test("Code Mode compact() rejects custom instructions instead of silently running plain compaction", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-compact-test",
    authJsonPath: "/tmp/loom-codex-compact-test/auth.json",
  };
  const s = await CodexAppServerSession.start(
    { sessionId: "s1", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
    codexHome,
    FAKE_CODEX,
  );
  try {
    await assert.rejects(
      () => s.compact("keep the plan verbatim"),
      /does not support custom instructions/,
    );
    await s.compact(); // plain compaction still works
    await s.compact("   "); // blank instructions are the same as none
  } finally {
    await s.close();
  }
});

test("Codex's item/tool/call invokes Loom's commit dynamic tool and replies on the envelope id (auto mode allows it)", async () => {
  const { root, git, cleanup } = repo();
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-commit",
    authJsonPath: "/tmp/loom-codex-dyntool-commit/auth.json",
  };
  const resultFile = join(root, "..", `tool-call-result-${process.pid}.json`);
  try {
    await writeFile(join(root, "a.txt"), "hello\n");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "commit", arguments: { message: "Add a.txt" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: root, prompt: "go", mode: "auto", mcpServers: [], loomServer: true },
      codexHome,
      FAKE_CODEX,
    );
    try {
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as {
        contentItems: Array<{ type: string; text: string }>;
        success: boolean;
      };
      assert.equal(result.success, true);
      assert.equal(result.contentItems[0]?.type, "inputText");
      assert.match(result.contentItems[0]?.text ?? "", /^committed [0-9a-f]{7,} Add a\.txt/);
      assert.equal(git("log", "-1", "--format=%s"), "Add a.txt");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await cleanup();
  }
});

test("CodexAppServerSession.start runs the injected dispatcher instead of committing locally", async () => {
  // Phase 5's approval-wait/cancellation logic wraps `ToolDispatcher`
  // (`tool-dispatch.ts`) rather than growing inside `#toolCall`'s switch —
  // this proves the seam actually exists: a fake dispatcher intercepts the
  // call before any local `commitInWorktree` execution, and the real repo
  // (which has an uncommitted `a.txt`) is left untouched.
  const { root, git, cleanup } = repo();
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-dispatch-injected",
    authJsonPath: "/tmp/loom-codex-dyntool-dispatch-injected/auth.json",
  };
  const resultFile = join(root, "..", `tool-call-result-dispatch-injected-${process.pid}.json`);
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  try {
    await writeFile(join(root, "a.txt"), "hello\n");
    const headBefore = git("rev-parse", "HEAD");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "commit", arguments: { message: "Add a.txt" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: root, prompt: "go", mode: "auto", mcpServers: [], loomServer: true },
      codexHome,
      FAKE_CODEX,
      undefined,
      false,
      undefined,
      spawnCodex,
      async (tool, args) => {
        calls.push({ tool, args });
        return { ok: true, text: "handled by the injected dispatcher, not git" };
      },
    );
    try {
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as {
        contentItems: Array<{ type: string; text: string }>;
        success: boolean;
      };
      assert.equal(result.success, true);
      assert.equal(result.contentItems[0]?.text, "handled by the injected dispatcher, not git");
      assert.deepEqual(calls, [{ tool: "commit", args: { message: "Add a.txt" } }]);
      assert.equal(
        git("rev-parse", "HEAD"),
        headBefore,
        "the injected dispatcher ran, not a real commit",
      );
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await cleanup();
  }
});

for (const mode of ["default", "plan", "acceptEdits"] as const) {
  test(`Codex's item/tool/call raises a real permission_request for commit in ${mode} mode instead of denying it outright`, async () => {
    // `@loom/runtime/policy`'s `policy()` never auto-allows `commit` outside
    // `auto` mode — every other mode blocks on a human decision through the
    // same pending-interaction machinery `ask_user`/`exit_plan`/native
    // approvals use, rather than denying immediately.
    const { root, git, cleanup } = repo();
    const codexHome = {
      dir: `/tmp/loom-codex-dyntool-ask-${mode}`,
      authJsonPath: `/tmp/loom-codex-dyntool-ask-${mode}/auth.json`,
    };
    const resultFile = join(root, "..", `tool-call-result-ask-${mode}-${process.pid}.json`);
    try {
      await writeFile(join(root, "a.txt"), "hello\n");
      const headBefore = git("rev-parse", "HEAD");
      Deno.env.set(
        "LOOM_TEST_TOOL_CALL_SPEC",
        JSON.stringify({ tool: "commit", arguments: { message: "Add a.txt" } }),
      );
      Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
      const s = await CodexAppServerSession.start(
        { sessionId: "s1", cwd: root, prompt: "go", mode, mcpServers: [], loomServer: true },
        codexHome,
        FAKE_CODEX,
      );
      try {
        let reqId = "";
        for await (const ev of s.events()) {
          if (ev.type === "permission_request" && ev.tool === "commit") {
            assert.deepEqual(ev.input, { message: "Add a.txt" });
            reqId = ev.id;
            break;
          }
        }
        await s.respondToPermission(reqId, { behavior: "deny", message: "not now" });
        const raw = await waitForFile(resultFile);
        const result = JSON.parse(raw) as {
          success: boolean;
          contentItems: Array<{ text: string }>;
        };
        assert.equal(result.success, false);
        assert.equal(result.contentItems[0]?.text, "not now");
        assert.equal(git("rev-parse", "HEAD"), headBefore, "no commit should have been made");
      } finally {
        await s.close();
      }
    } finally {
      Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
      Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
      await rm(resultFile, { force: true });
      await cleanup();
    }
  });
}

test("respondToPermission(allow) on a pending commit approval actually runs the commit", async () => {
  const { root, git, cleanup } = repo();
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-approve-commit",
    authJsonPath: "/tmp/loom-codex-dyntool-approve-commit/auth.json",
  };
  const resultFile = join(root, "..", `tool-call-result-approve-commit-${process.pid}.json`);
  try {
    await writeFile(join(root, "a.txt"), "hello\n");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "commit", arguments: { message: "Add a.txt" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: root,
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let reqId = "";
      for await (const ev of s.events()) {
        if (ev.type === "permission_request" && ev.tool === "commit") {
          reqId = ev.id;
          break;
        }
      }
      await s.respondToPermission(reqId, { behavior: "allow" });
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { success: boolean; contentItems: Array<{ text: string }> };
      assert.equal(result.success, true);
      assert.match(result.contentItems[0]?.text ?? "", /^committed [0-9a-f]{7,} Add a\.txt/);
      assert.equal(git("log", "-1", "--format=%s"), "Add a.txt");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await cleanup();
  }
});

test("interrupt() drains a pending commit approval instead of leaving it parked, and never runs the commit", async () => {
  const { root, git, cleanup } = repo();
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-interrupt-commit",
    authJsonPath: "/tmp/loom-codex-dyntool-interrupt-commit/auth.json",
  };
  const resultFile = join(root, "..", `tool-call-result-interrupt-commit-${process.pid}.json`);
  try {
    await writeFile(join(root, "a.txt"), "hello\n");
    const headBefore = git("rev-parse", "HEAD");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "commit", arguments: { message: "Add a.txt" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: root,
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      for await (const ev of s.events()) {
        if (ev.type === "permission_request" && ev.tool === "commit") break;
      }
      await s.interrupt();
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { success: boolean };
      assert.equal(result.success, false);
      assert.equal(git("rev-parse", "HEAD"), headBefore, "no commit should have been made");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await cleanup();
  }
});

test("Codex's item/tool/call always allows status, regardless of mode", async () => {
  const { root, cleanup } = repo();
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-status",
    authJsonPath: "/tmp/loom-codex-dyntool-status/auth.json",
  };
  const resultFile = join(root, "..", `tool-call-result-status-${process.pid}.json`);
  try {
    Deno.env.set("LOOM_TEST_TOOL_CALL_SPEC", JSON.stringify({ tool: "status", arguments: {} }));
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: root, prompt: "go", mode: "plan", mcpServers: [], loomServer: true },
      codexHome,
      FAKE_CODEX,
    );
    try {
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { success: boolean };
      assert.equal(result.success, true);
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await cleanup();
  }
});

test("Codex's item/tool/call reports an unsupported tool name as a failed (not errored) call", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-unknown",
    authJsonPath: "/tmp/loom-codex-dyntool-unknown/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-unknown-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "nonexistent", arguments: {} }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { success: boolean };
      assert.equal(result.success, false);
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("Codex's item/tool/call round-trips the ask_user dynamic tool through a question/answer event pair", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-askuser",
    authJsonPath: "/tmp/loom-codex-dyntool-askuser/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-askuser-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({
        tool: "ask_user",
        arguments: { question: "pick one", context: "because reasons" },
      }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let questionId = "";
      for await (const ev of s.events()) {
        if (ev.type === "question") {
          assert.equal(ev.question, "pick one");
          assert.equal(ev.context, "because reasons");
          questionId = ev.id;
          break;
        }
      }
      await s.answerQuestion(questionId, "chosen answer");
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      assert.equal(result.success, true);
      assert.equal(result.contentItems[0]?.text, "chosen answer");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("interrupt() drains a pending ask_user question instead of leaving it parked forever", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-askuser-interrupt",
    authJsonPath: "/tmp/loom-codex-dyntool-askuser-interrupt/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-askuser-interrupt-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "ask_user", arguments: { question: "?" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      for await (const ev of s.events()) {
        if (ev.type === "question") break;
      }
      await s.interrupt();
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      assert.equal(result.success, true);
      assert.equal(result.contentItems[0]?.text, "(the turn was interrupted)");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

const planDecisionCases: Array<{
  name: string;
  decision: PlanDecision;
  expectText: RegExp;
  expectMode?: "acceptEdits";
}> = [
  {
    name: "discuss",
    decision: { action: "discuss", message: "not ready yet" },
    expectText: /not ready to implement.*not ready yet.*call exit_plan again/s,
  },
  {
    name: "handoff",
    decision: { action: "handoff" },
    expectText: /continues in a separate session/,
  },
  {
    name: "implement",
    decision: { action: "implement" },
    expectText: /Plan approved\. Implementing now\./,
    expectMode: "acceptEdits",
  },
  {
    name: "revise",
    decision: { action: "revise", plan: "the revised plan" },
    expectText: /Plan approved\. Implementing now\./,
    expectMode: "acceptEdits",
  },
  {
    name: "implement_fresh",
    // implement_fresh's context-reset is explicitly Phase 6's job — treated
    // like a plain `implement` here (see `respondToPlan`'s doc comment).
    decision: { action: "implement_fresh" },
    expectText: /Plan approved\. Implementing now\./,
    expectMode: "acceptEdits",
  },
];

for (const { name, decision, expectText, expectMode } of planDecisionCases) {
  test(`Codex's exit_plan dynamic tool round-trips a "${name}" plan decision`, async () => {
    const codexHome = {
      dir: `/tmp/loom-codex-dyntool-exitplan-${name}`,
      authJsonPath: `/tmp/loom-codex-dyntool-exitplan-${name}/auth.json`,
    };
    const resultFile = join(tmpdir(), `tool-call-result-exitplan-${name}-${process.pid}.json`);
    try {
      Deno.env.set(
        "LOOM_TEST_TOOL_CALL_SPEC",
        JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
      );
      Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
      const s = await CodexAppServerSession.start(
        {
          sessionId: "s1",
          cwd: "/tmp",
          prompt: "go",
          mode: "plan",
          mcpServers: [],
          loomServer: true,
        },
        codexHome,
        FAKE_CODEX,
      );
      try {
        let planId = "";
        for await (const ev of s.events()) {
          if (ev.type === "plan_review") {
            assert.equal(ev.plan, "do the thing");
            planId = ev.id;
            break;
          }
        }
        await s.respondToPlan(planId, decision);
        const raw = await waitForFile(resultFile);
        const result = JSON.parse(raw) as {
          contentItems: Array<{ text: string }>;
          success: boolean;
        };
        assert.equal(result.success, true);
        assert.match(result.contentItems[0]?.text ?? "", expectText);
        if (expectMode) assert.equal(s.snapshot().mode, expectMode);
        else assert.equal(s.snapshot().mode, "plan");
      } finally {
        await s.close();
      }
    } finally {
      Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
      Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
      await rm(resultFile, { force: true });
    }
  });
}

test("exit_plan is refused outside plan mode instead of silently presenting a plan", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-dyntool-exitplan-wrongmode",
    authJsonPath: "/tmp/loom-codex-dyntool-exitplan-wrongmode/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-exitplan-wrongmode-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      assert.equal(result.success, false);
      assert.match(result.contentItems[0]?.text ?? "", /only usable in plan mode/);
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("Codex's native item/tool/requestUserInput round-trips through the same AskUserQuestion permission shape the TUI already renders", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-native-question",
    authJsonPath: "/tmp/loom-codex-native-question/auth.json",
  };
  const resultFile = join(tmpdir(), `user-input-result-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_USER_INPUT_SPEC",
      JSON.stringify({
        questions: [
          {
            id: "q1",
            header: "Color",
            question: "Pick a color",
            isOther: false,
            isSecret: false,
            options: [
              { label: "red", description: "warm" },
              { label: "blue", description: "cool" },
            ],
          },
        ],
      }),
    );
    Deno.env.set("LOOM_TEST_USER_INPUT_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let reqId = "";
      let input:
        | { questions: Array<{ question: string; header: string; options: unknown }> }
        | undefined;
      for await (const ev of s.events()) {
        if (ev.type === "permission_request" && ev.tool === "AskUserQuestion") {
          reqId = ev.id;
          input = ev.input as typeof input;
          break;
        }
      }
      assert.equal(input?.questions[0]?.question, "Pick a color");
      await s.respondToPermission(reqId, {
        behavior: "allow",
        updatedInput: { ...input, answers: { "Pick a color": "blue" } },
      });
      const raw = await waitForFile(resultFile);
      assert.deepEqual(JSON.parse(raw), { answers: { q1: { answers: ["blue"] } } });
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_USER_INPUT_SPEC");
    Deno.env.delete("LOOM_TEST_USER_INPUT_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("interrupt() drains a pending native question with a structurally valid empty-answer response", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-native-question-interrupt",
    authJsonPath: "/tmp/loom-codex-native-question-interrupt/auth.json",
  };
  const resultFile = join(tmpdir(), `user-input-result-interrupt-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_USER_INPUT_SPEC",
      JSON.stringify({
        questions: [
          { id: "q1", header: "", question: "?", isOther: false, isSecret: false, options: null },
        ],
      }),
    );
    Deno.env.set("LOOM_TEST_USER_INPUT_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      codexHome,
      FAKE_CODEX,
    );
    try {
      for await (const ev of s.events()) {
        if (ev.type === "permission_request" && ev.tool === "AskUserQuestion") break;
      }
      await s.interrupt();
      const raw = await waitForFile(resultFile);
      assert.deepEqual(JSON.parse(raw), { answers: { q1: { answers: [""] } } });
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_USER_INPUT_SPEC");
    Deno.env.delete("LOOM_TEST_USER_INPUT_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("a server request tagged with an unrecognized threadId is rejected, not actioned", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-unknown-thread",
    authJsonPath: "/tmp/loom-codex-unknown-thread/auth.json",
  };
  const resultFile = join(tmpdir(), `approval-result-unknown-thread-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_APPROVAL_SPEC",
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        threadId: "totally-unrecognized-thread",
        params: { command: "echo hi" },
      }),
    );
    Deno.env.set("LOOM_TEST_APPROVAL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      codexHome,
      FAKE_CODEX,
    );
    try {
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { error?: { message: string } };
      assert.match(result.error?.message ?? "", /unrecognized thread/);
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_APPROVAL_SPEC");
    Deno.env.delete("LOOM_TEST_APPROVAL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("a server request tagged with an observed sub-agent's threadId is accepted and routed through the same handler", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-subagent-thread",
    authJsonPath: "/tmp/loom-codex-subagent-thread/auth.json",
  };
  const resultFile = join(tmpdir(), `approval-result-subagent-thread-${process.pid}.json`);
  try {
    Deno.env.set(
      "LOOM_TEST_PRE_NOTIFICATION",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "sub-item-1",
            kind: "started",
            agentThreadId: "sub-thread-1",
            agentPath: "worker",
          },
        },
      }),
    );
    Deno.env.set(
      "LOOM_TEST_APPROVAL_SPEC",
      JSON.stringify({
        method: "item/commandExecution/requestApproval",
        threadId: "sub-thread-1",
        params: { command: "echo hi" },
      }),
    );
    Deno.env.set("LOOM_TEST_APPROVAL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let reqId = "";
      for await (const ev of s.events()) {
        if (ev.type === "permission_request" && ev.tool === "Bash") {
          reqId = ev.id;
          break;
        }
      }
      await s.respondToPermission(reqId, { behavior: "allow" });
      const raw = await waitForFile(resultFile);
      assert.deepEqual(JSON.parse(raw), { decision: "accept" });
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_PRE_NOTIFICATION");
    Deno.env.delete("LOOM_TEST_APPROVAL_SPEC");
    Deno.env.delete("LOOM_TEST_APPROVAL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

for (const [from, to, label] of [
  ["auto", "default", "tightening (policy + reviewer axes)"],
  ["default", "acceptEdits", "a pure relaxation (policy axis only)"],
  ["plan", "acceptEdits", "leaving plan's read-only sandbox (sandbox axis)"],
] as const) {
  test(`setMode interrupts an active turn for ${label}, since every native axis is snapshotted per turn`, async () => {
    const codexHome = {
      dir: `/tmp/loom-codex-setmode-${from}-${to}`,
      authJsonPath: `/tmp/loom-codex-setmode-${from}-${to}/auth.json`,
    };
    const markerFile = join(tmpdir(), `interrupt-marker-${from}-${to}-${process.pid}.txt`);
    try {
      Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
      Deno.env.set("LOOM_TEST_INTERRUPT_MARKER_FILE", markerFile);
      const s = await CodexAppServerSession.start(
        { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: from, mcpServers: [] },
        codexHome,
        FAKE_CODEX,
      );
      try {
        await s.setMode(to);
        assert.equal(
          await waitForExists(markerFile),
          true,
          "expected turn/interrupt to have been called",
        );
      } finally {
        await s.close();
      }
    } finally {
      Deno.env.delete("LOOM_TEST_HOLD_TURN");
      Deno.env.delete("LOOM_TEST_INTERRUPT_MARKER_FILE");
      await rm(markerFile, { force: true });
    }
  });
}

test("setMode does not interrupt when the mode isn't actually changing", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-setmode-noop",
    authJsonPath: "/tmp/loom-codex-setmode-noop/auth.json",
  };
  const markerFile = join(tmpdir(), `interrupt-marker-noop-${process.pid}.txt`);
  try {
    Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
    Deno.env.set("LOOM_TEST_INTERRUPT_MARKER_FILE", markerFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      codexHome,
      FAKE_CODEX,
    );
    try {
      await s.setMode("default");
      assert.equal(
        await waitForExists(markerFile, 300),
        false,
        "did not expect turn/interrupt to be called",
      );
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_INTERRUPT_MARKER_FILE");
    await rm(markerFile, { force: true });
  }
});

test("interrupt() still drains pending interactions and goes idle even when the turn/interrupt RPC itself fails", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-interrupt-rpc-fails",
    authJsonPath: "/tmp/loom-codex-interrupt-rpc-fails/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-interrupt-fails-${process.pid}.json`);
  try {
    Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
    Deno.env.set("LOOM_TEST_FAIL_TURN_INTERRUPT", "1");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "ask_user", arguments: { question: "?" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      for await (const ev of s.events()) {
        if (ev.type === "question") break;
      }
      // The daemon's own SessionManager already tolerates a rejected
      // `session.interrupt()` (wraps it in try/catch and logs a warning) —
      // what matters here is that the drain and idle transition happen
      // regardless of whether the RPC call itself succeeded.
      await assert.rejects(() => s.interrupt(), /forced turn\/interrupt failure/);
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      assert.equal(result.contentItems[0]?.text, "(the turn was interrupted)");
      assert.equal(s.snapshot().status.kind, "idle");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_FAIL_TURN_INTERRUPT");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("a dynamic tool call arriving for an already-interrupted turn is rejected instead of starting new work", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-stale-turn-toolcall",
    authJsonPath: "/tmp/loom-codex-stale-turn-toolcall/auth.json",
  };
  const resultFile = join(tmpdir(), `approval-result-stale-turn-${process.pid}.json`);
  try {
    // The fixture fires this ask_user call only after being told to
    // interrupt the turn it's tagged with — simulating a request that was
    // already in flight when `interrupt()` ran.
    Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_AFTER_INTERRUPT_SPEC",
      JSON.stringify({ tool: "ask_user", arguments: { question: "still relevant?" } }),
    );
    Deno.env.set("LOOM_TEST_APPROVAL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      await s.interrupt();
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { error?: { message: string } };
      assert.match(result.error?.message ?? "", /no longer active/);
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_AFTER_INTERRUPT_SPEC");
    Deno.env.delete("LOOM_TEST_APPROVAL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("exit_plan's plan_review event id matches the dynamic tool call's own callId, for replay correlation", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-exitplan-id-correlation",
    authJsonPath: "/tmp/loom-codex-exitplan-id-correlation/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-exitplan-idcheck-${process.pid}.json`);
  const callId = "fake-call-1"; // the fixture's hardcoded item/tool/call callId
  try {
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "plan",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let planId = "";
      for await (const ev of s.events()) {
        if (ev.type === "plan_review") {
          planId = ev.id;
          break;
        }
      }
      // Codex's own dynamic-tool-call identity, confirmed against the
      // codex-rs test suite to equal the eventual completed item's `id` —
      // the same id a persisted `tool_call`/`tool_result` pair for this
      // exact call would carry, so replay can tell the plan was resolved.
      assert.equal(planId, callId);
      await s.respondToPlan(planId, { action: "handoff" });
      await waitForFile(resultFile);
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("respondToPlan never tells the model 'approved' when the mode/turn transition itself fails", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-exitplan-transition-fails",
    authJsonPath: "/tmp/loom-codex-exitplan-transition-fails/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-exitplan-failtransition-${process.pid}.json`);
  try {
    Deno.env.set("LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE", "1");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "plan",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let planId = "";
      for await (const ev of s.events()) {
        if (ev.type === "plan_review") {
          planId = ev.id;
          break;
        }
      }
      await assert.rejects(
        () => s.respondToPlan(planId, { action: "implement" }),
        /forced thread\/settings\/update failure/,
      );
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      // Never "Plan approved. Implementing now." — the transition didn't happen.
      assert.doesNotMatch(result.contentItems[0]?.text ?? "", /Plan approved/);
      assert.match(result.contentItems[0]?.text ?? "", /could not be implemented/);
      assert.equal(s.snapshot().mode, "plan", "mode must not have changed either");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("an external interrupt() while a plan's settings update is still in flight prevents the transition from restarting implementation afterward", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-exitplan-cancel-settings",
    authJsonPath: "/tmp/loom-codex-exitplan-cancel-settings/auth.json",
  };
  const resultFile = join(
    tmpdir(),
    `tool-call-result-exitplan-cancel-settings-${process.pid}.json`,
  );
  const holdBase = join(tmpdir(), `hold-settings-update-${process.pid}`);
  try {
    Deno.env.set("LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE", holdBase);
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "plan",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let planId = "";
      for await (const ev of s.events()) {
        if (ev.type === "plan_review") {
          planId = ev.id;
          break;
        }
      }
      // Approve the plan — respondToPlan is now awaiting setMode(), which is
      // awaiting the (held) thread/settings/update response. Don't await
      // respondToPlan itself yet; the whole point is to race it.
      const responded = assert.rejects(
        () => s.respondToPlan(planId, { action: "implement" }),
        /the session was interrupted before the plan could be implemented/,
      );
      await waitForExists(`${holdBase}.received`, 2000);

      // An interrupt from *outside* this transition entirely (e.g. the user
      // hitting stop) — reproducing exactly this: "1. Approve a plan; hold
      // the settings RPC response. 2. Call interrupt() and await it — session
      // becomes idle. 3. Release the settings response. 4. The detached
      // transition [used to] start a new implementation turn."
      await s.interrupt();
      assert.equal(s.snapshot().status.kind, "idle");

      await writeFile(`${holdBase}.release`, "");
      await responded;

      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      assert.doesNotMatch(result.contentItems[0]?.text ?? "", /Plan approved/);
      assert.match(result.contentItems[0]?.text ?? "", /interrupted/);
      // The transition must not have snuck a fresh turn in on the way out.
      assert.equal(s.snapshot().status.kind, "idle");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await rm(`${holdBase}.received`, { force: true });
    await rm(`${holdBase}.release`, { force: true });
  }
});

test("an external interrupt() while a plan's fresh implementation turn is starting also prevents reporting approval", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-exitplan-cancel-turnstart",
    authJsonPath: "/tmp/loom-codex-exitplan-cancel-turnstart/auth.json",
  };
  const resultFile = join(
    tmpdir(),
    `tool-call-result-exitplan-cancel-turnstart-${process.pid}.json`,
  );
  const holdBase = join(tmpdir(), `hold-turn-start-${process.pid}`);
  try {
    // Call #1 is the initial "go" turn (needed just to get the exit_plan
    // tool call); call #2 is the fresh turn respondToPlan starts once the
    // plan is approved — that's the one this test holds.
    Deno.env.set("LOOM_TEST_HOLD_TURN_START_CALL", "2");
    Deno.env.set("LOOM_TEST_HOLD_TURN_START", holdBase);
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "plan",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
    );
    try {
      let planId = "";
      for await (const ev of s.events()) {
        if (ev.type === "plan_review") {
          planId = ev.id;
          break;
        }
      }
      const responded = assert.rejects(
        () => s.respondToPlan(planId, { action: "implement" }),
        /the session was interrupted before the plan could be implemented/,
      );
      // setMode's own thread/settings/update (call it doesn't hold) has
      // already succeeded and interrupted the planning turn by the time
      // send()'s turn/start (the held, second call) is in flight.
      await waitForExists(`${holdBase}.received`, 2000);

      await s.interrupt();
      assert.equal(s.snapshot().status.kind, "idle");

      await writeFile(`${holdBase}.release`, "");
      await responded;

      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      assert.doesNotMatch(result.contentItems[0]?.text ?? "", /Plan approved/);
      assert.match(result.contentItems[0]?.text ?? "", /interrupted/);
      assert.equal(s.snapshot().status.kind, "idle");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_HOLD_TURN_START_CALL");
    Deno.env.delete("LOOM_TEST_HOLD_TURN_START");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
    await rm(`${holdBase}.received`, { force: true });
    await rm(`${holdBase}.release`, { force: true });
  }
});

test("interrupt() invalidates an in-flight dispatch's askUser callback instead of letting it park a new question after the turn is gone", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-cancel-inflight-dispatch",
    authJsonPath: "/tmp/loom-codex-cancel-inflight-dispatch/auth.json",
  };
  const resultFile = join(tmpdir(), `tool-call-result-cancel-inflight-${process.pid}.json`);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  try {
    // The tool name/arguments don't matter — the injected dispatcher below
    // ignores them entirely and just simulates a dispatch that does some
    // async work (represented by `gate`) before ever reaching `ctx.askUser`.
    Deno.env.set("LOOM_TEST_TOOL_CALL_SPEC", JSON.stringify({ tool: "whatever", arguments: {} }));
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      {
        sessionId: "s1",
        cwd: "/tmp",
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      codexHome,
      FAKE_CODEX,
      undefined,
      false,
      undefined,
      spawnCodex,
      async (_tool, _args, ctx) => {
        await gate; // paused here while interrupt() runs, below
        const answer = await ctx.askUser!("late question", undefined);
        return { ok: true, text: answer };
      },
    );
    try {
      // The dispatch is admitted (past the stale-turn check) and currently
      // parked on `gate` — nothing has called `ctx.askUser` yet.
      await s.interrupt();
      releaseGate(); // let the dispatch proceed now that the turn is gone
      const raw = await waitForFile(resultFile);
      const result = JSON.parse(raw) as { contentItems: Array<{ text: string }>; success: boolean };
      // Resolves immediately with the same sentinel a drained question would
      // have gotten — never actually parks (which would otherwise hang this
      // test forever, since nothing here ever calls `answerQuestion`).
      assert.equal(result.contentItems[0]?.text, "(the turn was interrupted)");
    } finally {
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_TOOL_CALL_SPEC");
    Deno.env.delete("LOOM_TEST_TOOL_CALL_RESULT_FILE");
    await rm(resultFile, { force: true });
  }
});

test("localToolDispatcher never calls askUser once the turn's signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let askUserCalled = false;
  const result = await localToolDispatcher(
    "ask_user",
    { question: "still relevant?" },
    {
      mode: "default",
      cwd: "/tmp",
      signal: controller.signal,
      askUser: async () => {
        askUserCalled = true;
        return "should never be reached";
      },
    },
  );
  assert.equal(askUserCalled, false);
  assert.equal(result.ok, false);
});

test("localToolDispatcher rechecks cancellation after an approval wait, before running the commit", async () => {
  const controller = new AbortController();
  const { root, git, cleanup } = repo();
  try {
    await writeFile(join(root, "a.txt"), "hello\n");
    const headBefore = git("rev-parse", "HEAD");
    const result = await localToolDispatcher(
      "commit",
      { message: "should not land" },
      {
        mode: "default",
        cwd: root,
        signal: controller.signal,
        requestApproval: async () => {
          // The turn gets interrupted while the human's "yes" is in flight —
          // by the time this dispatcher sees the (still affirmative) decision,
          // the signal already says the turn is gone.
          controller.abort();
          return { behavior: "allow" };
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(git("rev-parse", "HEAD"), headBefore, "no commit should have run");
  } finally {
    await cleanup();
  }
});

test("Loom's own tool policy is independent of Codex's approvals reviewer — auto_review can never approve a Loom tool request on its behalf", () => {
  // The dynamic-tool dispatcher (`tool-dispatch.ts`) gates purely on
  // `@loom/runtime/policy`'s `policy()`, never on `approvalsReviewerFor` —
  // asserting both here as a single fact keeps that independence from
  // silently drifting apart as either side changes.
  for (const mode of ["default", "plan", "acceptEdits"] as const) {
    assert.equal(approvalsReviewerFor(mode), "user");
    assert.equal(policy(mode, "commit"), "ask");
  }
  assert.equal(approvalsReviewerFor("auto"), "auto_review");
  assert.equal(policy("auto", "commit"), "allow");
});

/** A minimal stand-in for `ChildProcessWithoutNullStreams`: real stdout/stderr
 *  streams a test can write fake server lines into, plus a `stdin.write` spy
 *  and an EventEmitter for `exit`/`error` — enough for `CodexRpcClient`
 *  without spawning a real process. */
const fakeProcess = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: unknown[] = [];
  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, {
    stdout,
    stderr,
    stdin: {
      write: (chunk: unknown) => {
        written.push(chunk);
        return true;
      },
    },
    kill: () => emitter.emit("exit", null, "SIGTERM"),
  });
  return { proc, stdout, stderr, written };
};

test("native ChatGPT launch receives a relay token without the configured upstream MCP env", async () => {
  const names = ["LOOM_TEST_CUSTOM_SEARCH_KEY"];
  const saved = names.map((name) => Deno.env.get(name));
  for (const name of names) Deno.env.set(name, "upstream-secret");
  const specs: CodexLaunchSpec[] = [];
  let session: Awaited<ReturnType<typeof CodexAppServerSession.start>> | undefined;
  try {
    session = await CodexAppServerSession.start(
      {
        sessionId: "relay-env",
        cwd: "/tmp",
        prompt: "",
        mode: "default",
        mcpServers: [
          {
            name: "search",
            credentialEnv: names[0]!,
            spec: {
              transport: "http",
              url: "http://127.0.0.1:23456/mcp",
              headers: { Authorization: "Bearer local-relay-token" },
            },
          },
        ],
      },
      {
        dir: "/tmp/loom-codex-launch-injected",
        authJsonPath: "/tmp/loom-codex-launch-injected/auth.json",
      },
      FAKE_CODEX,
      undefined,
      false,
      undefined,
      (spec) => {
        specs.push(spec);
        return spawnCodex(spec);
      },
    );
    assert.equal(specs[0]!.env.LOOM_TEST_CUSTOM_SEARCH_KEY, undefined);
    assert.match(specs[0]!.args.join(" "), /local-relay-token/);
    assert.doesNotMatch(JSON.stringify(specs), /upstream-secret/);
  } finally {
    await session?.close();
    for (const [i, name] of names.entries()) {
      if (saved[i] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, saved[i]!);
    }
  }
});

test("Codex usage counts deltas, ignores duplicates and other threads, and resumes without rebilling", async () => {
  const usage = (input: number, cached: number, output: number) => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: output,
    totalTokens: input + output,
  });
  for (const resumed of [false, true]) {
    const baseline = usage(1000, 600, 200);
    const total = resumed ? usage(1100, 640, 220) : usage(100, 40, 20);
    const update = { total, last: usage(100, 40, 20), modelContextWindow: 10000 };
    Deno.env.set(
      "LOOM_TEST_USAGE_UPDATES",
      JSON.stringify([{ ...update, threadId: "unrelated-thread" }, update, update]),
    );
    if (resumed)
      Deno.env.set(
        "LOOM_TEST_USAGE_REPLAY",
        JSON.stringify({
          total: baseline,
          last: usage(300, 200, 50),
          modelContextWindow: 10000,
        }),
      );
    let s: CodexAppServerSession | undefined;
    try {
      const home = {
        dir: "/tmp/loom-usage-codex",
        authJsonPath: "/tmp/loom-usage-codex/auth.json",
      };
      if (resumed) {
        s = await CodexAppServerSession.resume(
          { sessionId: "usage", providerRef: "fake-thread-1", cwd: "/tmp" },
          home,
          FAKE_CODEX,
        );
        await s.send("go");
      } else {
        s = await CodexAppServerSession.start(
          { sessionId: "usage", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
          home,
          FAKE_CODEX,
        );
      }
      const events = [];
      for await (const ev of s.events()) {
        if (ev.type === "usage") events.push(ev);
        if (ev.type === "result") break;
      }
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.tokens, { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
      assert.equal(events[0]?.contextUsed, 120);
      assert.equal(events[0]?.costDeltaUsd, undefined);
      assert.deepEqual(s.snapshot().usage, events[0]?.tokens);
    } finally {
      await s?.close();
      Deno.env.delete("LOOM_TEST_USAGE_UPDATES");
      Deno.env.delete("LOOM_TEST_USAGE_REPLAY");
    }
  }
});

test("Codex VM network access survives turns, mode changes and resume; host stays offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-network-"));
  const log = join(root, "requests.jsonl");
  Deno.env.set("LOOM_TEST_REQUEST_LOG", log);
  try {
    for (const executionEnvironment of ["host", "session-vm"] as const) {
      await writeFile(log, "");
      const provider = createProvider({
        id: "chatgpt",
        executionEnvironment,
        config: { codexCliPath: FAKE_CODEX, configDir: root },
        logger: makeLogger("test"),
      });
      const opts = {
        sessionId: "network",
        cwd: root,
        prompt: "",
        mode: "default" as const,
        mcpServers: [],
      };
      let session = await provider.createSession(opts);
      const providerRef = session.providerRef!;
      try {
        for (const mode of ["plan", "acceptEdits", "auto", "default"] as const) {
          await session.setMode!(mode);
          await session.send("check");
          for await (const event of session.events()) if (event.type === "result") break;
        }
      } finally {
        await session.close();
      }
      session = await provider.resumeSession({ sessionId: opts.sessionId, cwd: root, providerRef });
      try {
        await session.send("resumed");
        for await (const event of session.events()) if (event.type === "result") break;
      } finally {
        await session.close();
      }
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const allowed = executionEnvironment === "session-vm";
      const starts = requests.filter((r) => ["thread/start", "thread/resume"].includes(r.method));
      assert.equal(starts.length, 2);
      for (const { params } of starts)
        assert.equal(params.config["sandbox_workspace_write.network_access"], allowed);
      const policies = requests.filter((r) =>
        ["turn/start", "thread/settings/update"].includes(r.method),
      );
      assert.equal(policies.length, 9);
      for (const { params } of policies) {
        assert.equal(params.sandboxPolicy.networkAccess, allowed);
        if (params.sandboxPolicy.type === "workspaceWrite")
          assert.deepEqual(params.sandboxPolicy.writableRoots, [root]);
        else assert.equal(params.sandboxPolicy.type, "readOnly");
      }
    }
  } finally {
    Deno.env.delete("LOOM_TEST_REQUEST_LOG");
    await rm(root, { recursive: true, force: true });
  }
});
test("ChatGPT titling preserves labeling instructions and uses an ephemeral read-only thread", async () => {
  const { generateTitle } = await import("@loom/daemon/daemon/titler");
  const dir = await mkdtemp(join(tmpdir(), "loom-codex-title-"));
  const capture = join(dir, "start.json");
  Deno.env.set("LOOM_TEST_START_PARAMS_FILE", capture);
  Deno.env.set("LOOM_TEST_TITLE_REPLY", "Repair automatic session naming");
  try {
    const provider = createProvider({
      id: "chatgpt",
      config: { configDir: dir, codexCliPath: FAKE_CODEX, codexBuiltinWebSearch: true },
      logger: makeLogger("title-test"),
    });
    const title = await generateTitle({
      provider,
      prompt: "please fix automatic naming",
      cwd: dir,
      log: makeLogger("title-test"),
      timeoutMs: 3000,
    });
    assert.equal(title, "Repair automatic session naming");
    const { params, argv } = JSON.parse(await readFile(capture, "utf8"));
    assert.match(params.baseInstructions, /labelling function/);
    assert.equal(params.developerInstructions, "");
    assert.equal(params.ephemeral, true);
    assert.equal(params.sandbox, "read-only");
    assert.equal(params.approvalPolicy, "never");
    assert.equal(params.dynamicTools, undefined);
    assert.equal(params.config.project_doc_max_bytes, 0);
    assert.equal(params.config.features.shell_tool, false);
    assert.ok(argv.includes('web_search = "disabled"'));
    assert.ok(argv.includes("mcp_servers={  }"));
  } finally {
    Deno.env.delete("LOOM_TEST_START_PARAMS_FILE");
    Deno.env.delete("LOOM_TEST_TITLE_REPLY");
    await rm(dir, { recursive: true, force: true });
  }
});
