import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { SearchConfig } from "@loom/core/connector";
import { BuiltinTools } from "@loom/aisdk/tools/builtins";
import { isReadonly } from "@loom/aisdk/gate";
import { kagiExtract } from "@loom/aisdk/tools/kagi";
import { runSearch, searchTool } from "@loom/aisdk/tools/search";

const kagiCfg = (apiBase: string): SearchConfig => ({
  backend: "kagi",
  apiKey: "kg-key",
  apiBase,
  maxResults: 5,
});

/**
 * A minimal MCP streamable-HTTP stub: JSON-RPC over POST, JSON replies (no
 * SSE). Serves `initialize`, `tools/list` and `tools/call` with `callResult`.
 * Returns the origin as `base` (the kagi client appends `/mcp`) plus every
 * request's method / auth header / body.
 */
const mcpStub = (
  callResult: unknown,
  opts: { tools?: unknown[] } = {},
): Promise<{
  base: string;
  close: () => void;
  reqs: Array<{ method: string; auth: string | undefined; body: string }>;
}> => {
  const reqs: Array<{ method: string; auth: string | undefined; body: string }> = [];
  const tool = (name: string) => ({
    name,
    description: name,
    inputSchema: {
      type: "object",
      properties:
        name === "kagi_search_fetch" ? { query: { type: "string" } } : { url: { type: "string" } },
      required: name === "kagi_search_fetch" ? ["query"] : ["url"],
    },
  });
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method !== "POST") {
        // The transport also opens a GET (standalone SSE) stream and DELETEs
        // the session on close — neither carries a body we can dispatch on.
        res.writeHead(405);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string; name?: string; arguments?: unknown };
        };
        reqs.push({ method: msg.method, auth: req.headers.authorization, body });
        // A notification (no id) gets 202 and no reply — the client ignores it.
        if (msg.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const reply = (result: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        };
        if (msg.method === "initialize") {
          reply({
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "kagimcp-stub", version: "0.0.0" },
          });
        } else if (msg.method === "tools/list") {
          reply({ tools: opts.tools ?? [tool("kagi_search_fetch"), tool("kagi_extract")] });
        } else if (msg.method === "tools/call") {
          reply(callResult);
        } else {
          res.writeHead(400);
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close(), reqs });
    });
  });
};

test("runSearch (kagi): one MCP session, bearer auth, query passed through", async () => {
  const s = await mcpStub({
    content: [
      { type: "text", text: "1. Loom\n   https://loom.example\n   a fleet of agents" },
      { type: "text", text: "(second text block)" },
    ],
    isError: false,
  });
  try {
    const r = await runSearch(kagiCfg(s.base), "git worktree prune");
    assert.equal(r.ok, true);
    assert.match(r.output, /1\. Loom\n {3}https:\/\/loom\.example\n {3}a fleet of agents/);
    assert.match(r.output, /second text block/);

    // initialize → notification (202) → tools/list → tools/call, all bearer-authed.
    assert.deepEqual(
      s.reqs.map((q) => q.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    for (const q of s.reqs) assert.equal(q.auth, "Bearer kg-key");
    const call = JSON.parse(s.reqs[3]?.body ?? "{}") as {
      params: { name: string; arguments: unknown };
    };
    assert.equal(call.params.name, "kagi_search_fetch");
    // kagi's own schema owns the rest — only the query is sent.
    assert.deepEqual(call.params.arguments, { query: "git worktree prune" });
  } finally {
    s.close();
  }
});

test("runSearch (kagi): a tool error comes back as a clean failure", async () => {
  const s = await mcpStub({
    content: [{ type: "text", text: "invalid api key" }],
    isError: true,
  });
  try {
    const r = await runSearch(kagiCfg(s.base), "x");
    assert.equal(r.ok, false);
    assert.match(r.output, /invalid api key/);
  } finally {
    s.close();
  }
});

test("runSearch (kagi): a server without the tool, and an empty result, degrade cleanly", async () => {
  const gone = await mcpStub({ content: [{ type: "text", text: "unused" }] }, { tools: [] });
  try {
    const r = await runSearch(kagiCfg(gone.base), "x");
    assert.equal(r.ok, false);
    assert.match(r.output, /offers no kagi_search_fetch tool/);
  } finally {
    gone.close();
  }

  const empty = await mcpStub({ content: [], isError: false });
  try {
    const r = await runSearch(kagiCfg(empty.base), "x");
    assert.equal(r.ok, true);
    assert.equal(r.output, "(no results)");
  } finally {
    empty.close();
  }
});

test("kagiExtract: one MCP session, url passed through, markdown out", async () => {
  const s = await mcpStub({
    content: [{ type: "text", text: "# A page\n\nSome markdown body." }],
    isError: false,
  });
  try {
    const out = await kagiExtract(kagiCfg(s.base), "https://example.com/page");
    assert.equal(out, "# A page\n\nSome markdown body.");
    assert.deepEqual(
      s.reqs.map((q) => q.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    for (const q of s.reqs) assert.equal(q.auth, "Bearer kg-key");
    const call = JSON.parse(s.reqs[3]?.body ?? "{}") as {
      params: { name: string; arguments: unknown };
    };
    assert.equal(call.params.name, "kagi_extract");
    assert.deepEqual(call.params.arguments, { url: "https://example.com/page" });
  } finally {
    s.close();
  }
});

test("kagiExtract: a tool error rejects with the server's message; a long page is capped", async () => {
  const s = await mcpStub({
    content: [{ type: "text", text: "no such page" }],
    isError: true,
  });
  try {
    await assert.rejects(kagiExtract(kagiCfg(s.base), "https://example.com/404"), /no such page/);
  } finally {
    s.close();
  }

  const long = await mcpStub({
    content: [{ type: "text", text: "x".repeat(61_000) }],
    isError: false,
  });
  try {
    const out = await kagiExtract(kagiCfg(long.base), "https://example.com/big");
    assert.match(out, /… \[truncated — 1000 more characters\]$/);
    assert.ok(out.length < 61_000 + 100);
  } finally {
    long.close();
  }
});

test("kagi sessions get web_fetch alongside web_search (brave does not); both readonly", () => {
  const kagi = new BuiltinTools("/tmp", {
    backend: "kagi",
    apiKey: "k",
    apiBase: "",
    maxResults: 5,
  });
  assert.deepEqual(
    Object.keys(kagi.tools).filter((t) => t.startsWith("web")),
    ["web_search", "web_fetch"],
  );
  assert.equal(isReadonly("web_fetch"), true); // never prompts in default mode
  assert.match(searchTool(kagiCfg("")).description ?? "", /web_fetch/);

  const brave = new BuiltinTools("/tmp", {
    backend: "brave",
    apiKey: "k",
    apiBase: "",
    maxResults: 5,
  });
  assert.deepEqual(
    Object.keys(brave.tools).filter((t) => t.startsWith("web")),
    ["web_search"],
  );
});
