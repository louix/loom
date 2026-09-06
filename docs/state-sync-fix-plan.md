# State-sync corrective plan

Baseline: local `main` at `d52117f`, reviewing the seven commits after `01ad1a60`.
Status: step 0 done. Later steps are planned; their checkboxes are not implemented.

Goal: finish the existing state-sync contract, fix the reproduced regressions,
and delete the obsolete client-side representations. Keep replacement snapshots,
durable transcript IDs, the existing command queue and local TUI drafts/queues.

Work in the order below. Each numbered implementation step is a separate
reviewable commit. Add each regression before fixing it, confirm it fails for
the stated reason, then fix it. Do not add a framework to make the test possible.

## Boundaries

- No RxJS migration, delta protocol, state replay, operation-status service,
  automatic mutation retries, provider rewrite or generic synchronization layer.
- Do not remove raw replay used by `loom tail`.
- Do not change the meaning or ownership of local queued messages and drafts.
- Do not add `connected`, `hasSnapshot`, or another copy of the fleet beside
  `ClientState`. Make decisions by narrowing its existing `Loadable`.
- Code moved into another file is not a deletion. Remove the old caller and
  representation before claiming a simplification.
- A passing `--no-check` run is runtime evidence, not a passing typecheck.

## 0. Establish a usable verification baseline

Files: `deno.json`, existing test suites. No functional changes in this step.

- [x] Run in the repository Deno development environment. Record its version.
- [x] Stop the typecheck task from recursively checking other branches under
      `.loom/trees`. Prefer explicitly checking the workspace directories plus
      `scripts/` and `test/`; use the same scope for `typecheck:silent` and `watch`.
      Do not edit or remove another worktree to make the command pass.
- [x] Resolve dependency installation with the existing lockfile. Do not disable
      strictness, scatter `@ts-ignore`, change dependency versions, or permanently
      use `--no-check` to hide missing Node types.
- [x] Record the checked baseline. If an environment issue persists, state the
      exact failure separately from functional test results.

Known review results: the focused runtime runs passed 130 tests (6 steps) and
71 tests (100 steps). The normal typecheck traversed an older worktree and failed
on its obsolete ChatGPT `./oauth` import. An initial targeted checked run also
failed resolving Node types. Neither is a verified regression in these commits.

**Done.** Baseline recorded at `ae062be`, in the repository Nix shell:
deno 2.9.5 (v8 15.0.245.2-rusty, typescript 6.0.3).

`typecheck` now names the thirteen workspace directories plus `scripts/` and
`test/` rather than `.`; `typecheck:silent` and `watch` delegate to it, so the
scope cannot drift between the three. The recursion was real and is fixed: with
a deliberately broken `.loom/trees/scratch-verify/broken.ts` in place,
`deno check .` failed on it (`TS2307`) while `deno task typecheck` passed. The
scratch tree was then removed. Nothing outside this worktree was touched — the
old worktree that broke the reviewer's run still exists and is simply no longer
in scope. `.loom/trees/` is already gitignored, so `lint` and `format:check`
never had the problem and keep their `.` scope.

The Node-types failure did not reproduce. `deno install --frozen=true` completes
against the existing lockfile with no drift, and the targeted checked run
resolves everything; no strictness flag, `@ts-ignore`, version change or
`--no-check` was involved.

Checked baseline, all four green on `ae062be` plus this step's `deno.json`
change:

| check                    | result                                                 |
| ------------------------ | ------------------------------------------------------ |
| `deno task typecheck`    | clean                                                  |
| `deno task test`         | 622 passed (106 steps), 0 failed, 50s                  |
| `deno task lint`         | clean (oxlint 1.79.0)                                  |
| `deno task format:check` | clean after reformatting `docs/state-sync-fix-plan.md` |

`format:check` failed on arrival: oxfmt wanted the plan document's list
continuations indented under their bullets and `*all*` written `_all_`. That is
a formatting-only rewrite of this document, made so the gate is green from the
start.

## 1. Fix TUI effects during disconnect and reconnect

Files: `frontend/tui/src/fleet-handle.ts`, `frontend/tui/src/model.ts`.
Tests: direct handle cases in `test/tui-render.test.ts`; reducer cases only where
the behavior actually belongs to the reducer.

### Change

- [ ] Gate `drainQueues`, `forgetDeadSessions`, and history requests on
      `state.fleet.tag === "data"`. An unknown fleet is not an empty fleet.
- [ ] On disconnect, preserve selection, drafts and unsent queue entries;
      invalidate history requests, clear transcript caches and reset scroll.
      **Do not start a replacement history request yet.**
- [ ] On transition from non-data to data, fetch the selected session's latest
      page. Also fetch on selection change and an explicit cache reset while data.
