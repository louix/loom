# Cost accounting investigation (A0) and fix (A7)

Status: diagnosed in A0, fixed in A7. The fixtures live in
`test/cost-accounting.test.ts` and all pass. The diagnosis sections below
describe the code as of `2833a0b1`; their file:line references point at that
revision. The fix is described in [Implemented fix](#implemented-fix-a7).

## Summary

- **Inflation, Claude, high confidence.** Every time Loom started a new Claude
  CLI process with `--resume` on the same session id, the whole earlier
  session cost was charged again. The CLI restores its saved running total
  from the transcript, and Loom's new mapper diffed that total against zero.
  Repeated revives compound: for N equal-cost processes Loom recorded
  N(N+1)/2 turns' worth instead of N.
- **Deflation, Claude, high confidence.** The spend of an interrupted turn was
  never recorded.
- **Codex cannot inflate the displayed cost.** The old app has no price for
  Codex, so the row shows `--`. Token deltas are already de-duplicated and
  resume-safe; an existing test covers this.
- None of these is a cause: summing cumulative frames, compaction, duplicate
  results, zeroed crash results, subagent or child folding, model changes,
  cache pricing, undo and fresh-implementation query swaps (see
  [Eliminated](#eliminated-hypotheses)).

## The path, provider to screen

1. **Claude CLI.** Every `result` carries `total_cost_usd` and `modelUsage`.
   Both are running totals for the process's cost ledger and cover the main
   loop, Task subagents, compaction and other pipeline calls. `usage` covers
   only the main loop, per turn. The CLI computes the dollar figure from list
   price, or from an org override. It is an estimate, not a bill.
2. **Mapper.** `ClaudeEventMapper.#result`
   (`connectors/claude/src/map.ts:559`) subtracts the current query's baseline
   (`#queryUsage` / `#queryCostUsd`, `map.ts:263-264`) from the reported
   running total. It clamps with `Math.max` so a partial or zeroed report
   cannot lower the baseline (`map.ts:596-622`). It emits
   `usage.costDeltaUsd` (`map.ts:623`, `:655`). `onQuerySwap()` (`map.ts:331`)
   folds the finished query into `#carry` for undo and fresh implementation.
3. **Adapter.** `ClaudeSession.#drain` (`connectors/claude/src/adapter.ts:656`)
   runs every SDK message through the mapper. While `#interrupted` is set, it
   forwarded only `subagent_stopped` and `background_tasks`
   (`adapter.ts:676-680`).
4. **Session manager.** `#trackUsage`
   (`backend/daemon/src/daemon/session-manager.ts:510`) turns each `usage`
   event into a `UsageDelta` with `costSource: "provider"` whenever
   `costDeltaUsd` is present.
5. **Daemon.** `onUsage` (`backend/daemon/src/daemon/daemon.ts:469`) runs
   `#priceUsage` (`daemon.ts:2081`). A provider-sourced delta passes through
   unchanged. Otherwise an endpoint price table (aisdk/OpenAI only) is used,
   and failing that the delta is marked `none`.
6. **Store.** `SessionStore.addUsage`
   (`backend/daemon/src/store/sessions.ts:335`) adds `cost_usd = cost_usd + ?`
   (`:356`). `model_usage` gets the same delta, attributed to the session's
   current model.
7. **UI.** The fleet row and detail view print `usage.cost_usd`: `$x.xx` when
   the source is `provider`, `~$x.xx` when it is `table`, and `--` when it is
   `none` or `partial` (`frontend/tui/src/components.tsx:383-386`, `:595-596`,
   and `cli/src/loom.ts:760-763` for `loom ls`). Nothing sums child sessions
   into a parent.

## Root cause 1: resume re-charges the restored total (inflation)

**Provider behaviour (SDK 0.3.282, bundled CLI 2.1.x).**

- `sdk.d.ts`, on `SDKResultSuccess.total_cost_usd` and `modelUsage`: "a
  resumed or forked session continues from the total its transcript saved,
  when it has one (so the first result already carries the earlier turns;
  maxBudgetUsd counts only the spend since this query() call started or last
  /clear)".
- The bundled binary shows how. The cost ledger's `restore()` sets the running
  total and `modelUsage` from a `cost-state` transcript entry and records
  `restoredCostUSD`. The print/SDK resume path calls it when loading the
  session.
- Result frames report `total_cost_usd: Km()` and `modelUsage: HC()`, which
  are the full ledger including the restored part. Only the max-budget check
  subtracts `restoredCostUSD`.
- `cost-state` is written by an exit re-stamp provider, so it is written at a
  graceful process exit. Entries are last-wins per session id.
- `sdk.forkSession()` copies only chain entries and a few latches, not
  `cost-state`. A resumed undo fork therefore starts from zero.

**Loom behaviour.**

- `ClaudeProvider.resumeSession` (`adapter.ts:1382-1397`) builds a new
  `ClaudeSession`, so a new `ClaudeEventMapper` (`adapter.ts:377`), with
  `#queryCostUsd = 0`.
- The first result after resume reports `restored + new`. The mapper emitted
  all of it as `costDeltaUsd` (`map.ts:623`), and the store added it on top of
  the row that already held `restored` (`sessions.ts:356`).
- Token totals were inflated the same way, because `modelUsage` is restored
  too.

**When it fires.** Every revive of a Claude session whose previous CLI exited
gracefully:

- daemon restart and `[auto_resume]` (`daemon.ts:1698`)
- send to a non-live session (`#reviveLocked`, `daemon.ts:1604`, `:1663`)
- VM idle suspension (default 10 minutes) followed by the next send
  (`daemon.ts:2358`, `:2400`)
- environment refresh (`daemon.ts:2461-2472`)
- provider switch (`session-manager.ts:898`)
- worker recovery

After an undo, the fork's own later exit stamps a `cost-state`, so a revive
then re-charged the post-undo spend.

**Magnitude (fixtures, before the fix).**

| Sequence                                      | Loom    | Billed  |
| --------------------------------------------- | ------- | ------- |
| 2 turns, graceful exit, revive, 1 turn        | $0.1560 | $0.0936 |
| 5 processes × 1 turn                          | $0.4680 | $0.1560 |
| Graceful, revive, crash, revive (older stamp) | $0.1560 | $0.0936 |
| Adapter-level resume, first turn delta        | $0.0936 | $0.0312 |

**Live corroboration (partial).** One Loom worktree transcript under the user's
Claude profile holds five `cost-state` entries. Their totals are $4.18, $6.44,
$6.63, $10.26 and $40.43, rising monotonically, and all five carry the same
`startTime`. The restore anchors `startTime` to the saved value, so this is
consistent with five process lifetimes, each restoring the previous one. If
each later process was a Loom revive, the old app would have recorded about
$67.94 against $40.43 (1.68x). I could not compare this with the matching
`loom.db` row: reading the user's databases and transcripts was restricted
during this investigation.

**Confidence.** High for the mechanism: it is documented by the SDK, visible in
the CLI, confirmed by the probe below and reproduced through mapper, manager
and store. Medium for its share of the user's reported inflation, which needs
live data.

## Root cause 2: interrupted turns are never charged (deflation)

`#interruptAll` sets `#interrupted` (`adapter.ts:1024`), and it stays set until
the next `send()`. The interrupted turn's own `result` arrives in that window.
The mapper advanced its baseline, but `#drain` dropped the `usage` event
(`adapter.ts:676-680`). That spend never reached the store, and the next turn's
delta excluded it. In the fixture, Loom recorded $0.0624 where $0.1541 was
billed. The same muzzle covered the planning query's last result in
`#implementFresh` (`adapter.ts:947`).

## CLI probe (2.1.280, A7)

A throwaway script ran the user's `claude` 2.1.280 in stream-json mode,
against a synthetic transcript in a temporary `CLAUDE_CONFIG_DIR` with an
invalid API key, so no model request was made. Results:

- On `--resume` of a transcript whose `cost-state` holds $1.2345, `get_usage`
  sent before any turn reports `total_cost_usd: 1.2345` and the restored
  per-model tokens. Without a `cost-state`, it reports 0.
- `/clear` emits `conversation_reset`, then a new `system/init` under a new
  `session_id`, then a result with `total_cost_usd: 0` and empty
  `modelUsage`. `get_usage` afterwards reports 0.
- On stdin EOF and on SIGTERM, the CLI stamps a `cost-state`. On SIGKILL it
  stamps nothing, so a later resume restores the previous stamp, if any.

## Implemented fix (A7)

1. **Seed the baseline at every resumed query start.** `ClaudeSession.start`
   hands the SDK a prompt that is held back (`afterReady`) while
   `#seedBaseline` waits for `initializationResult()` and then calls
   `get_usage` with `skipBehaviors`. No user message reaches the CLI until the
   seed is applied, so the report covers the restored ledger and nothing
   else. `ClaudeEventMapper.seedQueryBaseline` sets the baseline without
   emitting anything.
   - The seed is part of the baseline but never part of what the mapper
     charged. `state.usage` and `state.costUsd` exclude it, and `#carry`
     folds only post-seed spend.
   - This applies to every query started with `resume`: daemon revives and
     undo forks. Fresh sessions and fresh implementations start at zero with
     no hold.
   - The same `get_usage` response primes the plan windows, so there is no
     second round-trip.
2. **Bounded hold, never a dropped result.** The hold ends after 10 s
   (`seedTimeoutMs`). A late answer is ignored for seeding, because a turn
   may already be running. `#drain` maps no `result` until the seed settles,
   so a startup-error result that precedes the first turn is held and then
   diffed against the seed, not against zero.
3. **Persisted fallback.** Each `usage` event now carries `providerTotal`:
   `{ ref, costUsd, tokens }`, the CLI's running totals for its session `ref`
   after that result.
   - The session manager passes it through, and `SessionStore.addUsage`
     keeps the latest in `usage.provider_total` (migration 29).
   - `Daemon.#reviveLocked` passes it as `SessionRef.usageBaseline`, but
     only when its `ref` is the provider ref being resumed.
   - The adapter uses it only when `get_usage` fails or times out.
   - It survives daemon restarts.
   - It never over-charges. If the CLI was killed (an older or missing
     stamp), it under-charges the new process until spend passes Loom's last
     observation.
4. **Explicit resets.** `conversation_reset` (from `/clear` and the CLI's
   other fresh-context flows) folds what was charged under the old ledger
   into `#carry` and zeroes the baseline. A smaller running total without
   that frame is still treated as a partial report and clamped, not as a new
   epoch.
5. **Interrupted turns are charged.** `#drain` forwards `usage` events while
   `#interrupted`. Because the mapper differences running totals, a trailing
   or duplicate result after the interrupt charges nothing extra.
6. **Scope labels.** The detail view's tokens row now says what the cost is:
   `reported` (provider), `estimated` (price table), `part estimated`
   (mixed), `part unpriced` (partial), or `unavailable` (none). The fleet row
   keeps its compact `$` / `~$` / `--` idiom. Both now use
   `sessionCost` / `costScope` in `frontend/tui/src/theme.ts`.

**Legacy totals.** Rows recorded before this fix keep their stored totals.
Those may include re-charged history from earlier revives, and they cannot be
corrected from `loom.db` alone. Nothing migrates or rewrites them. From now on
they only grow by correctly seeded deltas.

## VM idle suspension: does the CLI stop cleanly?

Only by luck of timing.

- `suspendIdle` → `SessionManager.close` → `RemoteWorkerSession.close`
  (`worker-provider.ts:285`) sends the guest worker a `close` RPC.
- The guest's `ClaudeSession.close` calls the SDK's `Query.close()`, which
  ends the CLI's stdin. It schedules SIGTERM after 2 s and SIGKILL 5 s later,
  on unref'd timers, and returns at once: the SDK's exit wait sits in a cleanup
  promise nobody awaits.
- The host then terminates the worker. For a VM, that SIGTERMs the VM
  supervisor (`session-vm-worker.ts:469`). For a host worker, it SIGKILLs the
  process group (`worker-launch.ts:78`).
- So the CLI's EOF-triggered exit, which stamps `cost-state`, races the
  teardown.

Accounting no longer depends on the outcome:

- `get_usage` reports whatever the CLI actually restored.
- The persisted fallback errs on the side of under-charging.

Making the close graceful (awaiting CLI exit, bounded) would also make the
transcript's own totals reliable. That is outside A7.

## Residual risks

- `get_usage` is experimental. If it disappears or changes shape, the
  persisted fallback takes over. That is exact after a graceful exit,
  low after a kill.
- The first send after a revive waits for the initialize handshake plus one
  `get_usage` round-trip, which includes a claude.ai rate-limit fetch for
  subscription logins. That is normally well under a second, with a hard
  10 s cap.
- **Stale provider ref after undo or `/clear`. This is pre-existing and not
  changed.**
  - `SessionManager.#trackRef` reports a session's provider ref once per
    attach. After an undo or `/clear`, the CLI moves to a new session id, but
    `sessions.provider_ref` keeps the old one, so a later revive resumes the
    pre-undo or pre-clear transcript.
  - Accounting stays correct: `get_usage` reports what that resume restores,
    and the persisted fallback is ignored because its `ref` differs.
  - The conversation itself is wrong after such a revive. This deserves its
    own fix.
- The fixtures model the CLI from its documentation and the probe above, not
  from captured model traffic.

## What each number means

| Number                             | Meaning                                                                                                                               | Source                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Context meter                      | Occupancy: input-side tokens of the last main-loop request. Compaction lowers it.                                                     | assistant `message.usage`, `compact_boundary` |
| `usage` event `tokens`             | Per-turn delta of every pipeline call (main, subagents, compaction) since the last result                                             | difference of `modelUsage`                    |
| `usage` event `providerTotal`      | The CLI's running totals for its session `ref` after this result: what a resume of `ref` restores                                     | `modelUsage`, `total_cost_usd`                |
| Session `cost_usd`                 | Cumulative estimated spend for the Loom session across CLI processes, labelled `reported` / `estimated` / `unavailable` in the detail | sum of `costDeltaUsd`                         |
| `result.total_cost_usd`            | CLI running total for this provider session id, including restored history; resets on `/clear` and on a new or forked session id      | CLI                                           |
| `rate_limit` five_hour / seven_day | Subscription quota utilisation (percent). Not money, and not derived from cost.                                                       | `rate_limit_event`, `get_usage`               |

`provider` cost is the CLI's list-price estimate. On a Pro or Max subscription
the marginal bill is normally $0 and the quota is the real constraint, so the
figure is API-equivalent spend, not a bill.

## main-new's `ConversationJournal.estimatedCost()`

`git show main-new:client/src/conversation-journal.ts`, around line 978, reads
the latest root `result.total_cost_usd` and does not sum anything. Because the
CLI restores `cost-state`, this is a session-lifetime figure after a graceful
resume, so it does not have root cause 1. That explains why it reads smaller.
It is not complete, though. It undercounts:

- after an undo (`forkSession` restarts at zero, losing pre-undo spend)
- after a fresh implementation (new session id, losing the planning spend)
- after a crash (the restored stamp is older than the last result seen)
- after a user `/clear`

It is also per provider session id, not per Loom session.

## Eliminated hypotheses

- **Summing cumulative frames.** The mapper differences them.
- **Compaction.** The same process keeps its ledger, so the summarise call is
  charged once and context drops without touching cost (fixture).
- **Duplicate or replayed results.** A repeated running total gives a zero
  delta. Queued interim results also charge once (fixture).
- **Zeroed crash results.** `map.ts:568-579` and the clamp at `:596-601` hold
  (fixture).
- **Subagents.** Already inside `modelUsage` and charged once (fixture). Loom
  child sessions and forks are separate rows; Claude forks are continuation
  sessions (`daemon.ts:3139`), so nothing is inherited. Nothing sums children
  in the UI.
- **Model change and cache pricing.** The cost comes from the CLI, priced per
  model with cache reads and writes (fixture). The aisdk mapper subtracts
  cached tokens from input before table pricing (`aisdk/src/map.ts:166`).
- **Undo and fresh implementation.** The new query starts at zero and
  `onQuerySwap` carries the rest (fixtures).
- **Worker replay.** The worker protocol is strictly sequenced and has no
  replay (`worker-provider.ts:401`).
- **Codex.** No `costDeltaUsd` and no price table for non-aisdk providers, so
  `costSource` is `none` and the UI shows `--`. Usage deltas skip other
  threads and replays and seed a resume baseline (`app-server.ts:1089-1160`;
  existing test in `test/chatgpt-connector.test.ts`). Two token-only
  deflations remain unverified without live data: other threads' (subagent)
  usage is dropped, and a falling `total` is clamped to the high-water mark.
