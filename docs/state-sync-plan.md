# Simple daemon state sync and independent transcripts

Status: implemented. Every checkbox below is done, and each section carries a
short note on what it changed and what covers it.

A review afterwards found real defects in this work — reproduced, not
speculative. They are fixed in `state-sync-fix-plan.md`, and each section here
ends with what that document corrected about it, including one completion claim
made here that was not true. Read the two together: this one records the design
and what shipped, that one records what it got wrong.

This records the user's agreed direction; do not reopen the architecture
discussion or expand it into a general synchronization framework.

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

**Done.** `SessionInteraction` (`@loom/core/interaction`) is a closed union of
`permission` / `user_question` / `question` / `plan_review`, each carrying its
request id and its display payload; `interactionFor(ev)` is the one place the
"`AskUserQuestion` is a multiple-choice prompt, not a gate" rule lives.
`SessionManager.Running.pending` holds the union, oldest first, and
`SessionSnapshot.requests` carries it on the wire. The three `onSubagents` /
`onBackgroundTasks` / `onRestructuring` hooks collapsed into `onOverlay`.
Compaction rides `Running.compaction`, tracked from `compact_progress` beats so
a provider-triggered auto-compaction is covered too.

Validation: six cases in `test/session-manager.test.ts` — a cold second client
answering a complete permission, one of three parallel permissions resolving in
both clients, complete question / plan / `AskUserQuestion` payloads, compaction
from beats to the landing `compact`, and stream end / `interrupt` clearing the
set.

Corrected since, by `state-sync-fix-plan.md`:

- This section claimed the drain "does exactly one publish per event". It did
  not: `#trackUsage` → `onUsage` published before the status was derived, so a
  completed turn went out twice, the first snapshot carrying the new turn count
  beside the previous turn's status. Fixed in fix-plan §6.
- `interactionReason` is deleted. `AwaitReason` and the interaction's `kind` are
  the same closed set, so it was the identity written longhand (fix-plan §5).

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

**Done.** `StatePush` carries a whole `DaemonSnapshot` and sits outside the
seq-stamped stream and its replay ring — a snapshot is only interesting when it
is the current one. `PushFrame` shrank to `EventPush | ResyncPush | NoticePush`;
`session_updated`, `session_removed` and `providers_updated` are gone and
`PROTOCOL_VERSION` is 2. `#stateFrame` is the one place a snapshot is built;
`hello` subscribes and enqueues the opening snapshot as one synchronous
operation and its result is handshake metadata only. Both ends chain socket
writes (`writeAll` can return after a partial write), and the client stamps each
socket with a generation. `TuiState` lost `sessions` / `providers` / `daemon` /
`connection` for one `fleet: ClientState`; `modeOptimistic` became `modeDraft`, a
local overlay the debounced RPC clears either way.

Validation: `test/client-state.test.ts` (opening snapshot, subscribe semantics,
two clients seeing an add and a removal, disconnect → `pending` → reconnect with
changes made while away, no post-reconnect snapshot repopulating the pre-drop
fleet, close → `idle`), plus `Connection` regressions for frame interleaving and
write-failure teardown.

Corrected since, by `state-sync-fix-plan.md` §3:

- `connect()` resolved on the hello response alone, so a caller could be handed
  a client whose fleet was still `pending` — indistinguishable from "no
  sessions". It now waits, bounded, for the first valid snapshot.
- `pushState` was exempt from the write-backlog ceiling. Snapshots supersede
  each other as values, not as encoded buffers already queued, so a wedged
  client could be outrun by snapshots alone.
- Both readers skipped a line they could not parse. They now drop the
  connection, as does a well-formed frame with no address to answer at;
  `core/src/wire-decode.ts` holds the shared boundary decoders.

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

**Done.** `mkSessionQueue` (`backend/daemon/src/daemon/session-queue.ts`)
serializes each session's commands end to end under one key. The insight the old
code missed: a mode change is validate → apply to adapter → write registry and
provider defaults → publish, and gating only the adapter call leaves the other
three interleaved. `setMode` / `setModel` / `setEffort` / `setProvider` now run
whole under `#queue.run(id, …)` with their checks moved inside, so they are
rechecked at execution time. The daemon's separate `#withLifecycleGate` folded
into the same queue — lifecycle ops are precisely the commands that can
invalidate a queued configuration change, so sharing one chain is what makes a
queued command's existence recheck conclusive. The hold extends across adapter
_construction_ (`#startSession`, `#reviveSession`), which deleted the attach-time
mode reconciliation that used to paper over that window. Approvals, questions,
plan responses and `interrupt` are deliberately not queued. Deadlock freedom is
structural: the edge to the manager's turn gate is one-way.

