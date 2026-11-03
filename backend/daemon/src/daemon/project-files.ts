import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { projectDirectory, type ProjectDirectoryConfig } from "@loom/core/paths";

/** Resolve on the host; sessions mount/grant only this repository's directory. */
export const ensureProjectDirectory = (
  repo: string,
  configured: ProjectDirectoryConfig = {},
): string => {
  const path = projectDirectory(repo, configured);
  if (path === repo || path.startsWith(repo + "/") || repo.startsWith(path + "/"))
    throw new Error("Project files must be outside the repository checkout");
  // Check before mkdir: a configured ancestor symlink must not create files in a checkout.
  let ancestor = path;
  for (;;) {
    try {
      if (realpathSync(ancestor) !== ancestor)
        throw new Error("Project files directory must not contain symlinks: " + path);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      ancestor = dirname(ancestor);
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const real = realpathSync(path);
  if (real !== path) throw new Error("Project files directory must not contain symlinks: " + path);
  return real;
};

export const projectFilesInstructions = (path: string, instructions = ""): string =>
  [
    "Project files: " +
      path +
      " (LOOM_PROJECT_DIR). Use this persistent shared directory for investigations, reports and reusable scripts; Markdown is suggested, any format is welcome. Read relevant files on demand. All sessions of this repository, including private clones, see live edits. There is no Git undo or branch isolation here. Concurrent agents should use distinct investigation directories. Reports should record the tested commit and reproduction steps. Run scripts from the current session workspace/environment; external scripts may need explicit dependency paths or runtime configuration.",
    "Notes under archive/ are historical and excluded from normal context: skip that directory when browsing or searching project files unless historical context is relevant. You may explicitly read archived notes when needed. Archive clearly superseded or resolved notes there, preserving relative paths and updating affected Markdown links; do not archive solely because of age. Active Markdown notes live outside archive/.",
    instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
