/** Git runs in the session VM; the host only interprets its bounded output. */
import type { GitFacts } from "@loom/core/wire";
import type { RebaseOutcome } from "./worktrees.ts";
import type { HookAttempt } from "../../../../core/src/shell-hook.ts";

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export type GuestCommand = (
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
  env?: Record<string, string>,
) => Promise<HookAttempt>;
export interface CloneFacts {
  git: GitFacts;
  head: string;
  operation: string | null;
}
const pendingOperation = `
op=""
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  path=$(git rev-parse --git-path "$marker")
  if [ -e "$path" ]; then op="$marker"; break; fi
done
`;
export class CloneGit {
  private readonly run: GuestCommand;
  constructor(run: GuestCommand) {
    this.run = run;
  }
  async facts(base: string | null, signal: AbortSignal): Promise<CloneFacts> {
    const result = await this.run(
      `set -eu
head=$(git rev-parse HEAD)
branch=$(git symbolic-ref --quiet --short HEAD || true)
commits=$(git rev-list --count HEAD)
subject=$(git log -1 --format=%s)
status=$(git status --porcelain)
dirty=false
if [ -n "$status" ]; then dirty=true; fi
ahead=0
behind=0
base=${shellQuote(base ? "refs/remotes/origin/" + base : "")}
if [ -n "$base" ] && git rev-parse --verify --quiet "$base" >/dev/null; then
  ahead=$(git rev-list --count "$base..HEAD")
  behind=$(git rev-list --count "HEAD..$base")
fi
${pendingOperation}
printf '%s\\0' "$head" "$branch" "$commits" "$subject" "$dirty" "$ahead" "$behind" "$op"
`,
      15000,
      signal,
    );
    if (result.code !== 0 || result.timedOut)
      throw new Error("Could not read Git state inside the session VM");
    const [head, branch, commits, subject, dirty, ahead, behind, operation, end] =
      result.output.split("\0");
    if (
      !head ||
      !/^[a-f0-9]{40,64}$/.test(head) ||
      end !== "" ||
      ![commits, ahead, behind].every((v) => v !== undefined && /^\d+$/.test(v)) ||
      !["true", "false"].includes(dirty!)
    )
      throw new Error("Invalid guest Git state");
    return {
      head,
      operation: operation || null,
      git: {
        branch: branch || null,
        commits: Number(commits),
        lastCommitSubject: subject || null,
        dirty: dirty === "true",
        aheadOfBase: Number(ahead),
        behindBase: Number(behind),
      },
    };
  }
  async sync(
    branch: string,
    base: string | null,
    mode: "rebase" | "merge",
    signal: AbortSignal,
  ): Promise<RebaseOutcome> {
    if (!base) return { outcome: "no-base" };
    // The existing turn/lifecycle gates keep the agent idle throughout this command.
    // Only fetch the base; never reset the private branch to its published copy.
    const ref = "refs/remotes/origin/" + base;
    const result = await this.run(
      `set -eu
git fetch -q origin ${shellQuote("+refs/heads/" + base + ":" + ref)}
base=${shellQuote(ref)}
baseHead=$(git rev-parse --short "$base")
behind=$(git rev-list --count "HEAD..$base")
${pendingOperation}
status=$(git status --porcelain)
active=$(git symbolic-ref --quiet --short HEAD || true)
recorded=$(git config --local --get loom.sessionBranch || true)
outcome=current
head=""
if [ -n "$op" ]; then outcome=busy
elif [ -z "$active" ]; then outcome=busy; op=detached
elif [ "$active" != ${shellQuote(branch)} ] && [ "$active" != "$recorded" ]; then outcome=busy; op=branch
elif [ "$behind" -eq 0 ]; then outcome=current
elif [ -n "$status" ]; then outcome=dirty
elif [ "$behind" -gt 0 ]; then
  if git ${mode} ${mode === "merge" ? "--no-edit" : ""} "$base" >/dev/null 2>&1; then
    outcome=updated
    head=$(git rev-parse --short HEAD)
  else
    conflict=$(git diff --name-only --diff-filter=U)
    outcome=error
    if [ -n "$conflict" ]; then outcome=conflict; fi
    git ${mode} --abort >/dev/null 2>&1 || exit 1
  fi
fi
if [ "$outcome" = updated ] || [ "$outcome" = current ]; then
  git push -q origin ${shellQuote("+HEAD:refs/heads/" + branch)}
fi
printf '%s\\0' "$outcome" "$baseHead" "$behind" "$head" "$op"
`,
      90000,
      signal,
    );
    if (result.code !== 0 || result.timedOut)
      throw new Error(
        "Git sync or publication failed inside the VM; inspect its Git state before retrying",
      );
    const [outcome, baseHead, behind, head, op, end] = result.output.split("\0");
    if (end !== "" || !baseHead || !/^\d+$/.test(behind!))
      throw new Error("Invalid guest Git sync result");
    const info = { base, baseHead, behind: Number(behind) };
    if (outcome === "updated" && head) return { outcome, head, ...info };
    if (outcome === "busy" && op) return { outcome, op, ...info };
    if (
      outcome === "current" ||
      outcome === "dirty" ||
      outcome === "conflict" ||
      outcome === "error"
    )
      return { outcome, ...info };
    throw new Error("Invalid guest Git sync outcome");
  }
}
