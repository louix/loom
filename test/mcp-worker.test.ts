import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import {
  startMcpWorker,
  mcpWorkerSpec,
  type ManagedMcp,
} from "../backend/daemon/src/daemon/mcp-worker.ts";
import {
  launchLocalWorker,
  type WorkerProcess,
} from "../backend/daemon/src/daemon/worker-launch.ts";
import { withExternalMcp } from "../backend/daemon/src/daemon/mcp-provider.ts";
import type { ConnectorContext } from "@loom/core/connector";
import { FakeProvider } from "@loom/connector-mock";
import { makeLogger } from "@loom/core/logger";
import { McpHub } from "../aisdk/src/mcp.ts";
import type { CreateSessionOptions, McpServerHandle } from "@loom/core/types";

const fixture = () => {
  const requests: Array<{ auth: string | null; method: string; path: string }> = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    requests.push({
      auth: req.headers.get("authorization"),
      method: req.method,
      path: new URL(req.url).pathname,
    });
    if (new URL(req.url).pathname === "/redirect")
      return Response.redirect("http://127.0.0.1:1/leak", 307);
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const m = await req.json();
    if (m.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    switch (m.method) {
      case "initialize":
        result = {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: "kagi_search_fetch",
              description: "search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        };
        break;
      case "tools/call":
        result = { content: [{ type: "text", text: `found ${m.params.arguments.query}` }] };
        break;
      default:
        return new Response(null, { status: 400 });
    }
    return Response.json({ jsonrpc: "2.0", id: m.id, result });
  });
  return {
    requests,
    url: `http://127.0.0.1:${server.addr.port}/mcp`,
    close: () => server.shutdown(),
  };
};
const http = (w: ManagedMcp) => {
  assert.equal(w.handle.spec.transport, "http");
  return w.handle.spec as Extract<typeof w.handle.spec, { transport: "http" }>;
};

test("AISDK rejects a required tool connection failure and closes prior clients", async () => {
  const s = fixture();
  try {
    await assert.rejects(
      McpHub.connect(
        [
          { name: "connected", required: true, spec: { transport: "http", url: s.url } },
          {
            name: "failed",
            required: true,
            spec: { transport: "http", url: new URL("/redirect", s.url).href },
          },
        ],
        makeLogger("test"),
      ),
      /Required tool failed failed to connect/,
    );
  } finally {
    await s.close();
  }
});

