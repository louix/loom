import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { SearchConfig } from "@loom/core/connector";
import { runSearch } from "@loom/aisdk/tools/search";
import { BuiltinTools } from "@loom/aisdk/tools/builtins";
import { isReadonly } from "@loom/aisdk/gate";

/** A one-request stub server; returns the base URL. */
function stub(
  handler: (
    req: import("node:http").IncomingMessage,
    body: string,
  ) => { status?: number; json: unknown },
): Promise<{ base: string; close: () => void; hits: Array<{ url: string; body: string }> }> {
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
}

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
