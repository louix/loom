# Review — Worktree manager, git ops, fork, auto-rebase, gc, undo/rewind

Scope: `backend/daemon/src/daemon/worktrees.ts`, `backend/daemon/src/scaffold.ts`,
`core/src/commit.ts`, the `session.*` handlers + auto-rebase driver in
`backend/daemon/src/daemon/daemon.ts`, `scratch-claude-rewind.mts`, `.loom/hooks/pre-push`.

Ranked most severe first.

---

### Auto-rebase can destroy the agent's own in-progress rebase/merge

- **File:** backend/daemon/src/daemon/worktrees.ts:285-299 (driver: daemon.ts:795-835)
- **Severity:** high
- **Issue:** `syncOntoBase` decides the tree is safe to touch purely from
  `git status --porcelain`. That does not detect a rebase/merge that is already
  in progress in the worktree (a `rebase-merge` / `rebase-apply` dir, or a merge
  with `MERGE_HEAD` and an otherwise clean index). Scenario: the agent runs
  `git rebase -i base` (or `git merge`) from its Bash tool, pauses at a clean
  stopping point, the turn ends → `#onDerivedStatus(idle)` → `#maybeAutoRebase`.
  `behind > 0`, porcelain is empty, so Loom runs `git rebase base`, which fails
  with "there is already a rebase-merge directory", and then the code
  unconditionally runs `git rebase --abort` **in the agent's worktree** — wiping
  the agent's partially-resolved rebase state and conflict resolutions. Returned
  as `outcome:"error"`.
- **Fix:** Before attempting, bail out (new `busy`/`in-progress` outcome) if
  `<gitdir>/rebase-merge`, `<gitdir>/rebase-apply`, `MERGE_HEAD`,
  `CHERRY_PICK_HEAD` or `REVERT_HEAD` exist (or check
  `git rebase --show-current-patch` / `git status --porcelain=v2 --branch`). Only
  run `--abort` if this call actually started the operation.

### Undo/rewind moves the model's context but never restores worktree files

- **File:** backend/daemon/src/daemon/daemon.ts:921-941 (`#recordCheckpoint`), 1400-1477 (`session.rewind`); store/migrations.ts:103-112
- **Severity:** high
- **Issue:** A checkpoint stores only `turn`, `providerRef`, `forkPoint`
  (transcript ref / message count) and `userText`. There is no git SHA. After
  `session.rewind` to an earlier turn, the transcript/context is truncated but
  the working tree still contains every later turn's edits and commits. The agent
  resumes believing it is at turn N while the files on disk are at turn N+k, so
  it re-does work on top of a tree that no longer matches its context — silent,
  with no warning to the operator. `scratch-claude-rewind.mts` only asserts on
  model context, never on file state, so this gap is untested.
- **Fix:** Record `HEAD` (and dirty-stash ref) in the checkpoint; on rewind offer
  to `git reset --hard <sha>` / restore, or at minimum surface a loud notice that
  the worktree was left at the newer state and list the commits/edits that now
  post-date the model's context.

### gc yanks a worktree out from under a still-registered session

- **File:** backend/daemon/src/daemon/daemon.ts:1731-1748 (`markDone`), 1788-1820 (`gc`)
- **Severity:** medium
- **Issue:** `markDone` calls `this.#sessions.interrupt(id)` but never
  `close(id)`, so the provider process stays registered (`this.#sessions.has(id)`
  remains true) with its cwd inside the worktree. `session.gc` then runs
  `git worktree remove --force <path>` without checking `this.#sessions.has(id)`.
  The live (idle-after-interrupt) process now has a deleted cwd. A later
  `session.send` will not revive it (the `if (!this.#sessions.has(id))` guard is
  false) and will drive it in a directory that no longer exists — file/git ops
  fail confusingly. `session.remove` gets this right (`close` first); `gc` does not.
- **Fix:** In `gc`, `await this.#sessions.close(s.id).catch(() => {})` before
  `worktrees.remove`, mirroring `session.remove`.

### Hard fork silently branches off the configured base when the parent ref doesn't resolve

- **File:** backend/daemon/src/daemon/worktrees.ts:109-119; daemon.ts:1504-1532
- **Severity:** medium
- **Issue:** `create()` does
  `baseRefOverride && rev-parse(--verify --quiet baseRefOverride).ok ? baseRefOverride : this.#resolveBase()`.
  If a fork is requested but `parent.branch` no longer resolves (parent branch
  deleted, or renamed by the auto-titler — see next finding — between the fork
  being decided and executed), the fork is silently created off `main`/`HEAD`
  instead of erroring. `session.fork` then still runs `this.#pmsgs.copyTo(id, newId)`,
  so the fork carries the parent's entire transcript while its tree is based on an
  unrelated commit. Divergence between context and tree, no error surfaced.
