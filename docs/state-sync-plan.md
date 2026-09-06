# Simple daemon state sync and independent transcripts

Status: ready for implementation. Work through the checkboxes in order, updating
this document with completion notes and validation results. This records the
user's agreed direction; do not reopen the architecture discussion or expand it
into a general synchronization framework.

## Decisions

- One daemon owns authoritative state. Multiple TUIs are ordinary clients.
- State synchronization is a stream of **complete replacement snapshots**.
- The client exposes the existing `Loadable<E, A>` primitive: connecting or
  disconnected means `pending`; a current snapshot means `data`.
- Commands never optimistically modify the client's authoritative state. Last
  successfully applied configuration change wins; no conflict revisions.
- Transcripts are a separate paginated resource. Reading history cannot change
  current session state, outstanding requests, or available actions.
- Reconnect resets transcript caches and returns the selected session to its
  latest page. Losing the old reading position is an accepted first-pass tradeoff.
- No operation IDs, command-status queries, automatic mutation retries, separate
  `uncertain` state, `Replica` abstraction, state deltas, or state replay.

Keep local drafts, selection, overlays, filters, and existing local follow-up
queues in the TUI. This is not a redesign of their ownership or behavior.

## Target contract

Names below are illustrative; keep the implementation small and explicit.

```ts
type DaemonSnapshot = {
  daemon: DaemonInfo;
  providers: readonly ProviderInfo[];
  sessions: readonly SessionSnapshot[];
};

// Move the existing Loadable and helpers into core for client/TUI sharing.
type ClientState = Loadable<ConnectionError, DaemonSnapshot>;

type HistoryPage = {
  items: readonly TranscriptEntry[];
  olderCursor: HistoryCursor | null;
};
```

`SessionSnapshot` includes complete outstanding interaction payloads and relevant
operation progress, including compaction. Each interaction is a discriminated
union of permission, question, or plan, carrying its ID and display data together.
Preserve simultaneous permissions and existing `AskUserQuestion` behavior.

A fresh snapshot restores knowledge of current state; it does not prove every
previous RPC has finished. Operations whose progress matters appear in the
snapshot. Ordinary RPC success/failure remains available for local feedback;
disconnects and timeouts must not trigger automatic resubmission.

## 1. Make session snapshots complete

Primary files: `core/src/wire.ts`, `core/src/session-state.ts`,
`backend/daemon/src/daemon/session-manager.ts`,
`backend/daemon/src/daemon/daemon.ts`.

- [x] Replace the session manager's reason-only pending-request values with
      complete typed interactions. Derive the existing await reason from them rather
      than maintain another parallel map of payloads.
- [x] Expose those interactions in session snapshots, including the data needed
      to render permission prompts, questions, and plan review without any history.
- [x] Make creation, resolution, cancellation, interruption, and stream end
      update the authoritative request set and notify snapshot publication. Publish
      when the set changes even if the session remains `awaiting_input` (for example,
      one of several parallel permissions was answered).
- [x] Include the compaction progress the UI currently derives from events in
      snapshots. Reuse existing runtime state; do not add persistence for transient
      operations solely for this refactor.
- [x] Use closed unions with exhaustive folds/switches and `absurd` for new
      domain shapes. Keep request IDs and their payloads together. Avoid duplicating
      domain state just to retain the old TUI shape.

Acceptance: a second client with no downloaded transcript can display and answer
the exact outstanding request. Resolving one permission updates both clients
while any other permissions remain available.

**Done.** Notes:

- New `core/src/interaction.ts` (`@loom/core/interaction`): `SessionInteraction`
  is a closed union of `permission` / `user_question` / `question` /
  `plan_review`, each carrying its request id _and_ its display payload.
  `foldInteraction` + `absurd` for exhaustiveness; `interactionReason` maps a
  request to its `AwaitReason` (the `kind`s are exactly those values, so the
  reason is derived, not tracked). `interactionFor(ev)` is the single place the
  "`AskUserQuestion` is a multiple-choice prompt, not a gate" rule lives —
  `deriveStatus` now calls it instead of re-deciding, so `status-machine.ts`
  lost its three duplicated cases.
- `SessionManager`'s `Running.pending` is `Map<string, SessionInteraction>`
  (insertion-ordered = oldest first). `requestsOf(id)` feeds the snapshot, and
  `setMode`'s `plan_pending` guard reads the union rather than a reason string.