- [ ] Register live transcript listening before starting that initial fetch.
- [ ] Allow a failed initial history fetch to be retried by leaving and
      reselecting the session, as well as by reconnecting. Do not automatically loop
      retries on every snapshot or render.
- [ ] Check the captured transcript generation before _all_ page callback work,
      including scroll adjustments outside the reducer. A stale response must have
      no viewport side effects.
- [ ] If a current snapshot proves a queued session is gone/done/error, clear
      that queue before dispatching its notice. Reentrant dispatch must not observe
      the same stranded queue again.
- [ ] Stop using fresh fallback arrays as change signals. Compare narrowed
      authoritative snapshot references or use a stable empty display value.
      This supports the data guard; it does not replace it.
- [ ] Do not resubmit a send whose RPC was disconnected or timed out. Remove
      that ambiguous head from automatic draining, preserve its text in an editable
      local draft, and show that it may already have been sent. Preserve genuinely
      unsent entries. Resending the ambiguous text requires an explicit user action;
      no new wire operation-tracking system is needed.

### Required regressions

1. Real handle, fake client: running session → type a follow-up → Alt+Enter →
   deliver pending. No exception, no send/history RPC while pending, queue and
   draft/selection preserved. Deliver data: one latest-page fetch; queue remains
   governed by the existing turn-end rules.
2. Data with loaded history → pending → data for the same selected ID. The head
   becomes data again. Assert request timing, not merely the final reducer state.
3. Hold an older-page response, reset/reconnect, then release it. Neither entries,
   cursor nor scroll changes from that obsolete response.
4. Fail the first head fetch, select another session and return. A successful
   retry loads history.
5. Remove a queued session in a data snapshot. One notice; queue cleared; no
   recursion. Drop a send response after dispatch: no automatic second send.

Done: the reproduced `Maximum call stack size exceeded` and stuck history-error
cases fail before the fix and pass afterward. No extra connection flags exist.

## 2. Fix mode application/publication ordering

Files: `backend/daemon/src/daemon/daemon.ts`,
`backend/daemon/src/daemon/session-manager.ts`.
Tests: `test/daemon.test.ts` with controlled adapter promises.

### Change

- [ ] Keep end-to-end serialization for explicit mode/model/effort commands.
- [ ] Change the manager's mode-change notification into “this live session's
      mode changed,” rather than a delayed assignment of a captured mode value.
- [ ] In its queued daemon handler, recheck session existence and read the
      current live adapter snapshot's mode **when the handler runs**. Publish that
      value. If there is no live adapter, do not write an old observation into the
      stored session. A replacement adapter must not inherit an old captured mode.
- [ ] Skip a no-op registry mutation/publication when the applied mode already
      agrees. Keep provider-default behavior consistent with existing explicit
      settings commands; do not invent a new defaults policy in this fix.
- [ ] Handle failures from the fire-and-forget queue promise; do not introduce
      an unhandled rejection during teardown.
- [ ] Preserve approval and interrupt preemption. Do not solve ordering by
      placing approvals behind a turn that is waiting for approval.

### Required regression

1. Start `session.setMode(default)` and hold its adapter call after validation.
2. Emit a plan review and approve implementation in `acceptEdits`.
3. The adapter applies `acceptEdits` while the earlier call is held.
4. Release the earlier adapter call, which now applies `default`.
5. Await the command queue through a subsequent queued configuration operation
   or explicit test barrier. Assert adapter, registry, and both clients all show
   `default`. Merely sending an unrelated `ping` is not a general queue drain.

Also cover a session removed/replaced before the queued notification executes.
Keep the existing two-explicit-mode-change test. No timing sleeps to manufacture
the ordering.

Done: the reproduced adapter=`default`, registry=`acceptEdits` disagreement is
gone; the notification no longer carries stale state to install later.

## 3. Complete the transport and startup contract

Files: `backend/daemon/src/daemon/connection.ts`, `client/src/client.ts`,
`core/src/wire.ts` if shared decoding helpers are needed.
Tests: `test/connection.test.ts`, `test/client-state.test.ts`.

### Change

- [ ] Apply the outgoing backlog policy to `pushState`. A queued snapshot does
      not supersede an earlier encoded buffer. Keep drop-on-overflow; do not add
      batching or a delta protocol.
- [ ] Make the client write chain close/invalidate its current connection on
      failure instead of swallowing the error. Reject pending RPCs through the
      existing failure path. Do not retry mutation frames.
- [ ] Both readers must terminate a connection on invalid JSON. Remove the
      `catch { continue; }` path.
