import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LoomClient } from "@loom/client";
import { findRepoRoot, loomPaths } from "@loom/core/paths";
import { ipcPermissions } from "@loom/core/network-permissions";
import { setLogLevel } from "@loom/core/logger";
import type { SessionSnapshot } from "@loom/core/wire";
import { Daemon } from "@loom/daemon/daemon/daemon";

setLogLevel("error");

test("bare repo and linked launches share sessions, base HEAD, config, and CLI routing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-bare-root-")));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  let daemon: Daemon | undefined;
  let client: LoomClient | undefined;
  try {
    const seed = join(root, "seed");
    git(root, "init", "-q", "-b", "main", seed);
    const commit = (cwd: string) =>
      git(
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "commit",
      );
    commit(seed);
    const bare = join(root, ".bare");
    git(root, "clone", "--bare", seed, bare);
    const base = git(bare, "rev-parse", "HEAD");
    const linked = join(root, "feature");
    git(bare, "worktree", "add", "-b", "feature", linked);
    commit(linked);
    assert.notEqual(git(linked, "rev-parse", "HEAD"), base);
    const nested = join(linked, "subdir");
    mkdirSync(nested);
    const configFile = join(root, "config.jsonc");
    writeFileSync(
      configFile,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(linked)},
      "base_branch": "missing-falls-back-to-head",
      "session": {
        "worktree": {
          "enabled": false
        }
      }
    }
  ],
  "session": {
    "titles": {
      "enabled": false
    }
  }
}`,
    );
    const paths = loomPaths(bare);
    const start = (repoRoot: string) =>
      Daemon.start({
        repoRoot,
        configFile,
        standalone: true,
        connectors: { "@loom/connector-mock": () => import("@loom/connector-mock") },
      });
    // Direct daemon options, like --repo, may name a linked worktree subdirectory.
    daemon = await start(nested);
    assert.equal(daemon.repoRoot, bare);
    assert.deepEqual(daemon.paths, paths);
    assert.equal(daemon.config.worktree.enabled, false);
    client = await LoomClient.connect({ repoRoot: bare, sockPath: paths.sock, autospawn: false });
    for (const worktree of [undefined, false]) {
      await assert.rejects(
        client.request("session.create", {
          prompt: "in place",
          provider: "fake",
          ...(worktree === undefined ? {} : { worktree }),
        }),
        /Bare repositories require worktrees/,
      );
    }
    assert.deepEqual(await client.request("session.list"), []);
    const session = await client.request<SessionSnapshot>("session.create", {
      prompt: "shared bare session",
      provider: "fake",
      worktree: true,
    });
    assert.ok(session.worktree?.startsWith(paths.trees + "/"));
    assert.equal(git(session.worktree!, "rev-parse", "HEAD"), base);
    assert.equal(findRepoRoot(session.worktree!), bare);
    assert.equal(existsSync(join(linked, ".loom")), false);

    // Exercise the real CLI with both cwd discovery and an explicit --repo.
    const entry = fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url));
    const denoConfig = fileURLToPath(new URL("../deno.json", import.meta.url));
    for (const explicit of [false, true]) {
      const output = await new Deno.Command(Deno.execPath(), {
        cwd: explicit ? root : nested,
        args: [
          "run",
          "--config",
          denoConfig,
          ...ipcPermissions(paths.sock),
          entry,
          "ls",
          "--json",
          ...(explicit ? ["--repo", nested] : []),
        ],
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(20_000),
      }).output();
      assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
      const rows = JSON.parse(new TextDecoder().decode(output.stdout)) as SessionSnapshot[];
      assert.ok(rows.some((row) => row.id === session.id));
    }
    await client.close();
    client = undefined;
    await daemon.stop("restart-from-bare");
    daemon = await start(bare);
    client = await LoomClient.connect({ repoRoot: bare, sockPath: paths.sock, autospawn: false });
    assert.equal(
      (await client.request<SessionSnapshot>("session.get", { id: session.id })).id,
      session.id,
    );
    assert.equal(daemon.config.worktree.enabled, false);
  } finally {
    await client?.close();
    await daemon?.stop("test-cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
