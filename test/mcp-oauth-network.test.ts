import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOAuthDiscoveryNetwork } from "../backend/daemon/src/daemon/mcp-oauth-network.ts";
import { OAuthTransportError } from "../backend/daemon/src/daemon/mcp-oauth-endpoint.ts";
import { readOAuthJson } from "../backend/daemon/src/daemon/mcp-oauth-helper-io.ts";
import type {
  WorkerLauncher,
  WorkerLaunchSpec,
} from "../backend/daemon/src/daemon/worker-launch.ts";

const code = (value: string) => (e: unknown) =>
  e instanceof OAuthTransportError && e.code === value;
const mock = (reply: unknown) => {
  const launches: WorkerLaunchSpec[] = [];
  const inputs: unknown[] = [];
  const launch: WorkerLauncher = (spec) => {
    launches.push(spec);
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    const consumed = readOAuthJson(pipe.readable, 16384).then((input) => {
      inputs.push(input);
    });
    return {
      pid: 0,
      input: pipe.writable,
      output: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify(reply)));
          c.close();
        },
      }),
      exited: consumed,
      terminate() {},
    };
  };
  return { launch, launches, inputs };
};

test("OAuth resolver sends only a hostname and rejects unsafe or incomplete DNS answers", async () => {
  for (const addresses of [
    ["8.8.8.8", "127.0.0.1"],
    [],
    Array(17).fill("8.8.8.8"),
    ["not-an-ip"],
  ]) {
    const m = mock({ addresses });
    await assert.rejects(
      createOAuthDiscoveryNetwork({ launch: m.launch }).resolve(
        "https://issuer.test/token?private=omitted",
      ),
      code("address_denied"),
    );
    assert.deepEqual(m.inputs, [{ hostname: "issuer.test" }]);
    assert.deepEqual(m.launches[0]!.permissions, {
      read: [],
      write: [],
      net: ["issuer.test"],
      env: [],
      run: [],
    });
    assert(!JSON.stringify(m.launches).includes("private=omitted"));
  }
  const m = mock({ addresses: ["8.8.8.8"] });
  const network = createOAuthDiscoveryNetwork({ launch: m.launch });
  await assert.rejects(network.resolve("file:///secret"), code("endpoint_denied"));
  await assert.rejects(network.resolve("https://127.0.0.1/token"), code("address_denied"));
  await network.resolve("https://8.8.8.8/token");
  assert.equal(m.launches.length, 0);
});

test("OAuth HTTP worker gets only validated IP grants, and malformed child output is sanitized", async () => {
  const dns = mock({ addresses: ["8.8.8.8"] });
  const plan = await createOAuthDiscoveryNetwork({ launch: dns.launch }).resolve(
    "https://issuer.test:8443/meta",
  );
  const http = mock({ status: 401, headers: [["www-authenticate", "Bearer"]], body: "{}" });
  const response = await createOAuthDiscoveryNetwork({ launch: http.launch }).get({
    ...plan,
    net: ["evil.test"],
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(http.launches[0]!.permissions.net, ["8.8.8.8:8443"]);
  for (const reply of [
    { addresses: "fixture-secret" },
    { error: "fixture-secret" },
    { status: 99 },
    "fixture-secret",
  ]) {
    const m = mock(reply);
    await assert.rejects(
      createOAuthDiscoveryNetwork({ launch: m.launch }).get(plan),
      code("network_error"),
    );
  }
  const large = mock({ addresses: ["x".repeat(4096)] });
  await assert.rejects(
    createOAuthDiscoveryNetwork({ launch: large.launch }).resolve("https://issuer.test"),
    code("response_too_large"),
  );
});

test("OAuth helper deadlines and cancellation kill stalled children and drain pipes", async () => {
  for (const cancel of [false, true]) {
    let killed = 0;
    let finish: () => void = () => {};
    let output: ReadableStreamDefaultController<Uint8Array>;
    const launch: WorkerLauncher = () => ({
      pid: 0,
      input: new WritableStream(),
      output: new ReadableStream({
        start(c) {
          output = c;
        },
      }),
      exited: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      terminate() {
        killed++;
        output.close();
        finish();
      },
    });
    const abort = new AbortController();
    const network = createOAuthDiscoveryNetwork({ launch, timeoutMs: 20 });
    const pending = network.resolve("https://issuer.test", abort.signal);
    if (cancel) abort.abort("fixture-secret");
    await assert.rejects(pending, code(cancel ? "aborted" : "timeout"));
    assert.equal(killed, 1);
  }
});

test("MCP discovery works from a deny-net parent through real restricted DNS/GET helpers", async () => {
  const requests: { path: string; method: string; auth: string | null; cookie: string | null }[] =
    [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req): Response => {
    const path = new URL(req.url).pathname;
    requests.push({
      path,
      method: req.method,
      auth: req.headers.get("authorization"),
      cookie: req.headers.get("cookie"),
    });
    if (path === "/mcp")
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="' + origin + '/meta", scope="read"',
          "set-cookie": "must-not-follow=secret",
        },
      });
    if (path === "/meta")
      return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
    return Response.json({
      issuer: origin,
      authorization_endpoint: origin + "/authorize",
      token_endpoint: origin + "/token",
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
  });
  const origin = "http://127.0.0.1:" + server.addr.port;
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--deny-net",
        "--no-prompt",
        "--cached-only",
        fileURLToPath(new URL("fixtures/mcp-oauth-discovery-child.ts", import.meta.url)),
        origin + "/mcp",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    const reply = JSON.parse(new TextDecoder().decode(result.stdout));
    assert.equal(reply.denied, true);
    assert.equal(reply.resolved, true);
    assert.equal(reply.result.issuer, origin);
    assert.deepEqual(reply.result.scopes, ["read"]);
    assert.deepEqual(
      requests.map((r) => r.path),
      ["/mcp", "/meta", "/.well-known/oauth-authorization-server"],
    );
    assert(requests.every((r) => r.method === "GET" && !r.auth && !r.cookie));
  } finally {
    await server.shutdown();
  }
});

test("OAuth discovery children cannot inherit ambient proxy or credential environment", async () => {
  const m = mock({ addresses: ["8.8.8.8"] });
  await createOAuthDiscoveryNetwork({ launch: m.launch }).resolve("https://issuer.test");
  assert.deepEqual(m.launches[0]!.env, {
    DENO_TLS_CA_STORE: "system,mozilla",
    DENO_NO_UPDATE_CHECK: "1",
  });
});

test("OAuth helper output overflow terminates a child that has not exited", async () => {
  let stopped = false;
  let finish: () => void = () => {};
  const launch: WorkerLauncher = () => ({
    pid: 0,
    input: new WritableStream(),
    output: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(4097));
      },
    }),
    exited: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    terminate() {
      stopped = true;
      finish();
    },
  });
  await assert.rejects(
    createOAuthDiscoveryNetwork({ launch }).resolve("https://issuer.test"),
    code("response_too_large"),
  );
  assert(stopped);
});
