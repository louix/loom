/**
 * Global options for Git that only reads a worktree someone else may be writing.
 *
 * By default `git status` holds `index.lock` while it refreshes stat info, and
 * `git diff` takes it to write that refresh back; a concurrent `git add` or
 * `git commit` in the same worktree then fails with "index.lock: File exists".
 * `--no-optional-locks` stops status; `git diff` ignores it (still true in Git
 * 2.55) and only stops with `diff.autoRefreshIndex=false`. Without the refresh,
 * patch/stat/numstat/quiet output is unchanged, but `--name-only`/`--name-status`/
 * `--raw` also list stat-only changes unless filtered (e.g. `--diff-filter=U`).
 *
 * Never for writes: a writer must take the lock and fail loudly when it can't.
 */
export const READ_ONLY_GIT_OPTIONS = [
  "--no-optional-locks",
  "-c",
  "diff.autoRefreshIndex=false",
] as const;

/** {@link READ_ONLY_GIT_OPTIONS} as a shell command prefix. */
export const READ_ONLY_GIT_SH = ["git", ...READ_ONLY_GIT_OPTIONS].join(" ");
