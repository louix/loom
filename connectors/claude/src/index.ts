/**
 * `@loom/connector-claude` — wraps `@anthropic-ai/claude-agent-sdk`. Auth is the
 * SDK's own OAuth in `~/.claude`; Loom brokers nothing.
 */
import type { AgentProvider } from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { ClaudeProvider } from "./adapter.ts";

export function createProvider(ctx: ConnectorContext): AgentProvider {
  return new ClaudeProvider({
    cliPath: ctx.config.cliPath ?? "",
    promptCacheTtl: ctx.config.promptCacheTtl ?? "",
  });
}
