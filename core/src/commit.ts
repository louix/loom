/**
 * `git commit` under a worktree, without shelling the agent out to git. Shared
 * by the Claude `loom` MCP server and the aisdk `commit` tool. Deliberately
 * free of any vendor SDK import so it can be pulled into either provider's
 * graph without dragging the other's dependencies in.
 */
import { spawnSync } from "node:child_process";

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
