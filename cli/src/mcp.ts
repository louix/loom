import { loadConfig } from "../../backend/daemon/src/config/config.ts";
import { nixMcpRuntime, mcpGrantsSchema } from "../../core/src/mcp-config.ts";
import { resolveRuntime } from "../../runtime/src/packaged/artifact.ts";
import { prepareRuntime } from "./runtime.ts";

/** Operate on definitions by name; defining/preparing a server does not select it. */
export const mcpCommand = async (
  args: string[],
  repo: string,
  opts: { json: boolean; smolvm?: string },
) => {
  const [action, name, ...rest] = args;
  if (!action || !["prepare", "status", "update"].includes(action) || rest.length)
    throw new Error("Usage: loom mcp prepare|status|update [name] [--smolvm PATH] [--json]");
  const config = loadConfig(repo);
  const catalog = config.mcpServers ?? {};
  const names = name
    ? [name]
    : [...config.mcp, ...config.httpMcp]
        .map((m) => m.name)
        .filter((n) => Object.hasOwn(catalog, n));
  const rows: Array<Record<string, unknown>> = [];
  for (const name of names) {
    if (!Object.hasOwn(catalog, name)) throw new Error(`Unknown mcp_servers.${name}`);
    const entry = catalog[name]!;
    try {
      if (entry.source.kind === "http") {
        const credential = entry.auth?.bearer_token_env;
        if (credential && !Deno.env.get(credential))
          throw new Error(`Missing credential environment variable ${credential}`);
        rows.push({
          name,
          status: "configured",
          transport: "http",
          connectivity: "checked at session launch",
        });
        continue;
      }
      const runtime = entry.source.kind === "nix" ? nixMcpRuntime(entry.source) : entry.source.ref;
      const prepared =
        action === "status"
          ? await resolveRuntime(runtime)
          : await prepareRuntime(runtime, {
              ...(opts.smolvm ? { smolvm: opts.smolvm } : {}),
              update: action === "update",
            });
      rows.push({
        name,
        status: "ready",
        artifact: prepared.lock.artifact,
        system: prepared.manifest.system,
        grants: mcpGrantsSchema.parse(entry.grants ?? {}),
      });
    } catch (error) {
      rows.push({
        name,
        status: "not ready",
        error: error instanceof Error ? error.message : String(error),
      });
      Deno.exitCode = 1;
    }
  }
  if (opts.json) return JSON.stringify(rows, null, 2) + "\n";
  if (!rows.length)
    return "No MCP servers selected. Define mcp_servers and select session.mcp_servers.\n";
  return (
    rows.map((r) => `${r.name}: ${r.status}${r.error ? " — " + r.error : ""}`).join("\n") + "\n"
  );
};
