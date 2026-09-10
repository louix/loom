/** Native Codex + real VM, local synthetic OAuth/model servers. No user credentials. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { CodexAuthOwner, readCodexAccess } from "../backend/daemon/src/daemon/codex-auth.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";
const [artifact, smolvm, nativeCli] = Deno.args;
assert(artifact && smolvm && nativeCli, "Pass ARTIFACT SMOLVM HOST_CODEX");
const f = await gitFixture();
const profile = join(f.root, "host-auth");
const sessionDirectory = join(f.root, "native-history");
await Deno.mkdir(profile);
await Deno.mkdir(join(sessionDirectory, "profile"), { recursive: true });
const jwt = (revision: string, expiresAt = Date.now() + 3600000) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000), email: "fixture@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus" }, revision })).toString("base64url")}.signature`;
const initial = jwt("initial");
const replacement = jwt("replacement");
const idToken = jwt("identity");
const writeProfile = async (token: string) => {
  await Deno.writeTextFile(
    join(profile, "next.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: token,
        id_token: idToken,
        account_id: "fixture-account",
        refresh_token: "host-only-refresh",
      },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await Deno.rename(join(profile, "next.json"), join(profile, "auth.json"));
};
await writeProfile(initial);
let refreshes = 0;
let rejectRefresh = false;
let failures = 0;
let rejectedOld = 0;
let sawReplacement = false;
let phase: "rotate" | "expire" = "rotate";
const active = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const expiring = Promise.withResolvers<void>();
const releaseExpiry = Promise.withResolvers<void>();
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const created = { type: "response.created", response: { id: "fixture-response" } };
const completed = {
  type: "response.completed",
  response: {
    id: "fixture-response",
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  },
};
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/oauth/token") {
    const body = await req.json();
    assert.equal(body.refresh_token, "host-only-refresh");
    if (rejectRefresh) {
      failures++;
      return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    }
    refreshes++;
    return Response.json({
      access_token: replacement,
      id_token: idToken,
      refresh_token: "rotated-host-refresh",
    });
  }
  if (!path.endsWith("/responses")) return Response.json({ models: [], data: [] });
  if (req.headers.get("upgrade")) return new Response("Use HTTP streaming", { status: 426 });
  await req.arrayBuffer();
  const token = req.headers.get("authorization");
  if (phase === "expire") {
    return new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(encode(created));
          expiring.resolve();
          await releaseExpiry.promise;
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (!activeSettled) {
    assert.equal(token, `Bearer ${initial}`);
    activeSettled = true;
    return new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(encode(created));
          active.resolve();
          await release.promise;
          c.enqueue(
            encode({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "fixture-call",
                name: "exec_command",
                arguments: JSON.stringify({ cmd: "echo AUTH_TOOL", yield_time_ms: 1000 }),
              },
            }),
          );
          c.enqueue(encode(completed));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (token === `Bearer ${initial}`) {
    rejectedOld++;
    return Response.json(
      { error: { message: "Expired fixture token", type: "invalid_request_error" } },
      { status: 401 },
    );
  }
  assert.equal(token, `Bearer ${replacement}`);
  sawReplacement = true;
  return new Response(
    [
      created,
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "answer",
          content: [{ type: "output_text", text: "AUTH_OK" }],
        },
      },
      completed,
    ]
      .map((v) => new TextDecoder().decode(encode(v)))
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
});
let activeSettled = false;
const port = (server.addr as Deno.NetAddr).port;
const wrapper = join(f.root, "codex-refresh");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
await Deno.writeTextFile(
  wrapper,
  `#!/bin/sh\nexport CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://127.0.0.1:${port}/oauth/token\nexec ${quote(nativeCli)} "$@"\n`,
  { mode: 0o700 },
);
await Deno.writeTextFile(
  join(sessionDirectory, "profile/config.toml"),
  `chatgpt_base_url = "http://127.0.0.1:3130/backend-api"\nmodel_provider = "fixture"\n[model_providers.fixture]\nbase_url = "http://127.0.0.1:3130/backend-api/codex"\nname = "OpenAI"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n`,
);
const owner = new CodexAuthOwner({ profile, cli: wrapper, pollMs: 100, refreshAheadMs: 1000 });
let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
let session: RemoteWorkerSession | undefined;
const timeout = Promise.withResolvers<never>();
const timer = setTimeout(() => {
  worker?.terminate();
  timeout.reject(new Error("Codex auth VM deadline"));
}, 90000);
try {
  await Promise.race([
    (async () => {
      worker = await launchSessionVm({
        artifact,
        smolvm,
        workspace: f.workspace,
        sessionDirectory,
        authOwner: owner,
        providerHosts: [],
        mcpRelays: [{ port, guestPort: 3130 }],
      });
      const connected = await RemoteWorkerSession.connect(
        "auth-fixture",
        "chatgpt",
        mockLaunchSpec(f.workspace),
        () => worker!,
        120000,
        {
          connector: "@loom/connector-chatgpt",
          config: {
            sdk: "chatgpt",
            codexCliPath: "codex",
            configDir: "/tmp/loom-home/.codex",
            model: "",
            models: [],
            codexBuiltinWebSearch: false,
          },
        },
      );
      session = connected.session;
      const paths = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
      const denoPath = paths.find((p) => /-deno-[0-9]/.test(p));
      assert(denoPath, "Artifact does not contain Deno");
      const deno = join(denoPath, "bin/deno");
      const guest = async (code: string) => {
        const result = await new Deno.Command(smolvm, {
          args: ["machine", "exec", "--name", sessionVmName, "--", deno, "eval", code],
          clearEnv: true,
          env: vmEnvironment(worker!.binding.state),
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
        return new TextDecoder().decode(result.stdout).trim();
      };
      const pids = () =>
        guest(
          `const a=[];for await(const e of Deno.readDir("/proc")){try{if((await Deno.readLink("/proc/"+e.name+"/exe")).includes("-codex-"))a.push(e.name);}catch{}}console.log(JSON.stringify(a.sort()));`,
        );
      await session.start({
        method: "create",
        args: [
          {
            sessionId: session.id,
            cwd: f.workspace,
            prompt: "Run the requested tool, then reply AUTH_OK.",
            mode: "auto",
            mcpServers: [],
            model: "gpt-5.4",
          },
        ],
      });
      const answer = (async () => {
        for await (const e of session!.events()) {
          if (e.type === "error") throw new Error(e.message);
          if (e.type === "result") {
            assert.equal(e.kind, "ok");
            return;
          }
        }
        throw new Error("missing result");
      })();
      void answer.catch(() => {});
      await active.promise;
      const before = await pids();
      assert.notEqual(before, "[]");
      await owner.current(true);
      assert.equal(refreshes, 1);
      assert.equal((await readCodexAccess(profile)).accessToken, replacement);
      const deadline = Date.now() + 10000;
      for (;;) {
        const ready = await guest(
          `try { const a=JSON.parse(await Deno.readTextFile("/tmp/loom-home/.codex/auth.json"));console.log(a.tokens.access_token===${JSON.stringify(replacement)} && a.tokens.refresh_token===""); } catch(e) { if (!(e instanceof Deno.errors.NotFound)) throw e; console.log(false); }`,
        );
        if (ready === "true") break;
        assert(Date.now() < deadline, "guest credential propagation timed out");
        await new Promise((r) => setTimeout(r, 100));
      }
      release.resolve();
      await answer;
      assert(sawReplacement, "replacement was not used");
      assert.equal(rejectedOld, 1, "expected one stale-token 401 before recovery");
      assert.equal(await pids(), before, "native Codex restarted");
      console.log(
        JSON.stringify({
          rotationDuringStream: true,
          refreshes,
          rejectedOld,
          sameProcess: true,
          refreshTokenExcluded: true,
        }),
      );
      phase = "expire";
      await session.send("Keep streaming while the host auth fixture expires.");
      await expiring.promise;
      rejectRefresh = true;
      const expiry = Date.now() + 2500;
      await writeProfile(jwt("expires", expiry));
      await owner.current();
      await worker.exited;
      assert(Date.now() >= Math.floor(expiry / 1000) * 1000, "VM stopped before credential expiry");
      assert(Date.now() < expiry + 10_000, "VM did not stop promptly at expiry");
      assert(failures > 0, "renewal failure was not exercised");
      console.log(
        JSON.stringify({ expiryDuringStreamStopsVm: true, renewalFailureObserved: true }),
      );
    })(),
    timeout.promise,
  ]);
} finally {
  clearTimeout(timer);
  release.resolve();
  releaseExpiry.resolve();
  await session?.close();
  worker?.terminate();
  await worker?.cleanup?.();
  await owner.close();
  await server.shutdown();
  await f.close();
}