- `SessionSnapshot.requests: SessionInteraction[]` on the wire; filled by the
  daemon's `#enrich`, `[]` in the store mapper (runtime overlay, not persisted).
- Publication: the trackers now _return_ whether they changed anything, and the
  drain does exactly one publish per event — a status transition already carries
  the fresh overlays, so only an overlay change without one publishes on its
  own. `#transition` returns whether it fired so `#resumeAfterAnswer` can
  publish when the turn stays blocked on the remaining permissions. Stream end,
  pump failure, `interrupt` and the provider swap clear the set through
  `#clearOverlays` and publish.
- The three identical `onSubagents` / `onBackgroundTasks` / `onRestructuring`
  hooks collapsed into one `onOverlay(sessionId)`, which republishes with
  `git: false` — these fire per tool call / per compaction beat now, and none of
  them can move the worktree.
- Compaction: `Running.compaction` is tracked from `compact_progress` beats
  (so a _provider-triggered_ auto-compaction, which never holds the op gate, is
  covered too) and cleared by the landing `compact` or any `error`, mirroring
  the TUI's `trackCompacting`. `SessionSnapshot.compacting` gained `generated`;
  `before: 0` from the gate-only fallback is substituted with the session's
  current context fill.

Validation: six new cases in `test/session-manager.test.ts` (cold second client
answers a complete permission; one of three parallel permissions resolves and
both clients see exactly that; question / plan / `AskUserQuestion` payloads
complete in the snapshot; compaction progress from beats to landing `compact`;
stream end and `interrupt` clear the set). All four repository checks are clean
(`typecheck`, `test:silent`, `lint`, `format:check`).

## 2. Add one snapshot subscription and migrate state consumers

Primary files: `core/src/wire.ts`, `core/deno.json`,
`frontend/tui/src/loadable.ts`, `client/src/client.ts`,
`backend/daemon/src/daemon/{daemon,server,connection,registry,event-log}.ts`,
`frontend/tui/src/{model,fleet-handle}.ts`,
`frontend/tui/src/{components,app,run}.tsx`.

- [x] Move `Loadable` and its existing helpers to `core`, export it, and update
      imports. The client must not depend on the TUI package.
- [x] Add a complete snapshot push. After protocol validation, subscribe and
      enqueue the initial snapshot as one synchronous operation. Handshake RPC
      results carry handshake metadata, not a second installable state baseline.
- [x] Route authoritative session additions, changes, removals, provider/default
      changes, and relevant runtime changes through one snapshot publisher. Read
      current authoritative values at publication; do not reuse an old mutation
      result. Build without asynchronous gaps and avoid new git subprocess calls
      across the fleet on every usage/progress update; use maintained facts.
- [x] Deliver snapshots directly to current subscribers. Do not retain complete
      fleet snapshots in the reconnect replay ring. Straight publication is the
      starting point; add no batching/delta protocol without measured need.
- [x] Guarantee serialized frame writes on each socket in both directions,
      including partial writes. Preserve frame/backlog limits; a malformed frame or
      write failure must terminate that connection rather than silently lose state.
- [x] Expose a stable client `getState`/`subscribe` API. Use `idle` before start,
      `pending` while connecting/reconnecting, `data` on snapshot, and `error` for a
      terminal connection/protocol failure. Existing connect callers that require
      initial state must wait for the first snapshot.
- [x] Guard socket callbacks with a local connection generation or identity.
      Close, read, and response callbacks from a superseded socket cannot change
      current state or install an obsolete snapshot. This is lifecycle bookkeeping,
      not a wire revision system.
- [x] Have the TUI consume this one client snapshot. Remove its boot-time and
      reconnect `session.list`/`providers.list` reconciliation, timestamp merging,
      and independent authoritative session/provider caches. Read-only RPCs can
      remain for CLI callers; their results must not feed this subscription.
- [x] Render connection/loading states with `foldLoadable`. Preserve drafts and
      selection intent while pending; disable commands that require current daemon
      state. Reconcile selected IDs and open request overlays against new snapshots,
      including closing an overlay whose exact request ID disappeared.
- [x] Keep ordinary command responses for acknowledgment, local feedback, and
      returned IDs (create/fork selection). Never install returned session values
      into the authoritative client snapshot.

Acceptance: updates and removals reach two TUIs through snapshots alone. A
disconnect produces `pending`; reconnect supplies the complete current fleet,
including changes made while disconnected. Delayed old callbacks cannot regress
it. No polling or state replay is needed.

**Done.** Notes:

- `StatePush` carries a whole `DaemonSnapshot` (daemon info, providers,
  sessions) and sits _outside_ the seq-stamped stream and its replay ring — a
  snapshot is only interesting when it is the current one, so buffering old ones
  would spend memory to deliver staleness. `PushFrame` shrank to
  `EventPush | ResyncPush | NoticePush`; `session_updated`, `session_removed`
  and `providers_updated` are gone, and `PROTOCOL_VERSION` is 2 (a v1 client
  would sit with an empty fleet forever, so the mismatch has to be loud).
- `#stateFrame` is the one place a snapshot is built, reading current
  authoritative values at publication. `refreshGitFor` re-probes one session's
  worktree; every other session reads the facts `#sweepGitFacts` maintains, so
  publishing per tool call doesn't become a `git` shell-out per session per
  token. `hello` subscribes and enqueues the opening snapshot as one synchronous
  operation and its result is handshake metadata only.
- Both ends chain socket writes: `writeAll` can return after a _partial_ write,
  so two concurrent frames interleaved their halves and corrupted both. A failed
  daemon-side write now drops the connection rather than leave a client holding
  a prefix of the truth. The client stamps each socket with a generation, so a
  read/close/response from a superseded socket cannot touch current state.
- `TuiState` lost `sessions` / `providers` / `daemon` / `connection` for one
  `fleet: ClientState`. `connectionOf` derives the header lamp from the loadable
  tag rather than tracking it beside the data, and while `pending` there is
  genuinely no fleet to show rather than a stale one the user might act on.
  Snapshot install reconciles the selection, child focus, and any prompt /
  picker / plan overlay whose session or exact request id is gone.
- `modeOptimistic` wrote a cycled permission mode straight into the session
  list. It is now `modeDraft`, a local overlay beside the snapshot that the
  debounced RPC clears either way — so a rejected change falls back to what the
  daemon reports instead of leaving the chip lying.
- Removed with their last consumer: the registry's per-session version counter
  and its `updatedAt` seeding (S6 cannot exist without a version), the TUI's
  `boot` Loadable and `refetch`, and `LoomClient.sessions`. `loom tail` keeps
  its raw-event replay and reports fleet size from the snapshot instead.

Validation: new `test/client-state.test.ts` (six cases: opening snapshot,
subscribe semantics, two clients seeing an add and a removal, disconnect →
`pending` → reconnect with changes made while away, no post-reconnect snapshot
repopulating the pre-drop fleet, close → `idle`), plus a `Connection` regression
test for frame interleaving that fails against the old unchained write (frames
arrive spliced, 1 line instead of 3) and one for write-failure teardown. Tests
asserting the removed push types were rewritten against snapshots. All four
repository checks are clean.

## 3. Serialize conflicting configuration commands

Primary files: `backend/daemon/src/daemon/{daemon,session-manager}.ts`,
`frontend/tui/src/fleet-handle.ts`.

- [x] Establish per-session serialization for mode/model/effort changes,
      covering validation, adapter application, registry/default updates, and
      snapshot publication. Serializing only the adapter call is insufficient.
      Handle inactive sessions too.
- [x] Recheck session existence and command validity when executing a queued
      change. Failed commands must not publish the requested value as applied.
- [x] Coordinate with existing provider-swap/restructuring behavior. Reuse gates
      where appropriate, but do not hold up interrupt or approval behind an entire
      turn waiting for user input, and do not introduce nested-gate deadlocks.
- [x] Preserve current mode semantics, including `plan_pending`: changing mode
      must not implicitly answer an outstanding plan review. Account for mode changes
      caused by plan decisions and adapter events as well as explicit `setMode`.
- [x] Preserve exact-request-ID, resolve-once behavior for approvals/questions.
      No new conflict tokens or operation-tracking subsystem.
- [x] Keep explicit target values in mode commands. A client computes the target
      it displays; the server does not reinterpret it as "cycle from current mode."

Acceptance: deliberately overlapping calls with a delayed adapter execute in
the daemon's chosen order, finish with matching adapter/registry state, and leave
both clients showing the final successful value. Rejection preserves existing
values and existing plan-review safeguards.

**Done.** Notes:

- New `backend/daemon/src/daemon/session-queue.ts` (`mkSessionQueue`) serializes
  each session's commands end to end under one key. The insight the old code
  missed: a mode change is validate → apply to adapter → write registry + provider
  defaults → publish, and gating only the adapter call leaves the other three
  interleaved. `session.setMode` / `setModel` / `setEffort` / `setProvider` now
  run whole under `#queue.run(id, …)`, with their existence and validity checks
  moved _inside_ so they are rechecked at execution time rather than at issue time.
