import assert from "node:assert/strict";
import { test } from "node:test";
import * as oauth from "oauth4webapi";
import { fileURLToPath } from "node:url";
import { createOAuthFetch } from "../backend/daemon/src/daemon/mcp-oauth-transport.ts";
import {
  prepareOAuthEndpoint,
  OAuthTransportError,
  type OAuthTransportCode,
} from "../backend/daemon/src/daemon/mcp-oauth-endpoint.ts";

const code = (expected: OAuthTransportCode) => (error: unknown) =>
  error instanceof OAuthTransportError && error.code === expected;

test("OAuth plans reject private/special-use, mixed and disguised addresses", () => {
  const denied = [
    "0.1.2.3",
    "10.0.0.1",
    "100.64.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.1.2.3",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002:808:808::",
    "3fff::1",
    "fe80::1%lo",
    "127.1",
    "2130706433",
    "0x7f000001",
    "localhost",
  ];
  for (const address of denied)
    assert.throws(
      () =>
        prepareOAuthEndpoint({
          url: "https://issuer.test/token",
          addresses: ["8.8.8.8", address],
        }),
      code("address_denied"),
      address,
    );
  const plan = prepareOAuthEndpoint({
    url: "https://issuer.test:8443/token",
    addresses: ["8.8.8.8", "2606:4700:4700::1111"],
  });
  assert.deepEqual(plan.net, ["8.8.8.8:8443", "[2606:4700:4700::1111]:8443"]);
  assert(Object.isFrozen(plan.addresses));
  assert.throws(
    () => prepareOAuthEndpoint({ url: "https://8.8.8.8/token", addresses: ["1.1.1.1"] }),
    code("address_denied"),
  );
});

test("OAuth loopback exceptions require explicit policy and do not permit private networks", () => {
  for (const url of [
    "http://issuer.test/token",
    "file:///secret",
    "https://user:secret@issuer.test/",
    "https://issuer.test/token#fragment",
  ]) {
    assert.throws(
      () => prepareOAuthEndpoint({ url, addresses: ["127.0.0.1"] }, true),
      code("endpoint_denied"),
    );
  }
  assert.throws(
    () =>
      prepareOAuthEndpoint({
        url: "http://127.0.0.1/token",
        addresses: ["127.0.0.1"],
      }),
    code("endpoint_denied"),
  );
  assert.deepEqual(
    prepareOAuthEndpoint(
      {
        url: "http://[::1]:8990/token",
        addresses: ["0:0:0:0:0:0:0:1"],
      },
      true,
    ).net,
    ["[::1]:8990"],
  );
  for (const address of ["10.0.0.1", "::ffff:127.0.0.1"])
    assert.throws(
      () =>
        prepareOAuthEndpoint(
          {
            url: "https://issuer.test/token",
            addresses: [address],
          },
          true,
        ),
      code("address_denied"),
    );
});

const fixture = () => {
  const requests: Array<{ path: string; body: string; host: string | null; auth: string | null }> =
    [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req): Promise<Response> => {
      const path = new URL(req.url).pathname;
      requests.push({
        path,
        body: await req.text(),
        host: req.headers.get("host"),
        auth: req.headers.get("authorization"),
      });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({ issuer: origin, token_endpoint: origin + "/token" });
      if (path === "/redirect")
        return new Response(null, { status: 307, headers: { location: "/target" } });
      if (path === "/large") return new Response("x".repeat(5000));
      if (path === "/chunked")
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(3000));
              c.enqueue(new Uint8Array(3000));
              c.close();
            },
          }),
        );
      if (path === "/compressed")
        return new Response("compressed", { headers: { "content-encoding": "gzip" } });
      if (path === "/slow-body") {
        let timer: ReturnType<typeof setTimeout>;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("{"));
              timer = setTimeout(() => {
                c.enqueue(new TextEncoder().encode("}"));
                c.close();
              }, 150);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
        );
      }
      if (path === "/slow") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return new Response("{}");
      }
      if (path === "/error")
        return Response.json(
          { error: "invalid_grant" },
          { status: 400, headers: { "retry-after": "10" } },
        );
      if (path === "/empty") return new Response(null, { status: 204 });
      return Response.json({
        access_token: "fixture-access",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  );
  const origin = "http://127.0.0.1:" + server.addr.port;
  const paths = [
    "/token",
    "/redirect",
    "/large",
    "/chunked",
    "/compressed",
    "/slow",
    "/slow-body",
    "/error",
    "/empty",
    "/.well-known/oauth-authorization-server",
  ];
  const inputs = paths.map((path) => ({ url: origin + path, addresses: ["127.0.0.1"] }));
  return { origin, inputs, requests, close: () => server.shutdown() };
};

