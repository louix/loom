/**
 * The shared, SDK-agnostic surface of Loom's own tools — `ask_user`,
 * `commit`, `status` — mounted by both the Claude adapter (an in-process MCP
 * server, `connectors/claude/src/loom-mcp.ts`) and aisdk sessions (plain
 * Vercel AI SDK `tool()`s, `aisdk/src/loom-tools.ts`). Only the description
 * text and input shape live here: both callers already share the execution
 * logic via `core/src/commit.ts` / `status.ts`, and each keeps its own
 * `tool()` wrapping since the two SDKs' return shapes differ (aisdk returns a
 * plain string; Claude's MCP tool returns `{content, isError?}`).
 *
 * The zod shapes below are bare field objects, not `z.object(...)` — Claude's
 * `tool(name, description, shape, fn)` takes a shape directly, while aisdk's
 * `tool({inputSchema: z.object(shape), ...})` wraps it. Both consume the same
 * object without adapting it.
 */
import { z } from "zod";

export interface LoomToolDeps {
  /** The session's worktree — `commit` runs here. */
  cwd: string;
  /** The repo's base branch — feeds the `status` tool's ahead/behind counts. */
  base?: string;
  /** Round-trip a question to the user; resolves with their answer text. */
  askUser(question: string, context: string | undefined): Promise<string>;
}

export const ASK_USER_DESC =
  "Ask the human supervising this session a question and wait for their answer. " +
  "Use this when you are blocked on a decision only they can make — do not guess " +
  "when you could ask. The call returns their reply as text.";

export const COMMIT_DESC =
  "Commit the current changes in this session's git worktree. Stages every change " +
  "first by default. Commits are made under this session's Loom identity. Returns " +
  "the new commit's short hash, subject, and a diffstat.";

export const STATUS_DESC =
  "Show the current state of this session's git worktree: the branch (with " +
  "ahead/behind counts vs the base branch when known), the changed files, a " +
  "diffstat, and the worktree's absolute path — pass it as `root` to tools " +
  "that want one. Read-only and cheap — prefer it over shelling out to git.";

export const askUserShape = {
  question: z.string().describe("The question to put to the user. Be specific and self-contained."),
  context: z
    .string()
    .optional()
    .describe("Optional background: what you were doing, why you're blocked, the options you see."),
};

export const commitShape = {
  message: z.string().describe("Commit message. First line is the subject; keep it under ~72 chars."),
  stage_all: z
    .boolean()
    .optional()
    .describe("Stage all changes first (git add -A). Default true; set false to commit only what is already staged."),
};

export const statusShape = {
  patch: z
    .boolean()
    .optional()
    .describe("Include the working diff against HEAD (clamped; untracked files are not included)."),
};