- The daemon already had this exact shape as `#withLifecycleGate` / `#lifecycleGate`
  for `markDone` / `remove` / `gc`. Rather than stand a second one up beside it,
  those fold into the same queue: lifecycle ops are precisely the commands that
  can invalidate a queued configuration change, so sharing one chain is what makes
  a queued command's existence recheck conclusive instead of a narrower race.
  Net effect is one concept where there were two, and `#withLifecycleGate` is gone.
- Inactive sessions are covered by the same key, and the queue is now also held
  across adapter _construction_: `#startSession` wraps registry-create-through-attach,
  and `#reviveSession` wraps the rebuild (`#reviveLocked`). Both build the adapter
  from the row's mode/model/effort, so a command landing in that window used to take
  the "session isn't running" path and write the row only — leaving the adapter on
  its pre-command values. The attach-time mode reconciliation in `#startSession`
  existed to paper over exactly that for mode; it is deleted, and model/effort
  (which it never covered) are fixed by the same hold.
- `onMode` — the adapter reporting where it actually landed, after a plan decision
  or its own switch — goes through the queue too, so it can't land after an
  in-flight `setMode`'s registry write and leave the row describing a mode the
  adapter has since left. It is `void`-dispatched on purpose: the manager calls it
  from inside `respondToPlan`, and awaiting a queue an approval doesn't otherwise
  touch would park the approval behind whatever command happens to be running.
- Approvals, questions, plan responses and `interrupt` are deliberately _not_
  queued, so none of them can be held up behind a configuration command. Exact-request-id
  resolve-once behaviour is untouched, and no conflict token or operation-id
  subsystem was added.
- Deadlock freedom is structural, not incidental: the edge between the two gates is
  one-way. A queued command may take the session manager's turn gate; nothing
  holding the turn gate ever waits on the queue (the pump's `onMode` is
  fire-and-forget, `#maybeAutoRebase` re-enters via `#sessions.send`, not an RPC).
  The one place the new hold could have parked on a turn-length wait —
  `session.setProvider` waiting out a `compact` while holding the queue — now
  fast-fails with the same `code: "busy"` `session.send` already uses.
- `plan_pending` still refuses, and now refuses _inside_ the queue: the reject
  happens before any registry or provider-defaults write, so a failed command
  never publishes its requested value as applied.
- TUI: `cycleSessionMode` already sent an explicit target (the server never
  re-derives "next mode from current"). Fixed a draft-lifetime bug beside it — the
  chip's local draft was retired when the _first_ `session.setMode` replied, which
  with two overlapping cycles snapped the chip back to a snapshot a later call was
  still on its way to change. It now survives until nothing is in flight.
- Collapsed the `#publishState(); #publishState(snap.id);` pairs left by §2's
  mechanical conversion — the second is a superset of the first, so these were
  sending two whole-fleet snapshots where one was meant.

