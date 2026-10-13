import { canonicalHostPath } from "../../../../core/src/host-path.ts";
/**
 * Per-session git worktrees (design spec §6). On session create we branch a
 * fresh worktree off the configured base; each tree gets a pre-push hook that
 * hard-blocks pushing. Commit identity comes from the session's environment
 * (see `config/git-identity.ts`), never from tree config. Loom never runs a
 * remote operation itself. `gc` removes trees for sessions the user has marked
 * done; branches are never auto-deleted.
 */
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { READ_ONLY_GIT_OPTIONS } from "@loom/core/git-read";
import type { Logger } from "@loom/core/logger";
import type { GitFacts } from "@loom/core/wire";
import { type BranchPrefix, sessionBranch } from "./session-branch.ts";

/**
 * The former session identity, `Loom (<model>) <loom+<model>@localhost>`. Now
 * only a private clone's config default for values Git could not resolve on
 * the host; the session environment's identity always outranks it.
 */
export const commitIdentity = (model: string): { name: string; email: string } => {
  if (!model) return { name: "Loom", email: "loom@localhost" };
  return {
    name: `Loom (${model})`,
    // Not every model id is email-safe (`openai/gpt-5`, `claude:work`) —
    // flatten the address, keep the name verbatim.
    email: `loom+${model.replace(/[^a-zA-Z0-9._+-]/g, "-")}@localhost`,
  };
};
const FACTS_TTL_MS = 3000;
/** `git status --porcelain` / `worktree list --porcelain` in a very large tree
 *  can exceed the 1 MB `spawnSync` default → `ENOBUFS` → `status: null`. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Every session tree is locked with a reason starting with this. `git worktree
 * prune` (and `gc`) skip a locked tree: a prune run where the tree is not
 * visible — a session VM mounts only its own tree, beside the whole `.git` —
 * would otherwise delete its admin directory and leave it no repository.
 */
const LOCK_REASON = "loom session";
const lockReason = (id: string): string => `${LOCK_REASON} ${id}`;

const PRE_PUSH_HOOK = `#!/bin/sh
# Installed by Loom. Sessions must never push — integrate in your own git.
echo "loom: push is blocked in session worktrees" >&2
exit 1
`;

/** Loom overrides `core.hooksPath` per worktree to install its push block, which
 *  also shadows the repo's own `pre-commit` / `commit-msg` / … . These wrappers
 *  chain through to the repo's real hooks dir so formatting / message checks
 *  still run on agent commits. `$0`'s basename is the hook being invoked. */
const CHAINED_HOOKS = ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"] as const;
const chainHookScript = (origHooksDir: string): string =>
  `#!/bin/sh\n` +
  `# Installed by Loom — delegates to the repo's own hook.\n` +
  `h="${origHooksDir}/$(basename "$0")"\n` +
  `[ -x "$h" ] && exec "$h" "$@"\n` +
  `exit 0\n`;

/** An entry of `git worktree list`. `locked`: the lock's reason, "" when it
 *  gives none; null when unlocked. */
interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  locked: string | null;
}

export interface WorktreeInfo {
  slug: string;
  path: string;
  branch: string;
  baseRef: string;
}

/** Result of {@link WorktreeManager.syncOntoBase}. `base` / `baseHead` / `behind`
 *  are absent only on `no-base`, where there's no base ref to describe. */
interface BaseInfo {
  /** Base branch name. */
  base: string;
  /** Base branch's short SHA — a caller can key repeat-nudge suppression on it. */
  baseHead: string;
  /** How many base commits the branch was missing. */
  behind: number;
}
export type RebaseOutcome =
  | { outcome: "no-base" }
  | ({ outcome: "current" | "dirty" | "conflict" | "error" } & BaseInfo)
  | ({ outcome: "busy"; op: string } & BaseInfo)
  | ({ outcome: "updated"; head: string } & BaseInfo);

export interface WorktreeManagerOptions {
  repoRoot: string;
  /** Absolute directory that holds the trees (`$XDG_DATA_HOME/loom/worktrees/<repo-key>`). */
  treesDir: string;
  /** Absolute directory for the shared, worktree-scoped hooks. */
  hooksDir: string;
  /** Configured base branch (`config.baseBranch`). */
  baseBranch: string;
  /**
   * Root of this repository's session clones. Host Git never runs inside it: a
   * clone's config and hooks are agent-written.
   */
  cloneRoot?: string;
  log: Logger;
}

interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** `spawnSync` error message (`ETIMEDOUT`, `ENOBUFS`, `ENOENT`), or "". */
  error: string;
}

export class WorktreeManager {
  readonly #repoRoot: string;
  readonly #treesDir: string;
  readonly #hooksDir: string;
  readonly #baseBranch: string;
  readonly #cloneRoot: string | null;
  readonly #log: Logger;
  #setupDone = false;
  #factsCache = new Map<string, { at: number; facts: GitFacts }>();
  #factsPending = new Map<string, Promise<GitFacts | null>>();

  constructor(opts: WorktreeManagerOptions) {
    this.#repoRoot = canonicalHostPath(opts.repoRoot);
    this.#treesDir = canonicalHostPath(opts.treesDir);
    this.#hooksDir = canonicalHostPath(opts.hooksDir);
    this.#baseBranch = opts.baseBranch;
    this.#cloneRoot = opts.cloneRoot ? canonicalHostPath(opts.cloneRoot) : null;
    this.#log = opts.log;
  }