- [ ] Validate routing envelopes and the new state/hello payloads before using
      them. Reject wrong discriminants, invalid response IDs, and malformed daemon,
      providers, sessions, status or request payloads. Define the snapshot decoder
      once at the boundary and reuse the domain shapes; do not build validators for
      every vendor SDK protocol as part of this change.
- [ ] Resolve initial `connect()` only after protocol validation **and** the
      first valid snapshot. A hello response alone is insufficient. Reuse a bounded
      startup deadline; a missing initial snapshot must fail and close its socket.
- [ ] Preserve the daemon's synchronous subscribe/enqueue-initial-snapshot
      operation. Do not put a second installable snapshot in the hello response.
- [ ] Guard startup/reconnect continuations as well as socket reads with the
      current connection identity. A late response, close or dial result from a
      cancelled/superseded connection must not install state or reopen a closed client.

### Required regressions

1. Stalled fake writer; enqueue more than the configured backlog in snapshots
   alone. Connection closes and queued writes do not continue indefinitely.
2. Partial writes preserve frame order in both directions. Force a write failure
   while reads remain open: the client leaves data and pending RPCs reject.
3. Install data, send malformed JSON and keep the peer open. Client leaves data;
   no stale snapshot is presented as current. Test the server reader too.
4. Send valid JSON with malformed state/hello contents: reject at the boundary.
5. Send hello response, hold initial snapshot: `connect()` remains unresolved.
   Release snapshot: it resolves with data. Never release it: deadline closes
   the socket. Update mismatch fixtures to send a real initial snapshot on their
   first _successful_ connection.
6. Deliberately release a held old callback after a new connection is installed,
   and a held dial after close. Neither can alter the new lifecycle state.

Done: limits apply to every snapshot path; malformed frames cannot be silently
lost; startup callers always receive current data or an explicit failure.

## 4. Make transcript retention actually bounded

Files: transcript helpers in `frontend/tui/src/model.ts`; history and scroll
operations in `frontend/tui/src/fleet-handle.ts`.
Tests: `test/tui-model.test.ts` plus one direct handle pagination case.

### Change

- [ ] Enforce `TRANSCRIPT_CAP` after page merges, ordinary live appends and
      out-of-order/replayed live merges. There must be one retention implementation.
- [ ] Retain a contiguous browsing window. Paging older at the cap evicts the
      newest end of that window; following the latest events evicts its oldest end.
      Never silently connect two retained regions across an unrepresented gap.
- [ ] Once newer entries have been evicted for older browsing, do not append
      unrelated live-tail entries across the gap. Keep live notices separate.
      The existing End/jump-to-latest action reloads the newest window and resumes
      following it. Keep this state inside the transcript handle/model, not another
      fleet-wide bookkeeping map.
- [ ] Base the older cursor on the retained window and actual server exhaustion.
      Eviction must not produce `olderCursor: null`. The user must be able to reload
      evicted older pages after returning to the latest window.
- [ ] Keep the visible reading position stable when older rows are prepended;
      do not let a subsequent live event discard the window being read.
- [ ] Keep loaded rows visible if a page request fails. Error/loading indicators
      must use the existing Loadable state, not another boolean pair.

### Required regressions

1. Three legal 5,000-entry pages never retain over 10,000 durable lines.
2. Older paging at capacity advances to earlier history; it neither loops on the
   same cursor nor claims false exhaustion.
3. A live event while viewing that older window does not evict the visible rows
   or create a gap presented as continuous history.
4. Jump to latest, then page older again: previously evicted entries can return.
5. Duplicates and out-of-order live delivery cannot bypass the cap or duplicate
   IDs. Page failure preserves the current window.

Done: page loading and live delivery obey the same bound, durable order remains
correct, and bounded memory does not masquerade as the end of server history.

## 5. Finish the interaction migration and delete the old projection

Files: `frontend/tui/src/{model,fleet-handle,components,app}.ts*`,
`core/src/interaction.ts`.
Tests: the existing interaction and render cases.

### Change

- [ ] Make request rendering and actions consume `SessionInteraction` directly.
      Keep ID, kind and payload together through the whole path.
- [ ] Use one small selector for the active request: prefer the first request
      matching the authoritative awaiting reason, falling back to the first request
      in snapshot order. Preserve FIFO within parallel permissions and retain all
      remaining requests; selecting one must not discard the rest.
- [ ] Preserve both free-text questions and native `AskUserQuestion` choices.
      Keep choice parsing at the boundary where its unknown input is interpreted.
- [ ] Reconcile every request-bound prompt, plan overlay and question navigator
      against the exact session/request ID in each new data snapshot. Close/reset
      obsolete interaction UI. Preserve typed text as a local draft where supported;
      never send it to a different request automatically.
