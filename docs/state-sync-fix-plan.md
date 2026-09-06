# State-sync corrective plan

Baseline: local `main` at `d52117f`, reviewing the seven commits after `01ad1a60`.
Status: steps 0-6 done. Later steps are planned; their checkboxes are not implemented.

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

- [x] Gate `drainQueues`, `forgetDeadSessions`, and history requests on
      `state.fleet.tag === "data"`. An unknown fleet is not an empty fleet.
- [x] On disconnect, preserve selection, drafts and unsent queue entries;
      invalidate history requests, clear transcript caches and reset scroll.
      **Do not start a replacement history request yet.**
- [x] On transition from non-data to data, fetch the selected session's latest
      page. Also fetch on selection change and an explicit cache reset while data.
- [x] Register live transcript listening before starting that initial fetch.
- [x] Allow a failed initial history fetch to be retried by leaving and
      reselecting the session, as well as by reconnecting. Do not automatically loop
      retries on every snapshot or render.
- [x] Check the captured transcript generation before _all_ page callback work,
      including scroll adjustments outside the reducer. A stale response must have
      no viewport side effects.
- [x] If a current snapshot proves a queued session is gone/done/error, clear
      that queue before dispatching its notice. Reentrant dispatch must not observe
      the same stranded queue again.
- [x] Stop using fresh fallback arrays as change signals. Compare narrowed
      authoritative snapshot references or use a stable empty display value.
      This supports the data guard; it does not replace it.
- [x] Do not resubmit a send whose RPC was disconnected or timed out. Remove
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

**Done.** All six regressions were written first and all six failed, each for
its stated reason — regression 1 with the reproduced
`RangeError: Maximum call stack size exceeded` thrown out of the snapshot
delivery through `note → dispatch → drainQueues → note`.

The root cause of most of it was one expression: `fleetSessions(state)` answers
a _fresh_ `[]` both for "no sessions" and for "no connection". Comparing that to
the previous one was true on every dispatch, so `drainQueues` and
`forgetDeadSessions` ran constantly and, while disconnected, read the empty
fallback as proof that every queued session was gone. `sessionsRef` now returns
the authoritative array or `null`, and the three effect functions each refuse to
run without a snapshot. No `connected` or `hasSnapshot` flag was added; every
decision narrows the existing `ClientState`.

Rather than list the checkboxes back, the parts worth knowing:

- **The recursion** was fixed by clearing the stranded queue before announcing
  it, and by re-reading `state.queue[id]` inside the loop instead of trusting
  the entries captured before the first reentrant dispatch.
- **Stranding is now the drain's job alone.** `applyClientState` used to
  `pruneByLive` the queue, which silently dropped a message the user had typed
  the moment its session went. That prune is gone; the reducer keeps the queue
  and `drainQueues` clears it _and_ says so.
- **A disconnect no longer refetches.** The cache reset on disconnect leaves
  every `head` at `idle`, which used to fire a request at a dead socket
  immediately. `loadHistory` returns without a snapshot, so the fetch now waits
  for the `non-data → data` edge, which is a third trigger beside a selection
  change and a cache reset.
- **A failed head retries only on an explicit action.** `loadHistory` proceeds
  from `idle` _or_ `error`, which is safe precisely because it is called from
  three discrete transitions and never from a render or an arbitrary snapshot.
- **`loadOlderHistory`'s callback returns early on a stale generation.** The
  reducer already refused the entries; what leaked was the viewport. Regression 3
  fails without this by scrolling to row 57 of a log the user never scrolled.
- **A disconnected or timed-out `session.send` is no longer re-drained.** Both
  mean the same thing — the reply never came back, so whether the daemon ran it
  is unknowable here. The head leaves the queue for a per-session `heldSend`
  slot, the notice says it may already have been sent, and opening that
  session's `send` prompt restores it as editable text. Nothing resends without
  the user pressing Enter.

Two changes outside the two files this step named:

- `client/src/client.ts`: the timeout rejection is now tagged `code: "timeout"`,
  beside the existing `code: "disconnected"`. The alternative was matching on
  the message string from the TUI.
- `frontend/tui/src/fleet-handle.ts` exports `FleetClient`, the seven-member
  slice of `LoomClient` the handle drives, and takes that instead of the class.
  A real daemon cannot hold a response open or deliver `pending` on cue, so the
  regressions need a stand-in; naming the dependency is how they get one without
  a cast.

