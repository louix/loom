# Review — Vercel AI SDK engine (non-Claude providers)

Area: `aisdk/src/{session,loop,map,gate,mcp,provider,loom-tools,transcript}.ts` plus
`aisdk/src/tools/builtins.ts`. SDK pinned at `ai@5.0.249`.

Findings ranked most severe first.

---

### Manual `compact()` / `rewind()` race a concurrently-started turn → transcript corruption
- **File:** aisdk/src/session.ts:252-256, 293-301, 551-617; backend/daemon/src/daemon/session-manager.ts:352-365
- **Severity:** high
- **Issue:** `compact()` and `rewind()` only `await this.#turn` — they do **not** set
  `#turnRunning` or any flag `send()` observes, and `#doCompact` runs for minutes
  (`SUMMARISE_TIMEOUT_MS = 15 min`). During a manual compaction the session is idle:
  `SessionManager.compact` deliberately leaves status alone (session-manager.ts:366-367),
  so a `send()` arriving mid-compaction hits `isLiveState(run.state) === false`
  (session-manager.ts:352), is treated as a *fresh turn*, and calls `session.send()`.
  In the adapter `#turnRunning` is `false`, so `send()` claims the turn and `#kickTurn()`
  runs `#runTurn` **concurrently with the still-running `#doCompact`**. When the summariser
  returns, `#doCompact` does `this.#messages.length = 0; this.#messages.push(...rebuilt)`
  and `store.replaceFrom(id, 0, rebuilt)` (session.ts:601-603), destroying the messages the
  concurrent turn appended in memory and in the store, and leaving `#messages` inconsistent
  with what the model was streamed. `rewind()` during compaction has the same shape
  (truncate, then compaction overwrites). Two `compact()` calls are safe (`#compacting`
  guard), but nothing else respects it.
- **Fix:** Gate every turn-control entry (`send`, `rewind`, `compact`, `#runTurn`'s
  auto-compact) on a single mutex or on `#compacting`. Simplest: in `send()` /`rewind()`,
  `while (this.#compacting) await <compaction promise>`; and track the manual-compaction
  promise the way `#turn` is tracked so `close()`/`interrupt()` can await it too.

---

### `interrupt()` / `close()` do not cancel an in-flight compaction
- **File:** aisdk/src/session.ts:284-291, 325-333, 619-654
- **Severity:** high
- **Issue:** `#summarize`'s only abort is `AbortSignal.timeout(SUMMARISE_TIMEOUT_MS)` — it is
  wired to neither `#abort` nor `#closing`. `interrupt()` aborts `#abort` (null during a
  manual compact) and awaits `#turn` (null), then returns while `#doCompact` keeps running
  for up to 15 minutes; `#interrupted` is set but `#doCompact` never checks it, so it still
  rebuilds the transcript after the user asked to stop. `close()` is worse: it never awaits
  the compaction at all (it only awaits `#turn`), then calls `#outbox.close()`. The
  still-running `#doCompact` then calls `this.#emit(...)` on a closed channel
  (`compact_progress` beats + the final `compact` event) and `store.replaceFrom(...)` after
  the session/store are torn down.
- **Fix:** Hold the summariser's `streamText` on a `linkedSignal` combining
  `AbortSignal.timeout(...)`, `this.#abort?.signal`, and a `#closing` signal. In
  `#doCompact`, bail before the `this.#messages` rewrite if `#closing || #interrupted`.
  Have `close()`/`interrupt()`/`compact()` share one "compaction in progress" promise so
  `close()` can await or cancel it.

---

### `#summarize` accepts a truncated summary → whole transcript replaced by partial text
- **File:** aisdk/src/session.ts:627-653; loop.ts:113-114
- **Severity:** medium
- **Issue:** `#summarize` iterates `res.fullStream` handling only `text-delta` and
  `finish-step`. A mid-stream `error` part (provider hiccup, rate-limit, disconnect) is
  ignored — the loop just ends — and the function returns `text.trim() || null`, i.e. a
  **non-empty truncated summary**. `#doCompact` then does `this.#messages.length = 0` and
  replaces the entire history with that fragment (session.ts:600-603). Silent,
  unrecoverable context loss. There is also no check that the completion finished on
  `finishReason === "stop"`, so any early close that doesn't throw yields a partial summary.
- **Fix:** In `#summarize`, on a `part.type === "error"` (or an `abort`, or a `finish`
  whose `finishReason !== "stop"`) return `null`. Only accept the summary when the stream
  finished cleanly.

---

### Provider/stream error with an unanswered permission prompt can wedge the turn
- **File:** aisdk/src/loop.ts:113-127; gate.ts:92-98; session.ts:488-505, 345-352
- **Severity:** medium
- **Issue:** The turn loop breaks only on `part.type === "abort"`; an `error` part sets
  `errored = true` but keeps consuming `fullStream`. Meanwhile a gated tool's `execute` is
  suspended on `opts.ask(...)`, whose promise is resolved only by `respondToPermission` or
  `#failPendingGates` (called from `interrupt()`/`close()` only). If the provider stream
  errors or the connection drops while a `permission_request` is outstanding and the SDK
  keeps the run open waiting on the tool result, `for await` never completes → `runTurn`
  never returns → `#turn` never settles. Recovery requires an explicit user `interrupt`.
  Even in the benign case (stream ends after the error) the `#pendingPerms` entry and the
  suspended `execute` closure leak.
