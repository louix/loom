/**
 * `@loom/connector-claude` — wraps `@anthropic-ai/claude-agent-sdk`. Auth is the
 * SDK's own OAuth in `~/.claude`; Loom brokers nothing.
 */
import type { AgentProvider } from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { ClaudeProvider } from "./adapter.ts";

export const createProvider = (ctx: ConnectorContext): AgentProvider => {
  return new ClaudeProvider({
    id: ctx.id,
    cliPath: ctx.config.cliPath ?? "",
    promptCacheTtl: ctx.config.promptCacheTtl ?? "",
    configDir: ctx.config.configDir ?? "",
  });
};