Reducer coverage moved with the behaviour: the old
"queue entries are pruned when their session disappears" asserted the prune this
step deleted, so it now asserts the queue survives for the drain to strand, and
a new case covers `holdSend`.

Verified: `deno task typecheck`, `deno task lint` and `deno task format:check`
clean; `deno task test` 624 passed (112 steps) / 0 failed, up from the 622 / 106
baseline.

## 2. Fix mode application/publication ordering

Files: `backend/daemon/src/daemon/daemon.ts`,
`backend/daemon/src/daemon/session-manager.ts`.
Tests: `test/daemon.test.ts` with controlled adapter promises.

### Change

- [x] Keep end-to-end serialization for explicit mode/model/effort commands.
- [x] Change the manager's mode-change notification into “this live session's
      mode changed,” rather than a delayed assignment of a captured mode value.
- [x] In its queued daemon handler, recheck session existence and read the
      current live adapter snapshot's mode **when the handler runs**. Publish that
      value. If there is no live adapter, do not write an old observation into the
      stored session. A replacement adapter must not inherit an old captured mode.
- [x] Skip a no-op registry mutation/publication when the applied mode already
      agrees. Keep provider-default behavior consistent with existing explicit
      settings commands; do not invent a new defaults policy in this fix.
- [x] Handle failures from the fire-and-forget queue promise; do not introduce
      an unhandled rejection during teardown.
- [x] Preserve approval and interrupt preemption. Do not solve ordering by
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

**Done.** Both regressions were written first and both failed with exactly the
reported disagreement — `actual 'acceptEdits' / expected 'default'` on the
registry row while the adapter sat on `default`.

The cause was the notification's shape. `respondToPlan` read
`run.session.snapshot().mode` at the moment of the decision and handed that
_value_ to `onMode`, whose handler is serialized behind the session's other
commands. A `session.setMode` parked inside the adapter therefore finished
after the decision but was published before it, and the queued notification
then wrote a mode the adapter had already left.

`onMode(sessionId)` now takes no mode. It means "this live session's mode
changed"; the queued handler answers "to what?" itself, from
`SessionManager.snapshot(id)`, when it runs. Three consequences fall out of
that rather than being coded separately:

- a value from before the command that overtook it can no longer be installed;
- no live adapter means no answer, so nothing is written — a replacement
  adapter cannot inherit an observation of the one it replaced;
- when the row and the adapter already agree there is nothing to write, so the
  no-op registry mutation and its publication are skipped.

The queue promise is fire-and-forget by design (the manager raises this from
inside `respondToPlan`, and awaiting a queue an approval doesn't otherwise
touch would park the approval behind an unrelated configuration command), so it
now carries a `.catch` that logs rather than leaving an unhandled rejection
during teardown. Approval and interrupt preemption are untouched:
`session.respondPlan` is still not queued.

Test-fidelity change: `FakeSession.respondToPlan` now applies the decision's
mode to its own snapshot. A real adapter leaves plan mode by applying the
approved mode to itself, and without that the fake could not express the state
the bug needs. `test/aisdk.test.ts`'s two `onMode` hooks read the mode back off
the manager instead of off the callback argument, which is the new contract.

Kept as they were: the two-explicit-mode-change test, the mounting-adapter test,
the revive-race test and the plan-guard rejection test all still pass unchanged.
No timing sleeps — the ordering is staged with `blockMode` and the `ping`
barrier, and the queue is drained through a later queued `session.setModel`.

Verified: typecheck, lint, format:check clean; `deno task test` 626 passed
(112 steps) / 0 failed.

## 3. Complete the transport and startup contract

Files: `backend/daemon/src/daemon/connection.ts`, `client/src/client.ts`,
`core/src/wire.ts` if shared decoding helpers are needed.
Tests: `test/connection.test.ts`, `test/client-state.test.ts`.

### Change

- [x] Apply the outgoing backlog policy to `pushState`. A queued snapshot does
      not supersede an earlier encoded buffer. Keep drop-on-overflow; do not add
      batching or a delta protocol.
- [x] Make the client write chain close/invalidate its current connection on
      failure instead of swallowing the error. Reject pending RPCs through the
      existing failure path. Do not retry mutation frames.
