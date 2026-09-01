/**
 * The running loom's version string, resolved once at module load.
 *
 * Precedence:
 *   1. `LOOM_BUILD_VER` — stamped by the build. The Nix derivation sets this
 *      via `wrapProgram --set` from the flake's `self.shortRev`, since the
 *      flake sandbox has no `.git` to describe.
 *   2. `git describe` against this file's own repo — the dev-checkout case,
 *      independent of the process's cwd (we resolve the toplevel from here,
 *      not from `process.cwd()`).
 *   3. `"unknown-version"` — running outside a build and outside a checkout.
 */
import { spawnSync } from "node:child_process";

const git = (cwd: string, args: string[]): string | null => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000 });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out === "" ? null : out;
};

const fromGit = (): string | null => {
  const root = git(import.meta.dirname, ["rev-parse", "--show-toplevel"]);
  if (root === null) return null;
  return git(root, ["describe", "--tags", "--always", "--dirty"]);
};

export const LOOM_VERSION: string = process.env.LOOM_BUILD_VER || fromGit() || "unknown-version";