Validation: `test/session-queue.test.ts` (5 cases) plus overlapping-mode-changes,
mode-racing-a-revive, mode-behind-a-removal and plan-review-rejection cases in
`test/daemon.test.ts`. Each ordering test was verified to fail against a
pass-through queue, and their races are driven by `ping` round-trip barriers
rather than sleeps.

Corrected since, by `state-sync-fix-plan.md` §2: `onMode` carried the mode value
captured when the notification was raised. Serializing it made that worse, not
better — a `setMode` parked in the adapter finished after a plan decision but
published before it, and the queued notification then wrote back a mode the
adapter had already left. `onMode(sessionId)` now carries no value; the queued
handler reads the live adapter snapshot when it runs.

## 4. Separate transcript storage, live delivery, and pagination from state

Primary files: `backend/daemon/src/store/{session-events,migrations}.ts`,
`backend/daemon/src/daemon/daemon.ts`, `core/src/wire.ts`,
`client/src/client.ts`, `frontend/tui/src/{model,fleet-handle}.ts`.

- [x] Give durable transcript entries a stable identity and ordering shared by
      page results and live transcript pushes. Prefer the existing
      `session_events.id` (`INTEGER PRIMARY KEY AUTOINCREMENT`); expose a safe wire
      representation instead of introducing a second counter or rebuilding history.
- [x] Persist before broadcasting a durable entry so a pushed ID is immediately
      readable. Keep transient raw events/notices separate; do not manufacture
      durable IDs for heartbeats.
- [x] Return `HistoryPage` from `session.events`, oldest-first within each page.
      Page backwards using the durable ID and existing `(session_id, id)` index.
      Return an explicit older cursor (query one extra row if needed); `null` means
      actual exhaustion. Reject malformed/invalid cursors distinctly from exhaustion.
- [x] Keep per-session transcript caches. Model initial loading and older-page
      loading with `Loadable`; preserve loaded entries while fetching older ones.
      Deduplicate by durable ID and order by durable order, not event timestamps.
- [x] Establish live transcript listening before fetching the latest page.
      Merge overlapping page/live entries by ID so entries arriving during a fetch
      are neither lost nor duplicated. Keep local echoes identifiable separately.
- [x] On reconnect, clear transcript caches, reset scroll to the live tail, and
      fetch the selected session's newest page. Ignore pre-reset fetch responses;
      other sessions fetch lazily when selected. Preserve drafts/selection.
- [x] Remove `trackPending` and `trackCompacting` from TUI event/backfill paths,
      along with history-based pruning/recovery helpers made obsolete by snapshots.
      Raw live events may create transient notices; history pages must not.
- [x] Remove `(epoch, seq)` transcript cursor translation and the global
      timestamp-sorted log merge. A client memory cap must not mean "server history
      exhausted." Use bounded page retention that permits refetching evicted pages;
      keep viewport behavior predictable within a connection.

Acceptance: scrolling old history never changes current requests or compaction.
Paging works across daemon restarts, including equal or nonmonotonic timestamps.
Live events overlapping a page appear once. Reconnect returns to a complete latest
page with no obsolete fetch reinstalling old cache state.

**Done.** `session_events.id` is the transcript's identity everywhere: it rides
the live push as `EventPush.id` and comes back on every `TranscriptEntry`, so a
page and the live stream merge by the same key. Absent iff the daemon did not
persist the event. Migration 23 drops the vestigial `seq` / `epoch` columns;
`EventPush` keeps them for the raw `loom tail` stream. `session.events` returns
`HistoryPage { items, olderCursor }`, paging backwards on `id < ?`, reading
`limit + 1` rows so exhaustion is _observed_ rather than inferred from a short
page, and answering a malformed cursor with `bad_request` — which the old
`(epoch, seq)` lookup could not distinguish from exhaustion, so a paging loop
stalled with no way to tell why. The TUI's single global `log` became
`transcripts: Record<string, Transcript>`. The ts-sorted whole-log merge is gone:
it existed because `(epoch, seq)` could not order across a restart, and it got
the boundary wrong whenever timestamps tied. Reconnect clears the caches and
bumps `transcriptGen`, so a fetch already in flight cannot reinstate what the
reset discarded; drafts and selection survive.

