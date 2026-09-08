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
import type { Logger } from "@loom/core/logger";
import type { McpServerHandle } from "@loom/core/types";

const cleanEnv = (extra: Record<string, string>): Record<string, string> => {
  return { ...Deno.env.toObject(), ...extra };
};

/**
 * The MCP client's own `tools/list` — public on the object, absent from its
 * published types: its `tools()` re-builds each tool and drops `annotations`,
 * which is where a server declares `readOnlyHint` (tilth's `tilth_deps` has no
 * read verb in its name to guess from). Structural, so an SDK shape change
 * degrades to "no hints" — hints are optional, the gate's name heuristics
 * still cover the call.
 */
type RawListTools = {
  listTools?: (opts?: { params?: { cursor?: string } }) => Promise<{
    tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    nextCursor?: string | null;
  }>;
};

/** Tool name → the server's `annotations.readOnlyHint`, where it declares one. */
const declaredReadonlyHints = async (
  client: experimental_MCPClient,
): Promise<ReadonlyMap<string, boolean>> => {
  const listTools = (client as unknown as RawListTools).listTools;
  if (typeof listTools !== "function") return new Map();
  const hints = new Map<string, boolean>();
  try {
    let page = await listTools.call(client);
    for (;;) {
      for (const t of page.tools) {
        if (typeof t.annotations?.readOnlyHint === "boolean") {
          hints.set(t.name, t.annotations.readOnlyHint);
        }
      }
      if (!page.nextCursor) return hints;
      page = await listTools.call(client, { params: { cursor: page.nextCursor } });
    }
  } catch {
    return hints; // whatever pages landed are still true declarations
  }
};

export class McpHub {
  readonly #clients: experimental_MCPClient[];
  readonly #tools: ToolSet;
  readonly #readOnlyHints: ReadonlyMap<string, boolean>;

  private constructor(
    clients: experimental_MCPClient[],
    tools: ToolSet,
    readOnlyHints: ReadonlyMap<string, boolean>,
  ) {
    this.#clients = clients;
    this.#tools = tools;
    this.#readOnlyHints = readOnlyHints;
  }

  static async connect(handles: McpServerHandle[], log: Logger, cwd?: string): Promise<McpHub> {
    const clients: experimental_MCPClient[] = [];
    const tools: ToolSet = {};
    const readOnlyHints = new Map<string, boolean>();

    for (const h of handles) {
      if (h.spec.transport === "runtime")
        throw new Error("Packaged MCP was not mounted by the daemon");
      let client: experimental_MCPClient | undefined;
      try {
        client = await experimental_createMCPClient({
          transport:
            h.spec.transport === "stdio"
              ? new Experimental_StdioMCPTransport({
                  command: h.spec.command,
                  ...(h.spec.args ? { args: h.spec.args } : {}),
                  ...(h.spec.env ? { env: cleanEnv(h.spec.env) } : {}),
                  // Anchor stdio servers to the session's worktree: they resolve
                  // relative paths (tilth's `--scope` default `.`) against their
                  // own cwd, which without this is the daemon's cwd — the main
                  // repo, not the worktree the session edits.
                  ...(cwd ? { cwd } : {}),
                })
              : {
                  type: "http",
                  url: h.spec.url,
                  ...(h.spec.headers ? { headers: h.spec.headers } : {}),
                },
        });
        const discovered = await client.tools();
        const declared = await declaredReadonlyHints(client);
        for (const [name, t] of Object.entries(discovered)) {
          // First server to claim a bare name keeps it; the rest are namespaced.
          const key = name in tools ? `${h.name}__${name}` : name;
          tools[key] = Object.assign(t, {
            description: `MCP server ${h.name}. ${t.description ?? ""}`,
          });
          const hint = declared.get(name);
          if (hint !== undefined) readOnlyHints.set(key, hint);
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

    return new McpHub(clients, tools, readOnlyHints);
  }

  /** Tools discovered across every server that started. */
  get tools(): ToolSet {
    return this.#tools;
  }

  /**
   * Mounted tool name → the server's MCP `annotations.readOnlyHint`, for the
   * names where the server declared one (`tilth_deps` declares itself
   * read-only, `tilth_write` the opposite). The permission gate prefers these
   * declarations over its name heuristics.
   */
  get readOnlyHints(): ReadonlyMap<string, boolean> {
    return this.#readOnlyHints;
  }

  get serverCount(): number {
    return this.#clients.length;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#clients.map((c) => c.close()));
  }
}
