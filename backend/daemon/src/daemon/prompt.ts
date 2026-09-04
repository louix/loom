import { loomInstructions } from "@loom/core/paths";

/**
 * Appended to the Claude system prompt for every session (spec §11.4). Steers
 * the agent onto the mounted MCP tools: tilth for reading and editing code,
 * fff for file finding and text search, and the in-process `loom` server for
 * committing and for asking the user when blocked. It also pins the session's
 * worktree as the one tree to touch, so absolute-path tools land in the branch.
 */
const toolSteer = (cwd: string): string =>
  [
    "This session runs under Loom, which mounts a few MCP tools you should reach for first:",
    "- Use tilth for working with code — locating a symbol or its references, reading source structurally, and editing (`tilth_write` creates or replaces a file, `tilth_edit` makes in-place changes). It understands code structure via tree-sitter, so prefer it over the built-in Read / Write / Edit for source files.",
    "- Use fff for file-level work — finding files by name or glob, and plain-text search across the tree.",
    `- All of this session's work stays inside the worktree at ${cwd}. Build every file path — Read, Edit, Write, tilth's \`root\`, \`cd\` targets — from there, not from memory of where the repo "usually" lives. A path outside it, such as a parent checkout of the same repo, is a *different* working tree: reads come back stale and writes never reach your branch. The \`status\` tool reprints this root.`,
    "- When you have a coherent set of changes, call the `commit` tool to record them; don't shell out to git.",
    "- If you are blocked on a decision only the user can make, call `ask_user` rather than guessing or stopping. Avoid a plain chat text question because it will show the session as idle/done instead of waiting on the user.",
  ].join("\n");

/**
 * System prompt for aisdk (OpenAI-compatible) sessions. There is no
 * "claude_code" base preset to append to, so this stands alone; it is followed
 * by the tool steer when MCP servers are mounted.
 */
const AISDK_SYSTEM = [
  "You are a coding agent working in a git worktree under Loom, an agent harness.",
  "Work autonomously toward the user's goal: inspect the repo before changing it, make focused edits, and explain what you did concisely.",
  "Make the smallest change that fully covers the request. Documentation and comments can be good used sparingly. The test: does this tell the reader something they can't get from the code, or could only get by re-deriving it painfully? If not, delete it.",
  "Before you commit, run the project's typecheck and tests and read their output. If a test you added fails or is flaky, fix the root cause or follow how the existing tests assert; never loosen an assertion just to get a green run.",
  "You have tools for reading and editing files, searching, and committing. Call them.",
].join("\n");

/**
 * The system-prompt append for a new session: the tool steer — led by the
 * standalone base prompt for aisdk sessions, which have no preset to append
 * to, and dropped for aisdk when no MCP servers are mounted — then the repo's
 * `.loom/LOOM.md` instructions when present. The file is read from the
 * session's `cwd` first (a committed LOOM.md rides inside the worktree),
 * falling back to the daemon's repoRoot checkout: new worktrees branch from
 * base, so a freshly written file isn't in them yet.
 */
export const systemPromptAppendFor = (
  aisdk: boolean,
  withMcp: boolean,
  cwd: string,
  repoRoot: string,
): string =>
  [
    ...(aisdk ? [AISDK_SYSTEM] : []),
    ...(aisdk && !withMcp ? [] : [toolSteer(cwd)]),
    loomInstructions(cwd) ?? loomInstructions(repoRoot),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n\n");
