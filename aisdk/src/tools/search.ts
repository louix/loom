/**
 * A `web_search` tool for aisdk sessions — Claude has its own built-in, this
 * fills the gap for OpenAI-compatible / Gemini / Anthropic-via-aisdk sessions.
 * Pluggable backend (`[search] backend`): Brave Search API or Tavily.
 * Hosted search MCPs are configured separately. Off unless a backend + key
 * are configured.
 */
import { tool } from "ai";
import { z } from "zod";
import type { SearchConfig } from "@loom/core/connector";

const DEFAULT_BASE = {
  brave: "https://api.search.brave.com/res/v1",
  tavily: "https://api.tavily.com",
} as const;

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
  if (!cfg.apiKey) {
    return {
      ok: false,
      output: `the "${cfg.backend}" web-search backend has no API key configured`,
    };
  }
  const want = maxResults ?? cfg.maxResults ?? 5;
  const n = Number.isFinite(want) ? Math.min(20, Math.max(1, want)) : 5;
  const signal = AbortSignal.timeout(15_000); // a hung backend must not stall the turn
  try {
    const output = hitsToText(
      cfg.backend === "brave"
        ? await brave(baseOf(cfg, "brave"), cfg.apiKey, query, n, signal)
        : await tavily(baseOf(cfg, "tavily"), cfg.apiKey, query, n, signal),
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

const baseOf = (cfg: SearchConfig, backend: "brave" | "tavily"): string =>
  (cfg.apiBase || DEFAULT_BASE[backend]).replace(/\/$/, "");

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