test("external MCP worker supports real client discovery/calls with private upstream auth", async () => {
  const s = fixture();
  const w = await startMcpWorker("kagi", {
    transport: "http",
    url: s.url,
    headers: { Authorization: "Bearer upstream-secret" },
  });
  try {
    const spec = http(w);
    assert.doesNotMatch(JSON.stringify(w.handle), /upstream-secret/);
    const client = await experimental_createMCPClient({
      transport: { type: "http", url: spec.url, headers: spec.headers! },
    });
    try {
      const tools = await client.tools();
      const result = await tools.kagi_search_fetch!.execute(
        { query: "hello" },
        { toolCallId: "1", messages: [], context: undefined },
      );
      assert.match(JSON.stringify(result), /found hello/);
    } finally {
      await client.close();
    }
    assert.ok(s.requests.length >= 4);
    assert.ok(s.requests.every((r) => r.auth === "Bearer upstream-secret" && r.path === "/mcp"));
    assert.equal((await fetch(spec.url)).status, 403);
    assert.equal(
      (await fetch(spec.url, { headers: { ...spec.headers, Origin: "https://evil.example" } }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(spec.url, {
          method: "POST",
          headers: spec.headers!,
          body: "x".repeat(1024 * 1024 + 1),
        })
      ).status,
      413,
    );
  } finally {
    await w.close();
    await s.close();
  }
  await assert.rejects(fetch(http(w).url));
});

test("MCP workers reject sibling tokens and redirects, and parent EOF stops a worker", async () => {
  const s = fixture();
  let child: WorkerProcess | undefined;
  let parentInput: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const a = await startMcpWorker("a", { transport: "http", url: s.url }, (spec) => {
    child = launchLocalWorker(spec);
    parentInput = child.input.getWriter();
    const input = parentInput;
    return {
      ...child,
      input: new WritableStream({
        write: (chunk) => input.write(chunk),
        close: () => input.close(),
      }),
    };
  });
  const b = await startMcpWorker("b", {
    transport: "http",
    url: s.url.replace("/mcp", "/redirect"),
    headers: { Authorization: "secret" },
  });
  try {
    assert.notEqual(a.pid, b.pid);
    assert.equal((await fetch(http(b).url, { headers: http(a).headers! })).status, 403);
    const denied = await fetch(http(b).url, { headers: http(b).headers! });
    assert.equal(denied.status, 502);
    assert.equal(await denied.text(), "External MCP request failed");
    // Model abrupt daemon disappearance without requesting a worker shutdown.
    assert.ok(child);
    await parentInput!.close();
    await Promise.race([
      a.exited,
      delay(3000).then(() => {
        throw new Error("EOF left worker alive");
      }),
    ]);
    await assert.rejects(fetch(http(a).url));
    assert.equal((await fetch(http(b).url, { headers: http(b).headers! })).status, 502);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("launch policy has only the upstream and local listener, no env, filesystem or native grants", () => {
  const spec = mcpWorkerSpec("https://mcp.kagi.com/mcp");
  assert.deepEqual(spec.permissions, {
    read: [],
    write: [],
    env: [],
    run: [],
    net: ["127.0.0.1:0", "mcp.kagi.com:443"],
  });
  assert.deepEqual(spec.env, {});
  assert.throws(() => mcpWorkerSpec("file:///tmp/secret"));
  assert.throws(() => mcpWorkerSpec("https://user:secret@example.com/mcp"));
});

test("generic HTTP mounts preserve advertised tools and preferences without leaking upstream credentials", async () => {
  const s = fixture();
  const options: CreateSessionOptions[] = [];
  const workers: ManagedMcp[] = [];
  const fake = new FakeProvider();
  const provider = await withExternalMcp(
    () =>
      new Proxy(fake, {
        get(target, prop) {
          if (prop === "createSession")
            return (opts: CreateSessionOptions) => {
              options.push(opts);
              return target.createSession(opts);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    { id: "generic", config: {}, logger: makeLogger("test") },
    async (...args) => {
      const w = await startMcpWorker(...args);
      workers.push(w);
      return w;
    },
  );
  const opts: CreateSessionOptions = {
    sessionId: "one",
    cwd: "/tmp",
    prompt: "",
    mode: "default",
    mcpServers: [
      {
        name: "research",
        defaultFor: ["web_search"],
        spec: {
          transport: "http",
          url: s.url,
          headers: { Authorization: "Bearer original-secret" },
        },
      },
    ],
  };
  const a = await provider.createSession(opts);
  const b = await provider.createSession({ ...opts, sessionId: "two" });
  try {
    assert.doesNotMatch(JSON.stringify(options), /original-secret/);
    assert.match(options[0]!.systemPromptAppend!, /web_search.*research/);
    const hub = await McpHub.connect(options[0]!.mcpServers, makeLogger("test"));
    try {
      assert.ok(hub.tools.kagi_search_fetch);
      assert.equal(hub.tools.web_search, undefined);
      const result = await hub.tools.kagi_search_fetch!.execute!(
        { query: "worker boundary" },
        { toolCallId: "1", messages: [], context: undefined },
      );
      assert.match(JSON.stringify(result), /found worker boundary/);
    } finally {
      await hub.close();
    }
    assert.notEqual(
      http(workers[0]!).headers?.Authorization,
      http(workers[1]!).headers?.Authorization,
    );
    await a.close();
    await assert.rejects(fetch(http(workers[0]!).url));
    assert.equal(
      (await fetch(http(workers[1]!).url, { headers: http(workers[1]!).headers! })).status,
      405,
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
    await s.close();
  }
});

test("Deno enforces the MCP worker's denied capabilities", async () => {
  const spec = mcpWorkerSpec("https://mcp.kagi.com/mcp");
  const child = launchLocalWorker({
    ...spec,
    entrypoint: new URL("fixtures/mcp-permissions.ts", import.meta.url).pathname,
  });
  try {
    const text = await new Response(child.output).text();
    await child.exited;
    assert.deepEqual(JSON.parse(text), [true, true, true, true, true]);
  } finally {
    child.terminate();
  }
});

test("session construction failure, native stream end and worker crash release MCP workers", async () => {
  const s = fixture();
  const workers: ManagedMcp[] = [];
  const context: ConnectorContext = {
    id: "claude",
    config: {},
    logger: makeLogger("test"),
  };
  const start = async (...args: Parameters<typeof startMcpWorker>) => {
    const w = await startMcpWorker(...args);
    workers.push(w);
    return w;
  };
  try {
    const fake = new FakeProvider();
    const provider = await withExternalMcp(() => fake, context, start);
    const options = {
      sessionId: "crash",
      cwd: "/tmp",
      prompt: "",
      mode: "default" as const,
      mcpServers: [
        { name: "remote", spec: { transport: "http", url: s.url } },
      ] as McpServerHandle[],
    };
    const crashed = await provider.createSession(options);
    const events = Array.fromAsync(crashed.events());
    Deno.kill(workers[0]!.pid, "SIGKILL");
    assert.ok((await events).some((e) => e.type === "error" && e.fatal));
    await crashed.close();

    const broken = await withExternalMcp(
      () => ({
        ...provider,
        createSession: async () => {
          throw new Error("fixture failure");
        },
      }),
      context,
      start,
    );
    await assert.rejects(broken.createSession(options), /fixture failure/);
    await workers[1]!.exited;
    await assert.rejects(fetch(http(workers[1]!).url));

    const title = await provider.createSession({ ...options, sessionId: "title", oneShot: true });
    assert.equal(workers.length, 2);
    await title.close();

    const resumed = await provider.resumeSession({
      sessionId: "resumed",
      providerRef: "old",
      cwd: "/tmp",
      mcpServers: options.mcpServers,
    });
    assert.equal(workers.length, 3);
    assert.notEqual(
      http(workers[0]!).headers?.Authorization,
      http(workers[2]!).headers?.Authorization,
    );
    const resumedEvents = Array.fromAsync(resumed.events());
    fake.session("resumed")!.endStream();
    await resumedEvents;
    await workers[2]!.exited;
    await assert.rejects(fetch(http(workers[2]!).url));
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await s.close();
  }
});
