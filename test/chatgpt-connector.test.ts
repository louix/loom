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
import {
  CODEX_MODEL_PAGES,
  discoverCodexModels,
  readCodexRateLimits,
} from "@loom/connector-chatgpt/discovery";
import { catalogueFromDiscovered } from "@loom/core/model-catalogue";
import { CodexRpcClient } from "@loom/connector-chatgpt/rpc";
import { makeLogger } from "@loom/core/logger";
import type { HarnessEvent } from "@loom/core/events";
import type { PlanDecision, SessionMode } from "@loom/core/types";
import { writtenPaths } from "@loom/core/tool-paths";
import { policy } from "@loom/runtime/policy";
import { CodexAppServerSession, mcpConfig } from "@loom/connector-chatgpt/app-server";
import {
  CODEX_PERMISSION_MODES,
  CodexNativeModes,
  codexAgentMode,
  reviewerFor,
} from "@loom/connector-chatgpt/agent-modes";
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
    config: { configDir: "/definitely/not" },
    logger: makeLogger("test"),
  });
  // Native history forks go through Codex's own `thread/fork`.
  assert.equal(provider.capabilities.forking, true);
  assert.equal(provider.capabilities.rewind, false);
  assert.equal(provider.capabilities.ownsTranscript, false);
  assert.equal(provider.capabilities.liveModelSwitch, false);
  assert.equal(provider.capabilities.liveModeSwitch, true);
  assert.equal(provider.capabilities.compaction, true);
  // Code Mode's `thread/compact/start` accepts no instruction payload.
  assert.equal(provider.capabilities.compactionInstructions, false);
  // Native presets only: offering acceptEdits would duplicate Manual.
  assert.deepEqual(provider.capabilities.permissionModes, ["default", "plan", "auto"]);
});

test("createProvider rejects the obsolete direct-backend base_url setting", () => {
  assert.throws(
    () =>
      createProvider({
        id: "chatgpt",
        config: { configDir: "/definitely/not", baseUrl: "https://example.invalid" },
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

test("codeModeInstructions rules out Codex's own sub-agent tools, naming loom-agents only when mounted", () => {
  const supervisor = codeModeInstructions("/workspace", true, true, null, "", "", true);
  assert.match(supervisor, /For sub-agents, use only the `loom-agents` tools \(`agent_start`/);
  assert.match(
    supervisor,
    /Never use Codex's built-in sub-agent tools \(`spawn_agent`, `followup_task`/,
  );
  for (const plain of [
    codeModeInstructions("/workspace", true, true, null),
    codeModeInstructions("/workspace", false, false, null),
  ]) {
    assert.doesNotMatch(plain, /loom-agents/);
    assert.match(plain, /Never use Codex's built-in sub-agent tools/);
  }
});

test("codeModeInstructions splices in the caller's repoInstructions instead of reading files itself", async () => {
  // A directory with no instruction files on disk at all — proves the text
  // below reached the output only because it was passed in, not because the
  // connector went and read the filesystem: the daemon decides which
  // providers need the repository's instructions.
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-codemode-noinstructions-"));
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
  const catalog = new ChatGPTCatalog(resolveCodexHome({ configDir: "/definitely/not" }));
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

test("Codex requires explicitly selected command and remote tools", () => {
  assert.equal(
    mcpConfig([
      { name: "host", required: true, spec: { transport: "stdio", command: "tool" } },
      {
        name: "remote",
        required: true,
        spec: { transport: "http", url: "https://example.invalid/mcp" },
      },
    ]),
    '{ "host" = { command = "tool", required = true }, "remote" = { url = "https://example.invalid/mcp", required = true } }',
  );
});

test("Loom modes map explicitly onto Codex's native presets; acceptEdits is Manual, not a duplicate choice", () => {
  assert.equal(codexAgentMode("auto"), "auto");
  assert.equal(codexAgentMode("default"), "default");
  assert.equal(codexAgentMode("plan"), "plan");
  // Its old Codex pair (on-request, user) is exactly Manual's.
  assert.equal(codexAgentMode("acceptEdits"), "default");
  assert.equal(reviewerFor("auto"), "auto_review");
  assert.equal(reviewerFor("default"), "user");
  assert.deepEqual(CODEX_PERMISSION_MODES, ["default", "plan", "auto"]);
});

test("resolveCodexHome: config_dir, then CODEX_HOME, then ~/.codex", () => {
  assert.equal(resolveCodexHome({ env: {} }).dir.endsWith("/.codex"), true);
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "/from/env" } }).dir, "/from/env");
  assert.deepEqual(resolveCodexHome({ configDir: "/explicit", env: { CODEX_HOME: "/ignored" } }), {
    dir: "/explicit",
    authJsonPath: "/explicit/auth.json",
  });
});

test("resolveCodexHome resolves a relative config_dir to an absolute path", () => {
  const relative = resolveCodexHome({ configDir: "./codex", env: {} });
  assert.equal(relative.dir, join(process.cwd(), "codex"));
  assert.equal(relative.authJsonPath, join(process.cwd(), "codex", "auth.json"));
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
      description: "Frontier coding model",
      isDefault: true,
      supportsEffort: true,
      effortLevels: ["low", "high"],
      defaultEffort: "low",
    },
    { id: "gpt-5.6-hidden", hidden: true },
  ]);
});

test("the Codex catalogue uses native displayName and efforts, drops hidden rows and marks the default", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-home-test",
    authJsonPath: "/tmp/loom-codex-home-test/auth.json",
  };
  const discovered = await discoverCodexModels({ cliPath: FAKE_CODEX, codexHome });
  // The provider's automatic list: hidden rows filtered, as `listModels` does.
  const catalogue = catalogueFromDiscovered(
    discovered.filter((m) => !m.hidden).map(({ hidden: _h, ...m }) => m),
  );
  assert.deepEqual(catalogue, {
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        description: "Frontier coding model",
        supportsEffort: true,
        effortLevels: ["low", "high"],
        defaultEffort: "low",
      },
    ],
    defaultModel: "gpt-5.6-sol",
  });
});

test("Codex model discovery is bounded: endless paging and a repeated cursor both fail", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-home-test",
    authJsonPath: "/tmp/loom-codex-home-test/auth.json",
  };
  const previous = Deno.env.get("LOOM_TEST_MODEL_LIST");
  const requested: number[] = [];
  const launch: CodexLauncher = (spec) => {
    requested.push(1);
    return spawnCodex(spec);
  };
  try {
    Deno.env.set("LOOM_TEST_MODEL_LIST", "endless");
    await assert.rejects(
      discoverCodexModels({ cliPath: FAKE_CODEX, codexHome, launch }),
      /exceeds discovery bounds/,
    );
    Deno.env.set("LOOM_TEST_MODEL_LIST", "repeat");
    await assert.rejects(
      discoverCodexModels({ cliPath: FAKE_CODEX, codexHome, launch }),
      /repeated a model catalogue cursor/,
    );
    assert.equal(requested.length, 2);
    assert.ok(CODEX_MODEL_PAGES >= 2);
  } finally {
    if (previous === undefined) Deno.env.delete("LOOM_TEST_MODEL_LIST");
    else Deno.env.set("LOOM_TEST_MODEL_LIST", previous);
  }
});

