# Review — Session manager / status machine / registry / session-state / titler

Area owner files:
- `backend/daemon/src/daemon/session-manager.ts`
- `backend/daemon/src/daemon/status-machine.ts`
- `backend/daemon/src/daemon/registry.ts`
- `core/src/session-state.ts`
- `backend/daemon/src/daemon/titler.ts`

Findings ranked most severe first.

---

### A trailing permission / question / plan_review event resurrects a killed turn
- **File:** status-machine.ts:49-62 (with session-manager.ts:285-296, 370-393)
- **Severity:** high
- **Issue:** `deriveStatus` returns `stateAwaitingInput(...)` **unconditionally** for `permission_request`, `question`, and `plan_review` — there is no `terminal(current)` guard on those three cases (unlike `assistant_text` / `tool_call` / `result`, which respect stickiness). `interrupt()` sets `stateInterrupted("user")` and clears `run.pending`, but it does **not** stop the pump; the adapter stream keeps delivering the killed turn's trailing frames. A turn with parallel tool calls emits its gate `permission_request`s as the SDK unwinds after an interrupt. Each such trailing event runs through `#applyStatus` → `deriveStatus` → `stateAwaitingInput`, which clobbers `interrupted`, and through `#trackPending`, which re-populates `run.pending`. Result: the user hits stop, the row flips back to `awaiting_input`, and the UI shows an approval prompt for a turn that no longer exists. The comment in `interrupt()` ("`interrupted` is sticky in `deriveStatus`, so trailing events from the killed turn won't undo it") is only true for model-output events, not for blocking-request events. Same hole lets a trailing gate override a settled `error`.
- **Fix:** In `deriveStatus`, gate the three blocking-request cases with `if (terminal(current)) return current;` (a genuinely new turn's gate only arrives after the manager's send/answer path has already moved the state off `interrupted`/`error`). Additionally have `#trackPending` ignore `permission_request`/`question`/`plan_review` while `run.state` is terminal so `run.pending` doesn't silently refill.

---

### `send()` force-transition to `running` races the just-started turn and can hide a real block
- **File:** session-manager.ts:341-360
- **Severity:** medium
- **Issue:** `injected` is read from `run.state` *before* `await run.session.send(text)`, then for a non-injection the method does an unconditional `this.#transition(id, run, stateRunning)` *after* the await. The pump runs concurrently during that await. If the prior state was `idle` and the new turn starts fast and reaches a permission gate (or emits its own `result`/error) before `session.send()` resolves, the pump sets the correct state (`awaiting_input`, `idle`, `error`) and then `send()` overwrites it with `running`. `run.pending` still holds the gate entry, but nothing re-derives `awaiting_input` (only a *new* `permission_request` event or `#resumeAfterAnswer` moves it), so the session can sit displaying `running` while the turn is actually blocked. `#resumeAfterAnswer`'s `pending.size` guard does not help here.
- **Fix:** Only apply the optimistic `stateRunning` if the tracked state is still the pre-send value (compare with `sameSessionState`), or skip the optimistic transition when `run.pending.size > 0` / when the state already advanced. Alternatively capture the state once and CAS it.

---

### Turn-control methods don't check `run.ended`; adapter calls hit a dead session
- **File:** session-manager.ts:370-471 (`interrupt`, `respondToPermission`, `answerQuestion`, `respondToPlan`, `setMode`, `setModel`, `setEffort`, `rewind`)
- **Severity:** medium
- **Issue:** `send()` and `compact()` guard with `if (run.ended) throw new Error("session has ended")`, but the other eight turn-control entry points only call `#require(id)` (present-in-map check). A session whose stream ended is `ended = true` but stays in `#running` until `close()`. In that window — which also leaves `run.pending` populated (see next finding) — a client can call `respondToPermission` / `answerQuestion` / `respondToPlan`, all of which will `await run.session.<method>()` on a torn-down adapter session. Depending on the adapter that throws (surfacing as a generic RPC error) or hangs. `rewind` similarly proceeds on an ended session, transitioning it to `idle` and hiding the real terminal state.
- **Fix:** Factor an `#requireLive(id)` helper that also rejects `run.ended`, and use it for every method that forwards to the adapter. `respondTo*` may prefer returning `{ ok: false, alreadyResolved: true }` instead of throwing.

