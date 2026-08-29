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
import { spawnSync } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

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
        .describe("Optional background: what you were doing, why you're blocked, the options you see."),
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
        .describe("Stage all changes first (git add -A). Default true; set false to commit only what is already staged."),
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
  return createSdkMcpServer({ name: "loom", version: "1", alwaysLoad: true, tools: [askUser, commit] });
}

// ---------------------------------------------------------------------------
// commit — exported for direct testing
// ---------------------------------------------------------------------------

export interface CommitResult {
  ok: boolean;
  /** Human-readable outcome, handed straight back to the model. */
  text: string;
  /** Short hash of the new commit, when one was made. */
  sha?: string;
}

export function commitInWorktree(
  cwd: string,
  message: string,
  opts: { stageAll: boolean },
): CommitResult {
  const msg = message.trim();
  if (msg === "") return { ok: false, text: "commit aborted: the message is empty" };

  if (opts.stageAll) {
    const add = git(cwd, ["add", "-A"]);
    if (!add.ok) return { ok: false, text: `git add failed: ${add.err || add.out}` };
  }

  const staged = git(cwd, ["diff", "--cached", "--name-only"]);
  if (staged.ok && staged.out.trim() === "") {
    return {
      ok: false,
      text: opts.stageAll
        ? "nothing to commit — the worktree is clean"
        : "nothing to commit — no changes are staged",
    };
  }

  // Never sign: these are automated commits under Loom's own identity, and a
  // machine-wide `commit.gpgsign = true` would block on a passphrase prompt.
  const co = git(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", msg]);
  if (!co.ok) return { ok: false, text: `git commit failed: ${co.err || co.out}` };

  const sha = git(cwd, ["rev-parse", "--short", "HEAD"]).out.trim();
  const subject = git(cwd, ["log", "-1", "--format=%s"]).out.trim();
  const stat = git(cwd, ["show", "--stat", "--oneline", "--format=", "HEAD"]).out.trim();
  return {
    ok: true,
    sha,
    text: `committed ${sha} ${subject}${stat ? `\n${stat}` : ""}`,
  };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}
