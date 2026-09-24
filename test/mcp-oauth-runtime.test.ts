import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createMcpOAuthStore } from "../backend/daemon/src/daemon/mcp-oauth-store.ts";
import {
  mcpOAuthIdentity,
  McpOAuthError,
  type McpOAuthCredential,
} from "../backend/daemon/src/daemon/mcp-oauth-model.ts";
import {
  refreshMcpOAuth,
  rejectMcpOAuth,
  acceptMcpOAuth,
  oauthUsable,
} from "../backend/daemon/src/daemon/mcp-oauth-tokens.ts";
import { startMcpWorker } from "../backend/daemon/src/daemon/mcp-worker.ts";
import { startOAuthMcp } from "../backend/daemon/src/daemon/mcp-oauth-owner.ts";
import { logoutMcpOAuth } from "../backend/daemon/src/daemon/mcp-oauth-logout.ts";
import {
  registerOAuthOwner,
  waitOAuthInvalidation,
} from "../backend/daemon/src/daemon/mcp-oauth-lease.ts";
import { mcpOAuthStatus } from "../backend/daemon/src/daemon/mcp-oauth-status.ts";
import { normalizeConfig } from "@loom/daemon/config/config";
import { preflightTools } from "../backend/daemon/src/daemon/tool-preflight.ts";
const linux = { skip: Deno.build.os !== "linux" };
const credential = (url: string): McpOAuthCredential => ({
  identity: mcpOAuthIdentity("work", url + "/mcp", {}),
  issuer: url,
  endpoints: {
    authorization: url + "/authorize",
    token: url + "/token",
    revocation: url + "/revoke",
  },
  client: {
    id: "client",
    authMethod: "none",
    dynamic: true,
    redirectUri: "http://127.0.0.1:8990/callback",
  },
  accessToken: "first",
  refreshToken: "refresh-first",
  issuedAt: Date.now() - 10000,
  expiresAt: Date.now() - 1,
});
const fixture = async () => {
  const root = await Deno.makeTempDir();
  const requests: URLSearchParams[] = [];
  const upstream: string[] = [];
  let mode = "ok";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    if (new URL(req.url).pathname === "/mcp") {
      upstream.push(req.headers.get("authorization") ?? "");
      return new Response("result", { status: mode === "401" ? 401 : 200 });
    }
    const body = new URLSearchParams(await req.text());
    requests.push(body);
    if (new URL(req.url).pathname === "/revoke") return new Response(null, { status: 503 });
    if (mode === "invalid") return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (mode === "offline")
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503, headers: { "retry-after": "60" } },
      );
    return Response.json({
      access_token: "second",
      token_type: "Bearer",
      ...(mode === "unknown" ? {} : { expires_in: 3600, refresh_token: "refresh-second" }),
    });
  });
  const origin = "http://127.0.0.1:" + server.addr.port;
  return {
    root,
    origin,
    requests,
    upstream,
    setMode: (value: string) => {
      mode = value;
    },
    store: createMcpOAuthStore("work", root),
    close: async () => {
      await server.shutdown();
      await Deno.remove(root, { recursive: true });
    },
  };
};
test(
  "refresh rotates once across owners, keeps omitted refresh tokens and unknown expiry",
  linux,
  async () => {
    const f = await fixture();
    try {
      const c = credential(f.origin);
      await f.store.commit(0, c);
      const results = await Promise.all([
        refreshMcpOAuth(f.store, c.identity),
        refreshMcpOAuth(createMcpOAuthStore("work", f.root), c.identity),
      ]);
      assert(results.every((r) => r.generation === 2));
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]!.get("grant_type"), "refresh_token");
      assert.equal(f.requests[0]!.get("resource"), c.identity.resource);
      assert.equal(results[0]!.credential!.refreshToken, "refresh-second");
      f.setMode("unknown");
      await rejectMcpOAuth(f.store, c.identity, 2);
      const forced = await refreshMcpOAuth(f.store, c.identity);
      assert.equal(forced.credential!.refreshToken, "refresh-second");
      assert.equal(forced.credential!.expiresAt, undefined);
      assert.equal(forced.credential!.recoveryPending, true);
      await refreshMcpOAuth(f.store, c.identity);
      assert.equal(f.requests.length, 2);
      await rejectMcpOAuth(f.store, c.identity, 2); // stale response ignored
      assert.equal((await f.store.read()).generation, forced.generation);
      await rejectMcpOAuth(f.store, c.identity, forced.generation); // replacement also rejected
      assert.equal((await f.store.read()).credential, undefined);
    } finally {
      await f.close();
    }
  },
);
test(
  "refresh persists transient backoff, preserves usable tokens and clears terminal rejection",
  linux,
  async () => {
    const f = await fixture();
    try {
      const c = {
        ...credential(f.origin),
        issuedAt: Date.now() - 3590000,
        expiresAt: Date.now() + 10000,
      };
      await f.store.commit(0, c);
      f.setMode("offline");
      const failed = await refreshMcpOAuth(f.store, c.identity);
      assert(oauthUsable(failed.credential));
      assert(failed.credential!.retryAt! > Date.now() + 55000);
      await refreshMcpOAuth(f.store, c.identity);
      assert.equal(f.requests.length, 1);
      assert.equal((await mcpOAuthStatus("work", c.identity.resource, {}, f.store)).state, "ready");
      await f.store.commit(failed.generation, c);
      f.setMode("invalid");
      assert.equal((await refreshMcpOAuth(f.store, c.identity)).credential, undefined);
    } finally {
      await f.close();
    }
  },
);
test(
  "successful recovery resets rejection tracking without permitting a rapid refresh loop",
  linux,
  async () => {
    const f = await fixture();
    try {
      const c = { ...credential(f.origin), rejected: true };
      await f.store.commit(0, c);
      const refreshed = await refreshMcpOAuth(f.store, c.identity);
      await acceptMcpOAuth(f.store, c.identity, refreshed.generation);
      const accepted = await f.store.read();
      assert.equal(accepted.credential!.recoveryPending, false);
      await rejectMcpOAuth(f.store, c.identity, accepted.generation);
      await refreshMcpOAuth(f.store, c.identity);
      assert.equal(f.requests.length, 1);
      assert.equal(oauthUsable((await f.store.read()).credential), false);
    } finally {
      await f.close();
    }
  },
);
test("relay rotates authorization, enforces expiry, blocks rejected tokens and never replays a 401", async () => {
  const f = await fixture();
  const reports: unknown[] = [];
  const worker = await startMcpWorker(
    "work",
    { transport: "http", url: f.origin + "/mcp" },
    undefined,
    {
      initial: { generation: 1, accessToken: "first" },
      report: (kind, generation) => reports.push({ kind, generation }),
    },
  );
  try {
    assert.equal(worker.handle.spec.transport, "http");
    if (worker.handle.spec.transport !== "http") throw new Error();
    const spec = worker.handle.spec;
    const request = async () => {
      const r = await fetch(spec.url, {
        method: "POST",
        headers: spec.headers!,
        body: "side effect",
      });
      await r.text();
      return r.status;
    };
    assert.equal(await request(), 200);
    await worker.updateOAuth!({ generation: 2, accessToken: "second" }, false);
    f.setMode("401");
    assert.equal(await request(), 401);
    assert.equal(await request(), 503);
    assert.deepEqual(f.upstream, ["Bearer first", "Bearer second"]);
    await sleep(10);
    assert(reports.some((r) => JSON.stringify(r) === '{"kind":"unauthorized","generation":2}'));
    await worker.updateOAuth!(
      { generation: 3, accessToken: "expired", expiresAt: Date.now() - 1 },
      false,
    );
    assert.equal(await request(), 503);
    await worker.updateOAuth!({ generation: 4 }, true);
    assert.equal(await request(), 503);
    assert.equal(f.upstream.length, 2);
    assert.doesNotMatch(JSON.stringify(spec), /first|second|expired/);
  } finally {
    await worker.close();
    await f.close();
  }
});
test(
  "status does not create storage; Keychain records never fall back to plaintext",
  linux,
  async () => {
    const root = await Deno.makeTempDir();
    try {
      const namespace = join(root, "absent");
      const store = createMcpOAuthStore("work", namespace);
      assert.deepEqual(await store.peek(), { version: 1, generation: 0 });
      await assert.rejects(Deno.stat(namespace), Deno.errors.NotFound);
      const items = new Map<string, string>();
      const keychain = (service: string, value?: string) => {
        if (value !== undefined) {
          items.set(service, value);
          return;
        }
        return items.get(service);
      };
      const secure = createMcpOAuthStore("work", root, keychain);
      await secure.commit(0, credential("https://example.com"));
      assert.equal((await secure.peek()).credential!.accessToken, "first");
      await assert.rejects(
        Deno.stat(join(secure.directory, "credential.json")),
        Deno.errors.NotFound,
      );
      await secure.clear();
      assert(![...items.values()][0]!.includes("first"));
      const broken = createMcpOAuthStore("work", root, () => {
        throw new McpOAuthError("storage_unavailable");
      });
      await assert.rejects(broken.read(), /storage_unavailable/);
      await assert.rejects(
        Deno.stat(join(secure.directory, "credential.json")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
test(
  "logout waits for live owner acknowledgement and reports an incomplete invalidation",
  linux,
  async () => {
    const root = await Deno.makeTempDir();
    const store = createMcpOAuthStore("work", root);
    let lease: Awaited<ReturnType<typeof registerOAuthOwner>> | undefined;
    try {
      await store.transact(async () => {
        lease = await registerOAuthOwner(store);
        return undefined;
      });
      await lease!.acknowledge(0);
      const cleared = await store.clear();
      await assert.rejects(
        waitOAuthInvalidation(store, cleared.generation, 50),
        /invalidation_incomplete/,
      );
      await lease!.acknowledge(cleared.generation);
      await waitOAuthInvalidation(store, cleared.generation);
      await lease!.close();
      await waitOAuthInvalidation(store, cleared.generation + 1);
    } finally {
      await lease?.close();
      await Deno.remove(root, { recursive: true });
    }
  },
);
test(
  "shared OAuth owner refreshes live relays, then logout clears every relay despite revocation failure",
  linux,
  async () => {
    const f = await fixture();
    const old = Deno.env.get("XDG_STATE_HOME");
    Deno.env.set("XDG_STATE_HOME", f.root);
    const workers: Awaited<ReturnType<typeof startOAuthMcp>>[] = [];
    try {
      const store = createMcpOAuthStore("work");
      const c = credential(f.origin);
      await store.commit(0, c);
      const notices: string[] = [];
      workers.push(
        await startOAuthMcp("work", c.identity.resource, {}, undefined, (m) => notices.push(m)),
      );
      workers.push(await startOAuthMcp("work", c.identity.resource, {}));
      assert.equal(f.requests.length, 1);
      const request = async (w: (typeof workers)[number]) => {
        if (w.handle.spec.transport !== "http") throw new Error();
        const r = await fetch(w.handle.spec.url, { headers: w.handle.spec.headers! });
        await r.text();
        return r.status;
      };
      assert.deepEqual(await Promise.all(workers.map(request)), [200, 200]);
      const result = await logoutMcpOAuth("work", store);
      assert.equal(result.invalidated, true);
      assert.equal(result.revocation, "failed");
      assert.deepEqual(await Promise.all(workers.map(request)), [503, 503]);
      assert(notices.some((m) => m.includes("loom mcp login work")));
      assert.equal((await store.read()).credential, undefined);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
      if (old === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", old);
      await f.close();
    }
  },
);
test(
  "OAuth config is HTTP-only, mutually exclusive with bearer, and preflight requires login",
  linux,
  async () => {
    const definition = {
      source: { kind: "http", url: "https://example.com/mcp" },
      auth: { oauth: {} },
    };
    const config = normalizeConfig({
      mcp_servers: { work: definition },
      session: { mcp_servers: ["work"] },
    });
    assert.deepEqual(config.httpMcp[0]!.oauth, {});
    for (const auth of [
      { oauth: {}, bearer_token: "secret" },
      { oauth: {}, bearer_token_env: "SECRET" },
    ])
      assert.throws(() => normalizeConfig({ mcp_servers: { work: { ...definition, auth } } }));
    assert.throws(() =>
      normalizeConfig({
        mcp_servers: { work: { ...definition, source: { kind: "runtime", ref: "tilth" } } },
      }),
    );
    const root = await Deno.makeTempDir();
    const old = Deno.env.get("XDG_STATE_HOME");
    Deno.env.set("XDG_STATE_HOME", root);
    try {
      await assert.rejects(preflightTools(config, "claude"), /loom mcp login work/);
      const store = createMcpOAuthStore("work");
      const c = credential("https://example.com");
      await store.commit(0, c); // expired but refreshable is allowed into runtime refresh
      await preflightTools(config, "claude");
      assert.equal(
        (await mcpOAuthStatus("work", "https://elsewhere.example/mcp", {}, store)).state,
        "config_changed",
      );
    } finally {
      if (old === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", old);
      await Deno.remove(root, { recursive: true });
    }
  },
);

test(
  "a deny-net owner in another process acknowledges logout before it returns",
  linux,
  async () => {
    const f = await fixture();
    let child: Deno.ChildProcess | undefined;
    try {
      const store = createMcpOAuthStore("work", join(f.root, "loom", "mcp-auth"));
      const c = { ...credential(f.origin), expiresAt: Date.now() + 3600000 };
      await store.commit(0, c);
      child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--deny-net",
          "--cached-only",
          new URL("fixtures/mcp-oauth-owner-child.ts", import.meta.url).pathname,
          c.identity.resource,
        ],
        env: { XDG_STATE_HOME: f.root },
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let line = "";
      while (!line.includes("\n")) {
        const next = await reader.read();
        assert(!next.done);
        line += next.value;
      }
      const spec = JSON.parse(line);
      const result = await logoutMcpOAuth("work", store);
      assert.equal(result.invalidated, true);
      const r = await fetch(spec.url, { headers: spec.headers });
      assert.equal(r.status, 503);
      await r.text();
      const input = child.stdin.getWriter();
      await input.close();
      assert.equal((await child.status).code, 0);
      await reader.cancel();
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      await child?.status;
      await f.close();
    }
  },
);
test("rotation leaves active streams open while logout aborts them", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode("first\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const worker = await startMcpWorker(
    "work",
    { transport: "http", url: "http://127.0.0.1:" + server.addr.port + "/mcp" },
    undefined,
    { initial: { generation: 1, accessToken: "first" }, report() {} },
  );
  try {
    if (worker.handle.spec.transport !== "http") throw new Error();
    const response = await fetch(worker.handle.spec.url, { headers: worker.handle.spec.headers! });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first\n");
    await worker.updateOAuth!({ generation: 2, accessToken: "second" }, false);
    stream!.enqueue(new TextEncoder().encode("still open\n"));
    assert.equal(new TextDecoder().decode((await reader.read()).value), "still open\n");
    await worker.updateOAuth!({ generation: 3 }, true);
    await assert.rejects(reader.read());
  } finally {
    await worker.close();
    try {
      stream?.close();
    } catch {
      /* aborted */
    }
    await server.shutdown();
  }
});