- **Fix:** On an `error` part, `break` the loop (like `abort`) and have `#runTurn` call
  `#failPendingGates("the turn errored")` on the errored path before healing dangling
  calls. Also clear `#pendingPerms` at the end of every turn.

---

### `#pendingPerms` keyed by provider `toolCallId` — duplicate ids collide and orphan a promise
- **File:** aisdk/src/session.ts:493, 152, 258-267; 507-549
- **Severity:** medium
- **Issue:** `#requestPermission` does `this.#pendingPerms.set(toolCallId || randomUUID(), resolve)`.
  Tool calls in one step execute concurrently, and concurrent `task` sub-agents run fully
  parallel `streamText`s through the same `#requestPermission`. If two calls carry the same
  id — a provider that emits sequential ids like `call_1`, or any duplicate — the second
  `set` overwrites the first resolver. The first `execute` then awaits a promise that
  nothing can resolve (`respondToPermission` deletes+resolves once), so that sub-agent's
  stream never finishes → `#runSubagent` hangs → the parent `task` tool hangs → the parent
  turn hangs until interrupt. Same hazard for two same-id calls in a single step even
  without sub-agents.
- **Fix:** Always allocate a fresh unique key (`randomUUID()`), keep a
  `key → toolCallId` map for display, and correlate the client response by that key. Never
  trust provider ids for map uniqueness.

---

### Sub-agent failures and step-limit truncation are swallowed
- **File:** aisdk/src/session.ts:507-549
- **Severity:** medium
- **Issue:** `#runSubagent` wraps the whole stream in `try/catch` and on any error sets
  `report = report || "sub-agent failed: <msg>"`, then emits `subagent_stopped`
  unconditionally with no `error` HarnessEvent. A watching client cannot tell a failed
  sub-agent from a successful one. `stopWhen: stepCountIs(this.#maxSteps)` with no
  segment/continuation logic (unlike the main loop) means a sub-agent that exhausts its
  step budget just stops; the parent receives whatever partial `text` accumulated, or
  `"(the sub-agent produced no output)"` if the last step was tool-calls with no text —
  with no signal that it was truncated. `part.type === "error"` inside the stream is not
  handled here at all (only `abort` breaks).
- **Fix:** Emit an `error` event (non-fatal) when the sub-agent stream errors or hits the
  step ceiling; include a truncation marker in the returned report; break on `error` parts.

---

### `map.ts` usage mapping assumes provider usage fields are present
- **File:** aisdk/src/map.ts:133-150; session.ts:367-377
- **Severity:** low
- **Issue:** `#usage` reads `u.inputTokens ?? 0`, `u.outputTokens ?? 0`,
  `u.cachedInputTokens ?? 0`. Several OpenAI-compatible endpoints omit token usage on
  streaming responses. When absent, `contextUsed` is emitted as `0`, so the snapshot's
  context meter flaps to zero after each step, and `#snap.usage.input/output` (and any
  budget enforcement keyed off `usage` events) silently under-counts. Auto-compaction is
  unaffected (it uses `estimateTokens`), but cost/budget reporting drifts.
