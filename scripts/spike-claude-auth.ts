/** Live auth spike: replace a stale access token on disk during the same CLI query.
 * Host credentials are read only; no refresh token is copied or exchanged.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
const cli = Deno.args[0];
const rotate = Deno.args[1] === "rotate";
let turn = 1;
assert(cli, "Pass the native Claude executable");
const source = JSON.parse(
  await Deno.readTextFile(
    join(Deno.env.get("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude"), ".credentials.json"),
  ),
).claudeAiOauth;
assert(typeof source?.accessToken === "string");
assert(source.expiresAt > Date.now(), "Host access token has expired; refresh host login first");
const state = await Deno.makeTempDir({ prefix: "loom-auth-spike-" });
let server: ReturnType<typeof Deno.serve> | undefined;
try {
  const config = join(state, "claude");
  await Deno.mkdir(config, { mode: 0o700 });
  const stale = "sk-ant-oat01-loom-auth-spike-invalid";
  const writeCredential = async (accessToken: string) => {
    await Deno.writeTextFile(
      join(config, "credentials.tmp"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          expiresAt: source.expiresAt,
          scopes: source.scopes,
        },
      }),
      { mode: 0o600 },
    );
    await Deno.rename(join(config, "credentials.tmp"), join(config, ".credentials.json"));
  };
  await writeCredential(rotate ? source.accessToken : stale);
  await Deno.writeTextFile(
    join(config, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  let rejectedStale = 0,
    forwardedFresh = 0;
  const observed: Array<{ turn: number; valid: boolean }> = [];
  server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);
    if (!["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname))
      return new Response(null, { status: 404 });
    const bearer = request.headers.get("authorization");
    if (bearer === `Bearer ${stale}`) {
      rejectedStale++;
      observed.push({ turn, valid: false });
      if (!rotate) await writeCredential(source.accessToken);
      console.log(JSON.stringify({ event: "stale-rejected", turn, replacementWritten: !rotate }));
      return Response.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message:
              "OAuth token has expired. Please obtain a new token or refresh your existing token.",
          },
        },
        { status: 401 },
      );
    }
    if (bearer !== `Bearer ${source.accessToken}`) return new Response(null, { status: 403 });
    forwardedFresh++;
    observed.push({ turn, valid: true });
    console.log(JSON.stringify({ event: "valid-forwarded", turn }));
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    return await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: await request.arrayBuffer(),
      signal: AbortSignal.timeout(30_000),
    });
  });
  const env: Record<string, string | undefined> = {
    PATH: Deno.env.get("PATH"),
    HOME: state,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.addr.port}`,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const gates = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const prompts = async function* (): AsyncGenerator<SDKUserMessage> {
    for (let i = 0; i < 3; i++) {
      if (i) await gates[i - 1]!.promise;
      yield {
        type: "user",
        message: { role: "user", content: "Reply with exactly AUTH_OK. Do not use tools." },
        parent_tool_use_id: null,
      };
    }
    await gates[2]!.promise;
  };
  const q = query({
    prompt: rotate ? prompts() : "Reply with exactly AUTH_OK. Do not use tools.",
    options: {
      pathToClaudeCodeExecutable: cli,
      cwd: state,
      env,
      model: "haiku",
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      stderr() {},
    },
  });
  const timer = setTimeout(() => q.close(), 60_000);
  try {
    const results: string[] = [];
    const errors: boolean[] = [];
    for await (const event of q)
      if (event.type === "result") {
        results.push(event.subtype);
        errors.push(event.is_error);
        console.log(
          JSON.stringify({
            event: "result",
            turn,
            subtype: event.subtype,
            isError: event.is_error,
          }),
        );
        if (!rotate || turn === 3) break;
        if (turn === 1) assert.equal(event.subtype, "success");
        await writeCredential(turn === 1 ? stale : source.accessToken);
        turn++;
        gates[turn - 2]!.resolve();
      }
    console.log(
      JSON.stringify({ results, rejectedStale, forwardedFresh, refreshTokenCopied: false }),
    );
    if (rotate) {
      assert.equal(results.length, 3);
      assert.deepEqual(errors, [false, true, false]);
      assert(observed.some((row) => row.turn === 2 && !row.valid));
      assert(
        !observed.some((row) => row.turn === 2 && row.valid),
        "CLI continued using cached valid credentials after disk replacement",
      );
      assert.equal(results[2], "success", "CLI did not recover after restoring valid credentials");
    }
    assert(rejectedStale > 0 && forwardedFresh > 0);
    assert.equal(errors.at(-1), false);
  } finally {
    clearTimeout(timer);
    for (const gate of gates) gate.resolve();
    q.close();
  }
} finally {
  try {
    await server?.shutdown();
  } finally {
    await Deno.remove(state, { recursive: true });
  }
}