- **Fix:** When `baseRefOverride` is passed and fails to resolve, throw rather
  than falling through to `#resolveBase()`; let `session.fork` translate that
  into a clear `worktree_error`.

### Worktree identity + push-block hook can be silently absent

- **File:** backend/daemon/src/daemon/worktrees.ts:85-97 (`ensureSetup`), 124-131 (`create`)
- **Severity:** medium
- **Issue:** Two unchecked-failure paths defeat the "sessions can never push /
  always commit as Loom" guarantee:
  1. `ensureSetup` runs `git config extensions.worktreeConfig true` and ignores
     the result. On a git that doesn't support it (or if it fails), every
     subsequent `git config --worktree user.email / core.hooksPath` in `create`
     writes to the **shared** repo config instead of per-worktree — the last
     session created repoints the main repo's commit identity and `core.hooksPath`.
  2. In `create`, failures of the three `git config --worktree` calls are only
     `this.#log.warn`-ed. A worktree with no `core.hooksPath` loses the pre-push
     hook entirely (push is no longer blocked); with no `user.email` it commits
     under whatever ambient identity git finds, or fails.
- **Fix:** Check `ensureSetup`'s `extensions.worktreeConfig` result and refuse to
  proceed (or hard-fail `create`) if it's not set; treat the `user.email` /
  `core.hooksPath` config failures in `create` as fatal (tear down the worktree)
  rather than warn-and-continue.

### A large auto-rebase freezes the whole daemon for up to 120s