- [x] Both readers must terminate a connection on invalid JSON. Remove the
      `catch { continue; }` path.
- [x] Validate routing envelopes and the new state/hello payloads before using
      them. Reject wrong discriminants, invalid response IDs, and malformed daemon,
      providers, sessions, status or request payloads. Define the snapshot decoder
      once at the boundary and reuse the domain shapes; do not build validators for
      every vendor SDK protocol as part of this change.
- [x] Resolve initial `connect()` only after protocol validation **and** the
      first valid snapshot. A hello response alone is insufficient. Reuse a bounded
      startup deadline; a missing initial snapshot must fail and close its socket.
- [x] Preserve the daemon's synchronous subscribe/enqueue-initial-snapshot
      operation. Do not put a second installable snapshot in the hello response.
- [x] Guard startup/reconnect continuations as well as socket reads with the
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

**Done.** Regressions were written first; the three new `test/connection.test.ts`
cases failed on arrival (`destroyed false !== true`; a frame after corrupted
input still routed; an id-less request still dispatched), and the client cases
failed against the pre-fix client.

Where the shapes are checked: a new `core/src/wire-decode.ts` holds the boundary
decoders both ends use — `isRequestFrame`, `isResponseFrame`, `isStatePush`,
`isPushFrame`, `isHelloResult`, `isDaemonSnapshot`. It validates envelopes,
discriminants, and the fields a consumer branches on or iterates; it does not
try to schema-check a permission request's `input`, which is the vendor SDK's
vocabulary and no part of this wire. Its header says so, so the next reader
doesn't mistake the scope for an oversight.

The substantive changes:

- **One backlog rule for everything written.** `pushState` bypassed the ceiling
  on the argument that snapshots supersede each other. They do as _values_ — not
  as encoded buffers already sitting in the write chain, which is what the
  ceiling counts. `#overBacklog()` is now the single check both `push` and
  `pushState` make, and the stale comment claiming the exemption is gone.
- **Neither reader skips a frame any more.** Both had a `catch { continue; }`
  over `JSON.parse`. A line we cannot read means the stream has already lost
  something we would never learn about, so both now drop the connection and
  re-baseline. The same applies to a well-formed frame we cannot route: a
  request with no id has no address to answer at.
- **`connect()` waits for the opening snapshot.** A hello response is not a
  connection; every caller goes straight on to read the fleet, and resolving
  before the first snapshot makes "no snapshot yet" indistinguishable from "no
  sessions". The wait is bounded by `firstSnapshotMs` (10s; a test seam lets a
  case prove the deadline in 250ms), and a daemon that never sends one fails
  with its socket closed and no reconnect loop left behind.
- **The daemon's side of that contract is untouched**: `#hHello` still
  subscribes and enqueues the opening snapshot in one synchronous step, before
  the hello response, and the response still carries handshake metadata only.
- **A write failure invalidates the client's connection** instead of being
  swallowed. The frame is never retried — a mutation would then run twice — and
  `#onSocketClose` rejects everything outstanding as `disconnected`, which is
  the honest answer when part of a frame may be on the wire.
- **Lifecycle continuations carry their connection's identity.** A dial that
  completes after `close()` closes the socket it was handed rather than
  installing it, and a handshake whose generation has been superseded does not
  announce a reconnect for a socket that no longer exists.
- **`close()` while reconnecting now returns to `idle`.** There was no socket to
  drop, so `#onSocketClose` never ran and nothing moved the state off `pending`
  — a client the caller had finished with went on saying "reconnecting…".

Two things this step did _not_ verify directly, stated rather than glossed:

- **A forced client-side write failure with reads still open is not reachable
  over a real Unix socket** — a peer that makes writes fail has also ended
  reads. The handling above is implemented and its consequences (pending RPCs
  rejecting as `disconnected`, the fleet leaving `data`) are covered through the
  dropped-peer path; the write-error branch itself is not driven by a test.
- **The superseded-handshake guard is unreachable by construction.** `gen` can
  only change during the hello `await`, and a drop during that await rejects the
  pending request, so the continuation never runs with a stale generation. The
  check is kept as a cheap invariant, not because a test exercises it.