test("Codex discovery switches off the user's MCP servers for the probe", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-home-test",
    authJsonPath: "/tmp/loom-codex-home-test/auth.json",
  };
  const specs: CodexLaunchSpec[] = [];
  const launch: CodexLauncher = (spec) => {
    specs.push(spec);
    return spawnCodex(spec);
  };
  await discoverCodexModels({ cliPath: FAKE_CODEX, codexHome, launch });
  assert.deepEqual(specs[0]?.args.slice(-2), ["-c", "mcp_servers={}"]);
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

test("Codex sessions run with its native multi-agent tools switched off, created or resumed", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-no-subagents",
    authJsonPath: "/tmp/loom-codex-no-subagents/auth.json",
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
  for (const spec of specs) {
    const overrides = spec.args.flatMap((arg, i) => (spec.args[i - 1] === "-c" ? [arg] : []));
    assert.ok(overrides.includes("features.multi_agent=false"));
    // A v2 model keeps its tools whatever `enabled` says (openai/codex#50880);
    // a one-thread cap is what refuses the spawn.
    assert.ok(
      overrides.includes(
        "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}",
      ),
    );
    assert.ok(!overrides.includes("features.multi_agent_v2=false"), "one setting for v2");
  }
});

test("activated Codex sessions preserve the project environment on create and resume", async () => {
  const previous = Deno.env.get("LOOM_PROJECT_ENVIRONMENT");
  const codexHome = {
    dir: "/tmp/loom-codex-environment",
    authJsonPath: "/tmp/loom-codex-environment/auth.json",
  };
  const specs: CodexLaunchSpec[] = [];
  const launch: CodexLauncher = (spec) => {
    specs.push(spec);
    return spawnCodex(spec);
  };
  try {
    for (const activated of [false, true]) {
      if (activated) Deno.env.set("LOOM_PROJECT_ENVIRONMENT", "1");
      else Deno.env.delete("LOOM_PROJECT_ENVIRONMENT");
      const started = await CodexAppServerSession.start(
        { sessionId: "environment", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
        codexHome,
        FAKE_CODEX,
        undefined,
        false,
        undefined,
        launch,
      );
      await started.close();
      const resumed = await CodexAppServerSession.resume(
        { sessionId: "environment", providerRef: "fake-thread-1", cwd: "/tmp" },
        codexHome,
        FAKE_CODEX,
        undefined,
        false,
        undefined,
        launch,
      );
      await resumed.close();
      for (const spec of specs.splice(0)) {
        assert.equal(spec.args.includes("allow_login_shell=false"), activated);
        assert.equal(spec.args.includes("features.shell_snapshot=false"), activated);
        assert.equal(
          spec.args.includes("shell_environment_policy.experimental_use_profile=false"),
          activated,
        );
      }
    }
  } finally {
    if (previous === undefined) Deno.env.delete("LOOM_PROJECT_ENVIRONMENT");
    else Deno.env.set("LOOM_PROJECT_ENVIRONMENT", previous);
  }
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
    // same pending-interaction machinery `ask_user`/native
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

for (const mode of ["plan", "default"] as const) {
  test(`a pre-native thread's exit_plan call (${mode}) is redirected to native Plan, never raising a review`, async () => {
    const codexHome = {
      dir: `/tmp/loom-codex-dyntool-exitplan-${mode}`,
      authJsonPath: `/tmp/loom-codex-dyntool-exitplan-${mode}/auth.json`,
    };
    const resultFile = join(tmpdir(), `tool-call-result-exitplan-${mode}-${process.pid}.json`);
    try {
      Deno.env.set(
        "LOOM_TEST_TOOL_CALL_SPEC",
        JSON.stringify({ tool: "exit_plan", arguments: { plan: "do the thing" } }),
      );
      Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
      const s = await CodexAppServerSession.start(
        { sessionId: "s1", cwd: "/tmp", prompt: "", mode, mcpServers: [], loomServer: true },
        codexHome,
        FAKE_CODEX,
      );
      try {
        const result = JSON.parse(await waitForFile(resultFile)) as {
          contentItems: Array<{ text: string }>;
          success: boolean;
        };
        assert.equal(result.success, false);
        assert.match(result.contentItems[0]?.text ?? "", /retired.*<proposed_plan>/s);
        await s.close();
        const events: string[] = [];
        for await (const ev of s.events()) events.push(ev.type);
        assert(!events.includes("plan_review"));
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
  // `@loom/runtime/policy`'s `policy()` of the Loom mode, never on Codex's
  // reviewer — Plan keeps whichever reviewer it exits to, yet still asks.
  for (const mode of ["default", "plan", "acceptEdits"] as const)
    assert.equal(policy(mode, "commit"), "ask");
  assert.equal(reviewerFor("default"), "user");
  assert.equal(reviewerFor("auto"), "auto_review");
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

test("Codex usage counts deltas, ignores duplicates and other threads, and resumes or forks without rebilling", async () => {
  const usage = (input: number, cached: number, output: number) => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: output,
    totalTokens: input + output,
  });
  for (const how of ["start", "resume", "fork"] as const) {
    // A native fork (`thread/fork`) replays the copied thread's cumulative
    // usage like a resume does: it seeds the baseline, it is never charged.
    const resumed = how !== "start";
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
          {
            sessionId: "usage",
            providerRef: "fake-thread-1",
            cwd: "/tmp",
            ...(how === "fork" ? { forkHistory: true } : {}),
          },
          home,
          FAKE_CODEX,
        );
        // A fork is a new thread; the source thread is not resumed.
        assert.equal(s.providerRef, how === "fork" ? "fake-thread-1-fork" : "fake-thread-1");
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
      // Every turn restates the same writable sandbox, Plan included; mode
      // changes are collaboration/reviewer settings and never touch it.
      const turns = requests.filter((r) => r.method === "turn/start");
      assert.equal(turns.length, 5);
      for (const { params } of turns) {
        assert.equal(params.sandboxPolicy.networkAccess, allowed);
        assert.equal(params.sandboxPolicy.type, "workspaceWrite");
        assert.deepEqual(params.sandboxPolicy.writableRoots, [root]);
      }
      // Plan, Manual (for acceptEdits), Auto, Manual; resuming in Manual is a no-op.
      const updates = requests.filter((r) => r.method === "thread/settings/update");
      assert.equal(updates.length, 4);
      for (const { params } of updates) assert.equal(params.sandboxPolicy, undefined);
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
test("ChatGPT plan limits are read on start/resume and refreshed by account notifications", async () => {
  const window = (usedPercent: number, windowDurationMins: number) => ({
    usedPercent,
    windowDurationMins,
    resetsAt: 2_000_000_000,
  });
  const codex = { limitId: "codex", primary: window(20, 300), secondary: window(85, 10080) };
  const astra = { limitId: "gpt-6-astra", primary: window(45, 300), secondary: null };
  Deno.env.set(
    "LOOM_TEST_LIMITS",
    JSON.stringify({
      rateLimits: codex,
      rateLimitsByLimitId: { codex, "gpt-6-astra": astra },
    }),
  );
  Deno.env.set(
    "LOOM_TEST_LIMITS_UPDATE",
    JSON.stringify({
      rateLimits: { ...astra, primary: window(100, 300) },
    }),
  );
  try {
    for (const resumed of [false, true]) {
      const home = { dir: "/tmp/loom-limits", authJsonPath: "/tmp/loom-limits/auth.json" };
      const s = resumed
        ? await CodexAppServerSession.resume(
            { sessionId: "limits", providerRef: "fake-thread-1", cwd: "/tmp" },
            home,
            FAKE_CODEX,
          )
        : await CodexAppServerSession.start(
            { sessionId: "limits", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
            home,
            FAKE_CODEX,
          );
      const deadline = setTimeout(() => void s.close(), 5000);
      try {
        await s.send("go");
        const events = [];
        for await (const event of s.events()) {
          if (event.type === "rate_limit") events.push(event);
          if (events.length === 4) break;
        }
        // The account read's windows are polled; the update's are not.
        assert.deepEqual(
          events.map((e) => [e.window, e.utilization, e.status, e.resetsAt, e.polled ?? false]),
          [
            ["codex 5h", 20, "allowed", 2_000_000_000_000, true],
            ["codex 7d", 85, "allowed_warning", 2_000_000_000_000, true],
            ["gpt-6-astra 5h", 45, "allowed", 2_000_000_000_000, true],
            ["gpt-6-astra 5h", 100, "rejected", 2_000_000_000_000, false],
          ],
        );
        assert.ok(events.every((e) => e.sessionId === "limits"));
      } finally {
        clearTimeout(deadline);
        await s.close();
      }
    }
  } finally {
    Deno.env.delete("LOOM_TEST_LIMITS");
    Deno.env.delete("LOOM_TEST_LIMITS_UPDATE");
  }
});

test("ChatGPT sessions still start when account limits are unavailable", async () => {
  Deno.env.set("LOOM_TEST_LIMITS_ERROR", "1");
  try {
    const s = await CodexAppServerSession.start(
      { sessionId: "limits", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
      { dir: "/tmp/loom-limits", authJsonPath: "/tmp/loom-limits/auth.json" },
      FAKE_CODEX,
    );
    await s.close();
  } finally {
    Deno.env.delete("LOOM_TEST_LIMITS_ERROR");
  }
});

const codexLimits = {
  limitId: "codex",
  primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 2_000_000_000 },
  secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 2_000_000_000 },
};

test("readCodexRateLimits reads the account's plan windows from a throwaway app-server", async () => {
  Deno.env.set("LOOM_TEST_LIMITS", JSON.stringify({ rateLimits: codexLimits }));
  const launched: CodexLaunchSpec[] = [];
  const launch: CodexLauncher = (spec) => {
    launched.push(spec);
    return spawnCodex(spec);
  };
  try {
    const windows = await readCodexRateLimits({
      cliPath: FAKE_CODEX,
      codexHome: { dir: "/tmp/loom-limits", authJsonPath: "/tmp/loom-limits/auth.json" },
      launch,
    });
    assert.deepEqual(
      windows.map((w) => [w.window, w.utilization, w.status, w.resetsAt]),
      [
        ["codex 5h", 30, "allowed", 2_000_000_000_000],
        ["codex 7d", 60, "allowed", 2_000_000_000_000],
      ],
    );
    // Metadata only: the user's MCP servers stay off, as for model discovery.
    assert.ok(launched[0]?.args.includes("mcp_servers={}"));
  } finally {
    Deno.env.delete("LOOM_TEST_LIMITS");
  }
});

test("a live ChatGPT session re-reads its plan windows on refreshPlanUsage", async () => {
  Deno.env.set("LOOM_TEST_LIMITS", JSON.stringify({ rateLimits: codexLimits }));
  try {
    const s = await CodexAppServerSession.start(
      { sessionId: "limits", cwd: "/tmp", prompt: "", mode: "default", mcpServers: [] },
      { dir: "/tmp/loom-limits", authJsonPath: "/tmp/loom-limits/auth.json" },
      FAKE_CODEX,
    );
    const deadline = setTimeout(() => void s.close(), 5000);
    try {
      const windows: string[] = [];
      for await (const event of s.events()) {
        if (event.type !== "rate_limit") continue;
        windows.push(event.window!);
        // The start-up read, then the on-demand one.
        if (windows.length === 2) await s.refreshPlanUsage();
        if (windows.length === 4) break;
      }
      assert.deepEqual(windows, ["codex 5h", "codex 7d", "codex 5h", "codex 7d"]);
    } finally {
      clearTimeout(deadline);
      await s.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_LIMITS");
  }
});

test("ChatGPT legacy limits preserve percentages and ignore malformed or absent windows", async () => {
  const { rateLimitEvents } = await import("../connectors/chatgpt/src/rate-limits.ts");
  assert.deepEqual(rateLimitEvents(null, "s", 1, "update"), []);
  assert.deepEqual(
    rateLimitEvents({ rateLimits: { primary: { usedPercent: "50" } } }, "s", 1, "update"),
    [],
  );
  assert.deepEqual(
    rateLimitEvents(
      {
        rateLimits: {
          primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null },
          secondary: null,
        },
      },
      "s",
      1,
      "read",
    ),
    [
      {
        type: "rate_limit",
        sessionId: "s",
        ts: 1,
        window: "codex primary",
        utilization: 0,
        status: "allowed",
        polled: true,
      },
    ],
  );
});

test("dynamic dispatch owns question completion despite contradictory provider item notifications", async () => {
  for (const success of [null, false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "loom-question-lifecycle-"));
    const resultFile = join(directory, "response.json");
    Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
    Deno.env.set(
      "LOOM_TEST_TOOL_CALL_SPEC",
      JSON.stringify({
        tool: "ask_user",
        arguments: { question: "Continue?" },
      }),
    );
    Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
    Deno.env.set(
      "LOOM_TEST_PRE_NOTIFICATION",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "dynamicToolCall",
            id: "fake-call-1",
            tool: "ask_user",
            status: success === null ? "inProgress" : "completed",
            success,
            contentItems: null,
          },
        },
      }),
    );
    let session: CodexAppServerSession | undefined;
    try {
      session = await CodexAppServerSession.start(
        {
          sessionId: "lifecycle",
          cwd: directory,
          prompt: "go",
          mode: "default",
          mcpServers: [],
          loomServer: true,
        },
        { dir: directory, authJsonPath: join(directory, "auth.json") },
        FAKE_CODEX,
      );
      const events = session.events()[Symbol.asyncIterator]();
      const seen = [];
      while (true) {
        const { value: event } = await events.next();
        assert(event);
        seen.push(event);
        if (event.type === "assistant_text" && event.text === "notification delivered") break;
      }
      assert.equal(seen.filter((e) => e.type === "tool_call").length, 1);
      assert.equal(seen.filter((e) => e.type === "question").length, 1);
      assert.equal(seen.filter((e) => e.type === "tool_result").length, 0);
      await session.answerQuestion("fake-call-1", "yes");
      while (true) {
        const { value: event } = await events.next();
        assert(event);
        seen.push(event);
        if (event.type === "tool_result") {
          assert.equal(event.ok, true);
          assert.equal(event.output, "yes");
          break;
        }
      }
      const response = JSON.parse(await waitForFile(resultFile));
      assert.equal(response.contentItems[0].text, "yes");
      assert.equal(seen.filter((e) => e.type === "answer").length, 1);
    } finally {
      await session?.close();
      for (const name of [
        "LOOM_TEST_HOLD_TURN",
        "LOOM_TEST_TOOL_CALL_SPEC",
        "LOOM_TEST_TOOL_CALL_RESULT_FILE",
        "LOOM_TEST_PRE_NOTIFICATION",
      ])
        Deno.env.delete(name);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("natural turn completion settles an unanswered dynamic question", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-question-end-"));
  const resultFile = join(directory, "response.json");
  const release = join(directory, "complete");
  Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
  Deno.env.set("LOOM_TEST_COMPLETE_TURN_FILE", release);
  Deno.env.set(
    "LOOM_TEST_TOOL_CALL_SPEC",
    JSON.stringify({
      tool: "ask_user",
      arguments: { question: "Continue?" },
    }),
  );
  Deno.env.set("LOOM_TEST_TOOL_CALL_RESULT_FILE", resultFile);
  let session: CodexAppServerSession | undefined;
  try {
    session = await CodexAppServerSession.start(
      {
        sessionId: "lifecycle",
        cwd: directory,
        prompt: "go",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      },
      { dir: directory, authJsonPath: join(directory, "auth.json") },
      FAKE_CODEX,
    );
    const events = session.events()[Symbol.asyncIterator]();
    while ((await events.next()).value?.type !== "question") {
      /* await admission */
    }
    await writeFile(release, "");
    const response = JSON.parse(await waitForFile(resultFile));
    assert.match(response.contentItems[0].text, /turn ended before this was answered/);
    await session.answerQuestion("fake-call-1", "too late");
    while (true) {
      const { value: event } = await events.next();
      assert(event);
      assert.notEqual(event.type, "answer");
      if (event.type === "tool_result") {
        assert.equal(event.output, response.contentItems[0].text);
        break;
      }
    }
  } finally {
    await session?.close();
    for (const name of [
      "LOOM_TEST_HOLD_TURN",
      "LOOM_TEST_COMPLETE_TURN_FILE",
      "LOOM_TEST_TOOL_CALL_SPEC",
      "LOOM_TEST_TOOL_CALL_RESULT_FILE",
    ])
      Deno.env.delete(name);
    await rm(directory, { recursive: true, force: true });
  }
});
test("a turn completed in the same read as turn/start's reply still ends, and is never steered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-codex-instant-turn-"));
  const log = join(dir, "requests.jsonl");
  Deno.env.set("LOOM_TEST_REQUEST_LOG", log);
  try {
    // Without and with `turn/started` ahead of the completion.
    for (const variant of ["1", "started"]) {
      await writeFile(log, "");
      Deno.env.set("LOOM_TEST_COMPLETE_TURN_WITH_REPLY", variant);
      const s = await CodexAppServerSession.start(
        { sessionId: "instant", cwd: dir, prompt: "", mode: "default", mcpServers: [] },
        { dir, authJsonPath: join(dir, "auth.json") },
        FAKE_CODEX,
      );
      // A dropped completion would otherwise wait for a result forever.
      const deadline = setTimeout(() => void s.close(), 5000);
      try {
        for (const prompt of ["first", "second"]) {
          await s.send(prompt);
          let ended = false;
          for await (const event of s.events())
            if (event.type === "result") {
              ended = true;
              break;
            }
          assert.ok(ended, `${variant}: the "${prompt}" turn never ended`);
          assert.equal(s.snapshot().status.kind, "idle", variant);
        }
      } finally {
        clearTimeout(deadline);
        await s.close();
      }
      const methods = (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).method);
      assert.equal(methods.filter((m) => m === "turn/start").length, 2, variant);
      assert.equal(methods.filter((m) => m === "turn/steer").length, 0, variant);
    }
  } finally {
    Deno.env.delete("LOOM_TEST_REQUEST_LOG");
    Deno.env.delete("LOOM_TEST_COMPLETE_TURN_WITH_REPLY");
    await rm(dir, { recursive: true, force: true });
  }
});
// --- Native agent modes ------------------------------------------------------

type Logged = { method: string; params: Record<string, any> };
const modesHome = {
  dir: "/tmp/loom-codex-native-modes",
  authJsonPath: "/tmp/loom-codex-native-modes/auth.json",
};

/** Run `body` against the fake app-server with its knobs set (`env` may name
 *  files in the scratch directory), logging every request it receives. */
const withFakeCodex = async (
  env: Record<string, string> | ((dir: string) => Record<string, string>),
  body: (requests: (method?: string) => Promise<Logged[]>, dir: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "loom-codex-modes-"));
  const log = join(dir, "requests.jsonl");
  const all = { LOOM_TEST_REQUEST_LOG: log, ...(typeof env === "function" ? env(dir) : env) };
  for (const [name, value] of Object.entries(all)) Deno.env.set(name, value);
  try {
    await body(async (method) => {
      const text = await readFile(log, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Logged)
        .filter((r) => !method || r.method === method);
    }, dir);
  } finally {
    for (const name of Object.keys(all)) Deno.env.delete(name);
    await rm(dir, { recursive: true, force: true });
  }
};

const startCodex = (mode: SessionMode, prompt = "") =>
  CodexAppServerSession.start(
    { sessionId: "s1", cwd: "/tmp", prompt, mode, mcpServers: [] },
    modesHome,
    FAKE_CODEX,
  );
const resumeCodex = (mode?: SessionMode) =>
  CodexAppServerSession.resume(
    { sessionId: "s1", cwd: "/tmp", providerRef: "fake-thread-1", ...(mode ? { mode } : {}) },
    modesHome,
    FAKE_CODEX,
  );

/** Events up to and including the first one `done` accepts. */
const eventsUntil = async (
  s: CodexAppServerSession,
  done: (ev: HarnessEvent) => boolean,
): Promise<HarnessEvent[]> => {
  const seen: HarnessEvent[] = [];
  for await (const ev of s.events()) {
    seen.push(ev);
    if (done(ev)) return seen;
  }
  throw new Error(`events ended without a match: ${seen.map((ev) => ev.type).join(", ")}`);
};
const inputText = (r: Logged): string => r.params.input?.[0]?.text ?? "";

test("CodexNativeModes reports only what Codex reports; an acknowledgement alone never settles a change", async () => {
  const modes = new CodexNativeModes(20);
  const presets = {
    data: [
      { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
      { name: "Default", mode: "default", model: null, reasoning_effort: null },
    ],
  };
  assert.equal(await modes.discover(async () => presets), null);
  const reply = { model: "m", approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  modes.initialize(reply, true);
  assert.equal(modes.mode, "auto", "a fresh thread is in Default collaboration");
  modes.initialize(reply, false);
  assert.equal(modes.mode, null, "a resume reply without collaboration is not guessed");
  assert.equal(modes.collaborationKnown, false);
  assert.equal(modes.executionMode, "auto");
  modes.initialize({ ...reply, collaborationMode: { mode: "plan" } }, false);
  assert.equal(modes.mode, "plan");
  assert.equal(modes.executionMode, "auto", "Plan keeps the reviewer it exits to");
  assert.equal(modes.updateFor("plan", null, null), null, "native no-ops are never sent");
  assert.deepEqual(modes.updateFor("default", null, "low"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    collaborationMode: {
      mode: "default",
      settings: { model: "m", reasoning_effort: "low", developer_instructions: null },
    },
  });

  const unobserved = modes.until("default");
  await assert.rejects(unobserved.wait(), /did not report the default mode as effective/);
  assert.equal(modes.mode, "plan");

  // Another mode's report doesn't settle the watch; the target's does, even
  // when it arrives before the acknowledgement (before `wait()`).
  const observed = modes.until("default");
  const settings = {
    model: "m",
    approvalPolicy: "on-request",
    collaborationMode: { mode: "default" },
  };
  modes.observe({ ...settings, approvalsReviewer: "auto_review" });
  assert.equal(modes.mode, "auto");
  modes.observe({ ...settings, approvalsReviewer: "user" });
  await observed.wait();
  assert.equal(modes.mode, "default");
  modes.observe({ ...settings, approvalPolicy: "never", approvalsReviewer: "user" });
  assert.equal(modes.mode, null, "settings outside Loom's presets name no mode");

  const pending = modes.until("auto");
  modes.close(new Error("connection gone"));
  await assert.rejects(pending.wait(), /connection gone/);
  await assert.rejects(modes.until("plan").wait(), /connection gone/);
});

test("CodexNativeModes reports missing or malformed collaboration presets instead of inventing them", async () => {
  const none = new CodexNativeModes();
  const failure = await none.discover(async () => {
    throw new Error("unknown method");
  });
  assert.match(failure ?? "", /did not list its collaboration modes \(unknown method\)/);
  none.initialize({ model: "m", approvalPolicy: "on-request", approvalsReviewer: "user" }, true);
  assert.equal(none.mode, "default");
  assert.throws(() => none.updateFor("plan", null, null), /does not offer a Plan/);
  assert.throws(() => none.updateFor("auto", null, null), /does not offer its default/);

  const planOnly = new CodexNativeModes();
  const missing = await planOnly.discover(async () => ({ data: [{ name: "Plan", mode: "plan" }] }));
  assert.match(missing ?? "", /Auto and Manual cannot be selected/);
  const twice = await new CodexNativeModes().discover(async () => ({
    data: [{ mode: "plan" }, { mode: "plan" }],
  }));
  assert.match(twice ?? "", /twice/);
  assert.match((await new CodexNativeModes().discover(async () => ({}))) ?? "", /malformed/);
});

for (const [mode, effective, reviewer] of [
  ["auto", "auto", "auto_review"],
  ["default", "default", "user"],
  ["acceptEdits", "default", "user"],
  ["plan", "plan", "user"],
] as const) {
  test(`a fresh Codex session requested in ${mode} starts on-request, workspace-write, and reports ${effective}`, () =>
    withFakeCodex({}, async (requests) => {
      const s = await startCodex(mode);
      try {
        assert.equal(s.snapshot().mode, effective);
        assert.equal(s.snapshot().pendingMode, undefined);
        const [start] = await requests("thread/start");
        assert.equal(start!.params.approvalPolicy, "on-request");
        assert.equal(start!.params.sandbox, "workspace-write");
        // A fresh Plan session has no earlier reviewer; it exits to Manual.
        assert.equal(start!.params.approvalsReviewer, reviewer);
        assert.equal((await requests("collaborationMode/list")).length, 1);
        const updates = await requests("thread/settings/update");
        if (mode === "plan") {
          assert.equal(updates.length, 1);
          assert.equal(updates[0]!.params.collaborationMode.mode, "plan");
          assert.equal(updates[0]!.params.approvalsReviewer, undefined);
          assert.equal(updates[0]!.params.sandboxPolicy, undefined);
        } else assert.equal(updates.length, 0, "the start already selected it");
      } finally {
        await s.close();
      }
    }));
}

for (const execution of ["auto", "default"] as const) {
  test(`${execution} -> plan -> ${execution} keeps the execution choice, and choosing a preset in Plan selects its reviewer`, () =>
    withFakeCodex({}, async (requests) => {
      const other = execution === "auto" ? "default" : "auto";
      const s = await startCodex(execution);
      try {
        await s.setMode("plan");
        assert.equal(s.snapshot().mode, "plan");
        await s.setMode(execution);
        assert.equal(s.snapshot().mode, execution);
        await s.setMode("plan");
        await s.setMode(other);
        assert.equal(s.snapshot().mode, other);
        await s.setMode(other); // already effective: nothing to send or observe
        const updates = (await requests("thread/settings/update")).map((r) => r.params);
        assert.deepEqual(
          updates.map((p) => [p.collaborationMode.mode, p.approvalsReviewer ?? "kept"]),
          [
            ["plan", "kept"],
            ["default", reviewerFor(execution)],
            ["plan", "kept"],
            ["default", reviewerFor(other)],
          ],
        );
        for (const p of updates) {
          assert.equal(p.approvalPolicy, "on-request");
          assert.equal(p.sandboxPolicy, undefined);
          assert.equal(p.collaborationMode.settings.developer_instructions, null);
        }
        assert.equal(updates[0]!.collaborationMode.settings.reasoning_effort, "medium");
      } finally {
        await s.close();
      }
    }));
}

for (const first of [false, true]) {
  test(`setMode settles on the observed mode whether Codex reports it ${first ? "before" : "after"} acknowledging`, () =>
    withFakeCodex(first ? { LOOM_TEST_SETTINGS_NOTIFICATION_FIRST: "1" } : {}, async () => {
      const s = await startCodex("default");
      try {
        await s.setMode("plan");
        assert.equal(s.snapshot().mode, "plan");
        await s.setMode("auto");
        assert.equal(s.snapshot().mode, "auto");
      } finally {
        await s.close();
      }
    }));
}

test("a mid-turn mode change applies to the next turn: pending until then, and never interrupting", () =>
  withFakeCodex(
    (dir) => ({ LOOM_TEST_HOLD_TURN: "1", LOOM_TEST_COMPLETE_TURN_FILE: join(dir, "complete") }),
    async (requests, dir) => {
      const s = await startCodex("default", "go");
      try {
        await s.setMode("auto");
        assert.equal(s.snapshot().status.kind, "running");
        assert.equal(s.snapshot().mode, "auto");
        assert.equal(s.snapshot().pendingMode, "auto", "the running turn started in Manual");
        await s.send("steer"); // still the current turn
        assert.equal((await requests("turn/interrupt")).length, 0);
        await writeFile(join(dir, "complete"), "");
        await eventsUntil(s, (ev) => ev.type === "result");
        assert.equal(s.snapshot().pendingMode, undefined, "nothing runs under the old mode");
        await rm(join(dir, "complete"));
        await s.send("next");
        assert.equal(s.snapshot().mode, "auto");
        assert.equal(s.snapshot().pendingMode, undefined);
        const turns = await requests("turn/start");
        assert.equal(turns.length, 2);
        assert.equal((await requests("turn/steer")).length, 1);
        for (const { params } of turns) {
          // Thread settings own the mode; turns restate only the sandbox.
          assert.equal(params.approvalPolicy, undefined);
          assert.equal(params.approvalsReviewer, undefined);
          assert.equal(params.collaborationMode, undefined);
          assert.equal(params.sandboxPolicy.type, "workspaceWrite");
        }
      } finally {
        await s.close();
      }
    },
  ));

test("a rejected mode change throws and leaves the reported mode and the session usable", () =>
  withFakeCodex({ LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE: "1" }, async () => {
    const s = await startCodex("default");
    try {
      await assert.rejects(s.setMode("plan"), /forced thread\/settings\/update failure/);
      assert.equal(s.snapshot().mode, "default");
      await assert.rejects(s.setMode("auto"), /forced thread\/settings\/update failure/);
      assert.equal(s.snapshot().mode, "default");
      await s.send("still usable");
      await eventsUntil(s, (ev) => ev.type === "result");
    } finally {
      await s.close();
    }
  }));

test("a disconnect during a mode change rejects it without claiming the requested mode", () =>
  withFakeCodex({ LOOM_TEST_EXIT_ON_SETTINGS_UPDATE: "1" }, async () => {
    const s = await startCodex("auto");
    try {
      await assert.rejects(s.setMode("plan"));
      assert.equal(s.snapshot().mode, "auto");
    } finally {
      await s.close();
    }
  }));

test("Codex without collaboration modes is reported: Plan is refused, nothing is invented", () =>
  withFakeCodex({ LOOM_TEST_NO_COLLABORATION_MODES: "1" }, async (requests) => {
    const s = await startCodex("plan");
    try {
      const events = await eventsUntil(s, (ev) => ev.type === "status_changed");
      const notes = events.flatMap((ev) => (ev.type === "error" ? [ev] : []));
      assert(notes.some((ev) => !ev.fatal && /collaboration modes/.test(ev.message)));
      assert(notes.some((ev) => !ev.fatal && /remains in Manual/.test(ev.message)));
      assert.equal(s.snapshot().mode, "default", "the reviewer Codex reported, in Default");
      await assert.rejects(s.setMode("plan"), /does not offer a Plan collaboration mode/);
      assert.equal((await requests("thread/settings/update")).length, 0);
    } finally {
      await s.close();
    }
  }));

for (const { saved, mode, expect, update } of [
  {
    // Codex restores the reviewer; Loom's saved mode agrees.
    saved: { approvalsReviewer: "auto_review" },
    mode: "auto",
    expect: "auto",
    update: null,
  },
  {
    // Plan was selected after the thread's last turn, or (legacy) Loom's
    // "plan" was only a read-only sandbox: restore native Plan, keep the reviewer.
    saved: { approvalsReviewer: "auto_review" },
    mode: "plan",
    expect: "plan",
    update: ["plan", "kept"],
  },
  {
    // The reply omits the collaboration mode: applying the saved mode refreshes it.
    saved: { approvalsReviewer: "auto_review", collaborationMode: null },
    mode: "default",
    expect: "default",
    update: ["default", "user"],
  },
  {
    // Old acceptEdits sessions were on-request/user — Manual, mapped explicitly.
    saved: { approvalsReviewer: "user" },
    mode: "acceptEdits",
    expect: "default",
    update: null,
  },
] as const) {
  test(`resuming a ${mode} session restores the saved reviewer and reports ${expect}${saved.collaborationMode === null ? " after refreshing" : ""}`, () =>
    withFakeCodex({ LOOM_TEST_RESUME_SETTINGS: JSON.stringify(saved) }, async (requests) => {
      const s = await resumeCodex(mode);
      try {
        assert.equal(s.snapshot().mode, expect);
        const [resume] = await requests("thread/resume");
        assert.equal(resume!.params.approvalsReviewer, undefined, "the saved reviewer is kept");
        assert.equal(resume!.params.approvalPolicy, "on-request");
        assert.equal(resume!.params.sandbox, "workspace-write");
        const updates = (await requests("thread/settings/update")).map((r) => [
          r.params.collaborationMode.mode,
          r.params.approvalsReviewer ?? "kept",
        ]);
        assert.deepEqual(updates, update ? [update] : []);
      } finally {
        await s.close();
      }
    }));
}

const planReview = async (s: CodexAppServerSession) => {
  const events = await eventsUntil(s, (ev) => ev.type === "plan_review" || ev.type === "result");
  const review = events.at(-1)!;
  assert.equal(review.type, "plan_review", "the planning turn is held open, not finished");
  assert(events.some((ev) => ev.type === "assistant_text" && ev.text === "1. do it"));
  return review as Extract<HarnessEvent, { type: "plan_review" }>;
};

for (const { name, start, decision, mode, reviewer, text } of [
  {
    name: "implement exits to the execution choice Plan kept",
    start: "auto",
    decision: { action: "implement" },
    mode: "auto",
    reviewer: "auto_review",
    text: /^The plan is approved\. Implement it now:\n\nthe plan you just presented$/,
  },
  {
    name: "implement in an explicitly chosen mode selects its reviewer",
    start: "default",
    decision: { action: "implement", mode: "auto" },
    mode: "auto",
    reviewer: "auto_review",
    text: /the plan you just presented/,
  },
  {
    name: "revise implements the edited plan; acceptEdits runs as Manual",
    start: "auto",
    decision: { action: "revise", plan: "1. do it better", mode: "acceptEdits" },
    mode: "default",
    reviewer: "user",
    text: /Implement it now:\n\n1\. do it better$/,
  },
  {
    name: "implement_fresh implements in place",
    start: "default",
    decision: { action: "implement_fresh" },
    mode: "default",
    reviewer: "user",
    text: /the plan you just presented/,
  },
  {
    name: "discuss stays in Plan and sends the note",
    start: "auto",
    decision: { action: "discuss", message: "tighten step 2" },
    mode: "plan",
    reviewer: null,
    text: /^tighten step 2$/,
  },
] as const) {
  test(`native plan review: ${name}`, () =>
    withFakeCodex({ LOOM_TEST_PLAN_ITEM: "1. do it" }, async (requests) => {
      const s = await startCodex(start);
      try {
        await s.setMode("plan");
        await s.send("go");
        const review = await planReview(s);
        assert.equal(review.id, "fake-plan-1");
        assert.equal(review.plan, "1. do it");
        assert.equal(review.implementMode, start);
        const before = (await requests("thread/settings/update")).length;
        await s.respondToPlan(review.id, decision as PlanDecision);
        assert.equal(s.snapshot().mode, mode);
        const updates = (await requests("thread/settings/update")).slice(before);
        if (reviewer) {
          assert.equal(updates.length, 1);
          assert.equal(updates[0]!.params.collaborationMode.mode, "default");
          assert.equal(updates[0]!.params.approvalsReviewer, reviewer);
        } else assert.equal(updates.length, 0);
        const turns = await requests("turn/start");
        assert.equal(turns.length, 2, "one new message, no interrupt");
        assert.match(inputText(turns[1]!), text);
        assert.equal((await requests("turn/interrupt")).length, 0);
        // The implementation turn ends the engagement; a discussion plans again.
        const next = await eventsUntil(
          s,
          (ev) => ev.type === "result" || ev.type === "plan_review",
        );
        assert.equal(next.at(-1)!.type, mode === "plan" ? "plan_review" : "result");
      } finally {
        await s.close();
      }
    }));
}

test("native plan review: handoff ends the held turn without a mode change or message", () =>
  withFakeCodex({ LOOM_TEST_PLAN_ITEM: "1. do it" }, async (requests) => {
    const s = await startCodex("plan", "go");
    try {
      const review = await planReview(s);
      assert.equal(review.implementMode, "default", "a fresh Plan session exits to Manual");
      await s.respondToPlan(review.id, { action: "handoff" });
      await eventsUntil(s, (ev) => ev.type === "result");
      assert.equal(s.snapshot().status.kind, "idle");
      assert.equal(s.snapshot().mode, "plan");
      assert.equal((await requests("turn/start")).length, 1);
      assert.equal((await requests("thread/settings/update")).length, 1); // entering Plan
      // Answered once; a stale answer is ignored.
      await s.respondToPlan(review.id, { action: "implement" });
      assert.equal((await requests("turn/start")).length, 1);
    } finally {
      await s.close();
    }
  }));

test("a plan is not offered for review once the user left Plan during its turn", () =>
  withFakeCodex(
    (dir) => ({
      LOOM_TEST_PLAN_ITEM: "1. do it",
      LOOM_TEST_HOLD_TURN: "1",
      LOOM_TEST_COMPLETE_TURN_FILE: join(dir, "complete"),
    }),
    async (_requests, dir) => {
      const s = await startCodex("plan", "go");
      try {
        await s.setMode("default");
        assert.equal(s.snapshot().pendingMode, "default");
        await writeFile(join(dir, "complete"), "");
        const events = await eventsUntil(s, (ev) => ev.type === "result");
        assert(!events.some((ev) => ev.type === "plan_review"));
        assert(events.some((ev) => ev.type === "assistant_text" && ev.text === "1. do it"));
      } finally {
        await s.close();
      }
    },
  ));

test("a failed plan exit settles the turn in Plan and never sends the implementation request", () =>
  withFakeCodex(
    { LOOM_TEST_PLAN_ITEM: "1. do it", LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE_FROM: "2" },
    async (requests) => {
      const s = await startCodex("plan", "go");
      try {
        const review = await planReview(s);
        await assert.rejects(
          s.respondToPlan(review.id, { action: "implement" }),
          /forced thread\/settings\/update failure/,
        );
        await eventsUntil(s, (ev) => ev.type === "result");
        assert.equal(s.snapshot().mode, "plan");
        assert.equal(s.snapshot().status.kind, "idle");
        assert.equal((await requests("turn/start")).length, 1);
      } finally {
        await s.close();
      }
    },
  ));

test("an external interrupt while a plan exit's mode change is in flight stops the implementation request", () =>
  withFakeCodex(
    (dir) => ({
      LOOM_TEST_PLAN_ITEM: "1. do it",
      LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE: join(dir, "hold"),
      LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE_CALL: "2",
    }),
    async (requests, dir) => {
      const s = await startCodex("plan", "go");
      try {
        const review = await planReview(s);
        const responded = assert.rejects(
          s.respondToPlan(review.id, { action: "implement" }),
          /interrupted before the plan could be implemented/,
        );
        assert(await waitForExists(join(dir, "hold.received"), 2000));
        await s.interrupt();
        assert.equal(s.snapshot().status.kind, "idle");
        await writeFile(join(dir, "hold.release"), "");
        await responded;
        assert.equal((await requests("turn/start")).length, 1);
        assert.equal(s.snapshot().status.kind, "idle");
      } finally {
        await s.close();
      }
    },
  ));

test("an external interrupt while a plan's implementation turn is starting ends that turn", () =>
  withFakeCodex(
    (dir) => ({
      LOOM_TEST_PLAN_ITEM: "1. do it",
      LOOM_TEST_HOLD_TURN_START: join(dir, "turn"),
      LOOM_TEST_HOLD_TURN_START_CALL: "2",
    }),
    async (requests, dir) => {
      const s = await startCodex("plan", "go");
      try {
        const review = await planReview(s);
        const responded = assert.rejects(
          s.respondToPlan(review.id, { action: "implement" }),
          /interrupted before the plan could be implemented/,
        );
        assert(await waitForExists(join(dir, "turn.received"), 2000));
        await s.interrupt();
        assert.equal(s.snapshot().status.kind, "idle");
        await writeFile(join(dir, "turn.release"), "");
        await responded;
        assert.equal((await requests("turn/interrupt")).length, 1);
        assert.equal(s.snapshot().status.kind, "idle");
      } finally {
        await s.close();
      }
    },
  ));
// A9 message queue: a queued message rides as `clientUserMessageId`, and the
// session reports it consumed when Codex takes it up.
const consumedOf = (seen: HarnessEvent[]) =>
  seen.flatMap((e) => (e.type === "input_consumed" ? [[e.inputId, e.midTurn]] : []));

test("Codex: a steered message is consumed when its userMessage item names it; a new turn's at the reply", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-queue-steer",
    authJsonPath: "/tmp/loom-codex-queue-steer/auth.json",
  };
  const release = join(tmpdir(), `codex-queue-release-${process.pid}`);
  Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
  Deno.env.set("LOOM_TEST_COMPLETE_TURN_FILE", release);
  Deno.env.set("LOOM_TEST_STEER", "echo");
  const s = await CodexAppServerSession.start(
    { sessionId: "q1", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
    codexHome,
    FAKE_CODEX,
  );
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const ev of s.events()) seen.push(ev);
  })();
  try {
    await s.send("also this", { inputId: "entry-steer", midTurn: true });
    await waitUntil(() => consumedOf(seen).length === 1);
    assert.deepEqual(consumedOf(seen), [["entry-steer", true]]);
    await writeFile(release, "");
    await waitUntil(() => seen.some((e) => e.type === "result"));
    assert.equal(consumedOf(seen).length, 1, "the turn's end does not report it twice");
    await rm(release, { force: true });
    await s.send("next turn", { inputId: "entry-turn" });
    await waitUntil(() => consumedOf(seen).length === 2);
    assert.deepEqual(consumedOf(seen)[1], ["entry-turn", false]);
  } finally {
    await s.close();
    await reader;
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_COMPLETE_TURN_FILE");
    Deno.env.delete("LOOM_TEST_STEER");
    await rm(release, { force: true });
  }
});

