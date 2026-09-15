/** Trusted tool catalogs are independent of the tools selected for a session. */
import { isClaudeId } from "@loom/core/provider-id";
import { MCP_CAPABILITIES } from "@loom/core/types";
import type { LoomConfig } from "./config.ts";

const groups = ["local-tools", "vm-tools", "remote-tools"] as const;
const fields = {
  "local-tools": { required: "command", allowed: ["command", "args", "default_for"] },
  "vm-tools": { required: "runtime", allowed: ["runtime", "default_for"] },
  "remote-tools": {
    required: "url",
    allowed: ["url", "bearer_token", "bearer_token_env", "default_for"],
  },
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Resolve only explicitly selected definitions into connector-neutral transports. */
export const resolveToolSelection = (
  raw: Record<string, unknown>,
): Pick<LoomConfig, "mcp" | "httpMcp"> => {
  if (["command-mcp", "http-mcp", "mcp"].some((key) => key in raw))
    throw new Error(
      "MCP lists are no longer supported. Define local-tools, vm-tools or remote-tools by name and select them under session.",
    );
  const session = raw.session ?? {};
  if (!record(session)) throw new Error("session must be a table");
  for (const key of Object.keys(session))
    if (!groups.includes(key as (typeof groups)[number]))
      throw new Error(
        `Unknown session setting: ${key}. Use worktree/isolation for agent execution settings.`,
      );

  const mcp: LoomConfig["mcp"] = [];
  const httpMcp: LoomConfig["httpMcp"] = [];
  for (const group of groups) {
    const catalog = raw[group] ?? {};
    if (!record(catalog)) throw new Error(`${group} must be a table of named definitions`);
    const { allowed, required: key } = fields[group];
    for (const [name, entry] of Object.entries(catalog)) {
      const label = `${group}.${name}`;
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || name === "loom")
        throw new Error(`Invalid or reserved tool name: ${label}`);
      if (!record(entry)) throw new Error(`${label} must be a table`);
      for (const key of Object.keys(entry))
        if (!allowed.includes(key)) throw new Error(`Unknown setting ${label}.${key}`);
      if (typeof entry[key] !== "string" || !entry[key].trim())
        throw new Error(`${label} requires ${key}`);
      if (
        entry.args !== undefined &&
        (!Array.isArray(entry.args) || !entry.args.every((v) => typeof v === "string"))
      )
        throw new Error(`${label}.args must be strings`);
      if (
        entry.default_for !== undefined &&
        (!Array.isArray(entry.default_for) ||
          !entry.default_for.every((v) => MCP_CAPABILITIES.includes(v)))
      )
        throw new Error(`${label}.default_for contains an invalid capability`);
      for (const field of ["bearer_token", "bearer_token_env"])
        if (entry[field] !== undefined && typeof entry[field] !== "string")
          throw new Error(`${label}.${field} must be a string`);
      if (group === "remote-tools") {
        let url: URL;
        try {
          url = new URL(entry.url as string);
        } catch {
          throw new Error(`${label} requires a valid HTTP(S) URL`);
        }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
          throw new Error(
            `${label} URL must be HTTP(S), without embedded credentials or a fragment`,
          );
      }
    }
    const selected = session[group] ?? [];
    if (!Array.isArray(selected) || !selected.every((v) => typeof v === "string"))
      throw new Error(`session.${group} must be an array of tool names`);
    if (new Set(selected).size !== selected.length)
      throw new Error(`session.${group} contains duplicate tool selections`);
    for (const name of selected) {
      if (!Object.hasOwn(catalog, name))
        throw new Error(`Unknown tool ${group}.${name} selected by session.${group}`);
      const entry = catalog[name] as Record<string, unknown>;
      const common = {
        name,
        required: true,
        defaultFor: (entry.default_for ?? []) as (typeof MCP_CAPABILITIES)[number][],
      };
      if (group === "remote-tools")
        httpMcp.push({
          ...common,
          url: entry.url as string,
          bearerTokenEnv: (entry.bearer_token_env ?? "") as string,
          ...(entry.bearer_token !== undefined
            ? { bearerToken: entry.bearer_token as string }
            : {}),
        });
      else if (group === "vm-tools")
        mcp.push({ ...common, runtime: entry.runtime as string, isolation: "vm" });
      else
        mcp.push({
          ...common,
          command: entry.command as string,
          args: (entry.args ?? []) as string[],
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
      "Set session.local-tools = [] and select vm-tools or remote-tools instead."
    );
};
