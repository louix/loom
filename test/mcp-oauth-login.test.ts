import assert from "node:assert/strict";
import { test } from "node:test";
import * as oauth from "oauth4webapi";
import { loginMcpOAuth } from "../backend/daemon/src/daemon/mcp-oauth-login.ts";
import { createMcpOAuthStore } from "../backend/daemon/src/daemon/mcp-oauth-store.ts";
import { McpOAuthError } from "../backend/daemon/src/daemon/mcp-oauth-model.ts";
import { resolveOAuthClientSecret } from "../backend/daemon/src/daemon/mcp-oauth-secret.ts";
import { safeOAuthText, showOAuthFailure } from "../backend/daemon/src/daemon/mcp-oauth-failure.ts";
import { OAuthDiscoveryError } from "../backend/daemon/src/daemon/mcp-oauth-challenge.ts";
import { OAuthTransportError } from "../backend/daemon/src/daemon/mcp-oauth-endpoint.ts";
const linux = { skip: Deno.build.os !== "linux" };
const code = (c: string) => (e: unknown) => e instanceof McpOAuthError && e.code === c;
const reason = (c: string, r: string) => (e: unknown) =>
  e instanceof McpOAuthError && e.code === c && e.message === "MCP OAuth: " + c + ": " + r;
const AWS_CLIENT_ID =
  "arn:aws:signin:us-east-1::external-client/dcr/00000000-0000-0000-0000-000000000000";
type RegistrationMode =
  | "echo"
  | "omit-method"
  | "omit-method-with-secret"
  | "aws"
  | "rejected"
  | "unexpected-status"
  | "rewrite-redirect";

