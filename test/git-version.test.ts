// test-run: own-process — prepends a git that reports another version to PATH.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import { writeExecutableSync } from "../scripts/lib/executable-fixture.ts";

setLogLevel("error");

/** Run `fn` with a `git` on PATH that reports `version` and otherwise is the real one. */
const withGitVersion = (version: string, fn: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "loom-git-version-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const path = Deno.env.get("PATH") ?? "";
  try {
    execFileSync("git", ["init", "-q", "-b", "main", join(root, "repo")]);
    execFileSync("git", [
      "-C",
      join(root, "repo"),
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const bin = join(root, "bin");
    execFileSync("mkdir", [bin]);
    writeExecutableSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = version ] && { echo "git version ${version}"; exit 0; }; done\nexec "${real}" "$@"\n`,
      0o755,
    );
    Deno.env.set("PATH", `${bin}:${path}`);
    fn(join(root, "repo"));
  } finally {
    Deno.env.set("PATH", path);
    rmSync(root, { recursive: true, force: true });
  }
};

const mgr = (repo: string): WorktreeManager =>
  new WorktreeManager({
    repoRoot: repo,
    treesDir: join(repo, ".loom", "trees"),
    hooksDir: join(repo, ".loom", "hooks"),
    baseBranch: "main",
    log: makeLogger("test"),
  });

test("a Git older than 2.33 is refused by name before any worktree is made", () => {
  withGitVersion("2.32.7 (Apple Git-136)", (repo) => {
    assert.throws(
      () => mgr(repo).create("aaaaaaaa-1111", { branchPrefix: ["loom"] }),
      /Loom needs Git 2\.33 or later for its session worktrees; found "git version 2\.32\.7/,
    );
  });
});

test("Git 2.33 makes locked session worktrees", () => {
  withGitVersion("2.33.0", (repo) => {
    const wt = mgr(repo).create("aaaaaaaa-1111", { branchPrefix: ["loom"] });
    assert.match(
      execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
      new RegExp(`worktree ${Deno.realPathSync(wt.path)}\\n[^]*locked loom session aaaaaaaa-1111`),
    );
  });
});

test("a clone session's branch needs no Git 2.33", () => {
  withGitVersion("2.32.7", (repo) => {
    const made = mgr(repo).createBranch("aaaaaaaa-1111", { branchPrefix: ["loom"] });
    assert.equal(made.branch, "loom/aaaaaaaa");
  });
});

test("relink on a Git older than 2.33 refuses instead of throwing", () => {
  withGitVersion("2.33.0", (repo) => {
    const wt = mgr(repo).create("aaaaaaaa-1111", { branchPrefix: ["loom"] });
    const admin = execFileSync(
      "git",
      ["-C", wt.path, "rev-parse", "--path-format=absolute", "--git-dir"],
      { encoding: "utf8" },
    ).trim();
    rmSync(admin, { recursive: true });
    const bin = join(dirname(repo), "bin", "git");
    writeExecutableSync(
      bin,
      Deno.readTextFileSync(bin).replace("git version 2.33.0", "git version 2.32.7"),
      0o755,
    );

    const result = mgr(repo).relink("aaaaaaaa-1111", wt.path, wt.branch);

    assert.equal(result.kind, "refused");
    assert.match(result.kind === "refused" ? result.reason : "", /needs Git 2\.33/);
    assert.ok(!existsSync(admin));
  });
});
