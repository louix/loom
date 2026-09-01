# Review area 08 — SQLite store + migrations, config loader, pricing, claude-profile, provider registry, MCP fallback

READ-ONLY review. Files under `backend/daemon/src/{store,config,daemon}`.

Environment note: `node:sqlite` here is SQLite 3.51.2 (Node 24), so `ALTER TABLE … DROP/RENAME COLUMN`
in migrations 10/12 is syntactically supported. Migrations are also individually transactional
(`BEGIN … COMMIT` per step in `db.ts:44-53`, `schema_version` bumped inside the txn), so a crash
mid-migration resumes cleanly at per-migration granularity. Those sub-areas are sound.

---

### No "database is newer than this build" guard — old daemon silently runs a newer schema
- **File:** backend/daemon/src/store/db.ts:38-40
- **Severity:** medium
- **Issue:** `migrate()` does `if (from >= MIGRATIONS.length) return;` and then proceeds. If a DB was
  migrated by a newer build (e.g. to v12, which *renamed* `await_reason` → `status_detail` and
  *dropped* the four `budget_*` columns) and an older daemon binary later opens it — a stale
  TUI-spawned daemon racing a freshly-installed one, a user downgrade, a second checkout on an
  older tag — the old code runs against a schema it doesn't understand. `SessionStore` does
  `SELECT * FROM sessions` and the old `toSnapshot`/reader expects `await_reason`; it now gets
  `undefined`, so every session's status/await-reason is silently wrong, and any old code path that
  named a dropped column in SQL throws at runtime. There is no downgrade fence.
- **Fix:** In `migrate()`, if `from > MIGRATIONS.length` throw a clear
  `database schema vN is newer than this build (supports vM)` and refuse to open, rather than
  falling through.

### Compound store writes are not wrapped in a transaction (no `withTransaction` helper anywhere)
- **File:** backend/daemon/src/store/sessions.ts:96-123 (`create`), 143-151 (`setStatus`), 156-171 (`markMidRunInterrupted`); backend/daemon/src/store/provider-messages.ts:59-71 (`replaceFrom`)
- **Severity:** medium
- **Issue:** Each of these performs multiple independent `.run()` calls, every one auto-committed.
  A crash or thrown exception between statements leaves the DB half-written:
  - `create()` inserts into `sessions`, then `usage`, then `status_history`. Interrupted after the
    first insert → a session with **no `usage` row**. `get()` tolerates that (falls back to
    `ZERO_USAGE`), but every later `addUsage()` then does `UPDATE usage … WHERE session_id = ?`
    which matches 0 rows — usage/cost/turn tracking is permanently dead for that session with no error.
  - `setStatus()` updates `sessions` then appends `status_history` — a gap yields a status with no
    audit row (or, if reordered by a future edit, the reverse).
  - `markMidRunInterrupted()` loops update+insert per row with no outer txn — a partial sweep on the
    crash-recovery path.
  - `replaceFrom()` does `DELETE … seq >= fromSeq` then `append()` of the replacement messages as
    separate statements — interrupted between them leaves an aisdk transcript truncated with **no
    summary**, corrupting `resumeSession`.
