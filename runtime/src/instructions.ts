import type { McpServerHandle } from "@loom/core/types";

/**
 * Connector-neutral pieces of a session's system-prompt append: the standalone
 * base prompt for engines with no vendor preset (aisdk / OpenAI-compatible),
 * and the tool steer pointing the model at whichever Loom tools are actually
 * mounted. Relocated (mostly verbatim) from
 * `backend/daemon/src/daemon/prompt.ts`, which still owns combining these with
 * the repository's AGENTS.md and deciding what applies to which provider.
 */

/** Which of Loom's own tools are mounted for this session — drives which bullets `toolSteer` includes. */
export interface MountedLoomTools {
  askUser: boolean;
  commit: boolean;
  status: boolean;
}

/**
 * System prompt for aisdk (OpenAI-compatible) sessions. There is no
 * "claude_code" base preset to append to, so this stands alone; it is followed
 * by the tool steer when MCP servers are mounted.
 */
export const AISDK_SYSTEM = [
  "You are a coding agent working in a git worktree under Loom, an agent harness.",
  "Work autonomously toward the user's goal: inspect the repo before changing it, make focused edits, and explain what you did concisely.",
  "Make the smallest change that fully covers the request. Documentation and comments can be good used sparingly. The test: does this tell the reader something they can't get from the code, or could only get by re-deriving it painfully? If not, delete it.",
  "Before you commit, run the project's typecheck and tests and read their output. If a test you added fails or is flaky, fix the root cause or follow how the existing tests assert; never loosen an assertion just to get a green run.",
  "You have tools for reading and editing files, searching, and committing. Call them.",
].join("\n");

/**
 * Appended to a session's system prompt for whichever of Loom's own
 * `ask_user`/`commit`/`status` tools this
 * session actually has (a Codex Code Mode session, for one, only gets
 * `commit`). Also pins the session's worktree as the one tree to touch, so
 * absolute-path tools land in the branch.
 */
export const toolSteer = (cwd: string, mounted: MountedLoomTools): string =>
  [
    "This session runs under Loom:",
    `- Repository work stays inside the worktree at ${cwd}. Use LOOM_PROJECT_DIR for shared project files when provided. Build every checkout file path — Read, Edit, Write, MCP root arguments, \`cd\` targets — from there, not from memory of where the repo "usually" lives. A path outside it, such as a parent checkout of the same repo, is a *different* working tree: reads come back stale and writes never reach your branch.${mounted.status ? " The `status` tool reprints this root." : ""}`,
    ...(mounted.commit
      ? [
          "- When you have a coherent set of changes, call the `commit` tool to record them; don't shell out to git.",
        ]
      : []),
    ...(mounted.askUser
      ? [
          "- When you need a decision from the user, use a question tool so the session waits for their answer; do not end with a plain chat question. For choices, prefer the available structured question tool (such as `AskUserQuestion`) over `ask_user`: put each choice in its options field, with a short label and a concise description, instead of an A/B/C menu in free text. Use single-select for mutually exclusive alternatives and multi-select only when several choices can apply. Use `ask_user` for open-ended questions or when no structured question tool is available in the current mode. Keep the question and context brief, and use real newlines rather than literal backslash-n text.",
        ]
      : []),
  ].join("\n");

/** Capability preferences, not tool aliases: each server owns its names and schemas. */
export const mcpToolPreferences = (servers: McpServerHandle[]): string => {
  const preferred = servers.filter((s) => s.defaultFor?.length);
  if (!preferred.length) return "";
  return [
    "Default tool providers for this session:",
    ...preferred.map(
      (s) =>
        "- For " +
        s.defaultFor!.join(", ") +
        ", prefer the tools advertised by MCP server " +
        s.name +
        ". Use their actual tool names and argument schemas.",
    ),
    "Use built-in tools as fallbacks when the preferred server is unavailable or does not support the operation. All tool calls remain subject to the session's permission policy.",
  ].join("\n");
};