- [ ] Do not close unrelated send/title prompts merely because some request was
      resolved. Continue preserving local state while connection state is pending.
- [ ] Delete `Pending`, `PendingPerm`, `pendingFor`'s optional-field conversion,
      `focusedPending`, and their obsolete callers after migrating all consumers.
- [ ] Delete the `resolved` shadow set, `pruneResolved`, and `resolvePerm`
      bookkeeping. Use the authoritative snapshot for outstanding requests. Retain
      a local submission latch solely to prevent duplicate key actions; it must not
      become a second request model or automatically retry an uncertain response.
- [ ] Replace `interactionReason(i)` with `i.kind` where needed. Remove unused
      `interactionLabel`. Keep/use an exhaustive fold where it simplifies rendering;
      do not keep wrappers just because the type is a union.

### Required regressions

1. Client A types an answer; client B resolves that exact request. A's stale
   prompt and navigation close; an unrelated draft remains intact.
2. Resolve one of several permissions in another client. Exactly that request
   disappears, the next remains actionable, and the session remains blocked.
3. Replace a question with a new ID in the same session. No old answer or cursor
   attaches to the new question.
4. Loading old history has no effect on any current interaction or action.
5. Batched duplicate approval keys issue one RPC without a shadow resolved set.

Done: searches for the deleted projection/reconciliation names return no
production callers. Delete the old `focusedPending` tests; keep the observable
behavior above. This step must remove production code overall.

## 6. Make publication follow a complete event transition

Files: `backend/daemon/src/daemon/session-manager.ts`,
`backend/daemon/src/daemon/daemon.ts`. Tests: manager/daemon suites.

- [ ] Update request/progress/background/rate-limit state and derive status
      before publishing the snapshot for that event.
- [ ] Stop publishing halfway through result handling from `onUsage` and then
      again from the status hook. Separate mutation from publication within this
      existing event path; no timed batching or new event-bus layer.
- [ ] Ensure a rate-limit-only event publishes its changed snapshot even when
      there is no status/usage change. Existing tests that fetch `session.get` do not
      prove that subscribers received an update.
- [ ] Preserve checkpoint/titling ordering: a completed turn's usage/turn count
      must be recorded before its checkpoint. Keep asynchronous title completion as
      a separate later transition.
- [ ] Do not let a failed transcript/broadcast hook skip all subsequent
      in-memory event bookkeeping. Handle that failure explicitly and log it; do
      not silently pretend persistence succeeded.

Test subscribers, not only `session.get`: a result publishes one consistent
completed-turn state; a rate-limit-only event reaches both clients; resolving
one parallel request publishes the remaining set even without a status change.
Hold a failing hook to prove state bookkeeping is not accidentally skipped.

Done: comments claiming a complete/once-per-event publication match the actual
callback order. No snapshot advertises half of one synchronous transition.

## 7. Close the cutover and verify the reductions

- [ ] Run the affected tests while implementing. Once the preceding steps pass,
      run `deno task typecheck`, `deno task test:silent`, `deno task lint`, and
      `deno task format:check`. Do not report unrun/unchecked checks as passing.
- [ ] Manually exercise two TUIs: queue a follow-up, disconnect/reconnect, browse
      old history, answer a request in the other window, and overlap a mode change
      with a plan decision. If interactive terminals are unavailable, name that
      missing check rather than treating a client-only test as equivalent.
- [ ] Verify `loom tail`, CLI list/create and protocol mismatch behavior.
- [ ] Update `docs/state-sync-plan.md`: replace inaccurate completion claims
      with the actual behavior and exact tests. Condense historical completion
      journals into brief status/validation notes.
- [ ] Report source, tests and docs line deltas separately. The reviewed growth
      was source/config +616, tests +1,128, docs +280. Do not count moving code or
      stripping comments as the substantive simplification.
- [ ] The final review must identify the removed representations and helpers,
      not merely list added safety checks. Keep genuine boundary tests; remove
      tests that only assert the deleted machinery.

## Separate follow-ups: do not smuggle them into the cutover

The earlier review also identified pre-existing request lifecycle problems:
adapter response failure can lose a manager request, and cross-provider plan
handoff creates a session before claiming the exact pending plan. Track a
separate provider-phase-5 change for these. Its tests must prove:

- a stale/already-claimed plan cannot create another session;
- two concurrent resolutions invoke the adapter/effect once;
- a known pre-application failure leaves the exact request answerable;
- an uncertain outcome is not automatically replayed;
- interrupt/close cancels parked interactions and cannot be undone by a late
  resolution callback.

Likewise, the provider control-event channel's lossy overflow and runtime
duplicate-ID registration need their own small fixes. This document does not
claim that completing state synchronization solves those upstream contracts.
