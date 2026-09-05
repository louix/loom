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

export type { LoomToolDeps };

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