Frame ordering under partial writes is covered in both directions: the existing
daemon-side case, plus a new client-side one that issues fifty 64 KiB requests
in a single turn and asserts the stub read fifty whole, parseable lines in issue
order.

Verified: typecheck, lint and format:check clean; `deno task test` 636 passed
(112 steps) / 0 failed.

## 4. Make transcript retention actually bounded

Files: transcript helpers in `frontend/tui/src/model.ts`; history and scroll
operations in `frontend/tui/src/fleet-handle.ts`.
Tests: `test/tui-model.test.ts` plus one direct handle pagination case.

### Change

- [x] Enforce `TRANSCRIPT_CAP` after page merges, ordinary live appends and
      out-of-order/replayed live merges. There must be one retention implementation.
- [x] Retain a contiguous browsing window. Paging older at the cap evicts the
      newest end of that window; following the latest events evicts its oldest end.
      Never silently connect two retained regions across an unrepresented gap.
- [x] Once newer entries have been evicted for older browsing, do not append
      unrelated live-tail entries across the gap. Keep live notices separate.
      The existing End/jump-to-latest action reloads the newest window and resumes
      following it. Keep this state inside the transcript handle/model, not another
      fleet-wide bookkeeping map.
- [x] Base the older cursor on the retained window and actual server exhaustion.
      Eviction must not produce `olderCursor: null`. The user must be able to reload
      evicted older pages after returning to the latest window.
- [x] Keep the visible reading position stable when older rows are prepended;
      do not let a subsequent live event discard the window being read.
- [x] Keep loaded rows visible if a page request fails. Error/loading indicators
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

**Done.** Four of the six new reducer cases fail against the previous logic and
pass after — verified by reverting the two changed folds in place and re-running:
"three legal pages never retain more than the cap", "older paging at capacity
advances…", "a live event while browsing an older window…", and "jump to latest
reloads the newest window…". The other two (duplicate/out-of-order delivery, a
failed page keeping its window) guard behaviour that already held; they are
regression cover, not reproductions.

The cap had one implementation and two callers, and only one of them used it:
`appendLive` trimmed, `foldPage` merged without a bound. Three 5,000-entry pages
retained 15,000 lines. There is now a single `retain(t, lines, keep, atOldest)`
that every growth goes through, and the two things it has to get right are
stated as its parameters rather than implied by the call site:

- **`keep` — which end survives.** The window is contiguous, so trimming has to
  drop from the end the reader is moving away from: following the tail evicts
  the front, paging back evicts the tail.
- **`atOldest` — what the source claims about the front it supplied.** That
  claim only holds while that front is still retained, which is why
  `olderCursor` is now _recomputed from the retained window_ instead of copied
  off the page. `null` means the retained front is the daemon's oldest entry and
  nothing else, and anything evicted is refetchable by construction because the
  cursor is always the front.

`Transcript.following` is the new state, and it carries the asymmetry the old
code had no way to express: only tail eviction leaves unrepresented history
between the window and the live stream. While it is false, `appendLive` folds
nothing in — an arriving event has nowhere contiguous to go, and drawing it onto
the window would present a gap as continuous history. The event still reaches
the user through the notice line, which is a separate path and untouched.
`End` dispatches `transcriptFollow`, which drops the older window and puts
`head` back to `idle` — the same edge that already makes the handle refetch —
and following resumes. The state lives in the transcript, not in a fleet-wide
map beside it.

One handle-side consequence: after an older fold at the cap, `logScroll` cannot
be adjusted by a row delta, because it counts up from a tail that has just
moved. When the fold dropped the tail (or the view was pinned) the position is
re-derived from the top instead. The fetch only fires within a page of the top,
so that is where the reader already is.

`test/tui-render.test.ts` drives the whole path through the real handle: two
6,000-row pages fetched, 10,000 retained, the cursor advanced to the retained
front, a live push that leaves the window alone, and `End` refetching the newest
page and resuming.

Verified: typecheck, lint and format:check clean; `deno task test` 643 passed
(113 steps) / 0 failed.

## 5. Finish the interaction migration and delete the old projection

Files: `frontend/tui/src/{model,fleet-handle,components,app}.ts*`,
`core/src/interaction.ts`.
Tests: the existing interaction and render cases.

### Change