test("Codex: a steer the server never echoes is consumed when its turn completes", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-queue-fallback",
    authJsonPath: "/tmp/loom-codex-queue-fallback/auth.json",
  };
  const release = join(tmpdir(), `codex-queue-fallback-${process.pid}`);
  Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
  Deno.env.set("LOOM_TEST_COMPLETE_TURN_FILE", release);
  const s = await CodexAppServerSession.start(
    { sessionId: "q2", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
    codexHome,
    FAKE_CODEX,
  );
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const ev of s.events()) seen.push(ev);
  })();
  try {
    await s.send("quietly steered", { inputId: "entry-quiet", midTurn: true });
    await delay(50);
    assert.deepEqual(consumedOf(seen), []);
    await writeFile(release, "");
    await waitUntil(() => consumedOf(seen).length === 1);
    assert.deepEqual(consumedOf(seen), [["entry-quiet", true]]);
  } finally {
    await s.close();
    await reader;
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_COMPLETE_TURN_FILE");
    await rm(release, { force: true });
  }
});

test("Codex: a steer that lost the race with the turn's end is refused, unconsumed", async () => {
  const codexHome = {
    dir: "/tmp/loom-codex-queue-reject",
    authJsonPath: "/tmp/loom-codex-queue-reject/auth.json",
  };
  Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
  Deno.env.set("LOOM_TEST_STEER", "reject");
  const s = await CodexAppServerSession.start(
    { sessionId: "q3", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
    codexHome,
    FAKE_CODEX,
  );
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const ev of s.events()) seen.push(ev);
  })();
  try {
    // The session manager requeues a refused hand-over for the next turn.
    await assert.rejects(
      s.send("too late", { inputId: "entry-late", midTurn: true }),
      /expected turn is not active/,
    );
    await delay(30);
    assert.deepEqual(consumedOf(seen), []);
  } finally {
    await s.close();
    await reader;
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_STEER");
  }
});

