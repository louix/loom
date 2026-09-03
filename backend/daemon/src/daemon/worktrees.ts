/**
 * Per-session git worktrees (design spec §6). On session create we branch a
 * fresh worktree off the configured base; each tree gets a distinct commit
 * identity and a pre-push hook that hard-blocks pushing. Loom never runs a
 * remote operation itself. `gc` removes trees for sessions the user has marked
 * done; branches are never auto-deleted.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@loom/core/logger";
import type { GitFacts } from "@loom/core/wire";

/**
 * The worktree-scoped commit identity: `Loom (<model>) <loom+<model>@localhost>`
 * — commits carry the model that ran the session, not just "claude". No model
 * (the daemon couldn't resolve one) falls back to the bare `Loom` identity.
 */
const identity = (model: string): { name: string; email: string } => {
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
  /** Absolute directory that holds the trees (`<repo>/.loom/trees`). */
  treesDir: string;
  /** Absolute directory for the shared, worktree-scoped hooks. */
  hooksDir: string;
  /** Configured base branch (`config.baseBranch`). */
  baseBranch: string;
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
  readonly #log: Logger;
  #setupDone = false;
  #factsCache = new Map<string, { at: number; facts: GitFacts }>();

  constructor(opts: WorktreeManagerOptions) {
    this.#repoRoot = opts.repoRoot;
    this.#treesDir = opts.treesDir;
    this.#hooksDir = opts.hooksDir;
    this.#baseBranch = opts.baseBranch;
    this.#log = opts.log;
  }

  // --- setup ----------------------------------------------------------

  /** Idempotent one-time repo prep: worktree-scoped config + the push hook. */
  ensureSetup(): void {
    if (this.#setupDone) return;
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
    const custom = abs(this.#gitOut(["config", "--get", "core.hooksPath"]));
    const customDir = custom && isDir(custom) ? custom : "";
    const commonDir =
      abs(this.#gitOut(["rev-parse", "--git-common-dir"])) || join(this.#repoRoot, ".git");
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

  // --- lifecycle ----------------------------------------------------

  /**
   * `git worktree add <trees>/<shortId> -b loom/<shortId> <base>`, then pin the
   * commit identity and hooks path for that tree. `opts.baseRef` branches
   * off something other than the configured base (a parent session's branch,
   * for a hard fork). `opts.model` is the session's model — it names the
   * commit identity (`Loom (<model>)`), so a commit says what ran it. `id` is
   * the session's own id — both the directory and the branch are named after it
   * (truncated to the fleet view's short id) so a tree is traceable back to the
   * session.
   */
  create(id: string, opts: { baseRef?: string; model?: string } = {}): WorktreeInfo {
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
    const branch = this.#uniqueBranch(id);

    const add = this.#git(["worktree", "add", path, "-b", branch, baseRef]);
    if (!add.ok) {
      // A partial checkout (disk full mid-`add`) leaves the dir behind — reclaim
      // it so the next attempt / `gc` isn't blocked by a stale entry.
      this.#git(["worktree", "prune"]);
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    // These three are the "sessions always commit as Loom, never push" guarantee.
    // A failure here is fatal: a worktree with no `core.hooksPath` has no
    // push-block hook, and one with no `user.email` commits under whatever
    // ambient identity git finds. Tear the tree down rather than run it unsafe.
    const ident = identity(opts.model ?? "");
    for (const [key, value] of [
      ["user.name", ident.name],
      ["user.email", ident.email],
      ["core.hooksPath", this.#hooksDir],
    ] as const) {
      const res = this.#git(["config", "--worktree", key, value], path);
      if (!res.ok) {
        try {
          this.remove(path, { force: true });
          this.deleteBranch(branch);
        } catch {
          this.#git(["worktree", "prune"]); // best-effort cleanup
        }
        throw new Error(
          `worktree config --worktree ${key} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
    }

    this.#log.info("worktree created", { slug, branch, baseRef, path });
    return { slug, path, branch, baseRef };
  }

  /**
   * `git worktree add <trees>/<shortId> <branch>` — check an *existing* branch
   * back out into a fresh tree, then re-pin the commit identity and hooks the
   * same way {@link create} does. Used when an archived (`done`) session is
   * messaged again: its worktree was removed but the branch was kept, so the
   * session resumes on a new tree carved from that branch. `id` names the
   * directory (the session's short id); `model` names the commit identity.
   * Throws if the branch no longer resolves (deleted in the user's own git).
   */
  reattach(id: string, branch: string, opts: { model?: string } = {}): WorktreeInfo {
    this.ensureSetup();
    if (!this.#git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
      throw new Error(`branch "${branch}" no longer exists`);
    }
    // A stale `worktree list` entry for a dir we already removed would make the
    // `add` fail with "already checked out" — clear it first.
    this.#git(["worktree", "prune"]);
    const slug = this.#uniqueDir(id);
    const path = join(this.#treesDir, slug);

    const add = this.#git(["worktree", "add", path, branch]);
    if (!add.ok) {
      this.#git(["worktree", "prune"]);
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    // Same "always commit as Loom, never push" guarantee as `create` — and
    // just as fatal if it can't be established.
    const ident = identity(opts.model ?? "");
    for (const [key, value] of [
      ["user.name", ident.name],
      ["user.email", ident.email],
      ["core.hooksPath", this.#hooksDir],
    ] as const) {
      const res = this.#git(["config", "--worktree", key, value], path);
      if (!res.ok) {
        try {
          this.remove(path, { force: true });
        } catch {
          this.#git(["worktree", "prune"]); // best-effort cleanup
        }
        throw new Error(
          `worktree config --worktree ${key} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
    }

    this.#log.info("worktree reattached", { slug, branch, path });
    return { slug, path, branch, baseRef: this.#baseBranch };
  }

  /**
   * Re-point an existing worktree's commit identity — after a deliberate
   * mid-session model switch, so later commits carry the model that actually
   * runs. Best-effort: a failure keeps the previous identity (warn, don't tear
   * the session down — {@link create} is fatal instead because a *fresh* tree
   * must never run unconfigured).
   */
  setIdentity(path: string, model: string): void {
    const ident = identity(model);
    for (const [key, value] of [
      ["user.name", ident.name],
      ["user.email", ident.email],
    ] as const) {
      const res = this.#git(["config", "--worktree", key, value], path);
      if (!res.ok) {
        this.#log.warn(
          `worktree config --worktree ${key} failed: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
    }
  }

  /**
   * Rebrand a session's still-generic `loom/<shortId>` branch from its freshly
   * generated title — `git branch -m` to `loom/<slug>` (git updates the linked
   * worktree's HEAD). The worktree *directory* is left as-is: the running
   * session holds it as its cwd, and the dir name is cosmetic. Returns the new
   * branch, or `currentBranch` unchanged on a no-op / failure.
   */
  renameBranch(hint: string, currentBranch: string): string {
    const branch = this.#uniqueBranchNamed(slugify(hint), currentBranch);
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
    this.#log.info("session branch renamed", { from: currentBranch, to: branch });
    return branch;
  }

  /** `git worktree remove` — used by gc for sessions marked done. */
  remove(path: string, opts: { force?: boolean } = {}): void {
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(path);
    const res = this.#git(args);
    this.#factsCache.delete(path);
    if (!res.ok) {
      throw new Error(`git worktree remove failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    this.#log.info("worktree removed", { path });
  }

  prune(): void {
    this.#git(["worktree", "prune"]);
  }

  /** The worktree's current `git HEAD` (full SHA), or null if it can't be read. */
  headSha(path: string): string | null {
    if (!path || !existsSync(path)) return null;
    const sha = this.#gitOut(["rev-parse", "HEAD"], path);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /** Whether the worktree has uncommitted (tracked or untracked) changes. */
  isDirty(path: string): boolean {
    if (!path || !existsSync(path)) return false;
    return this.#gitOut(["status", "--porcelain"], path).length > 0;
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
    this.#factsCache.delete(path);
    if (res.ok) {
      this.#log.info("worktree reset", { path, sha: sha.slice(0, 8) });
      return { ok: true, error: "" };
    }
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `git exit ${res.code}` };
  }

  /** Subjects of commits in `from..to` (oldest first), capped. For a drift notice. */
  commitsBetween(path: string, from: string, to: string, limit = 20): string[] {
    if (!from || !to || from === to) return [];
    const out = this.#gitOut(
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
  list(): Array<{ path: string; branch: string | null; head: string | null }> {
    const res = this.#git(["worktree", "list", "--porcelain"]);
    if (!res.ok) return [];
    const out: Array<{ path: string; branch: string | null; head: string | null }> = [];
    let cur: { path: string; branch: string | null; head: string | null } | null = null;
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur) out.push(cur);
        cur = { path: line.slice("worktree ".length), branch: null, head: null };
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

    const branch = this.#gitOut(["symbolic-ref", "--short", "-q", "HEAD"], path) || null;
    const dirty = this.#gitOut(["status", "--porcelain"], path).length > 0;
    const lastCommitSubject = this.#gitOut(["log", "-1", "--format=%s"], path) || null;
    const commits = numOr0(this.#gitOut(["rev-list", "--count", "HEAD"], path));

    let aheadOfBase = 0;
    let behindBase = 0;
    const base = baseBranch ?? this.#baseBranch;
    if (base && this.#git(["rev-parse", "--verify", "--quiet", base], path).ok) {
      const lr = this.#gitOut(["rev-list", "--left-right", "--count", `${base}...HEAD`], path);
      const [behind, ahead] = lr.split(/\s+/);
      behindBase = numOr0(behind);
      aheadOfBase = numOr0(ahead);
    }

    const facts: GitFacts = { branch, commits, aheadOfBase, behindBase, dirty, lastCommitSubject };
    this.#factsCache.set(path, { at: Date.now(), facts });
    return facts;
  }

  /** Last computed facts for `path`, ignoring the TTL — so a snapshot that
   *  skips the shell-out (the per-usage stream) can still carry a git line. */
  cachedFacts(path: string): GitFacts | null {
    return this.#factsCache.get(path)?.facts ?? null;
  }

  /** Drop the cached facts for `path` — call after a known mutation (a commit
   *  from the agent's tool, an undo restore) so the fleet view doesn't lag it. */
  invalidateFacts(path: string): void {
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
   * base commits the branch was missing.
   */
  syncOntoBase(path: string, baseBranch: string | null, mode: "rebase" | "merge"): RebaseOutcome {
    const base = baseBranch ?? this.#baseBranch;
    if (!base || !this.#git(["rev-parse", "--verify", "--quiet", base], path).ok) {
      return { outcome: "no-base" };
    }
    const baseHead = this.#gitOut(["rev-parse", "--short", base], path);
    const behind = numOr0(this.#gitOut(["rev-list", "--count", `HEAD..${base}`], path));
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

    if (this.#gitOut(["status", "--porcelain"], path).length > 0) {
      return { outcome: "dirty", ...info };
    }

    const run = this.#git([mode, ...(mode === "merge" ? ["--no-edit"] : []), base], path, 90_000);
    if (run.ok) {
      this.#factsCache.delete(path);
      const head = this.#gitOut(["rev-parse", "--short", "HEAD"], path);
      this.#log.info("branch synced onto base", { path, base, mode, behind, head });
      return { outcome: "updated", head, ...info };
    }

    // Classify before the abort clears the unmerged state: a real conflict
    // leaves unmerged paths in the index. Exit-code / index driven, not a
    // locale-dependent grep of git's stdout.
    const conflict = this.#gitOut(["diff", "--name-only", "--diff-filter=U"], path).length > 0;
    // Undo whatever half-applied state git left behind, whichever way it failed.
    const abort = this.#git([mode, "--abort"], path);
    this.#factsCache.delete(path);
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
      const rel = this.#gitOut(["rev-parse", "--git-path", marker], path);
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

  /** `loom/<first 8 chars of id>`, falling back to the full id on collision
   *  (astronomically rare — ids are random UUIDs). */
  #uniqueBranch(id: string): string {
    const short = `loom/${id.slice(0, 8)}`;
    if (!this.#git(["rev-parse", "--verify", "--quiet", short]).ok) return short;
    return `loom/${id}`;
  }

  /** `loom/<slug>`, with a short hex suffix if that ref is already taken.
   *  `exclude` (the branch being renamed away from) doesn't count as taken. */
  #uniqueBranchNamed(slug: string, exclude?: string): string {
    for (let attempt = 0; ; attempt++) {
      const name = attempt === 0 ? `loom/${slug}` : `loom/${slug}-${randomSuffix()}`;
      if (name === exclude) return name;
      if (!this.#git(["rev-parse", "--verify", "--quiet", name]).ok) return name;
      if (attempt > 20) return `loom/${slug}-${Date.now().toString(36)}`;
    }
  }

  #git(args: string[], cwd?: string, timeout = 15_000): GitResult {
    const res = spawnSync("git", ["-C", cwd ?? this.#repoRoot, ...args], {
      encoding: "utf8",
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
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

  #gitOut(args: string[], cwd?: string): string {
    return this.#git(args, cwd).stdout.trim();
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