test("oauth4webapi discovery uses the adapter's GET fetch hook", async () => {
  const s = fixture();
  try {
    const fetch = createOAuthFetch(s.inputs, { allowLoopback: true });
    const as = await oauth.processDiscoveryResponse(
      new URL(s.origin),
      await oauth.discoveryRequest(new URL(s.origin), {
        algorithm: "oauth2",
        [oauth.customFetch]: fetch,
        [oauth.allowInsecureRequests]: true,
      }),
    );
    assert.equal(as.issuer, s.origin);
    assert.deepEqual(
      s.requests.map((r) => r.path),
      ["/.well-known/oauth-authorization-server"],
    );
  } finally {
    await s.close();
  }
});

test("oauth4webapi exchanges through pinned transport, preserving form/auth and error responses", async () => {
  const s = fixture();
  try {
    const fetch = createOAuthFetch(s.inputs, { allowLoopback: true });
    const as = { issuer: s.origin, token_endpoint: s.origin + "/token" };
    const client = { client_id: "fixture-client" };
    const response = await oauth.refreshTokenGrantRequest(
      as,
      client,
      oauth.ClientSecretBasic("fixture-secret"),
      "fixture-refresh",
      {
        [oauth.customFetch]: fetch,
        [oauth.allowInsecureRequests]: true,
        additionalParameters: { resource: s.origin + "/mcp" },
      },
    );
    assert.equal(
      (await oauth.processRefreshTokenResponse(as, client, response)).access_token,
      "fixture-access",
    );
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0]!.host, new URL(s.origin).host);
    const form = new URLSearchParams(s.requests[0]!.body);
    assert.equal(form.get("refresh_token"), "fixture-refresh");
    assert.equal(form.get("resource"), s.origin + "/mcp");
    assert(s.requests[0]!.auth?.startsWith("Basic "));
    const error = await fetch(s.origin + "/error");
    assert.equal(error.status, 400);
    assert.equal(error.headers.get("retry-after"), "10");
    assert.deepEqual(await error.json(), { error: "invalid_grant" });
    assert.equal((await fetch(s.origin + "/empty")).body, null);
  } finally {
    await s.close();
  }
});

test("OAuth fetch rejects redirects, encodings and both declared/chunked oversized bodies", async () => {
  const s = fixture();
  try {
    const fetch = createOAuthFetch(s.inputs, { allowLoopback: true, maxResponseBytes: 4096 });
    for (const [path, expected] of [
      ["/redirect", "redirect_denied"],
      ["/large", "response_too_large"],
      ["/chunked", "response_too_large"],
      ["/compressed", "encoding_denied"],
    ] as const) {
      const count = s.requests.length;
      await assert.rejects(
        fetch(s.origin + path, { method: "POST", body: "secret" }),
        code(expected),
      );
      assert.equal(s.requests.length, count + 1);
    }
    assert(!s.requests.some((r) => r.path === "/target"));
  } finally {
    await s.close();
  }
});