Validation: `deno check .`, `deno task test:silent`, `deno task lint`,
`deno task format:check` all clean. New `test/session-queue.test.ts` (5 tests)
covers the queue itself; `test/daemon.test.ts` gains overlapping-mode-changes,
mode-racing-a-revive, mode-behind-a-removal and plan-review-rejection cases, and
the existing mount-window test was reshaped (the click now queues rather than
racing, so it asserts on the settled row instead of the create's return value).
The four ordering tests were each verified to **fail** against a pass-through
`mkSessionQueue`, and their races are driven by `ping` round-trip barriers
(requests dispatch in arrival order) rather than sleeps.

## 4. Separate transcript storage, live delivery, and pagination from state

Primary files: `backend/daemon/src/store/{session-events,migrations}.ts`,
`backend/daemon/src/daemon/daemon.ts`, `core/src/wire.ts`,
`client/src/client.ts`, `frontend/tui/src/{model,fleet-handle}.ts`.

- [ ] Give durable transcript entries a stable identity and ordering shared by
      page results and live transcript pushes. Prefer the existing
      `session_events.id` (`INTEGER PRIMARY KEY AUTOINCREMENT`); expose a safe wire
      representation instead of introducing a second counter or rebuilding history.
- [ ] Persist before broadcasting a durable entry so a pushed ID is immediately
      readable. Keep transient raw events/notices separate; do not manufacture
      durable IDs for heartbeats.
- [ ] Return `HistoryPage` from `session.events`, oldest-first within each page.
      Page backwards using the durable ID and existing `(session_id, id)` index.
      Return an explicit older cursor (query one extra row if needed); `null` means
      actual exhaustion. Reject malformed/invalid cursors distinctly from exhaustion.
- [ ] Keep per-session transcript caches. Model initial loading and older-page
      loading with `Loadable`; preserve loaded entries while fetching older ones.
      Deduplicate by durable ID and order by durable order, not event timestamps.
- [ ] Establish live transcript listening before fetching the latest page.
      Merge overlapping page/live entries by ID so entries arriving during a fetch
      are neither lost nor duplicated. Keep local echoes identifiable separately.
- [ ] On reconnect, clear transcript caches, reset scroll to the live tail, and
      fetch the selected session's newest page. Ignore pre-reset fetch responses;
      other sessions fetch lazily when selected. Preserve drafts/selection.
- [ ] Remove `trackPending` and `trackCompacting` from TUI event/backfill paths,
      along with history-based pruning/recovery helpers made obsolete by snapshots.
      Raw live events may create transient notices; history pages must not.
- [ ] Remove `(epoch, seq)` transcript cursor translation and the global
      timestamp-sorted log merge. A client memory cap must not mean "server history
      exhausted." Use bounded page retention that permits refetching evicted pages;
      keep viewport behavior predictable within a connection.

Acceptance: scrolling old history never changes current requests or compaction.
Paging works across daemon restarts, including equal or nonmonotonic timestamps.
Live events overlapping a page appear once. Reconnect returns to a complete latest
page with no obsolete fetch reinstalling old cache state.

## 5. Remove superseded paths and validate

- [ ] Update all wire consumers together, including `cli/src/loom.ts`, harness
      code, and fixtures. Bump `PROTOCOL_VERSION` for incompatible wire changes and
      ensure mismatch fails clearly rather than reconnecting indefinitely.
- [ ] Remove obsolete state version counters, state replay/resync handlers,
      pre-mount state reconstruction, duplicate connection/boot flags, and comments
      describing the old protocol once their callers are migrated.
- [ ] Inspect `loom tail` before deleting event infrastructure. Its raw-event
      replay is a separate existing feature: preserve it if still consumed, keeping
      snapshots out of it. Epoch/seq can remain for that stream; they no longer
      identify transcript pages or reconcile authoritative state.
- [ ] Replace tests asserting removed protocol machinery with tests of the
      behavior below. Preserve unrelated feature coverage.

Focused verification (extend existing suites):

| Scenario                                                 | Expected result                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Two clients change mode with delayed adapter calls       | Serialized application; matching final adapter, daemon, and client state |
| Second client attaches during a permission/question/plan | Complete actionable request without loading history                      |
| One of several permissions resolves in another client    | Exactly that request disappears in both; remaining requests stay         |
| Old history loads during a new request or compaction     | Transcript changes; current state/actions do not                         |
| Session added/removed while disconnected                 | First new snapshot contains the exact current fleet                      |
| Old socket/fetch callback arrives after reconnect        | Ignored; cannot regress state or repopulate reset history                |
| Live transcript overlaps page fetch                      | One entry per durable ID, in durable order                               |
| Pagination crosses a daemon restart                      | Stable cursor/order; explicit end; no timestamp heuristics               |
| Connection drops during send/create                      | No automatic duplicate submission; screen recovers from snapshot         |
| Partial writes, malformed frames, protocol mismatch      | Ordered intact frames or explicit connection failure                     |

Start with `test/daemon.test.ts`, `test/session-manager.test.ts`,
`test/store.test.ts`, `test/tui-model.test.ts`, and `test/tui-render.test.ts`.
Add client/transport tests where an existing suite has no appropriate seam.
Use controlled promises/barriers for races rather than timing-dependent sleeps.

Run relevant tests while implementing, then the repository checks:

```sh
deno task typecheck
deno task test:silent
deno task lint
deno task format:check
```

Use the repository dev shell if `deno` is not on PATH. Validate manually with two
TUIs against a scratch repository: change mode, answer a request in the other
window, browse history, and restart the daemon. Confirm pending/recovery and the
intentional reset to the latest transcript page.

Done means one authoritative client `Loadable`, complete replaceable snapshots,
independent transcript pages, the superseded reconciliation code removed, and
validation recorded. Report any actual environment blocker and the precise
checks that could not run; do not mark unrun checks as passing.
