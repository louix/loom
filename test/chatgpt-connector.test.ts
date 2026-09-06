import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  approvalsReviewerFor,
  CodexAppServerSession,
  mcpConfig,
} from "@loom/connector-chatgpt/app-server";
import { spawnCodex, type CodexLaunchSpec, type CodexLauncher } from "@loom/connector-chatgpt/launch";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

const repo = (): { root: string; git: (...a: string[]) => string; cleanup: () => Promise<void> } => {
  const root = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
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
    const mounted = codeModeInstructions(dir, true, null);
    assert.match(mounted, /call the `commit` tool/);
    assert.match(mounted, /`status` tool reprints this root/);
    assert.doesNotMatch(mounted, /call `ask_user`/);

    const unmounted = codeModeInstructions(dir, false, null);
    assert.doesNotMatch(unmounted, /call the `commit` tool/);
    assert.doesNotMatch(unmounted, /`status` tool reprints this root/);
    assert.doesNotMatch(unmounted, /call `ask_user`/);
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
    const withInstructions = codeModeInstructions(dir, true, "# from the repo root fallback\n\ndo the thing");
    assert.match(withInstructions, /from the repo root fallback/);

    const withoutInstructions = codeModeInstructions(dir, true, null);
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

test("Code Mode serializes Loom MCP mounts and configured Kagi into app-server config", () => {
  assert.equal(
    mcpConfig([
      { name: "tilth", spec: { transport: "stdio", command: "tilth", args: ["--mcp", "--edit"] } },
      { name: "remote", spec: { transport: "http", url: "https://example.invalid/mcp" } },
    ]),
    '{ "tilth" = { command = "tilth", args = ["--mcp", "--edit"] }, "remote" = { url = "https://example.invalid/mcp" } }',
  );
  assert.equal(
    mcpConfig([], { backend: "kagi", apiKey: "secret", apiBase: "", maxResults: 6 }),
    '{ "kagi" = { url = "https://mcp.kagi.com/mcp", bearer_token_env_var = "LOOM_CODEX_KAGI_API_KEY" } }',
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
  assert.deepEqual(
    resolveCodexHome({ configDir: "/explicit", env: { CODEX_HOME: "/ignored" } }),
    { dir: "/explicit", authJsonPath: "/explicit/auth.json" },
  );
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
  const codexHome = { dir: "/tmp/loom-codex-home-test", authJsonPath: "/tmp/loom-codex-home-test/auth.json" };
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
  const codexHome = { dir: "/tmp/loom-codex-resume-test", authJsonPath: "/tmp/loom-codex-resume-test/auth.json" };

  const withInstructions = await CodexAppServerSession.resume(
    { sessionId: "s1", providerRef: "fake-thread-1", cwd: "/tmp", systemPromptAppend: "resumed-instructions-marker" },
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

test("a failed thread/start closes the app-server process instead of leaking it", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "loom-codex-exit-"));
  const codexHome = { dir: "/tmp/loom-codex-fail-test", authJsonPath: "/tmp/loom-codex-fail-test/auth.json" };
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
    assert.equal((await waitForMarker(markerDir)).length, 1, "the spawned process should have exited");
  } finally {
    Deno.env.delete("LOOM_TEST_FAIL_STARTUP");
    Deno.env.delete("LOOM_TEST_EXIT_MARKER_DIR");
    await rm(markerDir, { recursive: true, force: true });
  }
});

test("a failed thread/resume closes the app-server process instead of leaking it", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "loom-codex-exit-"));
  const codexHome = { dir: "/tmp/loom-codex-fail-test", authJsonPath: "/tmp/loom-codex-fail-test/auth.json" };
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
    assert.equal((await waitForMarker(markerDir)).length, 1, "the spawned process should have exited");
  } finally {
    Deno.env.delete("LOOM_TEST_FAIL_STARTUP");
    Deno.env.delete("LOOM_TEST_EXIT_MARKER_DIR");
    await rm(markerDir, { recursive: true, force: true });
  }
});