- **Fix:** Add a tiny `withTransaction(db, fn)` helper (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`)
  and wrap each compound operation.

### `pricing.reload` RPC has no error handling, unlike config reload
- **File:** backend/daemon/src/daemon/daemon.ts:1136-1139; backend/daemon/src/config/pricing.ts:52-61
- **Severity:** low-medium
- **Issue:** `#reloadConfig()` carefully catches a malformed-TOML throw and keeps the running config
  with an operator notice (daemon.ts:1050-1054). The `pricing.reload` handler calls
  `loadPriceTable(...)` bare. `loadPriceTable` re-throws any non-`ENOENT` error (parse error,
  EACCES) as `failed to read price table …`. The current `#pricing` table is retained because the
  assignment never runs, but the operator just sees an opaque RPC failure with no
  "kept the running price table" feedback, and a scripted reload loop surfaces it as a hard error.
- **Fix:** Mirror `#reloadConfig`: try/catch, keep `this.#pricing`, emit a notice.

### `deepMerge` does not skip `__proto__` / `constructor` keys; TOML can supply them
- **File:** backend/daemon/src/config/config.ts:549-571
- **Severity:** low
- **Issue:** `smol-toml` parses `[__proto__]` into an object with an *own* `__proto__` key
  (verified). `deepMerge` iterates `Object.entries(over)` and does `out[k] = v`; for `k === "__proto__"`
  that invokes the prototype setter and changes the merged object's prototype. Global
  `Object.prototype` is *not* reachable this way (the spread `{...base}` breaks the chain and
  `constructor` is a function so recursion is skipped), and `normalizeConfig` only reads known keys,
  so real-world impact is contained. But `.loom/config.toml` is read from whatever repo the daemon
  is pointed at — a cloned untrusted repo is an input here — so defensively dropping
  `__proto__`/`constructor`/`prototype` keys in `deepMerge` (and/or `asRecord`) is cheap hardening.
- **Fix:** `if (k === "__proto__" || k === "constructor" || k === "prototype") continue;` in the loop.

### Migration loop reads `currentVersion()` outside the guarding transaction; `BEGIN` is not `IMMEDIATE`
- **File:** backend/daemon/src/store/db.ts:38-55
- **Severity:** low (mitigated by the per-repo single-instance pidfile)
- **Issue:** `from = currentVersion(db)` is read before the loop's `BEGIN`. If two daemon processes
  ever hold the same `loom.db` open near-simultaneously (stale/force-removed `daemon.pid`, tests,
  a future multi-worktree mode), both read the same `from`, and the loser replays an
  already-applied non-idempotent `ALTER TABLE … RENAME/DROP COLUMN`, throwing
  `migration N failed: no such column` on startup. Plain `BEGIN` (deferred) also upgrades
  reader→writer lazily and can hit `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does not retry.
- **Fix:** Use `BEGIN IMMEDIATE`, then re-read `schema_version` *inside* the transaction and skip
  the step if already applied.

### `readClaudeAccount` ignores `CLAUDE_CONFIG_DIR`
- **File:** backend/daemon/src/config/claude-profile.ts:76-105; consumed at backend/daemon/src/daemon/daemon.ts:634
- **Severity:** low
- **Issue:** The base `claude` profile's `dir` is `~/.claude` (DEFAULT_CONFIG). `provider-registry`
  deliberately passes `configDir: ""` for that id so the SDK does its own resolution — which honours
  `CLAUDE_CONFIG_DIR`. `readClaudeAccount` does not: it always reads `~/.claude/.credentials.json`
  and `~/.claude.json`. With `CLAUDE_CONFIG_DIR` pointed elsewhere the provider list shows a stale or
  empty `<login method> (<org>)` while sessions actually authenticate against the other dir.
  Display-only inaccuracy.
- **Fix:** When resolving the base `claude` profile dir for the account read, prefer
  `process.env.CLAUDE_CONFIG_DIR` if set.

### `scaffoldUserConfig` — existsSync/copyFileSync TOCTOU, no `COPYFILE_EXCL`
- **File:** backend/daemon/src/scaffold.ts:28-40
- **Severity:** low
- **Issue:** `existsSync(dest)` then `copyFileSync(src, dest)` with no exclusive flag. The
  single-instance guard is per-repo, so two daemons for two different repos on first run can both
  see no `~/.config/loom/config.toml` and both write it; the second overwrites the first.
  Contents are the identical shipped example so it is harmless in practice, but a copy racing a
  user's very-early hand-edit would clobber it.
- **Fix:** `copyFileSync(src, dest, constants.COPYFILE_EXCL)` and treat `EEXIST` as "already present".

### Per-session event / status history tables grow unbounded
- **File:** backend/daemon/src/store/session-events.ts (whole); backend/daemon/src/store/sessions.ts:303-307 (`#appendHistory`)
- **Severity:** low
- **Issue:** `session_events` and `status_history` get an append per event / per status transition
  with no pruning, TTL, or cap, and nothing in the codebase ever runs `VACUUM`. `SessionEventStore.list`
  caps the *read* at 500 rows but the table keeps growing for the life of the project; a busy,
  long-lived repo sees monotonic `loom.db` growth (plus WAL) that is never reclaimed even after
  `session.delete` (which cascades the rows but leaves free pages).
- **Fix:** Trim `session_events` to the last N per session on write (or a periodic sweep), and/or
  run `PRAGMA incremental_vacuum` / `VACUUM` on a schedule.

### `addUsage` NaN guard is bypassed for `lastTurnAt`
- **File:** backend/daemon/src/store/sessions.ts:216-263
- **Severity:** low
- **Issue:** The method explicitly coerces every additive/absolute field through `acc`/`accFloat`/`abs`
  to keep a provider's `NaN`/`Infinity` from poisoning a column (see its own comment). But
  `d.lastTurnAt ?? null` is bound directly — a `NaN` would pass the `?? null` check and reach the
  bind. `lastTurnAt` is currently sourced from daemon wall-clock so risk is low, but it is
  inconsistent with the stated intent and the field feeds the cache-liveness countdown.
- **Fix:** Route `lastTurnAt` through the same finite-number guard.

### `resolveMcpCommand` tokenises on whitespace — mis-splits quoted args
- **File:** backend/daemon/src/daemon/mcp-fallback.ts:25-27
- **Severity:** low
- **Issue:** `raw.split(/\s+/)` — a `[[mcp]]` command whose args contain a quoted path with spaces
  (`tilth mcp --root "/my repo/x"`) is split into separate tokens and the quotes are kept literally.
  The built-in defaults (`tilth mcp --edit`, `fff-mcp`) are unaffected.
- **Fix:** Use a minimal shell-style tokeniser that respects quotes, or document that `command`
  must be whitespace-separated with no quoting.

### provider-registry: `mock` id claimed "always known" but not registered
- **File:** backend/daemon/src/daemon/provider-registry.ts:9-11 (comment), 52-56, 100-102
- **Severity:** low (cosmetic)
- **Issue:** The header comment and `#packageFor`/`#contextFor` both handle `"mock"`, but the
  constructor's `#ids` set only adds `"fake"`. `get("mock")` rejects with `unknown provider: mock`.
- **Fix:** Add `"mock"` to `#ids`, or drop it from the comment and the two switch arms.

---

## Clean / no issue found

- **SQL injection:** every query in `store/*` uses `?` placeholders. `SessionStore.setFields`
  (sessions.ts:173-214) builds only `col = ?` fragments and the column names come from a fixed
  whitelist `map`; all values are bound. `ProviderMessageStore.copyTo` / `replaceFrom` interpolate
  nothing. No string-built SQL from caller data anywhere in the area.
- **provider-registry lazy import:** `get()` caches the *promise*, so concurrent `get`s for the same
  id dedupe on one in-flight build; a rejected build is evicted (`built.catch` → `#cache.delete`)
  so a later call retries after the env var is set / package installed. No "cached failed import"
  bug. Version/path resolution (`#packageFor`) is deterministic.
- **claude-profile credential handling:** pure `fs` + `JSON.parse`, every read wrapped in
  try/catch → `null`, mtime-signature cache keyed per dir. Nothing in the module (or its single
  caller) writes `.credentials.json` / `.claude.json`. The "Loom brokers no auth" claim holds.
- **Migration atomicity:** each migration is its own `BEGIN … COMMIT` with `schema_version` set
  inside it, so an interrupted upgrade resumes at the right step. Append-only discipline is
  respected.
- **pricing table hot-swap:** `this.#pricing = loadPriceTable(...)` is a single field reassignment;
  JS is single-threaded so an in-flight `costOf(this.#pricing, …)` reads a consistent old-or-new
  table, never a torn one. `parsePriceTable` skips malformed/negative/all-zero rows.
- **config precedence:** `loadConfig` sets `raw = user` then `deepMerge(raw, repo)` — repo wins, as
  documented. Missing file (`ENOENT`) → `null` → skipped; malformed file → throw (hard-fail on
  first load, caught + kept on hot-reload). Enum fields fall back to defaults on unknown literals.
