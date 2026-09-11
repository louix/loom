import { dirname, join } from "node:path";

/** Keep host paths intact so linked worktrees and Git's admin pointers work. */
export const workspaceMounts = async (workspace: string, repoRoot?: string): Promise<string[]> => {
  const cwd = await Deno.realPath(workspace);
  const paths = [cwd];
  if (repoRoot) paths.push(await Deno.realPath(repoRoot));
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
    const metadata = await Deno.realPath(common);
    paths.push(metadata.endsWith("/.git") ? dirname(metadata) : metadata);
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
