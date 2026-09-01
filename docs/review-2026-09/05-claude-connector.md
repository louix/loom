# Claude Agent SDK connector — focused review

Scope: `connectors/claude/src/{adapter,map,loom-mcp,cli,index}.ts`, cross-checked
against `core/src/{connector,types,channel}.ts`, `core/src/commit.ts`, the pinned
SDK type defs (`@anthropic-ai/claude-agent-sdk` 0.3.251 `sdk.d.ts`), and the
recent undo/rewind commits (`b11e729`, `6ca86a9`, `fea48fe`).

Findings ranked most severe first.

---

### Live model / effort / mode changes are silently reverted by `rewind()`

- **File:** connectors/claude/src/adapter.ts:492 (also 187–190, 527–539)
- **Severity:** high
- **Issue:** `start()` records `this.#startOpts = opts` once, from the original
  `CreateSessionOptions`. `setModel()` never updates any local field;
  `setEffort()` / `setMode()` update `this.#effort` / `this.#mode` but not
  `#startOpts`. `rewind()` rebuilds the query with
  `this.start({ ...this.#startOpts, prompt: "" }, ...)`, and `start()` reads
  `opts.model` / `opts.effort` / `opts.mode` for the new `query()`. So if the
  user switches model sonnet→opus (or changes effort/mode) via a live control
  call and then does an undo, the resumed session silently runs the _original_
  model/effort/mode. `snapshot()` still reports `this.#mode` / `this.#effort`
  (the values the setters stored), so the snapshot and the actually-running
  query diverge. The daemon's `SessionManager.rewind`
  (`session-manager.ts:464`) does not re-apply any of these afterwards.
- **Fix:** Track the current model in a `#model` field updated by `setModel()`,
  and have `rewind()` compose the restart opts from the live
  `#mode` / `#effort` / `#model` rather than the frozen `#startOpts`. Or, after
  the resumed `start()`, re-issue `setModel` / `setEffort` / `setPermissionMode`
  for any value that has drifted from `#startOpts`.

---

### `rewind()` regresses cumulative token / cost totals (docstring says it can't)

- **File:** connectors/claude/src/map.ts:399–401 (context: adapter.ts:459–496 docstring at 443–457)
- **Severity:** high
- **Issue:** The mapper is deliberately kept across a rewind and
  `#result()` does `this.state.usage = { ...cum }; this.state.costUsd = cum.costUsd;`
  with no monotonic guard. Per the SDK, `modelUsage` (the primary accounting
  source here) is _cumulative across turns of one `query()` call_ and
  "resumed sessions start fresh". `rewind()` forks + starts a brand-new
  `query()` with `resume:`, so its first `result` carries `modelUsage` /
  `total_cost_usd` restarted from ~0. The mapper differences that against the
  pre-rewind high-water mark: `delta = Math.max(0, small - big) = 0` for the
  first post-rewind turn, and then it _overwrites_ `state.usage` /
  `state.costUsd` with the small resumed totals. Result: `snapshot().usage` and
  `snapshot().costUsd` collapse to the resumed session's totals, losing all
  pre-rewind history — directly contradicting the `rewind()` docstring
  ("the mapper is kept, so cumulative cost never regresses").
- **Fix:** Keep a separate `#carry` baseline for usage/cost. On the first
  `result` after a query swap, detect the regression (new cumulative <
  stored) and fold the old totals into `#carry`, so reported cumulative =
  `#carry + currentQueryCumulative`. Clamp `state.usage` / `state.costUsd`
  to be non-decreasing.

---

### A zeroed `modelUsage` on a crash/startup-error `result` resets the counters