- **Fix:** When `inputTokens`/`outputTokens` are undefined, fall back to
  `estimateTokens(this.#messages)` for `contextUsed` and skip (don't zero) the usage delta,
  or mark the usage event as an estimate.

---

### Interrupt during first-turn MCP connect or top-of-turn auto-compact: no event, message unprocessed
- **File:** aisdk/src/session.ts:656-671
- **Severity:** low
- **Issue:** `#runTurn` checks `if (this.#closing || this.#interrupted) return;` after
  `await this.#doCompact(...)` and after `await this.#turnToolSet()`. If `interrupt()`
  lands while MCP servers are connecting (first turn) or during the auto-compaction, the
  method returns early: `#snap.status` is still `stateStarting`/whatever it was (the
  `stateRunning` assignment at line 675 hasn't run), no `interrupted` or `result` event is
  emitted, and the user message sits unprocessed in `#messages`. The daemon's
  `#transition(..., stateInterrupted)` masks the missing status, but the turn is silently
  dropped and only a later `send()` resurfaces it.
- **Fix:** On the early-return paths, emit an `interrupted`/`result` marker and set
  `#snap.status` so the session state is well-defined; or move the abort check to after
  `stateRunning` is set.

---

### No compaction between steps within a single segment
- **File:** aisdk/src/session.ts:662-668; loop.ts:74-111
- **Severity:** low
- **Issue:** Auto-compaction runs only at the top of `#runTurn` (each segment re-enters
  `#runTurn`, so segment boundaries are covered). But one segment is up to `maxSteps`
  (default 50) model round-trips with no compaction between them. A segment that does many
  large tool reads (file dumps, big MCP results) can push estimated context well past the
  model window before the next segment's check; that segment's later `streamText` calls
  then 400 with context-length-exceeded, caught as `errored`, turn ends in `stateError`.
- **Fix:** Have `prepareStep` (or `onStepFinish`) check `estimateTokens` against the limit
  and either stop the segment early (return control so `#runTurn` compacts) or lower
  `maxSteps` when history is already large.

---

### Minor / cosmetic
- **session.ts:772-774** — the step-limit error message reports
  `${this.#segmentsRun}×${this.#maxSteps}` steps, but not every segment necessarily hit the
  ceiling (the last one triggered the stop); the number is an upper bound, not actual.
- **map.ts:96-105 + loop.ts:137-146** — a stream `error` part emits a `fatal: true` error
  event via the mapper, and if the iterator then also throws, `runTurn`'s catch emits a
  second `fatal: true` error. Duplicate fatal events for one failure.
- **mcp.ts:31-73** — an MCP server that disconnects mid-session is never reconnected;
  every later call to its tools fails as a `tool-error`. Acceptable (model sees the error),
  but there's no health check or re-dial for the session's lifetime.

---

## Clean / sound sub-areas

- **Mid-turn injection splice (loop.ts:82-101).** Correct for `ai@5.0.249`:
  `StepResult.response.messages` is cumulative "during the call" (confirmed in the bundled
  `dist/index.d.ts`), so `genCount` as a running total, the `baseCount` offset captured on
  the first `prepareStep`, and the `offset`-compensated re-splice all line up. Injections
  are persisted exactly once (via `prepareStep`), generated messages exactly once (via
  `onStepFinish` tail-slice); interleave order in `#messages` matches what the model is
  sent. Note this is **version-fragile** — an SDK upgrade that makes `response.messages`
  per-step would corrupt ordering and double-count or drop persisted messages; worth a pinned
  comment or a guard assertion.
- **Step/segment counting (session.ts:761-793).** `MAX_TURN_SEGMENTS` yields exactly 5
  executed segments before the `step_limit` result; no off-by-one. `hitStepLimit`
  (`lastStepReason === "tool-calls"`) correctly distinguishes a `stopWhen` cut from the
  model finishing. Chained turns hand off `#turnRunning` cleanly via the `chained` flag and
  the `finally` guard.
- **`dropDanglingToolCalls` / `#healDanglingToolCalls` (transcript.ts, session.ts:354-365).**
  Trailing unanswered tool-call trimming is applied on cold resume, on interrupt, and on
  error, in memory and in the store. Handles the common single-trailing-assistant case
  correctly (a rare multi-trailing-assistant layout would slip through, but the SDK
  doesn't produce that).
- **Permission gate name heuristics (gate.ts).** Fail safe: an unclassified tool
  (`deploy`, `run_query`, `bash`) is `ask` in default/acceptEdits and withheld in plan
  mode; the edit-verb-wins tie-break keeps `search_and_replace`-style names gated. Builtin
  tool names (`bash`, `edit`, `grep`, `web_search`) all classify correctly.
- **`task` recursion.** Sub-agent tool set excludes `task` and `exit_plan`
  (session.ts:520), so depth is capped at 1; sub-agents share the parent `#abort` so
  interrupt propagates.
- **MCP connect failure isolation (mcp.ts:60-69).** A server that throws during
  `tools()` is closed and skipped; a partially-spawned transport is cleaned up; the session
  survives with the remaining servers (or zero tools, which `#runTurn` handles by omitting
  `tools`).
- **Compaction heartbeat (session.ts:560-582).** `setTimeout` chain is `unref`'d and
  cleared in `finally`; fast→slow backoff is time-based but bounded; `generated` is
  correctly documented as a liveness proxy, not a percentage.

---

## Summary

The engine's happy path — multi-step loop, segment continuation, step/segment counting,
and the mid-turn message splice — is sound and correct for the pinned `ai@5.0.249`
(the splice relies on `response.messages` being cumulative, which it is; flag for future
upgrades). The real exposure is around **compaction concurrency and cancellation**. Manual
`compact()`/`rewind()` take no lock that `send()` observes, and because a manual compaction
leaves the session "idle", a `send()` during the (up-to-15-minute) summarise starts a turn
that runs concurrently with `#doCompact`; when the summary lands it wipes `#messages` and
the store out from under that turn. `interrupt()`/`close()` can't cancel a running
compaction — `close()` doesn't even await it, so it emits to a closed channel and writes
the store post-teardown. `#summarize` also swallows mid-stream `error` parts and will
replace the entire transcript with a truncated summary. Secondary issues: a provider error
while a permission prompt is outstanding has no path to release the parked gate (possible
hang), `#pendingPerms` keyed on provider tool-call ids can collide under concurrent
sub-agents and orphan a promise, and sub-agent failures/step-limit truncation are hidden
from the event feed. Lower-severity: usage mapping assumes provider token fields exist,
and there's no compaction between steps inside one 50-step segment.