---

### Stream-ended path leaves `run.pending` populated (interrupt clears it)
- **File:** session-manager.ts:160-168
- **Severity:** medium
- **Issue:** When the adapter stream ends while `awaiting_input`, `#drain` transitions to `stateInterrupted("stream_ended")` but never clears `run.pending` — unlike `interrupt()`, which does `run.pending.clear()`. Stale request ids remain "resolvable": a later `respondToPermission(id, ...)` finds the id in `pending`, deletes it, and forwards to the dead adapter session (compounded by the missing `run.ended` guard above). `#resumeAfterAnswer` could then even transition the corpse to `running`.
- **Fix:** In the stream-ended branch (and the catch branch), `run.pending.clear()` alongside setting `run.ended`.

---

### Cost `NaN` from the adapter propagates into the usage rollup
- **File:** session-manager.ts:266-283 (`costUsd: ev.costDeltaUsd ?? 0`), and daemon.ts:891-905 (`#priceUsage`)
- **Severity:** medium
- **Issue:** `?? 0` only replaces `null`/`undefined`. If an adapter computes `costDeltaUsd` as `NaN` (unknown model → `tokens * undefinedRate`), the `NaN` flows straight into `onUsage` → `registry.addUsage` → the persisted total, permanently poisoning `costUsd`. The daemon's `#priceUsage` fallback does not rescue it either: `if ((delta.costUsd ?? 0) > 0)` is `false` for `NaN`, so it returns the delta with `costUsd: NaN` untouched whenever the model isn't in the local price table.
- **Fix:** Sanitize at the boundary: `const c = Number(ev.costDeltaUsd); costUsd: Number.isFinite(c) ? c : 0`. Consider the same guard on `contextUsed`/`contextLimit`.

---

### Version counter resets to 1 on daemon restart — breaks `session_updated` de-dup / stale-guard
- **File:** registry.ts:24-25, 35-39, 99-102
- **Severity:** medium
- **Issue:** `#versions` is an in-memory `Map` that starts empty on every daemon boot; the DB row survives but its version does not. After a restart the first `#bump` for a persisted session yields `1`. A client (or reconnecting TUI) that remembers version `7` from before the restart now receives events tagged version `1`, which is `< 7`; any "ignore if not newer than what I have" logic drops fresh updates until the counter climbs back past the client's high-water mark.
- **Fix:** Seed `#versions` from a persisted per-session counter (bump a `version` column in `setStatus`/`addUsage`/`setFields`), or reset clients' expectations on reconnect by sending a full snapshot with an explicit "version epoch". At minimum, initialize `#versions` lazily to a monotonic value derived from `updatedAt` or a boot nonce so it never goes backwards within a client session.

---

### Titler emits a partial / truncated title on timeout instead of bailing
- **File:** titler.ts:114-128
- **Severity:** medium
- **Issue:** The timeout callback only does `session.close()`. That makes the `for await` loop throw or end; control falls to `finally`, and the function then returns `cleanTitle(text)` over whatever partial `assistant_text` had accumulated. A slow model that streamed half a phrase before the 30 s cutoff yields a mangled title ("Refactor the session man…") that then replaces the clipped first message. There's no signal that the run was aborted.
- **Fix:** Track an `aborted` flag set by the timer; in `finally`/after the loop, `if (aborted) return null`. Only accept `text` when a real `result` (or clean end) was observed.

---