test("Codex reports a command running at item/started and only its result at completion", async () => {
  Deno.env.set(
    "LOOM_TEST_PRE_NOTIFICATION",
    JSON.stringify({
      method: "item/started",
      params: { item: { type: "commandExecution", id: "cmd-1", command: "sleep 9", cwd: "/tmp" } },
    }),
  );
  Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
  const s = await CodexAppServerSession.start(
    { sessionId: "q4", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
    { dir: "/tmp/loom-codex-item-started", authJsonPath: "/tmp/loom-codex-item-started/auth.json" },
    FAKE_CODEX,
  );
  try {
    for await (const ev of s.events()) {
      if (ev.type === "tool_call" && ev.id === "cmd-1") {
        assert.equal(ev.name, "Bash");
        assert.deepEqual(ev.input, { command: "sleep 9", cwd: "/tmp" });
        break;
      }
    }
  } finally {
    await s.close();
    Deno.env.delete("LOOM_TEST_PRE_NOTIFICATION");
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
  }
});

const waitUntil = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(5);
  }
};

/** Start a one-turn session under `env` and collect its events until the turn ends. */
const turnEvents = async (
  sessionId: string,
  env: Record<string, string>,
): Promise<HarnessEvent[]> => {
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    const s = await CodexAppServerSession.start(
      { sessionId, cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      { dir: `/tmp/loom-${sessionId}`, authJsonPath: `/tmp/loom-${sessionId}/auth.json` },
      FAKE_CODEX,
    );
    const deadline = setTimeout(() => void s.close(), 5000);
    const events: HarnessEvent[] = [];
    try {
      for await (const ev of s.events()) {
        events.push(ev);
        if (ev.type === "result" || (ev.type === "error" && ev.fatal)) break;
      }
      return events;
    } finally {
      clearTimeout(deadline);
      await s.close();
    }
  } finally {
    for (const k of Object.keys(env)) Deno.env.delete(k);
  }
};