  /** True for a session clone. Callers ask the guest, or read host refs, instead. */
  isClone(path: string | null | undefined): boolean {
    if (!path || !this.#cloneRoot) return false;
    const p = canonicalHostPath(path);
    return p === this.#cloneRoot || p.startsWith(this.#cloneRoot + "/");
  }

  /** Backstop behind every Git spawn here, so a missed call site fails instead of running. */
  #hostOnly(path: string): string {
    if (this.isClone(path)) throw new Error("Host Git must not open a session clone");
    return path;
  }

  // --- setup ----------------------------------------------------------

  /** Idempotent one-time repo prep: worktree-scoped config + the push hook. */
  ensureSetup(): void {
    if (this.#setupDone) return;
    // These settings apply only to the main worktree until worktreeConfig is
    // enabled. Afterwards Git would inherit them in every linked worktree.
    // Address the common directory explicitly: setup may itself run in a link.
    const common = this.#git(["rev-parse", "--git-common-dir"]);
    if (!common.ok) throw new Error(`git common directory failed: ${common.stderr.trim()}`);
    const commonDir = resolve(this.#repoRoot, common.stdout.trim());
    const sharedConfig = join(commonDir, "config");
    const mainConfig = join(commonDir, "config.worktree");
    const alreadyEnabled =
      this.#gitRead(["config", "--bool", "extensions.worktreeConfig"]) === "true";
    const checked = (args: string[]): void => {
      const result = this.#git(args);
      if (!result.ok)
        throw new Error(`git config migration failed: ${result.stderr.trim() || result.error}`);
    };
    const migrate: string[] = [];
    for (const key of ["core.bare", "core.worktree"]) {
      const value = this.#git(["config", "--file", sharedConfig, "--get", key]);
      if (value.code === 1) continue;
      if (!value.ok) throw new Error(`git config ${key} failed: ${value.stderr.trim()}`);
      if (
        key === "core.bare" &&
        this.#gitRead(["config", "--file", sharedConfig, "--bool", "core.bare"]) === "false"
      )
        continue;
      // Write the main-worktree copy before enabling the extension or removing
      // the shared value, so failed setup can be retried without losing it.
      const existing = this.#git(["config", "--file", mainConfig, "--get", key]);
      if (!existing.ok && existing.code !== 1)
        throw new Error(`git config ${key} failed: ${existing.stderr.trim()}`);
      if (!alreadyEnabled || !existing.ok)
        checked(["config", "--file", mainConfig, "--replace-all", key, value.stdout.trimEnd()]);
      migrate.push(key);
    }
    // Per-worktree `git config --worktree` requires this extension. If it can't
    // be set, every later `--worktree` write silently lands in the *shared* repo
    // config instead — the last session created would repoint the main repo's
    // commit identity and hooks path. Refuse to proceed.
    const ext = this.#git(["config", "extensions.worktreeConfig", "true"]);
    if (!ext.ok) {
      throw new Error(
        `git config extensions.worktreeConfig failed: ${ext.stderr.trim() || ext.stdout.trim()}`,
      );
    }
    for (const key of migrate) checked(["config", "--file", sharedConfig, "--unset-all", key]);
    mkdirSync(this.#treesDir, { recursive: true });
    mkdirSync(this.#hooksDir, { recursive: true });
    const hook = join(this.#hooksDir, "pre-push");
    if (!existsSync(hook)) {
      writeFileSync(hook, PRE_PUSH_HOOK);
      chmodSync(hook, 0o755);
    }

    // G12: `core.hooksPath` per worktree shadows the repo's own hooks. Resolve
    // where they really live and drop delegating wrappers so `pre-commit` etc.
    // still fire. Skip if the repo already points its hooks at us (no self-loop).
    const abs = (p: string): string => {
      if (!p) return "";
      return p.startsWith("/") ? p : join(this.#repoRoot, p);
    };
    const isDir = (p: string): boolean => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    // A `core.hooksPath` that isn't a real directory can't be holding the repo's
    // hooks: `/dev/null` (the idiom for "disable all hooks", common in sandboxes
    // and CI), a stale path, or unset. Fall back to the git common dir so the
    // delegating wrappers still chain to `<repo>/.git/hooks`.
    const custom = abs(this.#gitRead(["config", "--get", "core.hooksPath"]));
    const customDir = custom && isDir(custom) ? custom : "";
    const origHooksDir = customDir || join(commonDir, "hooks");
    if (origHooksDir !== this.#hooksDir) {
      const script = chainHookScript(origHooksDir);
      for (const name of CHAINED_HOOKS) {
        const p = join(this.#hooksDir, name);
        if (!existsSync(p)) {
          writeFileSync(p, script);
          chmodSync(p, 0o755);
        }
      }
    }
    this.#setupDone = true;
  }

  /**
   * Point every linked worktree whose `core.hooksPath` is `from` at this
   * manager's hooks, after the hooks directory moved. Call {@link ensureSetup}
   * first: a hooks path naming a missing directory runs no hooks, so the push
   * block would lapse. Returns the worktrees that could not be repointed.
   */
  repointHooks(from: string): string[] {
    const old = canonicalHostPath(from);
    const list = this.#git(["worktree", "list", "--porcelain"], undefined, { readOnly: true });
    if (!list.ok) return [this.#repoRoot];
    const failed: string[] = [];
    for (const line of list.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      if (!existsSync(path) || this.isClone(path)) continue;
      const current = this.#git(["config", "--worktree", "--get", "core.hooksPath"], path);
      if (!current.ok || canonicalHostPath(current.stdout.trim()) !== old) continue;
      const set = this.#git(["config", "--worktree", "core.hooksPath", this.#hooksDir], path);
      if (!set.ok) failed.push(path);
      else this.#log.info("worktree hooks repointed", { path, hooks: this.#hooksDir });
    }
    return failed;
  }

  // --- lifecycle ----------------------------------------------------

  /** Whether the manager's repository has no checkout for in-place sessions. */
  isBareRepository(): boolean {
    return this.#gitRead(["rev-parse", "--is-bare-repository"]) === "true";
  }

  /**
   * `git worktree add <trees>/<shortId> -b <prefix>/<shortId> <base>`, then pin the
   * hooks path for that tree. `opts.baseRef` branches off something other than
   * the configured base (a parent session's branch, for a hard fork). Commit
   * identity is not pinned: sessions receive it in their environment, and the
   * user's own commits in the tree keep their ordinary Git identity. `id` is
   * the session's own id — both the directory and the branch are named after it
   * (truncated to the fleet view's short id) so a tree is traceable back to the
   * session.
   */
  create(id: string, opts: { branchPrefix: BranchPrefix; baseRef?: string }): WorktreeInfo {
    this.ensureSetup();
    let baseRef: string;
    const baseRefOverride = opts.baseRef;
    if (baseRefOverride != null && baseRefOverride !== "") {
      // A fork asks for a specific base (the parent's branch). If that ref no
      // longer resolves, silently branching off the configured base would give
      // the fork a tree unrelated to the transcript it inherits — fail instead.
      if (!this.#git(["rev-parse", "--verify", "--quiet", baseRefOverride]).ok) {
        throw new Error(`base ref "${baseRefOverride}" does not resolve`);
      }
      baseRef = baseRefOverride;
    } else {
      baseRef = this.#resolveBase();
    }
    const slug = this.#uniqueDir(id);
    const path = join(this.#treesDir, slug);
    const branch = this.#uniqueBranch(opts.branchPrefix, id);

    const add = this.#git([
      "worktree",
      "add",
      "--lock",
      "--reason",
      lockReason(id),
      path,
      "-b",
      branch,
      baseRef,
    ]);
    if (!add.ok) {
      // A partial checkout (disk full mid-`add`) leaves the dir behind — reclaim
      // it so the next attempt / `gc` isn't blocked by a stale entry.
      this.prune();
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    // The "sessions never push" guarantee. A failure here is fatal: a worktree
    // with no `core.hooksPath` has no push-block hook. Tear the tree down
    // rather than run it unsafe.
    const res = this.#git(["config", "--worktree", "core.hooksPath", this.#hooksDir], path);
    if (!res.ok) {
      try {
        this.remove(path, { force: true });
        this.deleteBranch(branch);
      } catch {
        this.prune(); // best-effort cleanup
      }
      throw new Error(
        `worktree config --worktree core.hooksPath failed: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }

    this.#log.info("worktree created", { slug, branch, baseRef, path });
    return { slug, path, branch, baseRef };
  }

  /**
   * `git worktree add <trees>/<shortId> <branch>` — check an *existing* branch
   * back out into a fresh tree, then re-pin the hooks the same way
   * {@link create} does. Used when an archived (`done`) session is messaged
   * again: its worktree was removed but the branch was kept, so the session
   * resumes on a new tree carved from that branch. `id` names the directory
   * (the session's short id). Throws if the branch no longer resolves (deleted
   * in the user's own git).
   */
  reattach(id: string, branch: string): WorktreeInfo {
    this.ensureSetup();
    if (!this.#git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
      throw new Error(`branch "${branch}" no longer exists`);
    }
    // A stale `worktree list` entry for a dir we already removed would make the
    // `add` fail with "already checked out" — clear it first.
    this.prune();
    const slug = this.#uniqueDir(id);
    const path = join(this.#treesDir, slug);

    const add = this.#git(["worktree", "add", "--lock", "--reason", lockReason(id), path, branch]);
    if (!add.ok) {
      this.prune();
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    // Same "never push" guarantee as `create` — and just as fatal if it can't
    // be established.
    const res = this.#git(["config", "--worktree", "core.hooksPath", this.#hooksDir], path);
    if (!res.ok) {
      try {
        this.remove(path, { force: true });
      } catch {
        this.prune(); // best-effort cleanup
      }
      throw new Error(
        `worktree config --worktree core.hooksPath failed: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }

    this.#log.info("worktree reattached", { slug, branch, path });
    return { slug, path, branch, baseRef: this.#baseBranch };
  }

  /**
   * Drop the `Loom (<model>)` identity older versions pinned in a session
   * tree's own config, so the user's commits there use their ordinary
   * identity. Only values of {@link commitIdentity}'s shape are removed; the
   * session's environment outranks them either way. Best-effort.
   */
  clearLegacyIdentity(path: string): void {
    // The main worktree's `--worktree` config is the user's own; only linked trees qualify.
    const dirs = this.#gitRead(
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      path,
    );
    const [gitDir, commonDir] = dirs.split("\n");
    if (!gitDir || !commonDir || gitDir === commonDir) return;
    for (const [key, legacy] of [
      ["user.name", /^Loom( \(.*\))?$/],
      ["user.email", /^loom(\+.*)?@localhost$/],
    ] as const) {
      const value = this.#git(["config", "--worktree", "--get", key], path);
      if (!value.ok || !legacy.test(value.stdout.trim())) continue;
      const res = this.#git(["config", "--worktree", "--unset-all", key], path);
      if (!res.ok)
        this.#log.warn(
          `worktree config --worktree --unset-all ${key} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        );
    }
  }

  /**
   * Rebrand a session's still-generic `<prefix>/<shortId>` branch from its freshly
   * generated title — `git branch -m` to `<prefix>/<slug>` (git updates the linked
   * worktree's HEAD). The worktree *directory* is left as-is: the running
   * session holds it as its cwd, and the dir name is cosmetic. Returns the new
   * branch, or `currentBranch` unchanged on a no-op / failure.
   */
  renameBranch(hint: string, currentBranch: string, branchPrefix: BranchPrefix): string {
    const branch = this.#uniqueBranchNamed(branchPrefix, slugify(hint), currentBranch);
    if (branch === currentBranch) return currentBranch;

    const res = this.#git(["branch", "-m", currentBranch, branch]);
    if (!res.ok) {
      this.#log.warn("branch rename failed", {
        from: currentBranch,
        to: branch,
        error: res.stderr.trim() || res.stdout.trim(),
      });
      return currentBranch;
    }

    // Facts are keyed by worktree path (unchanged) but carry the old branch
    // name; the cache is tiny and rebuilds on the next snapshot.
    this.#factsCache.clear();
    this.#factsPending.clear();
    this.#log.info("session branch renamed", { from: currentBranch, to: branch });
    return branch;
  }

  /** `git worktree remove` — used by gc for sessions marked done. */
  remove(path: string, opts: { force?: boolean } = {}): void {
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(this.#hostOnly(path));
    const relock = this.#unlockOwn(path);
    const res = this.#git(args);
    this.invalidateFacts(path);
    if (!res.ok) {
      relock();
      throw new Error(`git worktree remove failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    this.#log.info("worktree removed", { path });
  }

  /** Keep the daemon responsive while Git deletes a potentially large tree. */
  async removeAsync(path: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["-C", this.#repoRoot, "worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(this.#hostOnly(path));
    const relock = this.#unlockOwn(path);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "git",
          args,
          { timeout: 15_000, maxBuffer: GIT_MAX_BUFFER },
          (error, stdout, stderr) => {
            if (error) {
              relock();
              reject(
                new Error(
                  `git worktree remove failed: ${stderr.trim() || stdout.trim() || error.message}`,
                ),
              );
            } else resolve();
          },
        );
      });
      this.#log.info("worktree removed", { path });
    } finally {
      this.invalidateFacts(path);
    }
  }

  /**
   * `git worktree prune`: drop the entries of trees whose directory is gone.
   * The host's view is the true one, so a session tree missing here is
   * unlocked first; a lock that is not Loom's is the user's to lift. Returns
   * whether the prune ran.
   */
  prune(): boolean {
    for (const w of this.list())
      if (w.locked?.startsWith(LOCK_REASON) && !existsSync(w.path))
        this.#git(["worktree", "unlock", w.path]);
    return this.#git(["worktree", "prune"]).ok;
  }

  /**
   * Lock session trees made before Loom locked them (see {@link LOCK_REASON}).
   * A lock already there stays; a tree Git does not list is skipped. Returns
   * how many it locked.
   */
  lock(trees: ReadonlyArray<{ id: string; path: string }>): number {
    const unlocked = new Set(
      this.list()
        .filter((w) => w.locked === null)
        .map((w) => canonicalHostPath(w.path)),
    );
    let locked = 0;
    for (const { id, path } of trees) {
      if (!unlocked.has(canonicalHostPath(path))) continue;
      const res = this.#git(["worktree", "lock", "--reason", lockReason(id), path]);
      if (res.ok) locked++;
      else this.#log.warn("worktree lock failed", { path, error: res.stderr.trim() || res.error });
    }
    return locked;
  }

  /** The worktree's current `git HEAD` (full SHA), or null if it can't be read. */
  headSha(path: string): string | null {
    if (!path || !existsSync(path)) return null;
    const sha = this.#gitRead(["rev-parse", "HEAD"], path);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /** Copy a stopped parent's changes into a fresh worktree at the same HEAD.
   * Ignored files and submodule working trees are deliberately not copied. */
  copyChanges(source: string, target: string): void {
    source = canonicalHostPath(source);
    target = canonicalHostPath(target);
    if (this.pendingGitOp(source))
      throw new Error("Finish the parent's Git operation before forking");
    const run = (args: string[], cwd = source, input?: string): string => {
      const r = spawnSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-C", this.#hostOnly(cwd), ...args],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: GIT_MAX_BUFFER,
          ...(input === undefined ? {} : { input }),
        },
      );
      if (r.error || r.status !== 0)
        throw new Error(r.error?.message || r.stderr || "Could not copy worktree changes");
      return r.stdout;
    };
    if (
      run([...READ_ONLY_GIT_OPTIONS, "ls-files", "--stage"])
        .split("\n")
        .some((line) => line.startsWith("160000 "))
    )
      throw new Error("Forking worktrees with submodules is not supported yet");
    // Apply the index and working-tree deltas separately to preserve staging.
    // Never invoke external diff drivers, hooks, or mutate the parent's index.
    for (const cached of [true, false]) {
      const patch = run([
        ...READ_ONLY_GIT_OPTIONS,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        ...(cached ? ["--cached"] : []),
      ]);
      if (patch)
        run(
          ["apply", "--binary", "--whitespace=nowarn", ...(cached ? ["--index"] : []), "-"],
          target,
          patch,
        );
    }
    for (const name of run([
      ...READ_ONLY_GIT_OPTIONS,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean)) {
      // In-place parents may contain Loom's worktrees, and `.loom` left by an
      // older version. These are runtime state, even in a repo that forgot to ignore them.
      const from = join(source, name);
      if (
        source === this.#repoRoot &&
        [this.#treesDir, this.#hooksDir, join(this.#repoRoot, ".loom")].some(
          (dir) => from === dir || from.startsWith(dir + "/"),
        )
      )
        continue;
      if (name.split("/").some((part) => part === ".." || part === ".git"))
        throw new Error("Unsafe untracked path");
      const dest = join(target, name);
      let dir = target;
      for (const part of dirname(name).split("/")) {
        if (part === ".") continue;
        dir = join(dir, part);
        try {
          mkdirSync(dir);
        } catch (error) {
          if ((error as { code?: string }).code !== "EEXIST") throw error;
        }
        if (!lstatSync(dir).isDirectory())
          throw new Error("Untracked path escapes the fork worktree");
      }
      cpSync(from, dest, {
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    }
  }

  /** Whether the worktree has uncommitted (tracked or untracked) changes. */
  isDirty(path: string): boolean {
    if (!path || !existsSync(path)) return false;
    return this.#gitRead(["status", "--porcelain"], path).length > 0;
  }

  /** The name of a git operation in progress in the worktree at `path`
   *  (rebase / merge / cherry-pick / revert), or null. Worktree-aware. */
  pendingGitOp(path: string): string | null {
    return this.#opInProgress(path);
  }

  /**
   * `git reset --hard <sha>` in the worktree — used by `session.rewind` to put
   * the files back where they were when the kept turn completed. Untracked files
   * are left alone (no `git clean`). Caller must have verified the tree is clean.
   */
  restoreTo(path: string, sha: string): { ok: boolean; error: string } {
    const res = this.#git(["reset", "--hard", sha], path);
    this.invalidateFacts(path);
    if (res.ok) {
      this.#log.info("worktree reset", { path, sha: sha.slice(0, 8) });
      return { ok: true, error: "" };
    }
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `git exit ${res.code}` };
  }

  /** Subjects of commits in `from..to` (oldest first), capped. For a drift notice. */
  commitsBetween(path: string, from: string, to: string, limit = 20): string[] {
    if (!from || !to || from === to) return [];
    const out = this.#gitRead(
      ["log", "--reverse", "--format=%h %s", `${from}..${to}`, `--max-count=${limit}`],
      path,
    );
    return out ? out.split("\n") : [];
  }

  /**
   * `git branch -D <branch>` in the repo root. Best-effort: returns false (and
   * logs) if the branch is missing, checked out elsewhere, or git refuses —
   * `session.remove` still succeeds. Call after the worktree is gone.
   */
  deleteBranch(branch: string): boolean {
    const res = this.#git(["branch", "-D", branch]);
    if (!res.ok) {
      this.#log.warn("branch delete failed", {
        branch,
        error: res.stderr.trim() || res.stdout.trim(),
      });
      return false;
    }
    this.#log.info("branch deleted", { branch });
    return true;
  }

  /** Parsed `git worktree list --porcelain`. */
  list(): WorktreeEntry[] {
    const res = this.#git(["worktree", "list", "--porcelain"]);
    if (!res.ok) return [];
    const out: WorktreeEntry[] = [];
    let cur: WorktreeEntry | null = null;
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur) out.push(cur);
        cur = { path: line.slice("worktree ".length), branch: null, head: null, locked: null };
      } else if (cur && (line === "locked" || line.startsWith("locked "))) {
        cur.locked = line.slice("locked ".length);
      } else if (cur && line.startsWith("HEAD ")) {
        cur.head = line.slice("HEAD ".length);
      } else if (cur && line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // --- facts ------------------------------------------------------

  /** Per-session git facts for the fleet view. Cached briefly. */
  facts(path: string, baseBranch: string | null): GitFacts | null {
    if (!path || !existsSync(path)) return null;
    const cached = this.#factsCache.get(path);
    if (cached && Date.now() - cached.at < FACTS_TTL_MS) return cached.facts;

    const branch = this.#gitRead(["symbolic-ref", "--short", "-q", "HEAD"], path) || null;
    const dirty = this.#gitRead(["status", "--porcelain"], path).length > 0;
    const lastCommitSubject = this.#gitRead(["log", "-1", "--format=%s"], path) || null;
    const commits = numOr0(this.#gitRead(["rev-list", "--count", "HEAD"], path));

    let aheadOfBase = 0;
    let behindBase = 0;
    const base = baseBranch ?? this.#baseBranch;
    if (base && this.#git(["rev-parse", "--verify", "--quiet", base], path).ok) {
      const lr = this.#gitRead(["rev-list", "--left-right", "--count", `${base}...HEAD`], path);
      const [behind, ahead] = lr.split(/\s+/);
      behindBase = numOr0(behind);
      aheadOfBase = numOr0(ahead);
    }

    const facts: GitFacts = { branch, commits, aheadOfBase, behindBase, dirty, lastCommitSubject };
    this.#factsCache.set(path, { at: Date.now(), facts });
    return facts;
  }

  // --- clone sessions: host refs only ---------------------------------

  /**
   * A clone session's branch, with no worktree. The host creates the ref once;
   * every later movement is a push from the guest through the relay.
   */
  createBranch(
    id: string,
    opts: { branchPrefix: BranchPrefix; baseRef?: string },
  ): { branch: string; baseRef: string } {
    this.ensureSetup();
    if (opts.baseRef && !this.#git(["rev-parse", "--verify", "--quiet", opts.baseRef]).ok)
      throw new Error(`base ref "${opts.baseRef}" does not resolve`);
    let baseRef = opts.baseRef ?? this.#resolveBase();
    // The relay exposes the base by name, so a clone session needs a branch, not HEAD.
    if (baseRef === "HEAD") baseRef = this.#gitRead(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!baseRef) throw new Error("clone sessions need a base branch; HEAD is detached");
    const branch = this.#uniqueBranch(opts.branchPrefix, id);
    const res = this.#git(["branch", branch, baseRef]);
    if (!res.ok) throw new Error(`git branch failed: ${res.stderr.trim() || res.error}`);
    return { branch, baseRef };
  }

  /** The published tip of a branch, read from the host repository. */
  branchHead(branch: string): string | null {
    return this.#gitRead(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) || null;
  }

  // --- a new session's base ------------------------------------------

  /**
   * The repository's default branch: `configured` (`base_branch`), else the
   * remote's default branch, else `init.defaultBranch`, else `main`. Named,
   * not checked: see {@link resolves} and {@link isBranch}.
   */
  defaultBranch(configured?: string): string {
    if (configured) return configured;
    const remote = this.#gitRead(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
    if (remote.startsWith("origin/") && remote.length > "origin/".length)
      return remote.slice("origin/".length);
    return this.#gitRead(["config", "--get", "init.defaultBranch"]) || "main";
  }

  /** The checked-out branch, else HEAD's full commit when detached; null before
   *  the first commit. */
  currentBase(): { ref: string; detached: boolean } | null {
    const branch = this.#gitRead(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (branch && this.isBranch(branch)) return { ref: branch, detached: false };
    const head = this.#gitRead(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return head ? { ref: head, detached: true } : null;
  }

  /** Whether `ref` names a commit here. */
  resolves(ref: string): boolean {
    return (
      !!ref &&
      !ref.startsWith("-") &&
      this.#git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], undefined, {
        readOnly: true,
      }).ok
    );
  }

  /** Whether `name` is a local branch. */
  isBranch(name: string): boolean {
    return (
      !!name &&
      this.#git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], undefined, {
        readOnly: true,
      }).ok
    );
  }

  /**
   * Facts for a clone session from host refs. They describe what the guest has
   * published; `dirty` is unknown on the host and reads false.
   */
  refFacts(branch: string, baseBranch: string | null): GitFacts | null {
    const key = `ref:${branch}`;
    const cached = this.#factsCache.get(key);
    if (cached && Date.now() - cached.at < FACTS_TTL_MS) return cached.facts;
    const ref = `refs/heads/${branch}`;
    if (!this.#git(["rev-parse", "--verify", "--quiet", ref]).ok) return null;
    const lastCommitSubject = this.#gitRead(["log", "-1", "--format=%s", ref]) || null;
    const commits = numOr0(this.#gitRead(["rev-list", "--count", ref]));
    let aheadOfBase = 0;
    let behindBase = 0;
    const base = baseBranch ?? this.#baseBranch;
    if (base && this.#git(["rev-parse", "--verify", "--quiet", base]).ok) {
      const lr = this.#gitRead(["rev-list", "--left-right", "--count", `${base}...${ref}`]);
      const [behind, ahead] = lr.split(/\s+/);
      behindBase = numOr0(behind);
      aheadOfBase = numOr0(ahead);
    }
    const facts: GitFacts = {
      branch,
      commits,
      aheadOfBase,
      behindBase,
      dirty: false,
      lastCommitSubject,
    };
    this.#factsCache.set(key, { at: Date.now(), facts });
    return facts;
  }

  /** Advisory probes must yield while Git runs so history RPCs remain responsive. */
  factsAsync(path: string, baseBranch: string | null): Promise<GitFacts | null> {
    if (!path || !existsSync(path) || this.isClone(path)) return Promise.resolve(null);
    const cached = this.#factsCache.get(path);
    if (cached && Date.now() - cached.at < FACTS_TTL_MS) return Promise.resolve(cached.facts);
    const pending = this.#factsPending.get(path);
    if (pending) return pending;
    const out = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        execFile(
          "git",
          [...READ_ONLY_GIT_OPTIONS, "-C", path, ...args],
          { timeout: 15_000, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
          (error, stdout) => resolve(error ? "" : stdout.trim()),
        );
      });
    let probe!: Promise<GitFacts | null>;
    probe = (async (): Promise<GitFacts | null> => {
      const branch = (await out(["symbolic-ref", "--short", "-q", "HEAD"])) || null;
      const dirty = (await out(["status", "--porcelain"])).length > 0;
      const lastCommitSubject = (await out(["log", "-1", "--format=%s"])) || null;
      const commits = numOr0(await out(["rev-list", "--count", "HEAD"]));
      const base = baseBranch ?? this.#baseBranch;
      const [behind, ahead] = base
        ? (await out(["rev-list", "--left-right", "--count", `${base}...HEAD`])).split(/\s+/)
        : [];
      const facts: GitFacts = {
        branch,
        dirty,
        lastCommitSubject,
        commits,
        aheadOfBase: numOr0(ahead),
        behindBase: numOr0(behind),
      };
      // A mutation/invalidation or a synchronous probe supersedes this result.
      if (this.#factsPending.get(path) !== probe || this.#factsCache.get(path) !== cached)
        return this.cachedFacts(path);
      this.#factsCache.set(path, { at: Date.now(), facts });
      return facts;
    })();
    this.#factsPending.set(path, probe);
    void probe.finally(() => {
      if (this.#factsPending.get(path) === probe) this.#factsPending.delete(path);
    });
    return probe;
  }

  /** Last computed facts for `path`, ignoring the TTL — so a snapshot that
   *  skips the shell-out (the per-usage stream) can still carry a git line. */
  cachedFacts(path: string): GitFacts | null {
    return this.#factsCache.get(path)?.facts ?? null;
  }

  /** Drop the cached facts for `path` — call after a known mutation (a commit
   *  from the agent's tool, an undo restore) so the fleet view doesn't lag it. */
  invalidateFacts(path: string): void {
    this.#factsPending.delete(path);
    this.#factsCache.delete(path);
  }

  // --- keep-current --------------------------------------------------

  /**
   * Bring the branch checked out at `path` up to date with `baseBranch` when the
   * base has advanced. `mode` picks `git rebase` (replay, linear history — the
   * default) or `git merge --no-edit` (a merge commit, no history rewrite).
   * Never fetches: the base ref is read as-is, so this only reacts to the local
   * base moving. On conflict the operation is aborted and the tree is left
   * exactly as it was.
   *
   *  - `no-base`   — `baseBranch` doesn't resolve; nothing to do.
   *  - `current`   — the branch already contains every base commit.
   *  - `dirty`     — the worktree has uncommitted changes; skipped untouched.
   *  - `busy`      — the agent has its own rebase / merge / cherry-pick in
   *                  progress; skipped untouched (`op` names it).
   *  - `updated`   — replayed / merged cleanly; `head` is the new short SHA.
   *  - `conflict`  — `git` reported conflicts; the abort ran, tree unchanged.
   *  - `error`     — git failed for some other reason; best-effort abort ran.
   *
   * `base` is the base branch name and `baseHead` its short SHA (so a caller can
   * de-dupe repeated nudges for the same base commit); `behind` is how many
   * base commits the branch was missing. `identity` is the session's
   * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so replayed and merge commits carry it.
   */
  syncOntoBase(
    path: string,
    baseBranch: string | null,
    mode: "rebase" | "merge",
    identity: Record<string, string> = {},
  ): RebaseOutcome {
    const base = baseBranch ?? this.#baseBranch;
    if (!base || !this.#git(["rev-parse", "--verify", "--quiet", base], path).ok) {
      return { outcome: "no-base" };
    }
    const baseHead = this.#gitRead(["rev-parse", "--short", base], path);
    const behind = numOr0(this.#gitRead(["rev-list", "--count", `HEAD..${base}`], path));
    const info = { base, baseHead, behind };

    // The agent may be part-way through its own `git rebase` / `git merge` /
    // cherry-pick from the Bash tool, paused at a clean stopping point. Running
    // our rebase (and then `--abort` on the "already a rebase in progress"
    // failure) would wipe its resolved state — bail before anything else. Checked
    // before `behind === 0` too: a paused rebase leaves HEAD on top of the base,
    // so `behind` reads 0 and would otherwise look "current".
    const op = this.#opInProgress(path);
    if (op) return { outcome: "busy", op, ...info };

    if (behind === 0) return { outcome: "current", ...info };

    if (this.#gitRead(["status", "--porcelain"], path).length > 0) {
      return { outcome: "dirty", ...info };
    }

    const run = this.#git([mode, ...(mode === "merge" ? ["--no-edit"] : []), base], path, {
      timeoutMs: 90_000,
      env: identity,
    });
    if (run.ok) {
      this.invalidateFacts(path);
      const head = this.#gitRead(["rev-parse", "--short", "HEAD"], path);
      this.#log.info("branch synced onto base", { path, base, mode, behind, head });
      return { outcome: "updated", head, ...info };
    }

    // Classify before the abort clears the unmerged state: a real conflict
    // leaves unmerged paths in the index. Exit-code / index driven, not a
    // locale-dependent grep of git's stdout.
    const conflict = this.#gitRead(["diff", "--name-only", "--diff-filter=U"], path).length > 0;
    // Undo whatever half-applied state git left behind, whichever way it failed.
    const abort = this.#git([mode, "--abort"], path);
    this.invalidateFacts(path);
    this.#log.warn("branch sync onto base failed", {
      path,
      base,
      mode,
      conflict,
      aborted: abort.ok,
      error: run.error || run.stderr.trim() || run.stdout.trim(),
    });
    return { outcome: conflict ? "conflict" : "error", ...info };
  }

  // --- internals -------------------------------------------------

  /** Lift Loom's own lock on the tree at `path` for its removal. Returns what
   *  puts it back should the removal fail; another lock stays, and Git refuses. */
  #unlockOwn(path: string): () => void {
    const at = canonicalHostPath(path);
    const reason = this.list().find((w) => canonicalHostPath(w.path) === at)?.locked;
    if (!reason?.startsWith(LOCK_REASON)) return () => {};
    this.#git(["worktree", "unlock", path]);
    return () => void this.#git(["worktree", "lock", "--reason", reason, path]);
  }

  /** The name of a git operation currently in progress in `path`
   *  (rebase / merge / cherry-pick / revert), or null. Worktree-aware — each
   *  linked worktree has its own state dir. */
  #opInProgress(path: string): string | null {
    for (const marker of [
      "rebase-merge",
      "rebase-apply",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]) {
      const rel = this.#gitRead(["rev-parse", "--git-path", marker], path);
      if (rel && existsSync(rel.startsWith("/") ? rel : join(path, rel))) return marker;
    }
    return null;
  }

  #resolveBase(): string {
    if (this.#git(["rev-parse", "--verify", "--quiet", this.#baseBranch]).ok)
      return this.#baseBranch;
    return "HEAD";
  }

  /** The worktree directory basename: the session id truncated to the fleet
   *  view's short id, with a random suffix on the (astronomically rare) clash. */
  #uniqueDir(id: string): string {
    const base = id.slice(0, 8);
    const taken = new Set(this.list().map((w) => w.path));
    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const path = join(this.#treesDir, slug);
      if (!taken.has(path) && !existsSync(path)) return slug;
      if (attempt > 20) return `${base}-${Date.now().toString(36)}`;
    }
  }

  /** `<prefix>/<first 8 chars of id>`, falling back to the full id on collision
   *  (astronomically rare — ids are random UUIDs). */
  #uniqueBranch(prefix: BranchPrefix, id: string): string {
    const short = sessionBranch(prefix, id.slice(0, 8));
    if (!this.#nameTaken(short)) return short;
    return sessionBranch(prefix, id);
  }

  /** `<prefix>/<slug>`, with a short hex suffix if that name is already taken.
   *  `exclude` (the branch being renamed away from) doesn't count as taken. */
  #uniqueBranchNamed(prefix: BranchPrefix, slug: string, exclude: string): string {
    for (let attempt = 0; ; attempt++) {
      const name = sessionBranch(prefix, attempt === 0 ? slug : `${slug}-${randomSuffix()}`);
      if (name === exclude) return name;
      if (!this.#nameTaken(name)) return name;
      if (attempt > 20) return sessionBranch(prefix, `${slug}-${Date.now().toString(36)}`);
    }
  }

  /** Anything the bare name resolves to counts, not only a branch: with no
   *  prefix, a branch named like a tag or an abbreviated SHA would be ambiguous
   *  wherever Git is handed the name bare. */
  #nameTaken(name: string): boolean {
    return this.#git(["rev-parse", "--verify", "--quiet", name]).ok;
  }