- [x] Make request rendering and actions consume `SessionInteraction` directly.
      Keep ID, kind and payload together through the whole path.
- [x] Use one small selector for the active request: prefer the first request
      matching the authoritative awaiting reason, falling back to the first request
      in snapshot order. Preserve FIFO within parallel permissions and retain all
      remaining requests; selecting one must not discard the rest.
- [x] Preserve both free-text questions and native `AskUserQuestion` choices.
      Keep choice parsing at the boundary where its unknown input is interpreted.
- [x] Reconcile every request-bound prompt, plan overlay and question navigator
      against the exact session/request ID in each new data snapshot. Close/reset
      obsolete interaction UI. Preserve typed text as a local draft where supported;
      never send it to a different request automatically.
- [x] Do not close unrelated send/title prompts merely because some request was
      resolved. Continue preserving local state while connection state is pending.
- [x] Delete `Pending`, `PendingPerm`, `pendingFor`'s optional-field conversion,
      `focusedPending`, and their obsolete callers after migrating all consumers.
- [x] Delete the `resolved` shadow set, `pruneResolved`, and `resolvePerm`
      bookkeeping. Use the authoritative snapshot for outstanding requests. Retain
      a local submission latch solely to prevent duplicate key actions; it must not
      become a second request model or automatically retry an uncertain response.
- [x] Replace `interactionReason(i)` with `i.kind` where needed. Remove unused
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

