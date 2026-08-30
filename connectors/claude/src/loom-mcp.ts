/**
 * The in-process `loom` MCP server (design spec §11.4). Mounted into every
 * Claude session alongside the configured stdio servers (tilth, fff). It runs
 * in the daemon process so its tools can reach Loom's own state:
 *
 *   - `ask_user`  — put a question to the human supervising the session and
 *                   block the turn until they answer. Routed out as a
 *                   `question` HarnessEvent and resolved via `session.answer`.
 *   - `commit`    — commit the session's worktree under its pinned Loom
 *                   identity (spec §6) without the agent shelling out to git.
 *
 * Only the Claude adapter imports this; nothing above the provider layer does.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { commitInWorktree, type CommitResult } from "@loom/core/commit";

// Re-exported for the tests that still import it from here.
export { commitInWorktree, type CommitResult };

export interface LoomMcpDeps {
  /** The session's worktree — `commit` runs here. */
  cwd: string;
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

export function buildLoomMcpServer(deps: LoomMcpDeps): McpSdkServerConfigWithInstance {
  const askUser = tool(
    "ask_user",
    ASK_USER_DESC,
    {
      question: z
        .string()
        .describe("The question to put to the user. Be specific and self-contained."),
      context: z
        .string()
        .optional()
        .describe(
          "Optional background: what you were doing, why you're blocked, the options you see.",
        ),
    },
    async (args) => {
      const answer = await deps.askUser(args.question, args.context);
      return { content: [{ type: "text", text: answer }] };
    },
  );

  const commit = tool(
    "commit",
    COMMIT_DESC,
    {
      message: z
        .string()
        .describe("Commit message. First line is the subject; keep it under ~72 chars."),
      stage_all: z
        .boolean()
        .optional()
        .describe(
          "Stage all changes first (git add -A). Default true; set false to commit only what is already staged.",
        ),
    },
    async (args) => {
      const res = commitInWorktree(deps.cwd, args.message, { stageAll: args.stage_all !== false });
      return res.ok
        ? { content: [{ type: "text", text: res.text }] }
        : { content: [{ type: "text", text: res.text }], isError: true };
    },
  );

  // `alwaysLoad` keeps these two tools in every prompt rather than deferring
  // them behind tool-search — they're few and broadly relevant to any session.
  return createSdkMcpServer({
    name: "loom",
    version: "1",
    alwaysLoad: true,
    tools: [askUser, commit],
  });
}
