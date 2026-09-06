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

- [ ] Replace the session manager's reason-only pending-request values with
      complete typed interactions. Derive the existing await reason from them rather
      than maintain another parallel map of payloads.
- [ ] Expose those interactions in session snapshots, including the data needed
      to render permission prompts, questions, and plan review without any history.
- [ ] Make creation, resolution, cancellation, interruption, and stream end
      update the authoritative request set and notify snapshot publication. Publish
      when the set changes even if the session remains `awaiting_input` (for example,
      one of several parallel permissions was answered).
- [ ] Include the compaction progress the UI currently derives from events in
      snapshots. Reuse existing runtime state; do not add persistence for transient
      operations solely for this refactor.
- [ ] Use closed unions with exhaustive folds/switches and `absurd` for new
      domain shapes. Keep request IDs and their payloads together. Avoid duplicating
      domain state just to retain the old TUI shape.

Acceptance: a second client with no downloaded transcript can display and answer
the exact outstanding request. Resolving one permission updates both clients
while any other permissions remain available.

## 2. Add one snapshot subscription and migrate state consumers

Primary files: `core/src/wire.ts`, `core/deno.json`,
`frontend/tui/src/loadable.ts`, `client/src/client.ts`,
`backend/daemon/src/daemon/{daemon,server,connection,registry,event-log}.ts`,
`frontend/tui/src/{model,fleet-handle}.ts`,
`frontend/tui/src/{components,app,run}.tsx`.

- [ ] Move `Loadable` and its existing helpers to `core`, export it, and update
      imports. The client must not depend on the TUI package.
- [ ] Add a complete snapshot push. After protocol validation, subscribe and
      enqueue the initial snapshot as one synchronous operation. Handshake RPC
      results carry handshake metadata, not a second installable state baseline.
- [ ] Route authoritative session additions, changes, removals, provider/default
      changes, and relevant runtime changes through one snapshot publisher. Read
      current authoritative values at publication; do not reuse an old mutation
      result. Build without asynchronous gaps and avoid new git subprocess calls
      across the fleet on every usage/progress update; use maintained facts.
- [ ] Deliver snapshots directly to current subscribers. Do not retain complete
      fleet snapshots in the reconnect replay ring. Straight publication is the
      starting point; add no batching/delta protocol without measured need.
- [ ] Guarantee serialized frame writes on each socket in both directions,
      including partial writes. Preserve frame/backlog limits; a malformed frame or
      write failure must terminate that connection rather than silently lose state.
- [ ] Expose a stable client `getState`/`subscribe` API. Use `idle` before start,
      `pending` while connecting/reconnecting, `data` on snapshot, and `error` for a
      terminal connection/protocol failure. Existing connect callers that require
      initial state must wait for the first snapshot.
- [ ] Guard socket callbacks with a local connection generation or identity.
      Close, read, and response callbacks from a superseded socket cannot change
      current state or install an obsolete snapshot. This is lifecycle bookkeeping,
      not a wire revision system.
- [ ] Have the TUI consume this one client snapshot. Remove its boot-time and
      reconnect `session.list`/`providers.list` reconciliation, timestamp merging,
      and independent authoritative session/provider caches. Read-only RPCs can
      remain for CLI callers; their results must not feed this subscription.
- [ ] Render connection/loading states with `foldLoadable`. Preserve drafts and
      selection intent while pending; disable commands that require current daemon
      state. Reconcile selected IDs and open request overlays against new snapshots,
      including closing an overlay whose exact request ID disappeared.
- [ ] Keep ordinary command responses for acknowledgment, local feedback, and
      returned IDs (create/fork selection). Never install returned session values
      into the authoritative client snapshot.

Acceptance: updates and removals reach two TUIs through snapshots alone. A
disconnect produces `pending`; reconnect supplies the complete current fleet,
including changes made while disconnected. Delayed old callbacks cannot regress
it. No polling or state replay is needed.

## 3. Serialize conflicting configuration commands

Primary files: `backend/daemon/src/daemon/{daemon,session-manager}.ts`,
`frontend/tui/src/fleet-handle.ts`.

- [ ] Establish per-session serialization for mode/model/effort changes,
      covering validation, adapter application, registry/default updates, and
      snapshot publication. Serializing only the adapter call is insufficient.
      Handle inactive sessions too.
- [ ] Recheck session existence and command validity when executing a queued
      change. Failed commands must not publish the requested value as applied.
- [ ] Coordinate with existing provider-swap/restructuring behavior. Reuse gates
      where appropriate, but do not hold up interrupt or approval behind an entire
      turn waiting for user input, and do not introduce nested-gate deadlocks.
- [ ] Preserve current mode semantics, including `plan_pending`: changing mode
      must not implicitly answer an outstanding plan review. Account for mode changes
      caused by plan decisions and adapter events as well as explicit `setMode`.
- [ ] Preserve exact-request-ID, resolve-once behavior for approvals/questions.
      No new conflict tokens or operation-tracking subsystem.
- [ ] Keep explicit target values in mode commands. A client computes the target
      it displays; the server does not reinterpret it as "cycle from current mode."

Acceptance: deliberately overlapping calls with a delayed adapter execute in
the daemon's chosen order, finish with matching adapter/registry state, and leave
both clients showing the final successful value. Rejection preserves existing
values and existing plan-review safeguards.

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