test("a turn Codex interrupted itself ends as an interrupted result carrying the reason", async () => {
  const message =
    "Automatic approval review rejected too many approval requests for this turn (3).";
  const events = await turnEvents("codex-too-many-denials", {
    LOOM_TEST_TURN_COMPLETION: JSON.stringify({
      status: "interrupted",
      error: { message, codexErrorInfo: "tooManyDenials", additionalDetails: null },
    }),
  });
  const end = events.at(-1);
  assert.deepEqual(end && { ...end, ts: 0 }, {
    type: "result",
    sessionId: "codex-too-many-denials",
    ts: 0,
    kind: "interrupted",
    reason: "too many denials",
    message,
  });
  // Without an error Codex still said it stopped; the reason is just unknown.
  const bare = await turnEvents("codex-interrupted-bare", {
    LOOM_TEST_TURN_COMPLETION: JSON.stringify({ status: "interrupted", error: null }),
  });
  const last = bare.at(-1);
  assert.equal(last?.type === "result" && last.kind, "interrupted");
  assert.equal(last?.type === "result" && last.kind === "interrupted" && last.reason, undefined);
});

test("a failed Codex turn's error names its code before Codex's message", async () => {
  const events = await turnEvents("codex-flex-unavailable", {
    LOOM_TEST_TURN_COMPLETION: JSON.stringify({
      status: "failed",
      error: {
        message: "Flex processing is unavailable right now.",
        codexErrorInfo: "flexUnavailable",
      },
    }),
  });
  const end = events.at(-1);
  assert.equal(end?.type, "error");
  assert.equal(
    end?.type === "error" && end.message,
    "flex processing unavailable: Flex processing is unavailable right now.",
  );
});