- **File:** backend/daemon/src/daemon/daemon.ts:785, 795-801; worktrees.ts:289,350-354
- **Severity:** medium
- **Issue:** `#maybeAutoRebase` is called synchronously from the idle status
  transition and calls `syncOntoBase`, which is entirely `spawnSync` with a
  `120_000` ms timeout on the `git rebase`/`git merge` call. A big or slow replay
  blocks the Node event loop — all other sessions, all RPC clients, heartbeats
  and timers — for as long as the rebase runs. The in-code comment frames the
  blocking as desirable (prevents racing `session.send`), but a 2-minute stall is
  a heavy price and scales with fleet size (≈4 git spawns per idle transition per
  session even when there's nothing to do).
- **Fix:** Run the rebase off-thread / in a worker or async `spawn`, guarded by a
  per-worktree lock; or at least gate the expensive path behind a cheap
  `behind === 0` check done less often, and shorten the timeout.

### session.remove / failed worktree add can orphan a tree with no row to reclaim it

- **File:** backend/daemon/src/daemon/daemon.ts:1764-1784 (`session.remove`); worktrees.ts:119-122 (`create`)
- **Severity:** medium
- **Issue:** `session.remove` catches a `worktrees.remove` failure, only warns,
  then unconditionally `this.#registry.remove(id)`. If the removal genuinely
  failed (submodule, permissions, lock), the directory and branch remain on disk
  with no session row — `gc` iterates registry rows, so nothing will ever reclaim
  them. Same shape when `git worktree add` fails mid-checkout (disk full): the
  partial dir is left, `create` throws, and `create` never calls `prune()`.
- **Fix:** On `worktrees.remove` failure keep the row (as the fork error-path
  already does) and mark it so a later `gc {id}` can retry; call
  `this.#worktrees.prune()` after a failed `create`.

### session.remove force-discards a dirty worktree with no confirmation

- **File:** backend/daemon/src/daemon/daemon.ts:1764-1773
- **Severity:** medium
- **Issue:** `session.remove` always calls `this.#worktrees.remove(s.worktree, { force: true })`.
  `--force` makes `git worktree remove` delete a tree with uncommitted / untracked
  changes, so any agent work that was never committed is gone silently. The
  handler doc mentions the transcript/history going away but not live file
  changes.
- **Fix:** Default to a non-force remove and return a distinct error ("worktree
  has uncommitted changes; pass force") so the caller opts in explicitly, the way
  `gc` already threads `force` from the RPC.

### Auto-rebase "once per base commit" dedupe is in-memory only

- **File:** backend/daemon/src/daemon/daemon.ts:817-818 (`#autoRebaseNudged`), 1736 & 1763 (clears)
- **Severity:** low
- **Issue:** The "already nudged this session for this `baseHead`" record lives in
  a plain `Map` on the daemon instance. After a daemon restart the map is empty,
  so a session whose branch is still behind (dirty/conflicting) gets a fresh
  `[loom] the base branch advanced...` turn injected again for a base commit it
  was already told about — repeated on every restart until it catches up.
- **Fix:** Persist the last-nudged `baseHead` per session (registry field or a
  small table), or key the suppression off something derivable after restart.

### Fragile git-output parsing: conflict/error classification, maxBuffer, timeouts

- **File:** backend/daemon/src/daemon/worktrees.ts:300 (regex), 350-361 (`#git`)
- **Severity:** low
- **Issue:** (a) conflict vs error is decided by `/conflict/i.test(stdout+stderr)`
  — locale-dependent and phrasing-dependent; a localized git turns a real
  conflict into `outcome:"error"` (different operator nudge text).
  (b) `spawnSync` is called without `maxBuffer`, so the 1 MB default applies;
  `git worktree list --porcelain` / `git status --porcelain` in a very large tree
  can hit `ENOBUFS`, yielding `status === null` → `list()` returns `[]` and the
  dirty check under-reports (then `syncOntoBase` proceeds to rebase a tree it
  thinks is clean).
  (c) `res.error` (e.g. `ETIMEDOUT` on the 15s/120s timeouts) is never inspected
  or logged, so a timed-out git call is indistinguishable from a normal failure
  and may leave `index.lock` / `rebase-merge` behind.
- **Fix:** Use `git status --porcelain=v2` / exit-code-driven conflict detection;
  set an explicit generous `maxBuffer`; surface `res.error` in `GitResult` and
  log it.

### git-facts cache staleness

- **File:** backend/daemon/src/daemon/worktrees.ts:17 (`FACTS_TTL_MS = 8000`), 223-252
- **Severity:** low
- **Issue:** The TTL is 8s (the review brief guessed ~2s), so ahead/behind/dirty
  in the fleet view can lag reality by 8s. `cachedFacts(path)` ignores the TTL
  entirely and will return whatever was last computed, however old, for the
  per-usage snapshot stream. After `renameBranch` the cache is cleared, but after
  an agent commit nothing invalidates it until TTL expiry.
- **Fix:** Document the window; optionally invalidate on known mutation points
  (commit tool success, rewind) and lower the TTL.

### core.hooksPath override disables the repo's real hooks inside worktrees

- **File:** backend/daemon/src/daemon/worktrees.ts:127
- **Severity:** low
- **Issue:** Setting `core.hooksPath` to Loom's hooks dir (which contains only
  `pre-push`) means every session worktree bypasses the repo's own
  `pre-commit` / `commit-msg` / `prepare-commit-msg` hooks. May be intentional
  (unblocked automated commits) but it's an unannounced behavior change and, e.g.,
  a repo relying on `pre-commit` formatting will get unformatted agent commits.
- **Fix:** If the intent is only to block push, install just a `pre-push` in the
  worktree's default hooks location, or chain to the repo's original
  `core.hooksPath`.

### Concurrent markDone / remove on the same id

- **File:** backend/daemon/src/daemon/daemon.ts:1731-1748, 1755-1784
- **Severity:** low
- **Issue:** Both handlers are `async` and both only guard with an initial
  `this.#registry.get(id)`. Interleaved (`markDone` awaits `interrupt`, `remove`
  awaits `close`), `remove` can delete the row while `markDone` is suspended;
  `markDone` then resumes and calls `this.#registry.setStatus(id, stateDone)` /
  `emitSessionUpdated` on a now-deleted session.
- **Fix:** Serialize lifecycle ops per session id (a small per-id mutex), or
  re-check existence after each await.

---

## Clean / not a concern

- **No shell injection anywhere.** Every git call is `spawnSync("git", [...])`
  with the array form and no `shell: true` (`worktrees.ts:351`, `commit.ts:56`).
  User-influenced values (`slugify` output, `loom/<uuid>` branch names, absolute
  tree paths) can't begin with `-` and aren't shell-interpreted.
- **Slug / branch uniqueness** is sound: `#uniqueSlug` checks both `list()` and
  `existsSync`, `#uniqueBranch` / `#uniqueBranchNamed` probe
  `rev-parse --verify --quiet` with sensible suffix + time-based fallbacks. Because
  every git call in `create()` is blocking `spawnSync` and the whole worktree
  build runs before the handler's first `await`, two concurrent `session.create`
  calls can't interleave their ref creation.
- **Branch-name derivation is consistent:** `loom/<id.slice(0,8)>` with a
  full-id fallback on collision, and `#maybeAutoTitle` checks _both_ forms
  (`daemon.ts:873`) before renaming.
- **Normal-path rebase conflict handling** leaves the tree unchanged: abort runs,
  `outcome:"conflict"`, operator nudged once per base commit.
- **Compaction correctly drops checkpoints** (`daemon.ts:266-269`) since absolute
  message offsets are invalidated — undo-past-compaction is explicitly refused.
- **Fork failure teardown is thorough** (`daemon.ts:1544-1568`): closes the
  session, force-removes the worktree, cascades the row delete, and — when the
  tree can't be removed — keeps an `error` row so `session.gc {id}` can reclaim it.
- **`scaffold.ts`** is inert w.r.t. this area (user-config copy only), no issues.
- **`.loom/hooks/pre-push`** matches the embedded `PRE_PUSH_HOOK` string and
  hard-exits 1; fine as far as it goes (see the two hook findings above for the
  ways it can end up not wired in).