test("OAuth fetch validates URL, method, headers and body before opening a socket", async () => {
  const s = fixture();
  try {
    const fetch = createOAuthFetch(s.inputs, { allowLoopback: true, maxRequestBytes: 4 });
    for (const url of [
      s.origin + "/unlisted",
      s.origin + "/token?leak=secret",
      s.origin + "/token#fragment",
    ])
      await assert.rejects(fetch(url), code("endpoint_denied"));
    for (const header of [
      "Host",
      "Cookie",
      "Content-Length",
      "Transfer-Encoding",
      "Proxy-Authorization",
    ])
      await assert.rejects(
        fetch(s.origin + "/token", { headers: { [header]: "secret" } }),
        code("invalid_request"),
      );
    await assert.rejects(
      fetch(s.origin + "/token", { headers: { Authorization: "x".repeat(17000) } }),
      code("request_too_large"),
    );
    await assert.rejects(fetch(s.origin + "/token", { method: "DELETE" }), code("invalid_request"));
    await assert.rejects(
      fetch(s.origin + "/token", { method: "POST", body: "ééé" }),
      code("request_too_large"),
    );
    await assert.rejects(
      fetch(s.origin + "/token", { method: "POST", body: new Uint8Array(5) }),
      code("request_too_large"),
    );
    await assert.rejects(
      fetch(s.origin + "/token", { signal: AbortSignal.abort("secret") }),
      code("aborted"),
    );
    assert.equal(s.requests.length, 0);
    // Creation copied plans; subsequent mutation cannot retarget a request.
    s.inputs[0]!.addresses[0] = "127.0.0.2";
    s.inputs[0]!.url = s.origin + "/target";
    assert.equal((await fetch(s.origin + "/token")).status, 200);
  } finally {
    await s.close();
  }
});

test("OAuth timeout/cancellation stop the request and sanitize failure details", async () => {
  const s = fixture();
  try {
    const fetch = createOAuthFetch(s.inputs, { allowLoopback: true, timeoutMs: 40 });
    await assert.rejects(fetch(s.origin + "/slow"), code("timeout"));
    await assert.rejects(fetch(s.origin + "/slow-body"), code("timeout"));
    const abort = new AbortController();
    const pending = fetch(s.origin + "/slow", { signal: abort.signal });
    abort.abort(new Error("fixture-secret"));
    await assert.rejects(
      pending,
      (e: unknown) => code("aborted")(e) && !JSON.stringify(e).includes("fixture-secret"),
    );
  } finally {
    await s.close();
  }
});

test("OAuth TLS pins DNS and verifies certificates with exact child IP permissions", async () => {
  const certPath = fileURLToPath(new URL("fixtures/mcp-oauth-cert.pem", import.meta.url));
  const keyPath = fileURLToPath(new URL("fixtures/mcp-oauth-key.pem", import.meta.url));
  const requests: string[] = [];
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      cert: await Deno.readTextFile(certPath),
      key: await Deno.readTextFile(keyPath),
      onListen() {},
    },
    async (req) => {
      requests.push(req.headers.get("host")!);
      assert.equal(await req.text(), "fixture-secret");
      return new Response("ok");
    },
  );
  const port = server.addr.port;
  const run = async (hostname: string, trusted: boolean) => {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--cached-only",
        "--no-prompt",
        ...(trusted ? ["--cert=" + certPath] : []),
        "--allow-net=127.0.0.1:" + port,
        fileURLToPath(new URL("fixtures/mcp-oauth-transport-child.ts", import.meta.url)),
      ],
      clearEnv: true,
      env: { DENO_NO_UPDATE_CHECK: "1" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          url: "https://" + hostname + ":" + port + "/token",
          addresses: ["127.0.0.1"],
          forbidden: "http://127.0.0.1:" + (port === 65535 ? port - 1 : port + 1),
        }),
      ),
    );
    await writer.close();
    const result = await child.output();
    return { ...result, reply: JSON.parse(new TextDecoder().decode(result.stdout)) };
  };
  try {
    const good = await run("issuer.test", true);
    assert.equal(good.code, 0, new TextDecoder().decode(good.stderr));
    assert.deepEqual(good.reply, {
      ok: true,
      status: 200,
      text: "ok",
      denied: true,
      net: ["127.0.0.1:" + port],
    });
    assert.equal((await run("wrong.test", true)).reply.ok, false);
    assert.equal((await run("issuer.test", false)).reply.ok, false);
    assert.deepEqual(requests, ["issuer.test:" + port]);
  } finally {
    await server.shutdown();
  }
});
