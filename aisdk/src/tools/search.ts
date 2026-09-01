/**
 * A `web_search` tool for aisdk sessions — Claude has its own built-in, this
 * fills the gap for OpenAI-compatible / Gemini / Anthropic-via-aisdk sessions.
 * Pluggable backend (`[search] backend`): Brave Search API, Tavily, or Kagi —
 * Kagi dials their hosted MCP server (kagimcp), so there's nothing to install.
 * Off unless a backend + key are configured.
 */
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";
import type { SearchConfig } from "@loom/core/connector";

const DEFAULT_BASE = {
  brave: "https://api.search.brave.com/res/v1",
  tavily: "https://api.tavily.com",
  kagi: "https://mcp.kagi.com",
} as const;

const KAGI_SEARCH_TOOL = "kagi_search_fetch";

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

export const runSearch = async (
  cfg: SearchConfig,
  query: string,
  maxResults?: number,
): Promise<{ ok: boolean; output: string }> => {
  const n = Math.min(20, Math.max(1, maxResults ?? cfg.maxResults));
  const base = (cfg.apiBase || DEFAULT_BASE[cfg.backend]).replace(/\/$/, "");
  const signal = AbortSignal.timeout(15_000); // a hung backend must not stall the turn
  try {
    const output =
      cfg.backend === "kagi"
        ? await kagi(base, cfg.apiKey, query, signal)
        : hitsToText(
            cfg.backend === "brave"
              ? await brave(base, cfg.apiKey, query, n, signal)
              : await tavily(base, cfg.apiKey, query, n, signal),
          );
    if (output === "") return { ok: true, output: "(no results)" };
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output: `search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

const hitsToText = (hits: Hit[]): string =>
  hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${oneLine(h.snippet)}`).join("\n");

const brave = async (
  base: string,
  key: string,
  q: string,
  n: number,
  signal: AbortSignal,
): Promise<Hit[]> => {
  const res = await fetch(`${base}/web/search?q=${encodeURIComponent(q)}&count=${n}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal,
  });
  if (!res.ok) throw new Error(`brave search ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
  };
  return (body.web?.results ?? []).slice(0, n).map((r) => ({
    title: str(r.title),
    url: str(r.url),
    snippet: str(r.description),
  }));
};

const tavily = async (
  base: string,
  key: string,
  q: string,
  n: number,
  signal: AbortSignal,
): Promise<Hit[]> => {
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query: q, max_results: n }),
    signal,
  });
  if (!res.ok) throw new Error(`tavily search ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
  };
  return (body.results ?? []).slice(0, n).map((r) => ({
    title: str(r.title),
    url: str(r.url),
    snippet: str(r.content),
  }));
};

/**
 * Kagi runs `kagi_search_fetch` on their hosted MCP server (`<base>/mcp`,
 * bearer auth). One short-lived MCP session per search — connect, discover,
 * call, close — so the tool's own schema owns everything but the query (its
 * server-side default is 10 results, and a hidden param would reject extra
 * arguments). Kagi formats the results itself; we pass the text through.
 */
const kagi = async (base: string, key: string, q: string, signal: AbortSignal): Promise<string> => {
  // `connect` / `tools()` don't take a signal — bound them by the deadline by
  // hand, or a hung server would stall the turn past the fetch timeout below.
  const raced = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        signal.addEventListener("abort", () => rej(new Error("kagi search timed out")), {
          once: true,
        }),
      ),
    ]);
  const client = await raced(
    experimental_createMCPClient({
      transport: {
        type: "http",
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${key}` },
      },
    }),
  );
  try {
    const tools = await raced(client.tools());
    const search = tools[KAGI_SEARCH_TOOL];
    if (!search) throw new Error(`kagi mcp server offers no ${KAGI_SEARCH_TOOL} tool`);
    const result = (await search.execute(
      { query: q },
      { toolCallId: KAGI_SEARCH_TOOL, messages: [], abortSignal: signal },
    )) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      toolResult?: unknown;
    };
    const text = mcpText(result);
    if (result.isError) throw new Error(text || `${KAGI_SEARCH_TOOL} failed`);
    return text;
  } finally {
    await client.close().catch(() => {});
  }
};

/** Pull the text out of an MCP `CallToolResult` (kagimcp returns markdown text). */
const mcpText = (result: {
  content?: Array<{ type: string; text?: string }>;
  toolResult?: unknown;
}): string => {
  if (Array.isArray(result.content)) {
    return result.content
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return typeof result.toolResult === "string" ? result.toolResult : "";
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);

export const searchTool = (cfg: SearchConfig) => {
  return tool({
    description:
      "Search the web. Returns a numbered list of results (title, URL, snippet). " +
      "Use a fetch tool afterwards to read a page in full.",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
      max_results: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How many results (default ${cfg.maxResults}).`),
    }),
    execute: async ({ query, max_results }) => {
      const r = await runSearch(cfg, query, max_results);
      if (!r.ok) throw new Error(r.output);
      return { results: r.output };
    },
  });
};
