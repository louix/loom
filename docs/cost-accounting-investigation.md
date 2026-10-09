# Cost accounting investigation (A0, feeding A7)

Status: diagnosis only. Nothing in the accounting path has been changed. The
fixtures live in `test/cost-accounting.test.ts`; defect cases are skipped with
the defect named and assert the correct total.

## Summary

- **Inflation, Claude, high confidence.** Every time Loom starts a new Claude
  CLI process with `--resume` on the same session id, the whole earlier
  session cost is charged again. The CLI restores its saved running total
  from the transcript. Loom's new mapper diffs that total against zero.
  Repeated revives compound: for N equal-cost processes Loom records
  N(N+1)/2 turns' worth instead of N.
- **Deflation, Claude, high confidence.** The spend of an interrupted turn is
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
   forwards only `subagent_stopped` and `background_tasks` (`adapter.ts:676-680`).
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
- The first result after resume reports `restored + new`. The mapper emits all
  of it as `costDeltaUsd` (`map.ts:623`), and the store adds it on top of the
  row that already holds `restored` (`sessions.ts:356`).
- Token totals are inflated the same way, because `modelUsage` is restored
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
then re-charges the post-undo spend.

**Magnitude (fixtures, un-skipped).**

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

**Confidence.** High for the mechanism; it is documented by the SDK, visible in
the CLI and reproduced through mapper, manager and store. Medium for its share
of the user's reported inflation, which needs the live data below.

## Root cause 2: interrupted turns are never charged (deflation)

`#interruptAll` sets `#interrupted` (`adapter.ts:1024`), and it stays set until
the next `send()`. The interrupted turn's own `result` arrives in that window.
The mapper advances its baseline, but `#drain` drops the `usage` event
(`adapter.ts:676-680`). That spend never reaches the store, and the next
turn's delta excludes it. In the fixture, Loom records $0.0624 where $0.1541
was billed. The same muzzle covers the planning query's last result in
`#implementFresh` (`adapter.ts:947`). This undercount partly offsets root
cause 1 in today's totals. Fix both together and validate against billed
amounts, not against today's numbers.

## What each number means

| Number                             | Meaning                                                                                                                                          | Source                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Context meter                      | Occupancy: input-side tokens of the last main-loop request. Compaction lowers it.                                                                | assistant `message.usage`, `compact_boundary` |
| `usage` event `tokens`             | Per-turn delta of every pipeline call (main, subagents, compaction) since the last result                                                        | difference of `modelUsage`                    |
| Session `cost_usd`                 | Intended: cumulative estimated spend for the Loom session across CLI processes. Today it is overcounted on resume and undercounted on interrupt. | sum of `costDeltaUsd`                         |
| `result.total_cost_usd`            | CLI running total for this provider session id, including restored history; resets on `/clear` and on a new or forked session id                 | CLI                                           |
| `rate_limit` five_hour / seven_day | Subscription quota utilisation (percent). Not money, and not derived from cost.                                                                  | `rate_limit_event`, `get_usage`               |

`provider` cost is the CLI's list-price estimate, but the UI prints it without
`~`, as if exact. On a Pro or Max subscription the marginal bill is normally
$0 and the quota is the real constraint. "Inflated compared with reality" can
also mean that the API-equivalent figure is being read as a bill.

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
  `onQuerySwap` carries the rest (fixtures). The adapter comment at
  `adapter.ts:1152-1153` about under-reporting after an undo is stale.
- **Worker replay.** The worker protocol is strictly sequenced and has no
  replay (`worker-provider.ts:401`).
- **Codex.** No `costDeltaUsd` and no price table for non-aisdk providers, so
  `costSource` is `none` and the UI shows `--`. Usage deltas skip other
  threads and replays and seed a resume baseline (`app-server.ts:1089-1160`;
  existing test in `test/chatgpt-connector.test.ts`). Two token-only
  deflations remain unverified without live data: other threads' (subagent)
  usage is dropped, and a falling `total` is clamped to the high-water mark.

## Live data that would settle the share

For a sample of Claude sessions, collect:

- `usage.cost_usd` and `provider_ref` from `loom.db`
- the `adapter_ready operation=resume` count from the daemon log
- the transcript `cost-state` totals for each `provider_ref`, following undo
  forks

Expected result: Loom ≈ billed + Σ(restored total at each revive), with
billed ≈ the latest `cost-state` per fork lineage. Also confirm whether VM
idle suspension stops the CLI gracefully. Only a graceful stop stamps the
total, and only a stamped total is re-charged.

## Proposed fix (A7, not implemented)

1. **Seed the query baseline with what the CLI restored.**
   - At every query start (create, resume, undo, fresh implementation), after
     `initializationResult()`, call
     `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`.
     Its `session.total_cost_usd` and `session.model_usage` are the ledger
     before any new turn, which is exactly the restored part.
   - Add `ClaudeEventMapper.seedQueryBaseline({ costUsd, usage })` to set
     `#queryUsage` / `#queryCostUsd` without emitting anything.
   - The adapter already makes this call at init (`#pollPlanUsage`,
     `adapter.ts:627`) and throws away `session`. The seed must land before
     the first `result` is mapped. Hold `result` mapping in `#drain` until the
     seed settles, with a timeout, rather than relying on the user being slow.
2. **Fallback when `get_usage` is unavailable.** Persist the last running total
   Loom saw, per `providerRef`, and seed from it on resume. This never
   overcounts. After a crash it undercounts the new process by
   (last seen − older stamp). Do not parse `cost-state` from the transcript:
   it is an internal format, and the transcript lives in the guest for VM
   sessions.
3. **Charge interrupted turns.** Forward `usage` (and `context`) events from
   `#drain` even while `#interrupted`. They are accounting, not chatter.
4. **Resets.** A healthy result whose running total falls below the baseline
   is a reset (user `/clear`). Today the clamp silently absorbs the spend that
   follows. Re-seed from `get_usage` instead of guessing; do not treat every
   decrease as a new epoch.
5. **Labels.** Show Claude `provider` cost as an estimate. Say
   "API-equivalent" when `get_usage.subscription_type` is set. Keep `--` for
   unknown.
6. **Existing rows.** Their totals can't be corrected from `loom.db` alone.
   Mark them legacy, or offer an explicit recompute from the transcripts'
   `cost-state`. Never rewrite them silently.

**Risks.**

- `get_usage` is experimental. Its shape or name can change; keep the
  fallback and a test for its absence.
- Holding results until the seed lands can delay turn completion if the
  control request stalls, so bound it.
- Older CLIs without `cost-state` start at zero, and seeding zero is correct.
- If a future SDK `forkSession()` copies `cost-state`, the seed covers undo
  too. That is a reason to seed at every query start, not only on resume.
- Fixing root cause 1 without root cause 2 changes totals unevenly. Land them
  together, then un-skip the five defect fixtures.