  #git(
    args: string[],
    cwd?: string,
    opts: { timeoutMs?: number; env?: Record<string, string>; readOnly?: boolean } = {},
  ): GitResult {
    const global = opts.readOnly ? READ_ONLY_GIT_OPTIONS : [];
    const at = this.#hostOnly(cwd ?? this.#repoRoot);
    const res = spawnSync("git", [...global, "-C", at, ...args], {
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: GIT_MAX_BUFFER,
      ...(opts.env ? { env: { ...Deno.env.toObject(), ...opts.env } } : {}),
    });
    const error = res.error ? (res.error.message ?? String(res.error)) : "";
    if (error) this.#log.warn("git spawn error", { args: args.slice(0, 2), error });
    return {
      // A spawn error (timeout / ENOBUFS) leaves `status` null — treat it as a
      // failure, not a silent empty result.
      ok: res.status === 0 && !error,
      code: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error,
    };
  }

  /** Stdout of a command that only reads; never takes Git's optional index lock. */
  #gitRead(args: string[], cwd?: string): string {
    return this.#git(args, cwd, { readOnly: true }).stdout.trim();
  }
}

// ---------------------------------------------------------------------------

export const slugify = (hint: string): string => {
  const words = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);
  const slug = words.slice(0, 5).join("-").slice(0, 40).replace(/-+$/g, "");
  return slug || "session";
};

const randomSuffix = (): string => {
  return randomBytes(3).toString("hex"); // always 6 hex chars (Math.random() could give fewer)
};

const numOr0 = (s: string | undefined): number => {
  const n = Number.parseInt((s ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
};