Validation: rewritten transcript cases in `test/store.test.ts` (ordering under
equal timestamps, backwards paging, observed exhaustion at an exact page
boundary, per-session cursor scoping); cursor paging, malformed-cursor rejection
and cross-restart pagination in `test/daemon.test.ts`; durable order, dedupe,
page/live merge and stale-generation rejection in `test/tui-model.test.ts`.

Corrected since, by `state-sync-fix-plan.md`:

- Retention was applied on the live-append path only. `foldPage` merged pages
  with no bound at all, so three legal 5,000-entry pages retained 15,000 lines.
  There is now one `retain` every growth goes through, the window is contiguous
  at both ends, and `Transcript.following` says whether it still ends at the
  live tail (fix-plan §4).
- `pendingFor` and the `resolved` overlay are deleted. `pendingFor` was a second
  shape for the request set and `resolved` was a second request model; consumers
  now take `SessionInteraction` directly, and a one-slot submission latch
  replaces the shadow set (fix-plan §5).

## 5. Remove superseded paths and validate

- [x] Update all wire consumers together, including `cli/src/loom.ts`, harness
      code, and fixtures. Bump `PROTOCOL_VERSION` for incompatible wire changes and
      ensure mismatch fails clearly rather than reconnecting indefinitely.
- [x] Remove obsolete state version counters, state replay/resync handlers,
      pre-mount state reconstruction, duplicate connection/boot flags, and comments
      describing the old protocol once their callers are migrated.
- [x] Inspect `loom tail` before deleting event infrastructure. Its raw-event
      replay is a separate existing feature: preserve it if still consumed, keeping
      snapshots out of it. Epoch/seq can remain for that stream; they no longer
      identify transcript pages or reconcile authoritative state.
- [x] Replace tests asserting removed protocol machinery with tests of the
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

**Done.** A protocol mismatch was not terminal: `#reconnectLoop` caught
everything and retried, so two incompatible builds left the UI cycling between
"reconnecting…" and the real error forever, re-spawning a daemon it could never
talk to — and the daemon-side rejection was not recognised as a mismatch at all.
It now latches `#fatal`, which stops the loop and keeps a later socket close from
falling back to `pending`; the daemon reports its own version in the error's
`data`. The pre-mount state reconstruction (`replayHistory`,
`LoomClient.bufferedEvents` and its 5,000-frame ring, and the TUI's replay at
mount) is gone: it was a second, worse path to the transcript — it could not
page and was bounded by a ring shared across every session. `loom tail` was
inspected and preserved. Comments describing the v1 push types were swept, and
`loom run` / `loom stub` stopped printing `status=[object Object]`.

Validation: the reconnect test fails against a pass-through of the old loop. A
scenario-to-test table and a manual run against a live daemon in a scratch repo
covered two clients changing mode, a client attaching mid-request, one of several
permissions resolving elsewhere, old history during a request or compaction,
sessions added/removed while disconnected, late socket callbacks, live/page
overlap, pagination across a daemon restart, a connection dropped mid-create, and
partial writes / malformed frames / protocol mismatch in both directions.

**Not run, then or since: the two _interactive_ TUI windows.** No session in this
line of work has had an attachable terminal, so the Ink app has never been driven
by hand. What stands in for it: `test/tui-render.test.ts` mounts the real app
against a real daemon over a fake stdout/stdin, and drives `mkFleetHandle`
directly for the cases a real daemon cannot stage; the CLI, `loom tail` and the
raw wire have been exercised against a live daemon. That is not the same check
and is not reported as one.

Corrected since, by `state-sync-fix-plan.md` §1: the TUI's own effects were
wrong in ways no test here caught. `fleetSessions` answers a fresh `[]` for both
"no sessions" and "no connection", so comparing it fired the queue drain on every
dispatch and, while disconnected, read the fallback as proof that every queued
session was gone — the stranded-queue notice then re-entered the drain and
overflowed the stack. See that document for the full list; the summary is that a
dropped connection must not be mistaken for an empty fleet.