test("a user stop keeps its attribution: Codex's interrupted completion of the stopped turn is not reported", async () => {
  Deno.env.set("LOOM_TEST_HOLD_TURN", "1");
  Deno.env.set(
    "LOOM_TEST_INTERRUPT_COMPLETION",
    JSON.stringify({ error: { message: "interrupted", codexErrorInfo: "other" } }),
  );
  try {
    const s = await CodexAppServerSession.start(
      { sessionId: "codex-user-stop", cwd: "/tmp", prompt: "go", mode: "default", mcpServers: [] },
      { dir: "/tmp/loom-codex-user-stop", authJsonPath: "/tmp/loom-codex-user-stop/auth.json" },
      FAKE_CODEX,
    );
    await s.interrupt();
    await delay(150);
    await s.close();
    const ends: HarnessEvent[] = [];
    for await (const ev of s.events())
      if (ev.type === "result" || (ev.type === "error" && ev.fatal)) ends.push(ev);
    assert.deepEqual(ends, []);
  } finally {
    Deno.env.delete("LOOM_TEST_HOLD_TURN");
    Deno.env.delete("LOOM_TEST_INTERRUPT_COMPLETION");
  }
});

test("Codex error codes read as short reasons; unknown codes degrade to words", async () => {
  const { codexErrorLabel, turnErrorReason } = await import("@loom/connector-chatgpt/turn-error");
  assert.equal(codexErrorLabel("tooManyDenials"), "too many denials");
  assert.equal(codexErrorLabel("flexUnavailable"), "flex processing unavailable");
  assert.equal(codexErrorLabel("other"), undefined);
  assert.equal(codexErrorLabel("someFutureCode"), "some future code");
  assert.equal(
    codexErrorLabel({ responseStreamDisconnected: { httpStatusCode: 502 } }),
    "stream disconnected (HTTP 502)",
  );
  assert.equal(codexErrorLabel({ futureVariant: {} }), "future variant");
  assert.equal(codexErrorLabel(null), undefined);
  // `other` falls back to Codex's message, which then needs no repeating.
  assert.deepEqual(turnErrorReason({ message: "boom", codexErrorInfo: "other" }), {
    reason: "boom",
  });
  assert.deepEqual(turnErrorReason(null), {});
});

