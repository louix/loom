/**
 * `git status` for a worktree, without shelling the agent out to git — the
 * read-only sibling of {@link commitInWorktree}. Shared by the Claude `loom`
 * MCP server and the aisdk `status` tool; deliberately free of any vendor SDK
 * import so it can be pulled into either provider's graph.
 *
 * The output is composed for a model: the branch line (augmented with
 * ahead/behind counts vs the base branch), the session's checkout root on a
 * `worktree:` line, the raw porcelain entries (models parse `XY` codes
 * natively — no reformatting), and a compact diffstat.
 */
import { spawnSync } from "node:child_process";

export interface StatusResult {
  ok: boolean;
  /** Human-readable status, handed straight back to the model. */
  text: string;
}

export interface StatusOptions {
  /** Base branch for ahead/behind counts; an unknown ref simply omits them. */
  base?: string;
  /** Include the working diff against HEAD (clamped; untracked files are not in the diff). */
  patch?: boolean;
}

/** Cap on the inline patch — head + tail, so early and late hunks both survive. */
const PATCH_CAP = 120_000;
const PATCH_HEAD = 80_000;

export const statusInWorktree = (cwd: string, opts: StatusOptions = {}): StatusResult => {
  const st = git(cwd, ["status", "--porcelain=v1", "-b"]);
  if (!st.ok) {
    if (/not a git repository/i.test(st.err)) {
      return { ok: false, text: `not a git repository: ${cwd}` };
    }
    return { ok: false, text: `git status failed: ${st.err || st.out}` };
  }

  const entries = st.out.split("\n").filter((l) => l !== "");
  // The `-b` header is `## <branch>` — or `## HEAD (no branch)`; name the commit.
  const header = (entries.shift() ?? "").replace(/^## /, "");
  let branchLine = header;
  if (header.startsWith("HEAD")) {
    const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
    if (sha.ok) branchLine = `HEAD ${sha.out.trim()}`;
  }
  if (opts.base) {
    // left = commits only on the base (behind), right = only on HEAD (ahead).
    const counts = git(cwd, ["rev-list", "--left-right", "--count", `${opts.base}...HEAD`]);
    const m = /^(\d+)\s+(\d+)$/.exec(counts.out.trim());
    if (counts.ok && m) {
      const behind = Number(m[1]);
      const ahead = Number(m[2]);
      if (ahead > 0 || behind > 0) branchLine += ` [+${ahead} -${behind} vs ${opts.base}]`;
    }
  }

  const stat = git(cwd, ["diff", "HEAD", "--shortstat"]);
  const changed = stat.ok ? compactStat(stat.out.trim()) : "";
  const clean = entries.length === 0 && changed === "";

  const parts = [`## ${branchLine}`, `worktree: ${cwd}`, ...entries];
  if (clean) parts.push("worktree clean");
  else if (changed) parts.push(changed);
  if (!clean && opts.patch) {
    const diff = git(cwd, ["diff", "HEAD"]);
    if (diff.ok && diff.out.trim() !== "") parts.push("", clampPatch(diff.out));
  }
  return { ok: true, text: parts.join("\n") };
};

/** `2 files changed, 18 insertions(+), 4 deletions(-)` → `2 files changed, +18 -4`. */
const compactStat = (s: string): string =>
  s.replace(/(\d+) insertions?\(\+\)/, "+$1").replace(/(\d+) deletions?\(-\)/, "-$1");

const clampPatch = (s: string): string => {
  if (Buffer.byteLength(s, "utf8") <= PATCH_CAP) return s;
  return `${s.slice(0, PATCH_HEAD)}\n… [diff truncated] …\n${s.slice(-(PATCH_CAP - PATCH_HEAD))}`;
};

const git = (cwd: string, args: string[]): { ok: boolean; out: string; err: string } => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
};
