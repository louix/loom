import { loomInstructions } from "@loom/core/paths";
import { AISDK_SYSTEM, toolSteer } from "@loom/runtime/instructions";

/**
 * The system-prompt append for a new (or resumed) session: the standalone
 * base prompt for aisdk sessions (no vendor preset to append to) followed by
 * the tool steer — assuming every loom tool (`ask_user`/`commit`/`status`) is
 * mounted, which holds for both Claude and aisdk's `loomServer: true` sessions
 * — then the repo's `.loom/LOOM.md` instructions when present. The file is
 * read from the session's `cwd` first (a committed LOOM.md rides inside the
 * worktree), falling back to the daemon's repoRoot checkout: new worktrees
 * branch from base, so a freshly written file isn't in them yet.
 */
export const systemPromptAppendFor = (
  aisdk: boolean,
  withMcp: boolean,
  cwd: string,
  repoRoot: string,
): string =>
  [
    ...(aisdk ? [AISDK_SYSTEM] : []),
    ...(aisdk && !withMcp ? [] : [toolSteer(cwd, { askUser: true, commit: true, status: true })]),
    loomInstructions(cwd) ?? loomInstructions(repoRoot),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n\n");
