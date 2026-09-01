import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { SearchConfig } from "@loom/core/connector";
import { runSearch } from "@loom/aisdk/tools/search";
import { BuiltinTools } from "@loom/aisdk/tools/builtins";
import { isReadonly } from "@loom/aisdk/gate";

/** A one-request stub server; returns the base URL. */
const stub = (
  handler: (
    req: import("node:http").IncomingMessage,
    body: string,
  ) => { status?: number; json: unknown },
): Promise<{ base: string; close: () => void; hits: Array<{ url: string; body: string }> }> => {
  const hits: Array<{ url: string; body: string }> = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ url: req.url ?? "", body });
        const out = handler(req, body);
        res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close(), hits });
    });
  });
};

test("runSearch (brave): sends the query + token header, formats the results", async () => {
  const s = await stub((req) => {
    assert.equal(req.headers["x-subscription-token"], "k-123");
    return {
      json: {
        web: {
          results: [
            { title: "First", url: "https://a.example", description: "the   first  hit" },
            { title: "Second", url: "https://b.example", description: "second" },
          ],
        },
      },
    };
  });
  try {
    const cfg: SearchConfig = { backend: "brave", apiKey: "k-123", apiBase: s.base, maxResults: 5 };
    const r = await runSearch(cfg, "loom fork tree");
    assert.equal(r.ok, true);
    assert.match(r.output, /1\. First\n {3}https:\/\/a\.example\n {3}the first hit/);
    assert.match(r.output, /2\. Second/);
    assert.match(s.hits[0]?.url ?? "", /\/web\/search\?q=loom%20fork%20tree&count=5/);
  } finally {
    s.close();
  }
});

test("runSearch (tavily): posts the key + query, maps results", async () => {
  const s = await stub((_req, body) => {
    const parsed = JSON.parse(body) as { api_key: string; query: string; max_results: number };
    assert.equal(parsed.api_key, "tv-key");
    assert.equal(parsed.max_results, 3);
    return {
      json: { results: [{ title: "Doc", url: "https://d.example", content: "body text" }] },
    };
  });
  try {
    const cfg: SearchConfig = {
      backend: "tavily",
      apiKey: "tv-key",
      apiBase: s.base,
      maxResults: 3,
    };
    const r = await runSearch(cfg, "how to rewind", 3);
    assert.equal(r.ok, true);
    assert.match(r.output, /1\. Doc\n {3}https:\/\/d\.example\n {3}body text/);
  } finally {
    s.close();
  }
});

test("runSearch: an error status is a clean failure, not a throw", async () => {
  const s = await stub(() => ({ status: 429, json: { error: "rate limited" } }));
  try {
    const cfg: SearchConfig = { backend: "brave", apiKey: "k", apiBase: s.base, maxResults: 5 };
    const r = await runSearch(cfg, "x");
    assert.equal(r.ok, false);
    assert.match(r.output, /429/);
  } finally {
    s.close();
  }
});

test("runSearch: no results → '(no results)'", async () => {
  const s = await stub(() => ({ json: { web: { results: [] } } }));
  try {
    const r = await runSearch(
      { backend: "brave", apiKey: "k", apiBase: s.base, maxResults: 5 },
      "nothing",
    );
    assert.equal(r.output, "(no results)");
  } finally {
    s.close();
  }
});

test("BuiltinTools mounts web_search only when a search config is given; it's readonly", () => {
  const bare = new BuiltinTools("/tmp");
  assert.equal("web_search" in bare.tools, false);

  const withSearch = new BuiltinTools("/tmp", {
    backend: "brave",
    apiKey: "k",
    apiBase: "",
    maxResults: 5,
  });
  assert.equal("web_search" in withSearch.tools, true);
  assert.equal(isReadonly("web_search"), true); // never prompts in default mode
});

// --- kagi (hosted MCP server) -------------------------------------------------

/**
 * A minimal MCP streamable-HTTP stub: JSON-RPC over POST, JSON replies (no
 * SSE). Serves `initialize`, `tools/list` (one `kagi_search_fetch`) and
 * `tools/call` with `callResult`. Returns the origin as `base` (`runSearch`
 * appends `/mcp`) plus every request's method / auth header / body.
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
          reply({
            tools: opts.tools ?? [
              {
                name: "kagi_search_fetch",
                description: "web search",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          });
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
    const cfg: SearchConfig = { backend: "kagi", apiKey: "kg-key", apiBase: s.base, maxResults: 5 };
    const r = await runSearch(cfg, "git worktree prune");
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
    const r = await runSearch(
      { backend: "kagi", apiKey: "kg-key", apiBase: s.base, maxResults: 5 },
      "x",
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /invalid api key/);
  } finally {
    s.close();
  }
});

test("runSearch (kagi): a server without the tool, and an empty result, degrade cleanly", async () => {
  const gone = await mcpStub({ content: [{ type: "text", text: "unused" }] }, { tools: [] });
  try {
    const r = await runSearch(
      { backend: "kagi", apiKey: "kg-key", apiBase: gone.base, maxResults: 5 },
      "x",
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /offers no kagi_search_fetch tool/);
  } finally {
    gone.close();
  }

  const empty = await mcpStub({ content: [], isError: false });
  try {
    const r = await runSearch(
      { backend: "kagi", apiKey: "kg-key", apiBase: empty.base, maxResults: 5 },
      "x",
    );
    assert.equal(r.ok, true);
    assert.equal(r.output, "(no results)");
  } finally {
    empty.close();
  }
});