**Done.** Production source is **net −55 lines** (262 added, 317 deleted) across
six files; tests are +105. Grepping the workspace for `Pending`, `PendingPerm`,
`pendingFor`, `firstPerm`, `focusedPending`, `pruneResolved`, `resolvePerm`,
`interactionReason` and `interactionLabel` returns nothing outside two unrelated
namesakes (`runtime/src/pending.ts`'s adapter-side parked-promise registry and
the ChatGPT connector's RPC waiter).

What was removed, and why each could go rather than being moved:

- **`Pending` / `PendingPerm`.** A second shape for the request set, built by
  flattening `SessionInteraction` into optional fields — `plan` and `planText`
  beside each other, `permission` and `user_question` merged into one
  `permissions` array. Every consumer now takes the interaction itself, so the
  id, kind and payload stay together from the snapshot to the screen to the RPC
  that answers it. `RequestPanel` is an exhaustive `foldInteraction`, which is
  what made the flattening unnecessary rather than merely inconvenient.
- **`focusedPending`.** It existed to undo damage `pendingFor` did: having
  merged everything into one bag, it had to narrow the bag back down using
  `status.on`. `activeRequest` reads `status.on` once, picks the matching
  request, and keeps the rest — twelve lines instead of two functions, and
  "selecting one must not discard the rest" is now structural rather than a
  rule to remember.
- **The `resolved` shadow set**, with `pruneResolved` and the `resolvePerm`
  action. It was a second request model: a per-session list of ids the client
  had answered, hidden from a projection, pruned against the snapshot on every
  install. What replaces it is one closure variable in the handle holding the
  last request id submitted. That is a duplicate-keystroke guard and nothing
  else — it never hides a request, and `releaseRequest` deliberately keeps the
  latch on a disconnected or timed-out reply, because retrying an uncertain
  answer would resolve the same request twice.
- **`interactionReason`.** `AwaitReason` and `SessionInteraction["kind"]` are
  the same closed set on purpose, so the fold was the identity written out
  longhand. `status-machine.ts` uses `request.kind`.
- **`interactionLabel`.** No callers.

What was added, deliberately: request-bound UI is now reconciled against the
exact `(session, request)` pair in every data snapshot. A prompt, plan overlay
or question navigator whose request the snapshot no longer carries closes, with
a notice saying it was resolved elsewhere. A `send` or `title` prompt carries no
request id and is untouched by any of it — resolving a permission does not close
the message someone is half-way through typing.

Regressions, each verified to fail with its fix reverted in place:

1. `a resolved request closes the UI bound to it, and nothing else` — client B
   resolves the exact request client A is answering; A's prompt and navigator
   close, an unrelated draft survives, and nothing typed for the old request is
   re-aimed at the new one.
2. `resolving one of several permissions retires exactly that one, FIFO`.
3. Covered by 1's second half: a new question id inherits no answers or cursor.
4. `loading old history changes no outstanding request`, driven through the
   real handle.
5. `a batched duplicate approval key issues one RPC, with no shadow request
set` — two `a` presses in one stdin chunk against the same snapshot.

Deleted tests: `focusedPending keeps only the surface…` (the function is gone)
and `answering a request hides it until the snapshot agrees` (it asserted the
shadow set). The observable behaviour both were reaching for is covered above.

One deliberate behaviour change worth naming: answering the first of several
parallel permissions now waits a round trip before the panel moves to the next,
where the shadow set moved instantly. That is the cost of having one source of
truth for what is outstanding, and §6 shortens the wait by publishing the
snapshot as part of the same transition.

Verified: typecheck, lint and format:check clean; `deno task test` 645 passed
(115 steps) / 0 failed.

## 6. Make publication follow a complete event transition

Files: `backend/daemon/src/daemon/session-manager.ts`,
`backend/daemon/src/daemon/daemon.ts`. Tests: manager/daemon suites.

- [x] Update request/progress/background/rate-limit state and derive status
      before publishing the snapshot for that event.
- [x] Stop publishing halfway through result handling from `onUsage` and then
      again from the status hook. Separate mutation from publication within this
      existing event path; no timed batching or new event-bus layer.
- [x] Ensure a rate-limit-only event publishes its changed snapshot even when
      there is no status/usage change. Existing tests that fetch `session.get` do not
      prove that subscribers received an update.
- [x] Preserve checkpoint/titling ordering: a completed turn's usage/turn count
      must be recorded before its checkpoint. Keep asynchronous title completion as
      a separate later transition.
- [x] Do not let a failed transcript/broadcast hook skip all subsequent
      in-memory event bookkeeping. Handle that failure explicitly and log it; do
      not silently pretend persistence succeeded.

Test subscribers, not only `session.get`: a result publishes one consistent
completed-turn state; a rate-limit-only event reaches both clients; resolving
one parallel request publishes the remaining set even without a status change.
Hold a failing hook to prove state bookkeeping is not accidentally skipped.

Done: comments claiming a complete/once-per-event publication match the actual
callback order. No snapshot advertises half of one synchronous transition.

**Done.** All four regressions were written first. Three failed:

- `a completed turn publishes one consistent state, never half of it` — the
  first snapshot carrying the new turn count reported the _previous_ status,
  because `#trackUsage` called `onUsage`, which published, before
  `#applyStatus` derived the settled state and published again. Two
  publications for one event, the first of them half-applied.
- `a rate-limit-only event reaches every attached client` — `#trackRateLimit`
  returned `void`, so a `rate_limit` event joined nothing that decided to
  publish. Worth recording how this one nearly passed for the wrong reason: the
  first version of the test emitted a `result` shortly before, and the
  _auto-titler_ finishing published a snapshot that happened to carry the new
  rate-limit window. Letting the turn settle first, and asserting against what
  subscribers were handed rather than `session.get`, made it fail properly —
  which is exactly the trap this step's brief warns about.
- `a failing emitEvent does not stop the session's state advancing` — the
  persist/broadcast hook sat inside the same `try` as every tracker, so one
  throw skipped the whole event: no request set, no status, nothing published,
  while the agent carried on. Driven against a bare `SessionManager`, since a
  real daemon's store does not fail on demand.

`resolving one parallel request publishes the rest, with no status change`
passed on arrival and is kept as regression cover.

The fix is a shape, not a set of guards: `#drain` now persists the event in its
own `try`, then applies everything the event changes — requests, compaction
progress, sub-agents, background tasks, rate-limit windows, usage — derives the
status from that, and only then publishes. `#trackRateLimit` and `#trackUsage`
report whether they changed anything instead of returning `void`, so they join
the same decision as every other tracker. `onUsage` accumulates and no longer
publishes; its doc says so. `onOverlay`'s doc now names the full set of things
it publishes for, which is what makes "once per event, after everything" a
claim a reader can check rather than take on trust.

Ordering preserved deliberately: usage and the turn count are recorded before
`onResult` takes the checkpoint, so the checkpoint belongs to the turn that
produced them, and the auto-titler stays asynchronous — a later transition of
its own, not part of this one.

Verified: typecheck, lint and format:check clean; `deno task test` 646 passed
(118 steps) / 0 failed.

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
