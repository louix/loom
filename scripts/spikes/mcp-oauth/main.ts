/**
 * Local-only protocol/transport spike; not production authentication code.
 * deno run --no-config --lock=scripts/spikes/mcp-oauth/deno.lock --allow-net=127.0.0.1,issuer.test scripts/spikes/mcp-oauth/main.ts
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import * as oauth from "npm:oauth4webapi@3.8.8";

const hits: string[] = [];
const hooked: string[] = [];
let verifier = "";
let tokenMode = "normal";
let resource = "";
let issuer = "";
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  hits.push(path);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (path === "/.well-known/oauth-protected-resource/mcp")
    return json({ resource, authorization_servers: [issuer], scopes_supported: ["read"] });
  if (path === "/.well-known/oauth-authorization-server/tenant")
    return json({
      issuer,
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      registration_endpoint: issuer + "/register",
      revocation_endpoint: issuer + "/revoke",
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  if (path === "/tenant/register") {
    const body = await req.json();
    assert.equal(body.application_type, "native");
    assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
    return json({ ...body, client_id: "fixture-client" }, 201);
  }
  if (path === "/tenant/token") {
    const body = new URLSearchParams(await req.text());
    assert.equal(body.get("resource"), resource);
    if (body.get("grant_type") === "authorization_code") {
      assert.equal(body.get("code_verifier"), verifier);
      assert.equal(body.get("code"), "fixture-code");
      assert.equal(body.get("redirect_uri"), "http://127.0.0.1:8990/callback");
    } else {
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "fixture-refresh");
    }
    if (tokenMode === "basic") {
      const header = req.headers.get("authorization")!;
      assert(header.startsWith("Basic "));
      assert.deepEqual(atob(header.slice(6)).split(":").map(decodeURIComponent), [
        "fixture-client",
        "fixture-secret",
      ]);
    }
    if (tokenMode === "post") assert.equal(body.get("client_secret"), "fixture-secret");
    if (tokenMode === "invalid") return json({ token_type: "Bearer" });
    if (tokenMode === "rejected") return json({ error: "invalid_grant" }, 400);
    return json({
      access_token: "fixture-access",
      token_type: "Bearer",
      ...(tokenMode === "no-expiry" ? {} : { expires_in: 3600 }),
      ...(body.get("grant_type") === "authorization_code"
        ? { refresh_token: "fixture-refresh" }
        : {}),
    });
  }
  if (path === "/tenant/revoke") {
    assert.equal(new URLSearchParams(await req.text()).get("token"), "fixture-refresh");
    return new Response(null, { status: 200 });
  }
  if (path === "/redirect")
    return new Response(null, { status: 302, headers: { location: "/redirect-target" } });
  if (path === "/large") return new Response("x".repeat(4097));
  if (path === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response("{}");
  }
  return json({ ok: true });
});
const origin = "http://127.0.0.1:" + server.addr.port;
issuer = origin + "/tenant";
resource = origin + "/mcp";
const allowed = new Set(
  [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server/tenant",
    "/tenant/register",
    "/tenant/token",
    "/tenant/revoke",
    "/redirect",
    "/large",
    "/slow",
  ].map((p) => origin + p),
);

// Bounded, buffered OAuth responses. This wrapper intentionally uses loopback;
// the separate lookup experiment below tests connection address selection.
const controlledFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!allowed.has(url)) throw new Error("endpoint denied");
  hooked.push(new URL(url).pathname);
  const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(50)]);
  const response = await fetch(input, { ...init, signal, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("redirect denied");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 4096) throw new Error("response too large");
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Response(bytes, { status: response.status, headers: response.headers });
};
const options = { [oauth.customFetch]: controlledFetch, [oauth.allowInsecureRequests]: true };
const passed: string[] = [];
const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
  await fn();
  passed.push(name);
};

try {
  const rs = await oauth.processResourceDiscoveryResponse(
    new URL(resource),
    await oauth.resourceDiscoveryRequest(new URL(resource), options),
  );
  assert.deepEqual(rs.authorization_servers, [issuer]);
  const as = await oauth.processDiscoveryResponse(
    new URL(issuer),
    await oauth.discoveryRequest(new URL(issuer), { ...options, algorithm: "oauth2" }),
  );
  await check("metadata discovery and issuer/resource rejection", async () => {
    await assert.rejects(
      oauth.processDiscoveryResponse(
        new URL(issuer),
        Response.json({ ...as, issuer: origin + "/attacker" }),
      ),
    );
    await assert.rejects(
      oauth.processResourceDiscoveryResponse(
        new URL(resource),
        Response.json({ ...rs, resource: origin + "/other" }),
      ),
    );
  });
  const registration = await oauth.processDynamicClientRegistrationResponse(
    await oauth.dynamicClientRegistrationRequest(
      as,
      {
        application_type: "native",
        redirect_uris: ["http://127.0.0.1:8990/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      options,
    ),
  );
  const client = { client_id: registration.client_id };
  passed.push("native dynamic registration");
  verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  const state = oauth.generateRandomState();
  const params = () => new URLSearchParams({ code: "fixture-code", state, iss: issuer });
  await check("callback state and RFC 9207 issuer validation", () => {
    assert.throws(() => oauth.validateAuthResponse(as, client, params(), "wrong"));
    for (const value of [undefined, origin + "/attacker", issuer + "/"]) {
      const p = params();
      if (value === undefined) p.delete("iss");
      else p.set("iss", value);
      assert.throws(() => oauth.validateAuthResponse(as, client, p, state));
    }
    const p = params();
    p.set("iss", origin + "/attacker");
    assert.throws(() =>
      oauth.validateAuthResponse(
        { ...as, authorization_response_iss_parameter_supported: false },
        client,
        p,
        state,
      ),
    );
  });
  const callback = oauth.validateAuthResponse(as, client, params(), state);
  const tokenOptions = { ...options, additionalParameters: { resource } };
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.None(),
      callback,
      "http://127.0.0.1:8990/callback",
      verifier,
      tokenOptions,
    ),
  );
  assert.equal(tokens.refresh_token, "fixture-refresh");
  passed.push("PKCE code exchange with resource indicator");
  await check("refresh, unchanged access token, missing refresh token/expiry", async () => {
    tokenMode = "no-expiry";
    const refreshed = await oauth.processRefreshTokenResponse(
      as,
      client,
      await oauth.refreshTokenGrantRequest(
        as,
        client,
        oauth.None(),
        tokens.refresh_token!,
        tokenOptions,
      ),
    );
    assert.equal(refreshed.access_token, tokens.access_token);
    assert.equal(refreshed.refresh_token, undefined);
    assert.equal(refreshed.expires_in, undefined);
  });
  for (const [mode, auth] of [
    ["basic", oauth.ClientSecretBasic("fixture-secret")],
    ["post", oauth.ClientSecretPost("fixture-secret")],
  ] as const)
    await check("client authentication: " + mode, async () => {
      tokenMode = mode;
      await oauth.processRefreshTokenResponse(
        as,
        client,
        await oauth.refreshTokenGrantRequest(as, client, auth, "fixture-refresh", tokenOptions),
      );
    });
  await check("invalid token and invalid_grant rejected without retry", async () => {
    for (const mode of ["invalid", "rejected"]) {
      tokenMode = mode;
      const before = hits.length;
      await assert.rejects(async () =>
        oauth.processRefreshTokenResponse(
          as,
          client,
          await oauth.refreshTokenGrantRequest(
            as,
            client,
            oauth.None(),
            "fixture-refresh",
            tokenOptions,
          ),
        ),
      );
      assert.equal(hits.length, before + 1);
    }
  });
  await check("revocation", async () => {
    await oauth.processRevocationResponse(
      await oauth.revocationRequest(as, client, oauth.None(), "fixture-refresh", options),
    );
  });
  await check("every library request uses controlled fetch", () => assert.deepEqual(hooked, hits));
  await check("endpoint, redirect, size, timeout, cancellation enforcement", async () => {
    await assert.rejects(controlledFetch(origin + "/forbidden"), /endpoint denied/);
    for (const [path, pattern] of [
      ["redirect", /redirect denied/],
      ["large", /response too large/],
    ] as const)
      await assert.rejects(
        oauth.refreshTokenGrantRequest(
          { ...as, token_endpoint: origin + "/" + path },
          client,
          oauth.None(),
          "fixture-refresh",
          options,
        ),
        pattern,
      );
    await assert.rejects(
      oauth.refreshTokenGrantRequest(
        { ...as, token_endpoint: origin + "/slow" },
        client,
        oauth.None(),
        "fixture-refresh",
        options,
      ),
      (e: unknown) => e instanceof DOMException && e.name === "TimeoutError",
    );
    await assert.rejects(
      oauth.refreshTokenGrantRequest(as, client, oauth.None(), "fixture-refresh", {
        ...options,
        signal: AbortSignal.abort(),
      }),
    );
    assert(!hits.includes("/redirect-target"));
    assert(!hits.includes("/forbidden"));
  });

  // A lookup callback selects the actual socket address: no precheck followed by
  // fetch resolving the hostname again. Exact fixture address policy, NOT a
  // production public-IP classifier. agent:false avoids pooled-socket ambiguity.
  let lookups = 0;
  const connect = (candidate: string, permitted: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "issuer.test",
          port: server.addr.port,
          path: "/pinned",
          agent: false,
          family: 4,
          lookup(_hostname, _options, callback) {
            lookups++;
            if (candidate !== permitted) return callback(new Error("address denied"), "", 4);
            callback(null, candidate, 4);
          },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });
  };
  await check("Deno node:http lookup pins connection and rejects changed DNS answer", async () => {
    await connect("127.0.0.1", "127.0.0.1");
    const before = hits.length;
    await assert.rejects(connect("127.0.0.2", "127.0.0.1"), /address denied/);
    assert.equal(hits.length, before);
    assert.equal(lookups, 2);
  });
  console.log(JSON.stringify({ deno: Deno.version.deno, oauth4webapi: "3.8.8", passed }, null, 2));
} finally {
  await server.shutdown();
}
