import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { LoomPaths } from "../../core/src/paths.ts";
import { sessionCloneRoot } from "../../backend/daemon/src/daemon/session-vm-state.ts";
import { repoBaseDirectory } from "../../runtime/src/session-vm/repo-base.ts";

/**
 * Every per-user directory a daemon or a test makes for one repository: socket,
 * state, package cache, session trees, session VMs and prepared environments.
 * Deleting the repository leaves them all behind.
 */
export const loomDirectories = (paths: LoomPaths): string[] => [
  paths.runtime,
  paths.state,
  dirname(paths.packageCache),
  paths.trees,
  sessionCloneRoot(paths.repoRoot),
  repoBaseDirectory(paths.repoRoot),
];

export const removeLoomDirectories = (paths: LoomPaths): void => {
  for (const dir of loomDirectories(paths)) rmSync(dir, { recursive: true, force: true });
};