const fixture = async (methods = ["none"]) => {
  const root = await Deno.makeTempDir();
  const store = createMcpOAuthStore("work", root);
  const registrations: unknown[] = [];
  const exchanges: { body: URLSearchParams; authorization: string | null }[] = [];
  let tokenMode = "ok";
  let registrationMode: RegistrationMode = "echo";
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
        if (registrationMode === "echo")
          return Response.json({ ...registration, client_id: "fixture-client" }, { status: 201 });
        // Shape of https://us-east-1.oauth.signin.aws/v1/register's reply on 2026-10-12.
        if (registrationMode === "aws")
          return Response.json(
            {
              client_id: AWS_CLIENT_ID,
              client_id_issued_at: 1791839369,
              redirect_uris: registration.redirect_uris,
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        if (registrationMode === "rejected")
          return Response.json(
            { error: "invalid_client_metadata", error_description: "bad\u001b[31m name" },
            { status: 400 },
          );
        if (registrationMode === "unexpected-status")
          return new Response("<html>busy</html>", { status: 503 });
        if (registrationMode === "rewrite-redirect")
          return Response.json(
            {
              ...registration,
              client_id: "fixture-client",
              redirect_uris: ["http://127.0.0.1:1/callback"],
            },
            { status: 201 },
          );
        const { token_endpoint_auth_method: requested, ...accepted } = registration;
        return Response.json(
          {
            ...accepted,
            client_id: "fixture-client",
            ...(requested !== "none" || registrationMode === "omit-method-with-secret"
              ? { client_secret: "fixture-client-secret", client_secret_expires_at: 0 }
              : {}),
          },
          { status: 201 },
        );
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
            { error: "invalid_grant", error_description: "fixture-description" },
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
    registrationMode: (mode: RegistrationMode) => {
      registrationMode = mode;
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
      await assert.rejects(
        loginMcpOAuth(input),
        reason("exchange_failed", "HTTP 400 invalid_grant: fixture-description"),
      );
      assert.deepEqual(await f.store.read(), prior);
      f.mode("zero");
      await assert.rejects(
        loginMcpOAuth(input),
        reason("exchange_failed", "expires_in is not a positive number"),
      );
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

test(
  "OAuth login takes a public registration that omits its auth method as none, and nothing else",
  linux,
  async () => {
    for (const [methods, mode, expected] of [
      [["none"], "echo", "none"],
      [["none"], "omit-method", "none"],
      [["none"], "omit-method-with-secret", "registration_failed"],
      [["client_secret_post"], "omit-method", "registration_failed"],
    ] as const) {
      const f = await fixture([...methods]);
      try {
        f.registrationMode(mode);
        const login = loginMcpOAuth({
          name: "work",
          resource: f.origin + "/mcp",
          config: {},
          store: f.store,
          present: f.present,
        });
        if (expected === "registration_failed") {
          await assert.rejects(login, code(expected));
          assert.equal(f.exchanges.length, 0);
        } else {
          await login;
          const client = (await f.store.read()).credential!.client;
          assert.equal(client.authMethod, expected);
          assert.equal(client.secret, undefined);
          assert.equal(f.exchanges[0]!.authorization, null);
          assert.equal(f.exchanges[0]!.body.get("client_id"), "fixture-client");
        }
        assert.equal(
          (f.registrations[0] as { token_endpoint_auth_method: string }).token_endpoint_auth_method,
          methods[0],
        );
      } finally {
        await f.close();
      }
    }
  },
);

test(
  "OAuth login accepts AWS sign-in's 200 OK registration of a public client",
  linux,
  async () => {
    const f = await fixture();
    try {
      f.registrationMode("aws");
      await loginMcpOAuth({
        name: "work",
        resource: f.origin + "/mcp",
        config: {},
        store: f.store,
        present: f.present,
      });
      const client = (await f.store.read()).credential!.client;
      assert.equal(client.id, AWS_CLIENT_ID);
      assert.equal(client.authMethod, "none");
      assert.equal(client.secret, undefined);
      assert.equal(f.exchanges[0]!.body.get("client_id"), AWS_CLIENT_ID);
      assert.equal(f.exchanges[0]!.authorization, null);
    } finally {
      await f.close();
    }
  },
);

test("OAuth login failures carry the safe cause", linux, async () => {
  for (const [mode, expected] of [
    ["rejected", "HTTP 400 invalid_client_metadata: bad?[31m name"],
    [
      "unexpected-status",
      'HTTP 503: "response" is not a conform Dynamic Client Registration Endpoint response (unexpected HTTP status code)',
    ],
    ["rewrite-redirect", "redirect_uris changed from the requested loopback URI"],
    ["omit-method-with-secret", "token_endpoint_auth_method client_secret_basic, requested none"],
  ] as const) {
    const f = await fixture();
    try {
      f.registrationMode(mode);
      await assert.rejects(
        loginMcpOAuth({
          name: "work",
          resource: f.origin + "/mcp",
          config: {},
          store: f.store,
          present: f.present,
        }),
        reason("registration_failed", expected),
      );
      assert.equal(f.exchanges.length, 0);
    } finally {
      await f.close();
    }
  }
  const f = await fixture();
  try {
    await assert.rejects(
      loginMcpOAuth({
        name: "work",
        resource: f.origin + "/mcp",
        config: { client_id: "client" },
        store: f.store,
        present: async (url) => {
          const authorization = new URL(url);
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({
            state: authorization.searchParams.get("state")!,
            iss: f.origin,
            error: "access_denied",
            error_description: "User declined",
          }).toString();
          await (await fetch(callback)).text();
        },
      }),
      reason("authorization_rejected", "access_denied: User declined"),
    );
    assert.equal(f.exchanges.length, 0);
  } finally {
    await f.close();
  }
});

test("showOAuthFailure", () => {
  assert.equal(
    showOAuthFailure(new OAuthDiscoveryError("issuer_mismatch")),
    "discovery issuer_mismatch",
  );
  assert.equal(showOAuthFailure(new OAuthTransportError("timeout")), "transport timeout");
  assert.equal(showOAuthFailure(new McpOAuthError("cancelled")), "cancelled");
  assert.equal(
    showOAuthFailure(new Error("https://host/?token=fixture-secret")),
    "unexpected Error",
  );
  assert.equal(safeOAuthText("x".repeat(400)), "x".repeat(300) + "...");
});
