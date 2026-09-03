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
 * `commit` reuses {@link commitInWorktree} from the Claude loom server, which is
 * SDK-agnostic.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { commitInWorktree } from "@loom/core/commit";
import { statusInWorktree } from "@loom/core/status";

export interface LoomToolDeps {
  /** The session's worktree — `commit` runs here. */
  cwd: string;
  /** The repo's base branch — feeds the `status` tool's ahead/behind counts. */
  base?: string;
  /** Round-trip a question to the user; resolves with their answer text. */
  askUser(question: string, context: string | undefined): Promise<string>;
}

const ASK_USER_DESC =
  "Ask the human supervising this session a question and wait for their answer. " +
  "Use this when you are blocked on a decision only they can make — do not guess " +
  "when you could ask. The call returns their reply as text.";

const COMMIT_DESC =
  "Commit the current changes in this session's git worktree. Stages every change " +
  "first by default. Commits are made under this session's Loom identity. Returns " +
  "the new commit's short hash, subject, and a diffstat.";

const STATUS_DESC =
  "Show the current state of this session's git worktree: the branch (with " +
  "ahead/behind counts vs the base branch when known), the changed files, a " +
  "diffstat, and the worktree's absolute path — pass it as `root` to tools " +
  "that want one. Read-only and cheap — prefer it over shelling out to git.";

export const buildLoomTools = (deps: LoomToolDeps): ToolSet => {
  return {
    ask_user: tool({
      description: ASK_USER_DESC,
      inputSchema: z.object({
        question: z
          .string()
          .describe("The question to put to the user. Be specific and self-contained."),
        context: z
          .string()
          .optional()
          .describe(
            "Optional background: what you were doing, why you're blocked, the options you see.",
          ),
      }),
      execute: async ({ question, context }) => {
        const answer = await deps.askUser(question, context);
        return { answer };
      },
    }),
    commit: tool({
      description: COMMIT_DESC,
      inputSchema: z.object({
        message: z
          .string()
          .describe("Commit message. First line is the subject; keep it under ~72 chars."),
        stage_all: z
          .boolean()
          .optional()
          .describe(
            "Stage all changes first (git add -A). Default true; set false to commit only what is staged.",
          ),
      }),
      execute: async ({ message, stage_all }) => {
        const res = commitInWorktree(deps.cwd, message, { stageAll: stage_all !== false });
        return res.text;
      },
    }),
    status: tool({
      description: STATUS_DESC,
      inputSchema: z.object({
        patch: z
          .boolean()
          .optional()
          .describe(
            "Include the working diff against HEAD (clamped; untracked files are not included).",
          ),
      }),
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
