import { cpus, freemem, totalmem, loadavg } from "node:os";
import process from "node:process";
import { shellQuote } from "./clone-git.ts";

/** Includes committed session work plus staged/unstaged changes; untracked names are listed separately. */
export const changesCommand = (base: string | null, patch: boolean): string => `
set -eu
export GIT_OPTIONAL_LOCKS=0
printf 'Working tree status (index / worktree)\\n'
git -c core.quotePath=true status --short
printf '\\n'
base=${shellQuote(base ?? "")}
if [ -n "$base" ] && start=$(git merge-base HEAD "$base" 2>/dev/null); then
  printf 'Tracked changes since branching from %s\\n' "$base"
elif start=$(git rev-parse --verify HEAD 2>/dev/null); then
  printf 'Uncommitted tracked changes against HEAD\\n'
else
  start=$(git hash-object -t tree /dev/null)
  printf 'Tracked changes in initial checkout\\n'
fi
git --no-pager diff --no-ext-diff --no-textconv --no-color ${patch ? "--patch" : "--stat"} "$start" --
printf '\\nUntracked files are listed above; their contents are not included.\\n'
`;

/** Host counters are deliberately labelled: they are not session or guest usage. */
export const hostMonitorText = (): string => {
  const mib = (bytes: number) => (bytes / 1048576).toFixed(0) + " MiB";
  const cpu = cpus();
  return [
    "DAEMON HOST · all sessions and other applications",
    `CPU cores     ${cpu.length}`,
    `Load average  ${loadavg()
      .map((n) => n.toFixed(2))
      .join(" / ")} (1 / 5 / 15 min)`,
    `RAM used      ${mib(totalmem() - freemem())} / ${mib(totalmem())}`,
    "",
    `LOOM DAEMON · PID ${process.pid}`,
    `Resident RAM  ${mib(process.memoryUsage().rss)}`,
    `Uptime        ${Math.floor(process.uptime())}s`,
    "",
    "CPU/RAM above describe the host, not this session's VM.",
  ].join("\n");
};
