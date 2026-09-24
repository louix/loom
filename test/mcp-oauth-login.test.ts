import assert from "node:assert/strict";
import { test } from "node:test";
import * as oauth from "oauth4webapi";
import { loginMcpOAuth } from "../backend/daemon/src/daemon/mcp-oauth-login.ts";
import { createMcpOAuthStore } from "../backend/daemon/src/daemon/mcp-oauth-store.ts";
import { McpOAuthError } from "../backend/daemon/src/daemon/mcp-oauth-model.ts";
import { resolveOAuthClientSecret } from "../backend/daemon/src/daemon/mcp-oauth-secret.ts";
const linux = { skip: Deno.build.os !== "linux" };
const code = (c: string) => (e: unknown) => e instanceof McpOAuthError && e.code === c;

const fixture = async (methods = ["none"]) => {
  const root = await Deno.makeTempDir();
  const store = createMcpOAuthStore("work", root);
  const registrations: unknown[] = [];
  const exchanges: { body: URLSearchParams; authorization: string | null }[] = [];
  let tokenMode = "ok";
  let authorization: URL;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req): Promise<Response> => {
      const path = new URL(req.url).pathname;
      if (path === "/mcp")
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer resource_metadata="' + origin + '/metadata", scope="read"',
          },
        });
      if (path === "/metadata")
        return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          registration_endpoint: origin + "/register",
          revocation_endpoint: origin + "/revoke",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: methods,
          authorization_response_iss_parameter_supported: true,
        });
      if (path === "/register") {
        const registration = await req.json();
        registrations.push(registration);
        assert.equal(registration.application_type, "native");
        return Response.json({ ...registration, client_id: "fixture-client" }, { status: 201 });
      }
      if (path === "/token") {
        const body = new URLSearchParams(await req.text());
        exchanges.push({ body, authorization: req.headers.get("authorization") });
        assert.equal(body.get("resource"), origin + "/mcp");
        assert.equal(body.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
        assert.equal(body.get("code"), "fixture-code");
        assert.equal(
          await oauth.calculatePKCECodeChallenge(body.get("code_verifier")!),
          authorization.searchParams.get("code_challenge"),
        );
        if (tokenMode === "rejected")
          return Response.json(
            { error: "invalid_grant", error_description: "fixture-secret" },
            { status: 400 },
          );
        return Response.json({
          access_token: "fixture-access",
          token_type: "Bearer",
          ...(tokenMode === "no-expiry" ? {} : { expires_in: tokenMode === "zero" ? 0 : 3600 }),
          refresh_token: "fixture-refresh",
          scope: "read",
        });
      }
      return new Response(null, { status: 404 });
    },
  );
  const origin = "http://127.0.0.1:" + server.addr.port;
  const present = async (url: string, scopes: readonly string[] | undefined) => {
    authorization = new URL(url);
    assert.deepEqual(scopes, ["read"]);
    assert.equal(authorization.searchParams.get("resource"), origin + "/mcp");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      iss: origin,
      code: "fixture-code",
    }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await response.text();
  };
  return {
    store,
    registrations,
    exchanges,
    origin,
    present,
    mode: (mode: string) => {
      tokenMode = mode;
    },
    close: async () => {
      await server.shutdown();
      await Deno.remove(root, { recursive: true });
    },
  };
};