### Raw token counts are summed additively though only `costDeltaUsd` is declared a delta
- **File:** session-manager.ts:266-283
- **Severity:** medium
- **Issue:** `#trackUsage` feeds `ev.tokens.input/output/cacheRead/cacheWrite` into an additive `UsageDelta` on every `usage` event. Only `costDeltaUsd` is explicitly a *delta* by name; `ev.tokens.*` are not. If any adapter emits `usage` more than once per turn with cumulative-per-turn token figures (Claude's SDK emits incremental usage messages), the rollup double-counts input/output/cache tokens while cost stays correct — silent usage inflation. `lastCacheRead`/`lastCacheWrite` are also set from the same field, implying "last" (level) semantics for cache, which sits uneasily with `cacheRead`/`cacheWrite` being treated as add.
- **Fix:** Pin down and document the contract: either every adapter guarantees `usage` carries a per-event delta (add a normalization step in the adapter), or `#trackUsage` must diff against the last seen cumulative value per session before calling `onUsage`.

---

### `result` error branch neither truncates nor null-guards `ev.error`
- **File:** status-machine.ts:109-119
- **Severity:** low
- **Issue:** The fatal-`error`-event branch runs `truncate(ev.message)`, but the failed-`result` branch does `return stateError(ev.error)` verbatim. `ev.error` may be `undefined` (→ `{ kind: "error", message: undefined }`, then persisted via `sessionStateDetail` as `undefined`/null and rendered as bare "error"), and an arbitrarily long provider error string goes unbounded into the state object and the `status_detail` column.
- **Fix:** `return stateError(truncate(ev.error ?? "unknown error"));`

---

### `setKeepWarm` clears the give-up counter on every call, including idempotent re-asserts
- **File:** session-manager.ts:308-313 (with daemon.ts:970-999, fleet-handle.ts:673)
- **Severity:** low
- **Issue:** `setKeepWarm(id, on)` always does `this.#warmPings.delete(id)`. `warmPingCount` drives `keepWarmMove(...)`'s `"giveup"` decision (stop re-priming after `KEEP_WARM_MAX_PINGS` unanswered pings). Any path that re-sends `session.setKeepWarm { on: true }` while it's already on — a TUI toggle bounce, a reconnect re-assertion — resets the counter to 0, so a session nobody is answering can be re-primed indefinitely, never hitting `"giveup"`.
- **Fix:** Only reset `#warmPings` on an actual on→off or off→on edge (track prior membership), not on a no-op re-assert. Do not clear it when `on` is already reflected in `#keepWarm`.

---

### Ordinal counter restarts at 0 on resume / restart, colliding with persisted ordinals
- **File:** session-manager.ts:124-140, 144-145
- **Severity:** low
- **Issue:** `#attach` always creates `ordinal: 0`, and `#drain` stamps every event `ordinal: run.ordinal++`. On `resume()` after a daemon restart, the reattached session's new events get ordinals 0,1,2… which overlap the ordinals already written to the push log for that session pre-restart. Any consumer that orders or de-dupes by `ordinal` will interleave post-restart events among old ones.
- **Fix:** Seed `run.ordinal` from the max ordinal already persisted for the session (or from a per-session monotonic column), or make the ordinal a `(bootEpoch, seq)` pair.

---

### Class doc claims per-session serialization of turn control that the code doesn't enforce
- **File:** session-manager.ts:1-7, 341-471
- **Severity:** low
- **Issue:** The header says turn control "funnels through here so it is serialized per session". The methods are plain `async` with no per-session mutex/queue; two overlapping `send()` (or `send()` + `interrupt()`) calls both read state, both `await` the adapter, and interleave their post-await transitions freely. Today the daemon happens to call them from single RPC handlers, but the invariant is asserted, not implemented.
- **Fix:** Either add a real per-session promise chain (`run.turnLock = run.turnLock.then(() => op())`) or soften the comment to say the daemon is expected to serialize callers.

---

### `interrupt()` / `rewind()` accept non-live / terminal states and can overwrite a clean end
- **File:** session-manager.ts:370-393, 464-471
- **Severity:** low
- **Issue:** `interrupt()` does no state check at all — calling it on an already-`idle` or `error` session clears `pending`, fires `onBackgroundTasks`, and transitions to `stateInterrupted("user")`, replacing a legitimate terminal state with a spurious "interrupted by user". `rewind()` blocks only `running`/`starting`, so it will proceed while `awaiting_input` or `working_background` without clearing `run.pending` or the background-task overlay, leaving stale entries after the transition to `idle`.
- **Fix:** `interrupt()` should no-op (or just best-effort call the adapter) when `!isLiveState(run.state)`. `rewind()` should also reject `awaiting_input`/`working_background`, and clear `run.pending` + `run.backgroundTasks` as part of the rewind transition.

---

### `#drain`: a throwing hook kills the drain loop and can produce an unhandled rejection
- **File:** session-manager.ts:142-176
- **Severity:** low
- **Issue:** Every per-event hook (`emitEvent`, `onStatus`, `onUsage`, `onResult`, `onSubagents`, `onBackgroundTasks`) is called synchronously inside the `for await`. A transient throw from any of them (e.g. a store write failure inside `onUsage`/`onStatus`) is caught by the outer `catch`, which marks the whole session `error` and stops draining — a persistence hiccup tears down a live session. Worse, the `catch` body itself calls `emitEvent` and `#transition` → `onStatus` again; if those throw, `#drain` rejects. `run.pump` is only ever awaited by `close()`/`shutdown()` (`.catch(() => {})`), so a session torn down via `registry.remove`/other paths leaves the rejected `pump` promise unhandled.
- **Fix:** Wrap the per-event hook fan-out in a try/catch that logs and continues the loop (don't let a downstream failure end the drain). Ensure the outer `catch` can't itself throw (guard the re-emit), and always attach a `.catch` to `run.pump` at creation.

---

## Sub-areas that look sound

- `sortSnapshots` / `GROUP_RANK` (registry.ts): complete over `SessionStateKind`, `?? 9` fallback, and the `awaiting_input` "oldest first" vs "most recent first" split matches the comment. No issue.
- `session-state.ts` unions, `foldSessionState` (exhaustive with `absurd`), `sameSessionState` (compares payloads per variant), `isLiveState` (correctly includes `working_background`). `parseSessionState` is total and defensive; only nit is that an unknown `kind` silently becomes `idle` (acknowledged in its comment).
- `deriveStatus` `background_tasks` handling (idle↔working_background at settled edges only) and the `starting`-only unstick for `answer`/`tool_result` are carefully reasoned and look correct.
- `#trackRateLimit` merge-per-window semantics and `rateLimitsOf` are fine.
- Titler `cleanTitle` sanitization and the daemon's `titleLocked` double-check (before and after `generateTitle`, plus the `#titling` set) close most of the manual-rename race; only a sub-millisecond window between the second `titleLocked` check and `setFields` remains.

---

## tl;dr

Top risks: (1) trailing `permission_request`/`question`/`plan_review` events have no terminal-state guard in `deriveStatus`, so a killed or errored turn's late gates flip the session back to `awaiting_input` and repopulate `pending`; (2) `send()`'s post-await unconditional `stateRunning` can race and mask a real block from the turn it just started; (3) eight turn-control methods skip the `run.ended` check that `send`/`compact` have, so they forward to a dead adapter session, and the stream-ended path (unlike `interrupt`) never clears `run.pending`; (4) `NaN` cost from an adapter survives `?? 0` and both daemon guards, poisoning the persisted total; (5) the registry version counter resets to 1 on daemon restart, defeating `session_updated` de-dup for reconnecting clients; (6) the titler returns a truncated partial title on timeout instead of `null`; (7) raw token counts are summed additively though only cost is a declared delta — double-count risk if any adapter emits cumulative `usage`.