test("every Codex plan type reads as a plan name; unknown ones degrade to words or nothing", async () => {
  const { codexPlanLabel } = await import("@loom/connector-chatgpt/account");
  // `PlanType` in `codex app-server generate-json-schema` (Codex 0.160.0).
  const schema = [
    "free",
    "go",
    "plus",
    "pro",
    "prolite",
    "promax",
    "team",
    "self_serve_business_prolite",
    "self_serve_business_usage_based",
    "business",
    "ent26",
    "enterprise_cbp_automation",
    "enterprise_cbp_usage_based",
    "enterprise",
    "edu",
    "edu_plus",
    "edu_pro",
  ];
  const labels = schema.map(codexPlanLabel);
  assert.ok(labels.every((l) => l?.startsWith("ChatGPT ")));
  assert.equal(new Set(labels).size, schema.length, "each plan reads differently");
  assert.equal(codexPlanLabel("promax"), "ChatGPT Pro Max");
  assert.equal(codexPlanLabel("prolite"), "ChatGPT Pro Lite");
  assert.equal(codexPlanLabel("unknown"), undefined);
  assert.equal(codexPlanLabel("some_new_plan"), "ChatGPT Some New Plan");
  for (const junk of [null, undefined, "", " ", 3, {}])
    assert.equal(codexPlanLabel(junk), undefined);
});

test("Codex plan windows carry the account's plan when the snapshot names it", async () => {
  const { rateLimitWindows } = await import("../connectors/chatgpt/src/rate-limits.ts");
  const window = { usedPercent: 5, windowDurationMins: 300, resetsAt: 2_000_000_000 };
  assert.deepEqual(
    rateLimitWindows(
      { rateLimits: { limitId: "codex", planType: "promax", primary: window } },
      1,
      "read",
    ).map((w) => w.plan),
    ["ChatGPT Pro Max"],
  );
  for (const planType of [null, "unknown"])
    assert.equal(
      rateLimitWindows(
        { rateLimits: { limitId: "codex", planType, primary: window } },
        1,
        "update",
      )[0]?.plan,
      undefined,
    );
});
