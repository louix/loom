/**
 * Connector-neutral pieces of a session's system-prompt append: the standalone
 * base prompt for engines with no vendor preset (aisdk / OpenAI-compatible),
 * and the tool steer pointing the model at whichever Loom tools are actually
 * mounted. Relocated (mostly verbatim) from
 * `backend/daemon/src/daemon/prompt.ts`, which still owns combining these with
 * a repo's `.loom/LOOM.md` and deciding what applies to which provider.
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
 * Appended to a session's system prompt to steer it onto the mounted MCP
 * tools: tilth for reading and editing code, fff for file finding and text
 * search, and whichever of Loom's own `ask_user`/`commit`/`status` tools this
 * session actually has (a Codex Code Mode session, for one, only gets
 * `commit`). Also pins the session's worktree as the one tree to touch, so
 * absolute-path tools land in the branch.
 */
export const toolSteer = (cwd: string, mounted: MountedLoomTools): string =>
  [
    "This session runs under Loom, which mounts a few MCP tools you should reach for first:",
    "- Use tilth for working with code — locating a symbol or its references, reading source structurally, and editing (`tilth_write` creates or replaces a file, `tilth_edit` makes in-place changes). It understands code structure via tree-sitter, so prefer it over the built-in Read / Write / Edit for source files.",
    "- Use fff for file-level work — finding files by name or glob, and plain-text search across the tree.",
    `- All of this session's work stays inside the worktree at ${cwd}. Build every file path — Read, Edit, Write, tilth's \`root\`, \`cd\` targets — from there, not from memory of where the repo "usually" lives. A path outside it, such as a parent checkout of the same repo, is a *different* working tree: reads come back stale and writes never reach your branch.${mounted.status ? " The `status` tool reprints this root." : ""}`,
    ...(mounted.commit
      ? [
          "- When you have a coherent set of changes, call the `commit` tool to record them; don't shell out to git.",
        ]
      : []),
    ...(mounted.askUser
      ? [
          "- If you are blocked on a decision only the user can make, call `ask_user` rather than guessing or stopping. Avoid a plain chat text question because it will show the session as idle/done instead of waiting on the user.",
        ]
      : []),
  ].join("\n");
