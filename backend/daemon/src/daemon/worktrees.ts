/**
 * Per-session git worktrees (design spec §6). On session create we branch a
 * fresh worktree off the configured base; each tree gets a distinct commit
 * identity and a pre-push hook that hard-blocks pushing. Loom never runs a
 * remote operation itself. `gc` removes trees for sessions the user has marked
 * done; branches are never auto-deleted.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@loom/core/logger";
import type { GitFacts } from "@loom/core/wire";

const IDENTITY_NAME = "Loom (claude)";
const IDENTITY_EMAIL = "loom+claude@localhost";
const FACTS_TTL_MS = 8000;

const PRE_PUSH_HOOK = `#!/bin/sh
# Installed by Loom. Sessions must never push — integrate in your own git.
echo "loom: push is blocked in session worktrees" >&2
exit 1
`;

export interface WorktreeInfo {
  slug: string;
  path: string;
  branch: string;
  baseRef: string;
}

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
    // Per-worktree `git config --worktree` requires this extension.
    this.#git(["config", "extensions.worktreeConfig", "true"]);
    mkdirSync(this.#treesDir, { recursive: true });
    mkdirSync(this.#hooksDir, { recursive: true });
    const hook = join(this.#hooksDir, "pre-push");
    if (!existsSync(hook)) {
      writeFileSync(hook, PRE_PUSH_HOOK);
      chmodSync(hook, 0o755);
    }
    this.#setupDone = true;
  }

  // --- lifecycle ----------------------------------------------------

  /**
   * `git worktree add <trees>/<slug> -b loom/<slug> <base>`, then pin the
   * commit identity and hooks path for that tree. `baseRefOverride` branches
   * off something other than the configured base (a parent session's branch,
   * for a hard fork).
   */
  create(hint: string, baseRefOverride?: string): WorktreeInfo {
    this.ensureSetup();
    const baseRef =
      baseRefOverride && this.#git(["rev-parse", "--verify", "--quiet", baseRefOverride]).ok
        ? baseRefOverride
        : this.#resolveBase();
    const slug = this.#uniqueSlug(hint);
    const path = join(this.#treesDir, slug);
    const branch = `loom/${slug}`;

    const add = this.#git(["worktree", "add", path, "-b", branch, baseRef]);
    if (!add.ok) {
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    for (const [key, value] of [
      ["user.name", IDENTITY_NAME],
      ["user.email", IDENTITY_EMAIL],
      ["core.hooksPath", this.#hooksDir],
    ] as const) {
      const res = this.#git(["config", "--worktree", key, value], path);
      if (!res.ok) this.#log.warn("worktree config failed", { key, err: res.stderr.trim() });
    }

    this.#log.info("worktree created", { slug, branch, baseRef, path });
    return { slug, path, branch, baseRef };
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

  // --- internals -------------------------------------------------

  #resolveBase(): string {
    if (this.#git(["rev-parse", "--verify", "--quiet", this.#baseBranch]).ok)
      return this.#baseBranch;
    return "HEAD";
  }

  #uniqueSlug(hint: string): string {
    const base = slugify(hint);
    const taken = new Set(this.list().map((w) => w.path));
    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const path = join(this.#treesDir, slug);
      const branchTaken = this.#git(["rev-parse", "--verify", "--quiet", `loom/${slug}`]).ok;
      if (!taken.has(path) && !existsSync(path) && !branchTaken) return slug;
      if (attempt > 20) return `${base}-${Date.now().toString(36)}`;
    }
  }

  #git(args: string[], cwd?: string): GitResult {
    const res = spawnSync("git", ["-C", cwd ?? this.#repoRoot, ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return {
      ok: res.status === 0,
      code: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
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