- **File:** connectors/claude/src/map.ts:375–401
- **Severity:** medium
- **Issue:** SDK docs: "crash/startup-error results may carry zeroed usage".
  When `m.modelUsage` is present but all-zero, `sumModelUsage(mu)` returns 0,
  so `delta` clamps to 0 (fine) but `this.state.usage = { ...cum }` and
  `this.state.costUsd = cum.costUsd` reset the mapper's running totals to 0.
  The next healthy turn then differences its cumulative `modelUsage` against 0
  and emits one massive false `usage` delta / `costDeltaUsd` spike. Same hazard
  if a user ever sends a literal `/clear` through `send()` ("a mid-session
  /clear resets the running total").
- **Fix:** Ignore `modelUsage` when every summed field is 0 (fall through to the
  `m.usage` per-turn path, or skip the update entirely); make `state.usage` /
  `state.costUsd` non-decreasing as above.

---

### `#forkTruncated` mutates global `process.env.CLAUDE_CONFIG_DIR` across an `await`

- **File:** connectors/claude/src/adapter.ts:498–514
- **Severity:** medium
- **Issue:** `forkSession()` reads the transcript from `CLAUDE_CONFIG_DIR`
  in-process, so `#forkTruncated` sets `process.env.CLAUDE_CONFIG_DIR`, `await`s
  `forkSession`, then restores it in `finally`. `CLAUDE_CONFIG_DIR` is a
  process global and multiple `~/.claude` profiles are a supported feature
  (commit `23c910a`). If two sessions on different profiles undo concurrently
  (or one undoes while another's `#forkTruncated` runs), the second setter wins
  for the duration of the first's `await`, so the first forks from the wrong
  profile directory (wrong transcript, or `forkSession` throws "not found"), and
  the `finally` chain restores a stale value.
- **Fix:** Serialize all `forkSession` calls process-wide behind a single mutex,
  or pass the profile explicitly if the SDK later exposes it
  (`SessionMutationOptions.dir` is the _project_ dir, not the config dir, so it
  doesn't currently help). At minimum also pass `dir: opts.cwd` to narrow the
  search.

---

### Live query ending during the pre-teardown fork window leaves a permanently silent session

- **File:** connectors/claude/src/adapter.ts:285–318, 467–492
- **Severity:** medium
- **Issue:** `rewind()` sets `#rewindInFlight = true` but only sets
  `#rewinding = true` _after_ `#forkTruncated` resolves. During the fork
  `await`, if the live `query()` stream ends or throws (CLI crash, or the
  post-interrupt abort surfacing as a stream error on some SDK builds),
  `#drain` runs its `catch`/`finally` with `#rewinding === false`, so it pushes
  a fatal `error` and then **closes `#outbox` and `#inbox`**. `rewind()` then
  proceeds, builds a fresh `#inbox`, and calls `start()` — whose new `#drain`
  pushes every event into the already-closed `#outbox` (silently dropped by
  `AsyncChannel.push`). The daemon's `events()` iterator has already ended, so
  the resumed session produces nothing, forever, while `snapshot()` still
  reports `stateRunning`.
- **Fix:** Have `#drain`'s `catch` and `finally` check `this.#rewindInFlight`
  (the wider span), not just `this.#rewinding`, before emitting the error or
  closing the channels.

---

### `interrupt()` doesn't cancel pending gates / `ask_user`, and `canUseTool` bypasses the interrupt muzzle

- **File:** connectors/claude/src/adapter.ts:193–226, 285–294, 428–441
- **Severity:** medium
- **Issue:** `interrupt()` sets `#interrupted`, drains `#inbox`, and calls
  `#query.interrupt()` (which in 0.3.251 has no `cancel_queued` param, correctly
  noted). But:
  (a) `#interrupted` only suppresses _mapper_ events in `#drain`;
  `canUseTool` pushes `permission_request` / `plan_review` straight to
  `#outbox`, so a turn already in the CLI command queue can still raise a
  permission prompt into a session the user just stopped.
  (b) `interrupt()` does not resolve outstanding `#pendingPerms` /
  `#pendingQuestions` / `#pendingPlans`. An in-process `loom__ask_user` call
  blocked in its MCP `execute` is not cancellable by `#query.interrupt()`, so it
  hangs until `close()` / stream-end, and the `question` event stays "open" in
  the UI.
  (c) The next `send()` clears `#interrupted`, so any still-queued pre-interrupt
  turn's output un-muzzles and streams interleaved with the new turn as if
  current.
- **Fix:** On `interrupt()`, also gate `canUseTool` emissions on `#interrupted`
  (auto-deny while interrupted), and `#rejectPending("interrupted")` for
  questions at least. Consider tracking a queue-generation counter so
  post-interrupt stale-turn events stay dropped even after the next `send()`.

---

### `partialTokens: true` capability is inaccurate

- **File:** connectors/claude/src/adapter.ts:53; connectors/claude/src/map.ts:216–219, adapter.ts:241
- **Severity:** medium
- **Issue:** `CAPS.partialTokens = true` advertises "emits token counts before
  the final result". The adapter sets `includePartialMessages: false` and the
  mapper explicitly drops `stream_event`; `usage` events are only produced from
  `result` messages, i.e. exactly at turn end. No partial/interim usage is ever
  emitted. Any daemon/TUI affordance keyed off this capability is misled.
- **Fix:** Set `partialTokens: false`, or enable `includePartialMessages: true`
  and map the interim usage out of `stream_event` / `SDKThinkingTokensMessage`.

---

### `setModel()` is unguarded, unlike `setMode()` / `setEffort()`

- **File:** connectors/claude/src/adapter.ts:527–529
- **Severity:** low/medium
- **Issue:** `setMode` and `setEffort` wrap the control call in try/catch and
  rethrow a readable message; `setModel` is a bare
  `await this.#query?.setModel(model)`. An out-of-catalog / typo'd model id
  surfaces the raw SDK/CLI error, and there is no local model field so
  `snapshot().model` (from `mapper.state.model`) keeps reporting the previous
  model until the next assistant frame — which never comes if the change was
  rejected.
- **Fix:** Mirror the `setMode` pattern (try/catch + readable rethrow), and
  track the requested model locally so the snapshot reflects intent /reverts on
  failure.

---

### `listModels()` probe has no timeout or stderr capture

- **File:** connectors/claude/src/adapter.ts:652–687
- **Severity:** low/medium
- **Issue:** The discovery `query()` uses an immediately-returning async
  generator as its prompt and `await`s `q.initializationResult()` with no
  timeout and no `stderr` handler (unlike a real session, which sets one at
  line 243). If the CLI can't start (missing/expired OAuth, bad bundled binary
  on NixOS/musl) the call rejects or hangs with no diagnostic, and this feeds
  the model picker / doctor overlay at startup.
- **Fix:** Race `initializationResult()` against a timeout, attach a `stderr`
  logger, and return `[]` (fall back to configured `models`) on failure.

---

### Foreground `Task` that never returns a `tool_result` leaks a `subagent_started`

- **File:** connectors/claude/src/map.ts:326–337, 343–362
- **Severity:** low
- **Issue:** `#openSubagents` is only cleared when the matching `tool_result`
  arrives on the main chain. If a foreground subagent crashes without a
  `tool_result`, `subagent_started` is never balanced by `subagent_stopped`,
  and there is no session-teardown sweep to close open subagents.
- **Fix:** On the final `result` of an engagement (or on stream end), emit
  `subagent_stopped` for any id left in `#openSubagents`.

---

### `result` with `queued_turn_count > 0` still emits `result kind:error`

- **File:** connectors/claude/src/map.ts:412–437
- **Severity:** low
- **Issue:** The `queued_turn_count > 0` early-return (keep usage, drop the
  turn-complete marker) only applies when `ok` is true. A failed SDK turn that
  has more user turns queued behind it still emits `error` + `result kind:error`
  mid-engagement, which can flap the daemon session to `idle` while it is
  demonstrably still working through the queue. Comment says this is
  intentional ("the error is worth seeing"), but the `result` marker (not just
  the error) is the part that flaps state.
- **Fix:** When `queued_turn_count > 0`, emit the `error` event but suppress the
  `result` marker, same as the success path.

---

### `snapshot()` always reports `status: stateRunning`

- **File:** connectors/claude/src/adapter.ts:541–545
- **Severity:** low
- **Issue:** Even after the CLI process has exited (`#drain` ended, `#outbox`
  closed, fatal `error` emitted), `snapshot()` returns `stateRunning`
  unconditionally. Anything polling the adapter snapshot rather than watching
  the event stream sees a dead session as running.
- **Fix:** Track a terminal flag set in `#drain`'s `finally` (when not
  rewinding) and report `stateStopped`/`stateError` from `snapshot()`.

---

### Mapper carry-over state not reset across `rewind()`

- **File:** connectors/claude/src/map.ts:176, 183, 180; adapter.ts:490–492
- **Severity:** low
- **Issue:** `rewind()` keeps the mapper (intentional, for cost). But
  `#lastChainUuid`, `#lastBgSig`, and `#openSubagents` also survive. If the
  resumed query emits a `result` before any main-chain `assistant`/`user` frame
  carrying a UUID, `state.rewindRef` is snapshotted from a stale
  `#lastChainUuid` that points into the truncated-away portion of the old
  transcript. `#lastBgSig` surviving can also suppress a legitimate
  `background_tasks` re-emit right after the swap.
- **Fix:** Reset `#lastChainUuid = null`, `#lastBgSig = null`, and clear
  `#openSubagents` when `rewind()` swaps the query (add a
  `mapper.onQuerySwap()` hook).

---

### `send()` forwards leading-slash text unfiltered

- **File:** connectors/claude/src/adapter.ts:334–338, 346–350
- **Severity:** low
- **Issue:** `compact()` relies on the CLI treating a leading-`/` user message
  as a command. `send()` applies no such filter, so a user turn that legimately
  begins `/clear`, `/exit`, `/model …` etc. is executed as a CLI command —
  `/clear` in particular silently resets `modelUsage` / `total_cost_usd` and
  desyncs the mapper (see the counter-reset finding).
- **Fix:** Escape or reject leading-slash user input in `send()` (only
  `compact()` should be able to drive commands), or explicitly allow-list.

---

## Clean / not a problem

- **`toPermissionMode` cast** (adapter.ts:63): sound — SDK `PermissionMode`
  does include `'auto'` (and `'dontAsk'`), so the four Loom modes map 1:1 as the
  comment claims. `bypassPermissions` is never constructible from a
  `SessionMode`.
- **`modelUsage` differencing in steady state** (map.ts:375–391): correct —
  `modelUsage` is cumulative-per-`query()` and the `Math.max(0, …)` delta plus
  fallback to per-turn `m.usage` is the right shape _within a single query_.
  (The bugs above are all at query-swap / crash boundaries.)
- **`queryEnv`** (adapter.ts:77–87): correctly spreads `process.env` before the
  overrides (the SDK's `env` replaces the child environment) and returns
  `undefined` when there's nothing to override.
- **`resolveClaudeCli`** (cli.ts): explicit-path validation, PATH scan, and
  bundled-binary fallback are all handled; a bad explicit path throws a clear
  error and keeps re-throwing (‑`#cliResolved` stays false).
- **`commitInWorktree`** (core/src/commit.ts): empty message, nothing-staged,
  `commit.gpgsign=false`, and a 15s `spawnSync` timeout are all handled; the
  `loom` MCP `commit` tool correctly maps `ok:false` → `isError:true`.
- **`#rejectPending`** on normal `#drain` end / `close()`: outstanding
  permission / question / plan promises are resolved (deny / "(reason)"), so the
  MCP tools don't hang on a clean CLI exit. (Gap is the `interrupt()` path —
  see that finding.)
- **Plan-review routing** (adapter.ts:197–212, 390–426): `ExitPlanMode` is
  surfaced as a first-class `plan_review`; the four `PlanDecision` branches are
  driven deterministically (deny + re-send) rather than relying on SDK
  `updatedInput` support.
- **`parseContextTag` / `[1m]` stripping** (adapter.ts:89–94, 670): regex is
  anchored and safe; model-id `[…]` suffix is stripped for the catalog id.
