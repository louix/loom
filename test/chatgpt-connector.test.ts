import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { streamText } from "ai";
import { AisdkEventMapper } from "@loom/aisdk/map";
import { createChatGPTModels } from "@loom/connector-chatgpt/oauth";
import { createProvider, codeModeInstructions } from "@loom/connector-chatgpt";
import { resolveCodexHome } from "@loom/connector-chatgpt/codex-home";
import { discoverCodexModels } from "@loom/connector-chatgpt/discovery";
import { CodexRpcClient } from "@loom/connector-chatgpt/rpc";
import { makeLogger } from "@loom/core/logger";
import {
  approvalsReviewerFor,
  CodexAppServerSession,
  mcpConfig,
} from "@loom/connector-chatgpt/app-server";

const noopTranscript = {
  load: () => [],
  count: () => 0,
  append: () => {},
  replaceFrom: () => {},
  clear: () => {},
  copyTo: () => {},
};

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

test("ChatGPT's provider-level capabilities stay conservative across its two backends", async () => {
  // One provider id multiplexes a transcript-owning aisdk backend (ordinary
  // models) and a thread-owning Code Mode backend (`code_mode_only` models).
  // Until a per-session signal exists (Phase 4's persisted backend
  // discriminator), the daemon must treat the whole provider conservatively so
  // its transcript-based checkpoint / rewind / fork / cross-provider-switch
  // machinery never runs against a Codex thread it doesn't own.
  const provider = await createProvider({
    id: "chatgpt",
    config: { authPath: "/definitely/not/auth.json" },
    transcript: noopTranscript,
    logger: makeLogger("test"),
  });
  assert.equal(provider.capabilities.forking, false);
  assert.equal(provider.capabilities.rewind, false);
  assert.equal(provider.capabilities.ownsTranscript, false);
  assert.equal(provider.capabilities.liveModelSwitch, false);
});

test("codeModeInstructions only mentions the loom tool Code Mode actually mounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-codemode-"));
  try {
    const withCommit = codeModeInstructions(dir, true);
    assert.match(withCommit, /call the `commit` tool/);
    assert.doesNotMatch(withCommit, /call `ask_user`/);
    assert.doesNotMatch(withCommit, /`status` tool reprints this root/);

    const withoutLoomServer = codeModeInstructions(dir, false);
    assert.doesNotMatch(withoutLoomServer, /call the `commit` tool/);
    assert.doesNotMatch(withoutLoomServer, /call `ask_user`/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ChatGPT OAuth connector constructs a v5 model without reading credentials eagerly", () => {
  // Constructing the provider must not touch ~/.codex/auth.json: a user should
  // be able to configure Loom before running `codex login`, then get the
  // provider's actionable auth error only when starting a session.
  const { makeModel } = createChatGPTModels({
    codexHome: resolveCodexHome({ authPath: "/definitely/not/auth.json" }),
  });
  const model = makeModel("gpt-5.6-terra");
  assert.equal(model.specificationVersion, "v2");
  assert.equal(model.provider, "chatgpt");
  assert.equal(model.modelId, "gpt-5.6-terra");
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

test("ChatGPT serializes tool history as Responses input items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-tools-test-"));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }),
  );
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/codex/models"))
      return Response.json({ models: [{ slug: "gpt-5.5", base_instructions: "test" }] });
    if (url.includes("/codex/responses")) {
      const body = init?.body;
      if (typeof body !== "string") throw new Error("expected a JSON request body");
      request = JSON.parse(body) as Record<string, unknown>;
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { makeModel } = createChatGPTModels({ codexHome: resolveCodexHome({ authPath }) });
    await makeModel("gpt-5.5").doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Run pwd" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "shell",
              input: { command: "pwd" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "shell",
              output: { type: "text", value: "/workspace" },
            },
          ],
        },
      ],
    } as never);
    assert.deepEqual(request?.["input"], [
      { role: "user", content: "Run pwd" },
      { type: "function_call", call_id: "call-1", name: "shell", arguments: '{"command":"pwd"}' },
      { type: "function_call_output", call_id: "call-1", output: "/workspace" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("ChatGPT cached-input usage feeds Loom's provider/model cache observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-test-"));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/codex/models"))
      return Response.json({ models: [{ slug: "gpt-5.5", base_instructions: "test" }] });
    if (url.includes("/codex/responses")) {
      const event = {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 20,
          },
        },
      };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: {
          "x-codex-primary-used-percent": "42",
          "x-codex-primary-window-minutes": "60",
          "x-codex-primary-reset-at": "1700000000",
          "x-codex-secondary-used-percent": "84",
          "x-codex-secondary-reset-at": "1700003600",
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { makeModel } = createChatGPTModels({ codexHome: resolveCodexHome({ authPath }) });
    const result = streamText({
      model: makeModel("gpt-5.5"),
      prompt: "hello",
    });
    const mapper = new AisdkEventMapper("session", "gpt-5.5");
    const events = [];
    for await (const part of result.fullStream) {
      events.push(...mapper.map(part));
    }
    const usage = events.find((event) => event.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.deepEqual(usage.tokens, { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
    assert.equal(usage.contextUsed, 100);
    assert.deepEqual(
      events.filter((event) => event.type === "rate_limit"),
      [
        {
          type: "rate_limit",
          sessionId: "session",
          ts: events[0]?.ts,
          window: "codex-primary",
          status: "allowed",
          utilization: 42,
          resetsAt: 1_700_000_000_000,
        },
        {
          type: "rate_limit",
          sessionId: "session",
          ts: events[0]?.ts,
          window: "codex-secondary",
          status: "allowed_warning",
          utilization: 84,
          resetsAt: 1_700_003_600_000,
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex auth errors are actionable and never fall back to an API key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-chatgpt-noauth-"));
  try {
    const { makeModel } = createChatGPTModels({ codexHome: resolveCodexHome({ configDir: dir }) });
    await assert.rejects(
      async () => {
        await makeModel("gpt-5.5").doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        } as never);
      },
      /codex login/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
