import { join } from "node:path";

/**
 * Keep host paths intact so linked worktrees and Git's admin pointers work. A linked
 * worktree needs only its own tree and the Git common directory, never the main
 * checkout's files: smolvm watches every mount recursively with inotify, so a
 * checkout's node_modules alone can exhaust the user's watch limit.
 */
export const workspaceMounts = async (workspace: string): Promise<string[]> => {
  const cwd = await Deno.realPath(workspace);
  const paths = [cwd];
  const result = await new Deno.Command("git", {
    args: ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.success) {
    const [root, common] = new TextDecoder().decode(result.stdout).trim().split("\n");
    if (!root || !common) throw new Error("Cannot resolve repository mount paths");
    paths.push(await Deno.realPath(root));
    paths.push(await Deno.realPath(common));
  } else {
    // Ordinary non-Git workspaces remain usable, but never hide a broken Git layout.
    try {
      await Deno.lstat(join(cwd, ".git"));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [...new Set(paths)];
      throw error;
    }
    throw new Error(
      "Cannot resolve workspace Git metadata: " + new TextDecoder().decode(result.stderr).trim(),
    );
  }
  return [...new Set(paths)].filter(
    (path, _, all) => !all.some((parent) => parent !== path && path.startsWith(parent + "/")),
  );
};

/**
 * Hook directories Git runs from outside `mounts`: Loom's per-worktree hooks, and the
 * repository or global `core.hooksPath` its wrappers delegate to. Mounted read-only,
 * so the guest runs them but cannot plant a hook for host Git.
 */
export const gitHookMounts = async (workspace: string, mounts: string[]): Promise<string[]> => {
  const git = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args: ["-C", workspace, ...args],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return result.success ? new TextDecoder().decode(result.stdout).trim() : "";
  };
  const candidates = [await git("rev-parse", "--path-format=absolute", "--git-path", "hooks")];
  // Unset exits 1. A relative value resolves inside the worktree, which is mounted.
  const delegated = (
    await git("config", "--type=path", "--show-scope", "--get-all", "core.hooksPath")
  )
    .split("\n")
    .filter((line) => line && !line.startsWith("worktree\t"))
    .at(-1)
    ?.split("\t")[1];
  if (delegated?.startsWith("/")) candidates.push(delegated);
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const path = await Deno.realPath(candidate);
      if (!(await Deno.stat(path)).isDirectory) continue;
      if (mounts.some((mount) => path === mount || path.startsWith(mount + "/"))) continue;
      if (!paths.includes(path)) paths.push(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return paths;
};