test("a non-ChatGPT authenticated account is rejected without leaking the process", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "loom-codex-exit-"));
  const codexHome = { dir: "/tmp/loom-codex-account-test", authJsonPath: "/tmp/loom-codex-account-test/auth.json" };
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
    assert.equal((await waitForMarker(markerDir)).length, 1, "the spawned process should have exited");
  } finally {
    Deno.env.delete("LOOM_TEST_ACCOUNT_TYPE");
    Deno.env.delete("LOOM_TEST_EXIT_MARKER_DIR");
    await rm(markerDir, { recursive: true, force: true });
  }
});

test("Code Mode compact() rejects custom instructions instead of silently running plain compaction", async () => {
  const codexHome = { dir: "/tmp/loom-codex-compact-test", authJsonPath: "/tmp/loom-codex-compact-test/auth.json" };
  const s = await CodexAppServerSession.start(
    { sessionId: "s1", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
    codexHome,
    FAKE_CODEX,
  );
  try {
    await assert.rejects(() => s.compact("keep the plan verbatim"), /does not support custom instructions/);
    await s.compact(); // plain compaction still works
    await s.compact("   "); // blank instructions are the same as none
  } finally {
    await s.close();
  }
});

test("Codex's item/tool/call invokes Loom's commit dynamic tool and replies on the envelope id (auto mode allows it)", async () => {
  const { root, git, cleanup } = repo();
  const codexHome = { dir: "/tmp/loom-codex-dyntool-commit", authJsonPath: "/tmp/loom-codex-dyntool-commit/auth.json" };
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
      const result = JSON.parse(raw) as { contentItems: Array<{ type: string; text: string }>; success: boolean };
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
      const result = JSON.parse(raw) as { contentItems: Array<{ type: string; text: string }>; success: boolean };
      assert.equal(result.success, true);
      assert.equal(result.contentItems[0]?.text, "handled by the injected dispatcher, not git");
      assert.deepEqual(calls, [{ tool: "commit", args: { message: "Add a.txt" } }]);
      assert.equal(git("rev-parse", "HEAD"), headBefore, "the injected dispatcher ran, not a real commit");
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
  test(`Codex's item/tool/call denies commit in ${mode} mode instead of running it unapproved`, async () => {
    // Loom can't yet raise a `permission_request` for a Codex dynamic-tool
    // call (Phase 5) — Codex's own sandbox has no visibility into this
    // side-channel call either, since it runs in Loom's process, not the
    // sandboxed turn. Every mode but `auto` must deny rather than silently
    // mutate the worktree, matching Claude/aisdk's own `commit` gating
    // (`@loom/runtime/policy`'s `policy()`, which never auto-allows `commit`
    // outside `auto` mode — "commit" matches neither the readonly nor edit
    // verb lists).
    const { root, git, cleanup } = repo();
    const codexHome = {
      dir: `/tmp/loom-codex-dyntool-deny-${mode}`,
      authJsonPath: `/tmp/loom-codex-dyntool-deny-${mode}/auth.json`,
    };
    const resultFile = join(root, "..", `tool-call-result-deny-${mode}-${process.pid}.json`);
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
}

test("Codex's item/tool/call always allows status, regardless of mode", async () => {
  const { root, cleanup } = repo();
  const codexHome = { dir: "/tmp/loom-codex-dyntool-status", authJsonPath: "/tmp/loom-codex-dyntool-status/auth.json" };
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
  const codexHome = { dir: "/tmp/loom-codex-dyntool-unknown", authJsonPath: "/tmp/loom-codex-dyntool-unknown/auth.json" };
  const resultFile = join(tmpdir(), `tool-call-result-unknown-${process.pid}.json`);
  try {
    Deno.env.set("LOOM_TEST_TOOL_CALL_SPEC", JSON.stringify({ tool: "nonexistent", arguments: {} }));
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    const s = await CodexAppServerSession.start(
      { sessionId: "s1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [], loomServer: true },
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
