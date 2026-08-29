/**
 * A `web_search` tool for aisdk sessions — Claude has its own built-in, this
 * fills the gap for OpenAI-compatible / Gemini / Anthropic-via-aisdk sessions.
 * Pluggable backend (`[search] backend`): Brave Search API or Tavily. Off
 * unless a backend + key are configured.
 */
import { tool } from "ai";
import { z } from "zod";

export interface SearchConfig {
  backend: "brave" | "tavily";
  /** Resolved API key (not the env-var name). */
  apiKey: string;
  /** Base URL override — "" uses the backend default. */
  apiBase: string;
  maxResults: number;
}

const DEFAULT_BASE = {
  brave: "https://api.search.brave.com/res/v1",
  tavily: "https://api.tavily.com",
} as const;

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

export async function runSearch(
  cfg: SearchConfig,
  query: string,
  maxResults?: number,
): Promise<{ ok: boolean; output: string }> {
  const n = Math.min(20, Math.max(1, maxResults ?? cfg.maxResults));
  const base = (cfg.apiBase || DEFAULT_BASE[cfg.backend]).replace(/\/$/, "");
  try {
    const hits = cfg.backend === "brave" ? await brave(base, cfg.apiKey, query, n) : await tavily(base, cfg.apiKey, query, n);
    if (hits.length === 0) return { ok: true, output: "(no results)" };
    return {
      ok: true,
      output: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${oneLine(h.snippet)}`).join("\n"),
    };
  } catch (err) {
    return { ok: false, output: `search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function brave(base: string, key: string, q: string, n: number): Promise<Hit[]> {
  const res = await fetch(`${base}/web/search?q=${encodeURIComponent(q)}&count=${n}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
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
}

async function tavily(base: string, key: string, q: string, n: number): Promise<Hit[]> {
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query: q, max_results: n }),
  });
  if (!res.ok) throw new Error(`tavily search ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
  return (body.results ?? []).slice(0, n).map((r) => ({
    title: str(r.title),
    url: str(r.url),
    snippet: str(r.content),
  }));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);

export function searchTool(cfg: SearchConfig) {
  return tool({
    description:
      "Search the web. Returns a numbered list of results (title, URL, snippet). " +
      "Use a fetch tool afterwards to read a page in full.",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
      max_results: z.number().int().positive().optional().describe(`How many results (default ${cfg.maxResults}).`),
    }),
    execute: async ({ query, max_results }) => {
      const r = await runSearch(cfg, query, max_results);
      if (!r.ok) throw new Error(r.output);
      return { results: r.output };
    },
  });
}
