/**
 * The `loom` tools for an aisdk session — the OpenAI-compatible equivalent of
 * the in-process `loom` MCP server the Claude adapter mounts. Plain Vercel AI
 * SDK `tool()` definitions rather than an MCP round-trip:
 *
 *   - `ask_user` — put a question to the human and block the turn on their reply
 *     (surfaces as a `question` HarnessEvent, resolved via `answerQuestion`).
 *   - `commit`   — commit the session's worktree under its pinned Loom identity.
 *   - `status`   — report the worktree's git state (branch, changes, diffstat).
 *
 * Descriptions and input shapes are shared with the Claude adapter's `loom`
 * MCP server via `@loom/runtime/loom-tools`; `commit` reuses
 * {@link commitInWorktree}, which is SDK-agnostic.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { commitInWorktree } from "@loom/core/commit";
import { statusInWorktree } from "@loom/core/status";
import {
  ASK_USER_DESC,
  askUserShape,
  COMMIT_DESC,
  commitShape,
  type LoomToolDeps,
  STATUS_DESC,
  statusShape,
} from "@loom/runtime/loom-tools";
import { AGENT_TOOL_NAMES, AGENT_TOOLS, type AgentToolName } from "@loom/runtime/agent-tools";
import type { AgentCallResult } from "@loom/core/types";

export type { LoomToolDeps };

/**
 * The `loom-agents` tools: each hands its call to `call`, which the session
 * routes to the daemon as an `agent_call` event. A failed call throws, so the
 * model sees an errored tool result rather than a plain one.
 */
export const buildAgentTools = (
  call: (tool: AgentToolName, input: Record<string, unknown>) => Promise<AgentCallResult>,
): ToolSet =>
  Object.fromEntries(
    AGENT_TOOL_NAMES.map((name) => [
      name,
      tool({
        description: AGENT_TOOLS[name].description,
        inputSchema: z.object(AGENT_TOOLS[name].shape),
        execute: async (input) => {
          const res = await call(name, input as Record<string, unknown>);
          if (!res.ok) throw new Error(res.text);
          return res.text;
        },
      }),
    ]),
  );

export const buildLoomTools = (deps: LoomToolDeps): ToolSet => {
  return {
    ask_user: tool({
      description: ASK_USER_DESC,
      inputSchema: z.object(askUserShape),
      execute: async ({ question, context }) => {
        const answer = await deps.askUser(question, context);
        return { answer };
      },
    }),
    commit: tool({
      description: COMMIT_DESC,
      inputSchema: z.object(commitShape),
      execute: async ({ message, stage_all }) => {
        const res = commitInWorktree(deps.cwd, message, { stageAll: stage_all !== false });
        return res.text;
      },
    }),
    status: tool({
      description: STATUS_DESC,
      inputSchema: z.object(statusShape),
      execute: async ({ patch }) => {
        const res = statusInWorktree(deps.cwd, {
          ...(deps.base ? { base: deps.base } : {}),
          ...(patch ? { patch: true } : {}),
        });
        return res.text;
      },
    }),
  };
};
