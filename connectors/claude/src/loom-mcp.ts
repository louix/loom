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
 *   - `status`   — report the worktree's git state: branch, changed files, diffstat.
 *
 * Descriptions and input shapes are shared with the aisdk `loom` tools via
 * `@loom/runtime/loom-tools`. Only the Claude adapter imports this; nothing
 * above the provider layer does.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { commitInWorktree, type CommitResult } from "@loom/core/commit";
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

// Re-exported for the tests that still import it from here.
export { commitInWorktree, type CommitResult };
export type { LoomToolDeps };

export const buildLoomMcpServer = (deps: LoomToolDeps): McpSdkServerConfigWithInstance => {
  const askUser = tool("ask_user", ASK_USER_DESC, askUserShape, async (args) => {
    const answer = await deps.askUser(args.question, args.context);
    return { content: [{ type: "text", text: answer }] };
  });

  const commit = tool("commit", COMMIT_DESC, commitShape, async (args) => {
    const res = commitInWorktree(deps.cwd, args.message, { stageAll: args.stage_all !== false });
    return res.ok
      ? { content: [{ type: "text", text: res.text }] }
      : { content: [{ type: "text", text: res.text }], isError: true };
  });

  const status = tool("status", STATUS_DESC, statusShape, async (args) => {
    const res = statusInWorktree(deps.cwd, {
      ...(deps.base ? { base: deps.base } : {}),
      ...(args.patch ? { patch: true } : {}),
    });
    return res.ok
      ? { content: [{ type: "text", text: res.text }] }
      : { content: [{ type: "text", text: res.text }], isError: true };
  });

  // `alwaysLoad` keeps these tools in every prompt rather than deferring
  // them behind tool-search — they're few and broadly relevant to any session.
  return createSdkMcpServer({
    name: "loom",
    version: "1",
    alwaysLoad: true,
    tools: [askUser, commit, status],
  });
};
