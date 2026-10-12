/** Trusted tool catalogs are independent of the tools selected for a session. */
import { nixMcpRuntime, mcpGrantsSchema, type McpGrants } from "../../../../core/src/mcp-config.ts";
import { expandNetworkPresets } from "../../../../runtime/src/session-vm/network-policy.ts";
import { isClaudeId } from "@loom/core/provider-id";
import { absurd } from "@loom/core/absurd";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { mcpGrantsConfigSchema, ToolSettings } from "./schema.ts";
import type { LoomConfig } from "./config.ts";

/** Configured grants, presets expanded; none configured grants nothing. */
export const resolveMcpGrants = (
  grants: z.output<typeof mcpGrantsConfigSchema> | undefined,
): McpGrants =>
  mcpGrantsSchema.parse({
    workspace: grants?.workspace ?? "none",
    network: [
      ...(grants?.network.allowed_hosts ?? []),
      ...expandNetworkPresets(grants?.network.presets ?? []),
    ],
  });
/** Resolve only explicitly selected definitions into connector-neutral transports. */
export const resolveToolSelection = (raw: ToolSettings): Pick<LoomConfig, "mcp" | "httpMcp"> => {
  const mcp: LoomConfig["mcp"] = [];
  const httpMcp: LoomConfig["httpMcp"] = [];
  for (const name of raw.session.mcp_servers) {
    if (!Object.hasOwn(raw.mcp_servers, name))
      throw new Error(`Unknown MCP server ${name} selected by session.mcp_servers`);
    const entry = raw.mcp_servers[name]!;
    const common = { name, required: true, defaultFor: entry.default_for };
    switch (entry.source.kind) {
      case "http":
        httpMcp.push({
          ...common,
          url: entry.source.url,
          bearerTokenEnv: entry.auth?.bearer_token_env ?? "",
          ...(entry.auth?.bearer_token !== undefined
            ? { bearerToken: entry.auth.bearer_token }
            : {}),
          ...(entry.auth?.oauth ? { oauth: entry.auth.oauth } : {}),
        });
        break;
      case "command": {
        const { command, args, env, cwd } = entry.source;
        mcp.push({
          ...common,
          command,
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(cwd !== undefined ? { cwd: expandHome(cwd) } : {}),
        });
        break;
      }
      case "nix":
      case "runtime":
        mcp.push({
          ...common,
          runtime: entry.source.kind === "nix" ? nixMcpRuntime(entry.source) : entry.source.ref,
          isolation: "vm",
          grants: resolveMcpGrants(entry.grants),
        });
        break;
      default:
        absurd(entry.source);
    }
  }
  const roles = new Set<string>();
  for (const tool of [...mcp, ...httpMcp]) {
    for (const role of tool.defaultFor ?? []) {
      if (roles.has(role)) throw new Error(`Multiple tool defaults for ${role}`);
      roles.add(role);
    }
  }
  return { mcp, httpMcp };
};

export const toolExecutionError = (config: LoomConfig, provider: string): string | undefined => {
  if (provider === "fake" || provider === "mock") return;
  let vm = config.isolation.aisdk;
  if (isClaudeId(provider)) vm = config.isolation.claude;
  else if (config.providers.aisdk[provider]?.sdk === "chatgpt") vm = config.isolation.codex;
  const host = config.mcp.filter((m) => "command" in m);
  if ((config.defaults.isolation === "vm" || vm) && host.length)
    return (
      `Provider ${provider} runs in a VM but host commands are selected: ${host.map((m) => m.name).join(", ")}. ` +
      'Remove them from session.mcp_servers, or select servers whose source.kind is "nix", "runtime" or "http".'
    );
};

const expandHome = (path: string): string =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
