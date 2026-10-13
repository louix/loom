/**
 * `@loom/connector-claude` — wraps `@anthropic-ai/claude-agent-sdk`. Auth is the
 * SDK's own OAuth in `~/.claude`; Loom brokers nothing.
 */
import type { AgentProvider } from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { ClaudeProvider } from "./adapter.ts";

export const createProvider = (ctx: ConnectorContext): AgentProvider => {
  if (ctx.config.autoMemory !== true) Deno.env.set("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
  else Deno.env.delete("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
  if (ctx.config.claudeAiConnectors !== true) Deno.env.set("ENABLE_CLAUDEAI_MCP_SERVERS", "false");
  else Deno.env.delete("ENABLE_CLAUDEAI_MCP_SERVERS");
  return new ClaudeProvider({
    id: ctx.id,
    cliPath: ctx.config.cliPath ?? "",
    promptCacheTtl: ctx.config.promptCacheTtl ?? "",
    autoMemory: ctx.config.autoMemory ?? false,
    claudeAiConnectors: ctx.config.claudeAiConnectors ?? false,
    configDir: ctx.config.configDir ?? "",
    ...(ctx.baseBranch ? { base: ctx.baseBranch } : {}),
  });
};