test(
  "OAuth login registers, exchanges PKCE code through helpers, and reuses saved registration/port",
  linux,
  async () => {
    const f = await fixture();
    try {
      const input = {
        name: "work",
        resource: f.origin + "/mcp",
        config: {},
        store: f.store,
        present: f.present,
      };
      const first = await loginMcpOAuth(input);
      assert.equal(first.generation, 1);
      assert(first.expiresAt! > Date.now());
      const saved = await f.store.read();
      assert.equal(saved.credential!.accessToken, "fixture-access");
      const second = await loginMcpOAuth(input);
      assert.equal(second.generation, 2);
      assert.equal(f.registrations.length, 1);
      assert.equal(f.exchanges.length, 2);
      assert.equal(
        (await f.store.read()).credential!.client.redirectUri,
        saved.credential!.client.redirectUri,
      );
      assert(!JSON.stringify(second).includes("fixture-access"));
    } finally {
      await f.close();
    }
  },
);
test(
  "OAuth login preserves prior credentials on exchange failure, cancellation and stale publication",
  linux,
  async () => {
    const f = await fixture();
    try {
      const input = {
        name: "work",
        resource: f.origin + "/mcp",
        config: { client_id: "pre-registered" },
        store: f.store,
        present: f.present,
      };
      await loginMcpOAuth(input);
      const prior = await f.store.read();
      f.mode("rejected");
      await assert.rejects(loginMcpOAuth(input), code("exchange_failed"));
      assert.deepEqual(await f.store.read(), prior);
      f.mode("zero");
      await assert.rejects(loginMcpOAuth(input), code("exchange_failed"));
      assert.deepEqual(await f.store.read(), prior);
      const abort = new AbortController();
      await assert.rejects(
        loginMcpOAuth({
          ...input,
          signal: abort.signal,
          present: async () => {
            abort.abort("fixture-secret");
          },
        }),
        code("cancelled"),
      );
      assert.deepEqual(await f.store.read(), prior);
      f.mode("ok");
      await assert.rejects(
        loginMcpOAuth({
          ...input,
          present: async (url, scopes) => {
            await f.store.clear();
            await f.present(url, scopes);
          },
        }),
        code("stale_login"),
      );
      assert.equal((await f.store.read()).credential, undefined);
    } finally {
      await f.close();
    }
  },
);
test(
  "OAuth confidential login persists the explicit secret and supports unknown token expiry",
  linux,
  async () => {
    for (const method of ["client_secret_basic", "client_secret_post"]) {
      const f = await fixture([method]);
      try {
        f.mode("no-expiry");
        const result = await loginMcpOAuth({
          name: "work",
          resource: f.origin + "/mcp",
          store: f.store,
          present: f.present,
          config: {
            client_id: "client",
            client_secret_command: [
              Deno.execPath(),
              "eval",
              "--no-config",
              "--no-lock",
              "--cached-only",
              'console.log("fixture-secret")',
            ],
          },
        });
        assert.equal(result.expiresAt, undefined);
        assert.equal(f.registrations.length, 0);
        const c = (await f.store.read()).credential!;
        assert.equal(c.client.secret, "fixture-secret");
        assert.equal(c.client.authMethod, method);
        if (method === "client_secret_basic")
          assert.deepEqual(
            atob(f.exchanges[0]!.authorization!.slice(6)).split(":").map(decodeURIComponent),
            ["client", "fixture-secret"],
          );
        else assert.equal(f.exchanges[0]!.body.get("client_secret"), "fixture-secret");
      } finally {
        await f.close();
      }
    }
  },
);
test("OAuth secret commands enforce argv, exit status, output limits and newline rules", async () => {
  const command = (script: string) => ({
    client_id: "fixture-client",
    client_secret_command: [
      Deno.execPath(),
      "eval",
      "--no-config",
      "--no-lock",
      "--cached-only",
      script,
    ],
  });
  for (const script of [
    'console.log("");',
    'console.log("secret"); Deno.exit(1);',
    'console.log("x".repeat(65537));',
    'console.log("secret\\n");',
  ])
    await assert.rejects(resolveOAuthClientSecret(command(script)), code("secret_failed"));
  assert.equal(
    await resolveOAuthClientSecret(
      command('Deno.stdout.writeSync(new TextEncoder().encode("secret\\r\\n"))'),
    ),
    "secret",
  );
  const abort = new AbortController();
  const pending = resolveOAuthClientSecret(command("setTimeout(() => {}, 60000)"), abort.signal);
  abort.abort();
  await assert.rejects(pending, code("cancelled"));
});

test(
  "OAuth callback timeout ends login even when the browser presenter stalls",
  linux,
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        loginMcpOAuth({
          name: "work",
          resource: f.origin + "/mcp",
          config: { client_id: "client" },
          store: f.store,
          callbackTimeoutMs: 20,
          present: () => new Promise<void>(() => {}),
        }),
        code("login_timeout"),
      );
      assert.deepEqual(await f.store.read(), { version: 1, generation: 0 });
      assert.equal(f.exchanges.length, 0);
    } finally {
      await f.close();
    }
  },
);
