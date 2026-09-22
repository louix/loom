/** Trusted tool catalogs are independent of the tools selected for a session. */
import { nixMcpRuntime, mcpGrantsSchema } from "../../../../core/src/mcp-config.ts";
import { isClaudeId } from "@loom/core/provider-id";
import { MCP_CAPABILITIES } from "@loom/core/types";
import type { ToolSettings } from "./schema.ts";
import type { LoomConfig } from "./config.ts";

const groups = ["local_tools", "vm_tools", "remote_tools"] as const;
/** Resolve only explicitly selected definitions into connector-neutral transports. */
export const resolveToolSelection = (raw: ToolSettings): Pick<LoomConfig, "mcp" | "httpMcp"> => {
  const session = raw.session;
  const mcp: LoomConfig["mcp"] = [];
  const httpMcp: LoomConfig["httpMcp"] = [];
  for (const group of groups) {
    const catalog = raw[group];
    const selected = session[group];
    for (const name of selected) {
      if (!Object.hasOwn(catalog, name))
        throw new Error(`Unknown tool ${group}.${name} selected by session.${group}`);
      const entry = catalog[name] as Record<string, unknown>;
      const common = {
        name,
        required: true,
        defaultFor: (entry.default_for ?? []) as (typeof MCP_CAPABILITIES)[number][],
      };
      if (group === "remote_tools")
        httpMcp.push({
          ...common,
          url: entry.url as string,
          bearerTokenEnv: (entry.bearer_token_env ?? "") as string,
          ...(entry.bearer_token !== undefined
            ? { bearerToken: entry.bearer_token as string }
            : {}),
        });
      else if (group === "vm_tools")
        mcp.push({ ...common, runtime: entry.runtime as string, isolation: "vm" });
      else
        mcp.push({
          ...common,
          command: entry.command as string,
          args: (entry.args ?? []) as string[],
        });
    }
  }
  for (const name of session.mcp_servers) {
    if (!Object.hasOwn(raw.mcp_servers, name)) throw new Error(`Unknown MCP server ${name}`);
    const entry = raw.mcp_servers[name]!;
    const common = { name, required: true, defaultFor: entry.default_for };
    if (entry.source.kind === "http") {
      httpMcp.push({
        ...common,
        url: entry.source.url,
        bearerTokenEnv: entry.auth?.bearer_token_env ?? "",
      });
    } else {
      mcp.push({
        ...common,
        runtime: entry.source.kind === "nix" ? nixMcpRuntime(entry.source) : entry.source.ref,
        isolation: "vm",
        grants: mcpGrantsSchema.parse(entry.grants ?? {}),
      });
    }
  }
  const names = new Set<string>();
  const roles = new Set<string>();
  for (const tool of [...mcp, ...httpMcp]) {
    if (names.has(tool.name)) throw new Error(`Tool ${tool.name} is selected from multiple groups`);
    names.add(tool.name);
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
  if ((config.isolation.enabled || vm) && host.length)
    return (
      `Provider ${provider} runs in a VM but host tools are selected: ${host.map((m) => m.name).join(", ")}. ` +
      "Set session.local_tools = [] and select vm_tools or remote_tools instead."
    );
};
