import assert from "node:assert/strict";
import { join } from "node:path";
export const gitFixture = async function () {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-git-test-" }),
  );
  const repo = join(root, "repo");
  const workspace = join(root, "worktree");
  const state = join(root, "state");
  await Deno.mkdir(state);
  const found = (Deno.env.get("PATH") ?? "").split(":").map((p) => join(p, "git"));
  let executable = "";
  for (const path of found) {
    try {
      if ((await Deno.stat(path)).isFile) {
        executable = await Deno.realPath(path);
        break;
      }
    } catch {
      /* next */
    }
  }
  assert.ok(executable, "Git must be on PATH");
  const git = async (...args: string[]) => {
    const result = await new Deno.Command(executable, {
      args,
      clearEnv: true,
      env: {
        HOME: root,
        PATH: Deno.env.get("PATH") ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Bridge test",
        GIT_AUTHOR_EMAIL: "bridge@example.invalid",
        GIT_COMMITTER_NAME: "Bridge test",
        GIT_COMMITTER_EMAIL: "bridge@example.invalid",
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
  const gitDir = await git("-C", workspace, "rev-parse", "--absolute-git-dir");
  const commonDir = join(repo, ".git");
  return {
    root,
    repo,
    workspace,
    state,
    gitDir,
    commonDir,
    git,
    executable,
    options: { workspace, gitDir, commonDir, state, git: executable },
    close: () => Deno.remove(root, { recursive: true }),
  };
};

export const bridgeRequest = async function (socket: string, request: unknown) {
  const conn = await Deno.connect({ transport: "unix", path: socket });
  const timer = setTimeout(() => {
    try {
      conn.close();
    } catch {
      /* closed */
    }
  }, 10_000);
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(request) + "\n");
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
    let text = "";
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(4096);
    for (;;) {
      const n = await conn.read(buffer);
      if (n === null) throw new Error("Disconnected before reply");
      text += decoder.decode(buffer.subarray(0, n), { stream: true });
      if (text.length > 512 * 1024) throw new Error("Oversized reply");
      if (text.includes("\n")) return JSON.parse(text.slice(0, text.indexOf("\n")));
    }
  } finally {
    clearTimeout(timer);
    conn.close();
  }
};
