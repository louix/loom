# Daemon lifecycle / startup-shutdown / socket server — review findings

Area: `backend/daemon/src/daemon/{daemon,lifecycle,hygiene,server,connection}.ts`
Review is read-only; nothing was modified.

---

### Net server loses its `error` listener after a successful `listen()`

- **File:** backend/daemon/src/daemon/server.ts:59-71
- **Severity:** medium
- **Issue:** `listen()` attaches `server.once("error", reject)` only for the bind phase and then `server.removeListener("error", reject)` on success. After that the `net.Server` has **no** `error` listener for the rest of its life. Node `net.Server` still emits `error` post-listen for accept-time failures (`EMFILE`/`ENFILE` "too many open files", `ENOBUFS`, some `ECONNABORTED` variants). An unhandled `error` event on an `EventEmitter` is rethrown as an uncaught exception, so a transient fd exhaustion while a session is spawning subprocesses takes the whole daemon down instead of just failing one accept.
- **Fix:** Keep a permanent `server.on("error", ...)` installed for the server's lifetime that logs and (for fatal codes) triggers `stop()`; use a separate one-shot listener only to reject the bind promise.

---

### Signal handlers aren't installed until the end of `#bringUp`, and a `#bringUp` failure after `acquirePidfile` leaks resources

- **File:** backend/daemon/src/daemon/daemon.ts:357-398 (also 224-319, 321-325)
- **Severity:** medium
- **Issue:** `#bringUp()` acquires the pidfile first (line 359) but installs `SIGINT`/`SIGTERM` handlers only near the end (line 383), _after_ `#resolveAutoModels()` and `#resolveClaudeModels()`, which each do bounded-but-real network I/O (up to ~10s for the Claude probe). Two problems in that window:
  1. A `SIGTERM`/`SIGINT` during model resolution hits the Node default (immediate terminate) — no `releasePidfile`, no `db.close()`, no `server.close()`. Recoverable only because the next start's stale-pid check cleans the orphaned pidfile.
  2. There is no `try/catch` in `#bringUp` or `Daemon.start`. If anything after `acquirePidfile` throws (`server.listen()` racing `EADDRINUSE`, an unexpected throw from a provider's `listModels`, hygiene throwing), `start()` rejects with the pidfile still on disk (pointing at the _live_ CLI pid) and the DB handle (opened in the constructor, line 242) still open. If the host process doesn't exit promptly, that pidfile blocks every future start.
- **Fix:** Install signal handlers before the slow probes (or immediately after `acquirePidfile`). Wrap `#bringUp` in `try { ... } catch (e) { await this.#teardownPartial(); throw e; }` that releases the pidfile, closes the DB, closes any listening socket, and clears the warm-sweep interval.

---

### Shutdown has no timeout and no escalation on a second signal — one wedged adapter makes the daemon unkillable and strands the pidfile

- **File:** backend/daemon/src/daemon/daemon.ts:400-434, 436-444; backend/daemon/src/daemon/session-manager.ts:490-505
- **Severity:** medium
- **Issue:** `stop()` does `await this.#sessions.shutdown()` with no time bound; `SessionManager.shutdown()` is `await Promise.all(runs.map(... await run.session.close(); await run.pump ...))` — also unbounded. If one provider adapter's `close()` (or its event pump) never settles, `stop()` hangs before `releasePidfile()` (line 429). The `SIGINT`/`SIGTERM` handler (`fn = () => void this.stop(sig)`) is guarded by `#stopping`, so hammering Ctrl-C just returns the already-pending `#closed` promise — there is no "second signal → `process.exit`" path. Net effect: a stuck child wedges shutdown indefinitely, `whenClosed()` never resolves, and the pidfile (naming a still-alive pid) blocks restart until the operator `kill -9`s it.
- **Fix:** Race `#sessions.shutdown()` against a few-second timeout (like the existing `#titleJobs` race at line 416-421), then proceed to force-close. On a second `SIGINT`/`SIGTERM` received while `#stopping`, `process.exit(1)`.

---

### Push fan-out ignores socket backpressure — one stuck client grows daemon memory unboundedly

- **File:** backend/daemon/src/daemon/connection.ts:73-89; backend/daemon/src/daemon/server.ts:93-95
- **Severity:** medium
- **Issue:** `Connection.#write` calls `this.socket.write(...)` and never inspects the return value or listens for `drain`; `SocketServer.broadcast` pushes every `PushFrame` to every subscribed connection. A subscribed client that stops reading (suspended TUI, SIGSTOP, slow link) causes every subsequent event/`session_updated`/notice frame to accumulate in that socket's Node write buffer with no high-water-mark disconnect and no drop policy. During a busy multi-session run this is unbounded heap growth in the daemon driven by a single misbehaving client. `MAX_FRAME_BYTES` only bounds the _inbound_ parse buffer, not outbound.
- **Fix:** Track `socket.write()` returning `false`; if a connection stays un-drained past a threshold (bytes or time), drop it with a `resync`-style disconnect so it reconnects and backfills via `sinceSeq`. Optionally coalesce `session_updated` frames per session while backed up.

---

### `reapChildren` forgets the bookkeeping row before the child is confirmed dead; SIGKILL escalation is on an `unref`'d timer

- **File:** backend/daemon/src/daemon/hygiene.ts:59-97
- **Severity:** low-medium
- **Issue:** For a stale-epoch child it sends `SIGTERM`, schedules an `unref`'d `setTimeout(2000)` for `SIGKILL`, then immediately `children.forget(row.pid)` and counts it reaped. If the child ignores `SIGTERM` and the new daemon exits (or is itself killed) within ~2s, the `unref`'d timer never fires, the child survives, and its ChildStore row is already gone — so the _next_ restart's `reapChildren` has nothing to act on and the process is orphaned permanently. The "reaped" count in the hygiene report also overstates what actually terminated.
- **Fix:** Only `forget` after confirming `!pidAlive(pid)`, or keep the row until the escalation path has run. Consider a short synchronous re-check loop instead of a fire-and-forget `unref`'d timer for the startup path.

---

### `#reloadConfig` aliases `this.config` as `before` then mutates it in place; restart-detection is correct only by accident

- **File:** backend/daemon/src/daemon/daemon.ts:1045-1091
- **Severity:** low-medium
- **Issue:** `const before = this.config` (line 1055) is a reference, not a copy. The hot-apply block then mutates `this.config` (`worktree`, `autoRebase`, `notify`, `titles`, and `daemon.idleShutdownMinutes`) — i.e. it mutates `before` too. The subsequent `needsRestart` diff (lines 1074-1082) compares `next.*` against this now-partially-mutated `before`. It happens to produce the right answer today only because the mutated keys are disjoint from the keys `needsRestart` tests. Any future field that is both hot-applied and restart-relevant will silently stop triggering the restart nudge. Separately, only `daemon.idleShutdownMinutes` is reconciled from `next.daemon`; other `daemon.*` changes (except `eventBufferSize`) are neither applied nor flagged.
- **Fix:** Snapshot `before` with a deep copy (or `structuredClone`) before mutating, and diff `next` against that snapshot. Explicitly enumerate every `daemon.*` field as either hot-applied or restart-required.

---

### Model probes block the socket from accepting for up to ~10s at startup

- **File:** backend/daemon/src/daemon/daemon.ts:374-380
- **Severity:** low-medium
- **Issue:** `await this.#resolveAutoModels()` and `await this.#resolveClaudeModels()` run before `await this.#server.listen()`. The Claude probe is a 10s-timeout `Promise.race`; `#resolveAutoModels` is an 8s-timeout fetch per aisdk auto-model provider (parallelised). A `loom` CLI that just spawned the daemon and is polling the socket waits out that latency, and the window also widens the unhandled-signal gap in the finding above.
- **Fix:** `listen()` first, then resolve models in the background and emit a `notice` / `session_updated`-style refresh of `providers.list` when they land. Session creation already fails with a clear message if a model isn't resolved yet.

---

### `tidyWorktrees` deletes `index.lock` unconditionally

- **File:** backend/daemon/src/daemon/hygiene.ts:99-133
- **Severity:** low
- **Issue:** On startup it `rmSync`s any `.git/index.lock` / `index.lock` it finds under `.loom/trees/*` with no check that the owning `git` process is actually dead (no pid file inspection, no mtime/age heuristic). The assumption "a prior daemon's killed git left this" is usually true, but if an operator (or an editor's git integration) has a legitimate `git` operation in flight in a Loom worktree at the moment the daemon restarts, removing its lock mid-operation risks index corruption.
- **Fix:** Only remove locks older than some threshold (e.g. mtime > 30s), or check `.git`'s referenced gitdir for a live `git` pid, before unlinking.

---

### `stop()` has no `try/finally` guaranteeing `#resolveClosed()` and `releasePidfile()`

- **File:** backend/daemon/src/daemon/daemon.ts:400-434
- **Severity:** low (latent)
- **Issue:** Only the `checkpoint`/`db.close()` step is wrapped in `try/catch`. `#sessions.shutdown()`, the `#titleJobs` race, and `#server.close()` are `await`ed bare. Today none of them reject (all are written defensively), so this is latent — but a future change that lets any of them throw would leave `#stopping === true`, `#closed` forever unresolved (so `whenClosed()` hangs the host process and a retry `stop()` just returns the dead promise), and the pidfile — naming a still-live pid — left on disk blocking restart.
- **Fix:** `try { ...teardown... } finally { if (this.#pidfile) releasePidfile(this.paths.pid); this.#resolveClosed(); }`.

---

### Claude model-discovery timeout timer is never cleared

- **File:** backend/daemon/src/daemon/daemon.ts:585-590
- **Severity:** low
- **Issue:** `Promise.race([provider.listModels(), new Promise((_, rej) => setTimeout(() => rej(...), 10_000).unref?.())])`. On the fast path the 10s timer is never cleared. It's `unref`'d so it won't hold the loop open, and `Promise.race` keeps a rejection handler attached so there's no unhandled rejection — but it's a dangling timer, and the `.unref?.()` optional-call (Node's `setTimeout` always returns a `Timeout` with `.unref`) suggests the author wasn't sure of the shape. Same untidiness pattern would apply anywhere this idiom is copied.
- **Fix:** Hoist the timer handle and `clearTimeout` it in a `finally`, or use `AbortSignal.timeout(10_000)` as `#resolveAutoModels`'s `probeOpenAiModels` already does.

---

### `acquirePidfile` writes the pidfile non-atomically

- **File:** backend/daemon/src/daemon/lifecycle.ts:24-54
- **Severity:** low
- **Issue:** `writeFileSync(path, body, { flag: "wx" })` is a create+write, not atomic. A crash between create and write (or a torn write) leaves invalid JSON; the next start's `JSON.parse` throws, `existing` becomes `null`, and the file is treated as stale and unlinked. The payload is tiny so a torn write is very unlikely, but if it ever happened to a _live_ daemon's pidfile, a second start would delete it and both daemons would run.
- **Fix:** Write to `path + ".tmp"` then `renameSync` into place (rename is atomic on the same filesystem); keep the `wx` exclusivity on the final name via a link/rename check, or accept the tmp+rename and rely on the `pidAlive` check.

---

## Sub-areas with nothing serious found

- **`IdleTimer` (lifecycle.ts:75-117):** logic is sound — `poke(true)` clears, `poke(false)` is idempotent while counting, `setMinutes` re-arms cleanly, `#ms === 0` disables. `#reloadConfig` correctly `setMinutes` + re-`poke`s.
- **`releasePidfile` (lifecycle.ts:56-68):** correctly no-ops when the file is gone, corrupt, or owned by another pid.
- **Double-`stop()` (daemon.ts:400-401):** guarded by `#stopping`, returns the shared `#closed`.
- **`emitEvent` / `#emitSessionUpdated` / `#emitNotice` during shutdown:** all early-return on `#stopping`, so no writes to a closing DB or a closed socket set.
- **`isSocketLive` probe (server.ts:130-143):** cleans up its probe socket (`removeAllListeners` + `destroy`) and has a 500ms `unref`'d fallback; combined with the pidfile guard this adequately prevents two daemons racing the same repo.
- **`Connection` framing (connection.ts):** inbound size cap, unparseable-line skip, `#onClose` fires exactly once on both local `close()` and remote close.
- **`RpcDispatcher.handle` (rpc.ts):** catches everything and always resolves a `ResponseFrame`, so `server.ts`'s `#onFrame` `.then(...)` without a `.catch` cannot leak an unhandled rejection.
- **`session.fork` / `session.create` failure paths (daemon.ts:1318-1336, 1517-1568):** worktree/branch/row teardown on partial failure is thorough, including the "tree still on disk → keep an `error` row for later `gc`" case.
