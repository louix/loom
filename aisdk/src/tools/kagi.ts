/**
 * Kagi's hosted MCP server (kagimcp) — the machinery behind
 * `[search] backend = "kagi"`. One short-lived MCP session per call: connect,
 * discover, call, close, over streamable HTTP with the API key as a bearer
 * token. Only the required input is sent — the server's tool schema owns the
 * rest (its search default is 10 results, and a hidden param would reject
 * extra arguments).
 */
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";
import type { SearchConfig } from "@loom/core/connector";

const KAGI_BASE = "https://mcp.kagi.com";
const SEARCH_TOOL = "kagi_search_fetch";
const EXTRACT_TOOL = "kagi_extract";

/** The `[search]` keys the kagi tools need. */
type KagiCfg = Pick<SearchConfig, "apiKey" | "apiBase">;

const baseOf = (cfg: KagiCfg): string => (cfg.apiBase || KAGI_BASE).replace(/\/$/, "");

/** `kagi_search_fetch` — web/news/video/podcast/image search; Kagi formats the results itself. */
export const kagiSearch = async (cfg: KagiCfg, query: string): Promise<string> => {
  return callTool(baseOf(cfg), cfg.apiKey, SEARCH_TOOL, { query }, AbortSignal.timeout(15_000));
};

/**
 * `kagi_extract` — one page's full content as markdown. Kagi's extract API
 * allows 30s (their KAGI_EXTRACT_TIMEOUT default), and pages can be long, so
 * the text is capped before it lands in the model's context.
 */
const MAX_EXTRACT_CHARS = 60_000;

export const kagiExtract = async (cfg: KagiCfg, url: string): Promise<string> => {
  const text = await callTool(
    baseOf(cfg),
    cfg.apiKey,
    EXTRACT_TOOL,
    { url },
    AbortSignal.timeout(30_000),
  );
  return text.length <= MAX_EXTRACT_CHARS
    ? text
    : `${text.slice(0, MAX_EXTRACT_CHARS)}\n\n… [truncated — ${text.length - MAX_EXTRACT_CHARS} more characters]`;
};

const callTool = async (
  base: string,
  key: string,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<string> => {
  // connect / tools() don't take a signal — bound them by the deadline by
  // hand, or a hung server would stall the turn past the timeout.
  const raced = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        signal.addEventListener("abort", () => rej(new Error(`${name} timed out`)), {
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
    const t = tools[name];
    if (!t) throw new Error(`kagi mcp server offers no ${name} tool`);
    const result = (await t.execute(args, {
      toolCallId: name,
      messages: [],
      abortSignal: signal,
    })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      toolResult?: unknown;
    };
    const text = mcpText(result);
    if (result.isError) throw new Error(text || `${name} failed`);
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

/** The `web_fetch` tool — `kagi_extract` under a first-party name, so the agent can read a search hit in full. */
export const fetchTool = (cfg: KagiCfg) => {
  return tool({
    description:
      "Fetch a web page and return its full content as markdown. " +
      "Use after web_search to read a result in full.",
    inputSchema: z.object({
      url: z.string().describe("The HTTPS URL of the page to read."),
    }),
    execute: async ({ url }) => {
      let text: string;
      try {
        text = await kagiExtract(cfg, url);
      } catch (err) {
        throw new Error(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { content: text === "" ? "(no content)" : text };
    },
  });
};
