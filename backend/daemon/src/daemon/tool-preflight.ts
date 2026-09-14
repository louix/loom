import type { LoomConfig } from "../config/config.ts";
import { toolExecutionError } from "../config/tool-selection.ts";
export { toolExecutionError } from "../config/tool-selection.ts";
import { onPath } from "@loom/core/paths";
import { resolveRuntime } from "../../../../runtime/src/packaged/artifact.ts";

/** Check selections before creating worktrees, executing init hooks or starting MCP workers. */
export const preflightTools = async (
  config: LoomConfig,
  provider: string,
  dependencies = { onPath, resolveRuntime },
): Promise<void> => {
  const error = toolExecutionError(config, provider);
  if (error) throw new Error(error);
  for (const m of config.mcp) {
    if ("runtime" in m) await dependencies.resolveRuntime(m.runtime);
    else if (m.required && !dependencies.onPath(m.command))
      throw new Error(
        `Required host tool ${m.name}: executable ${m.command} is unavailable. Install it or change session.tools.`,
      );
  }
  for (const m of config.httpMcp)
    if (!m.bearerToken && m.bearerTokenEnv && !Deno.env.get(m.bearerTokenEnv))
      throw new Error(`Remote tool ${m.name}: ${m.bearerTokenEnv} is not set`);
};
