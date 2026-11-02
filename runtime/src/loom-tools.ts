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
import type { PublishedPort } from "@loom/core/host-ports";

export interface LoomToolDeps {
  /** The session's worktree — `commit` runs here. */
  cwd: string;
  /** The repo's base branch — feeds the `status` tool's ahead/behind counts. */
  base?: string;
  /** This VM run's resolved `guest_ports`, for the `status` tool. */
  guestPorts?: PublishedPort[];
  /** Round-trip a question to the user; resolves with their answer text. */
  askUser(question: string, context: string | undefined): Promise<string>;
}

export const ASK_USER_DESC =
  "Ask the human supervising this session an open-ended question and wait for their answer. " +
  "For a choice between options, prefer the available structured question tool (such as " +
  "AskUserQuestion) instead: supply its options field so the user can select an answer. " +
  "Use this free-text tool for choices only when no structured question tool is available " +
  "in the current mode. Do not embed option menus here when a structured tool is available. " +
  "Keep the question and context concise; use real newlines, not literal backslash-n text. " +
  "Use this when you need a decision only the user can make. The call returns their reply as text.";

export const COMMIT_DESC =
  "Commit the current changes in this session's git worktree. Stages every change " +
  "first by default. Commits are made under this session's Loom identity. Returns " +
  "the new commit's short hash, subject, and a diffstat.";

export const STATUS_DESC =
  "Show the current state of this session's git worktree: the branch (with " +
  "ahead/behind counts vs the base branch when known), the changed files, a " +
  "diffstat, the worktree's absolute path — pass it as `root` to tools " +
  "that want one — and, in a VM, which host port each published guest port " +
  "is reachable on. Read-only and cheap — prefer it over shelling out to git.";

export const askUserShape = {
  question: z.string().describe("The question to put to the user. Be specific and self-contained."),
  context: z
    .string()
    .optional()
    .describe(
      "Brief background needed to answer the question; do not duplicate the question or list options.",
    ),
};

export const commitShape = {
  message: z
    .string()
    .describe("Commit message. First line is the subject; keep it under ~72 chars."),
  stage_all: z
    .boolean()
    .optional()
    .describe(
      "Stage all changes first (git add -A). Default true; set false to commit only what is already staged.",
    ),
};

export const statusShape = {
  patch: z
    .boolean()
    .optional()
    .describe("Include the working diff against HEAD (clamped; untracked files are not included)."),
};
