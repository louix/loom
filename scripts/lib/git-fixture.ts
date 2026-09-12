import assert from "node:assert/strict";
import { join } from "node:path";
export const gitFixture = async function () {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-git-test-" }),
  );
  const repo = join(root, "repo");
  const workspace = join(root, "worktree");
  const git = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      clearEnv: true,
      env: {
        HOME: root,
        PATH: Deno.env.get("PATH") ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Loom test",
        GIT_AUTHOR_EMAIL: "loom@example.invalid",
        GIT_COMMITTER_NAME: "Loom test",
        GIT_COMMITTER_EMAIL: "loom@example.invalid",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.ok(result.success, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  await git("init", "--initial-branch=main", repo);
  await Deno.writeTextFile(join(repo, "file.txt"), "base\n");
  await git("-C", repo, "add", "file.txt");
  await git("-C", repo, "commit", "-m", "base commit");
  await git("-C", repo, "worktree", "add", "-b", "session", workspace);
  const commonDir = join(repo, ".git");
  return {
    root,
    repo,
    workspace,
    commonDir,
    git,
    close: () => Deno.remove(root, { recursive: true }),
  };
};
