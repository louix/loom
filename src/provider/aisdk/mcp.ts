/**
 * MCP client hub for an aisdk session. Loom's vendor-neutral `McpServerHandle[]`
 * become live MCP clients (stdio or streamable-HTTP) via `@ai-sdk/mcp`; their
 * tools are merged into one set for the turn. A server that fails to start is
 * logged and skipped — it never takes the session down with it.
 *
 * The Claude adapter gets the same servers through the SDK's own `mcpServers`
 * option; this is the equivalent for OpenAI-compatible providers.
 */
import { experimental_createMCPClient, type experimental_MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { Logger } from "../../util/logger.ts";
import type { McpServerHandle } from "../types.ts";

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return { ...out, ...extra };
}

export class McpHub {
  readonly #clients: experimental_MCPClient[];
  readonly #tools: ToolSet;

  private constructor(clients: experimental_MCPClient[], tools: ToolSet) {
    this.#clients = clients;
    this.#tools = tools;
  }

  static async connect(handles: McpServerHandle[], log: Logger): Promise<McpHub> {
    const clients: experimental_MCPClient[] = [];
    const tools: ToolSet = {};

    for (const h of handles) {
      let client: experimental_MCPClient | undefined;
      try {
        client = await experimental_createMCPClient({
          transport:
            h.spec.transport === "stdio"
              ? new Experimental_StdioMCPTransport({
                  command: h.spec.command,
                  ...(h.spec.args ? { args: h.spec.args } : {}),
                  ...(h.spec.env ? { env: cleanEnv(h.spec.env) } : {}),
                })
              : {
                  type: "http",
                  url: h.spec.url,
                  ...(h.spec.headers ? { headers: h.spec.headers } : {}),
                },
        });
        const discovered = await client.tools();
        for (const [name, t] of Object.entries(discovered)) {
          // First server to claim a bare name keeps it; the rest are namespaced.
          const key = name in tools ? `${h.name}__${name}` : name;
          tools[key] = t;
        }
        clients.push(client);
        log.debug("mcp server connected", { name: h.name, tools: Object.keys(discovered).length });
      } catch (err) {
        // The transport may already have spawned a child / opened a socket
        // before `tools()` threw — close it so it isn't orphaned for the
        // daemon's lifetime (it never made it into `clients`).
        await client?.close().catch(() => {});
        log.warn("mcp server failed to start; skipping", {
          name: h.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return new McpHub(clients, tools);
  }

  /** Tools discovered across every server that started. */
  get tools(): ToolSet {
    return this.#tools;
  }

  get serverCount(): number {
    return this.#clients.length;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#clients.map((c) => c.close()));
  }
}
