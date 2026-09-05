The biggest improvement would be to make the ownership and synchronization
contracts explicit; richer types can then enforce those contracts. More `Loadable` would help, but it won’t by
itself resolve ambiguity about which data is authoritative.

There’s already a good foundation: SessionState, authoritative snapshots, a sequenced push stream, reconnect
replay, and durable history. I’d keep those pieces and tighten their boundaries.

1. Current state should be complete without reading history.

This is the most consequential issue I found. The TUI reconstructs outstanding permissions, questions, and plans
from events, then uses snapshots to prune requests it thinks have settled. Pending and focusedPending (frontend/
tui/src/model.ts:341) document the resulting reconciliation.

Worse, applyBackfill (frontend/tui/src/model.ts:1176) feeds older pages through trackPending and
trackCompacting. Loading yesterday’s history can therefore change the TUI’s understanding of what is happening
now. A resolution in an already-loaded newer page doesn’t necessarily get reapplied after the older request
arrives.

I’d establish this invariant:

> Fetching transcript history cannot change current session state or available actions.

The daemon should expose outstanding requests, including their IDs and display payloads, in its authoritative
session view. The client should never need to find the original request event to render an approval.

For example:

type Interaction =
  | { tag: "permission"; id: RequestId; tool: string; input: unknown }
  | { tag: "question"; id: RequestId; text: string; context?: string }
  | { tag: "plan"; id: RequestId; text: string };

Where the domain guarantees that awaiting input means outstanding requests exist, carry a nonempty collection in
that state. Preserve support for simultaneous permissions; a single optional “current permission” would discard
a real possibility.

Historical request and resolution events remain useful transcript entries. Their presence in a downloaded page
should have no operational effect.

2. Give synchronization one owner and one ordering contract.

Currently, synchronization is spread across LoomClient, fleet-handle, and the TUI reducer:

- The wire promises that clients ignore older session versions, but session_updated (frontend/tui/src/
  model.ts:1039) replaces the session without checking version.

- session.list reconciliation (frontend/tui/src/model.ts:668) compares updatedAt, a different ordering
  mechanism. It also iterates only the returned list: a stale response can drop a newly pushed session or
  resurrect a removed one.

- LoomClient.sessions (client/src/client.ts:78) is populated by handshake/resync rather than maintained as the
  live session cache.

- #resync (client/src/client.ts:448) fetches another baseline while push processing remains active.

The usual pattern here is snapshot plus watch: obtain a snapshot at a known stream position, then apply
subsequent changes. Kubernetes provides a useful concrete precedent, including fetching a fresh baseline when
retained watch history is insufficient. Kubernetes API concepts.

I’d put this in a reusable client state layer, with an explicit handshake result:

type SyncResult =
  | { tag: "resume"; through: StreamPosition; changes: readonly Change[] }
  | { tag: "replace"; at: StreamPosition; snapshot: FleetSnapshot };

The contract would be:

- Resume applies the missing ordered changes to the existing baseline.
- Replace installs a complete baseline at position H, then applies buffered changes after H.
- A daemon epoch change requires replacement.
- Only one synchronization attempt owns the baseline at a time; obsolete responses are ignored.

The existing synchronous subscribe/hello implementation is a useful starting point.

Use revisions consistently on snapshots, pushes, and mutation results. Runtime fields such as outstanding
requests and compaction must participate too. Timestamps should describe time, rather than decide which state
wins.

The TUI then subscribes to one immutable client view and owns selection, drafts, overlays, and scroll position.

3. Treat concurrent commands as an explicit daemon policy.

For your mode example, there are two separate questions:

1. In what order does the daemon execute changes?
2. Should it accept a command based on stale client state?

session.setMode (backend/daemon/src/daemon/daemon.ts:2413) awaits the adapter and then updates the registry.
SessionManager.setMode (backend/daemon/src/daemon/session-manager.ts:614) bypasses the gate used for send/
compact/rewind. Concurrent calls can overlap; the daemon currently lacks an explicit serialization contract for
these changes.

I’d serialize conflicting configuration changes per session, covering validation, adapter application, and
authoritative publication. Long-running operations need explicit busy/in-progress states so control commands
such as interrupt remain usable.

Then choose conflict semantics deliberately:

 Command                                 Suggested policy
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Set title                               Last accepted write wins is reasonable
──────────────────────────────────────  ──────────────────────────────────────────
 Set permission mode                     Reject a stale configuration revision
──────────────────────────────────────  ──────────────────────────────────────────
 Approve permission / answer question    Resolve that exact request ID once
──────────────────────────────────────  ──────────────────────────────────────────
 Send / create / fork                    Use an operation ID to reconcile retries

For mode changes:

type SetModeResult =
  | { tag: "applied"; session: VersionedSession }
  | { tag: "conflict"; current: VersionedSession }
  | { tag: "rejected"; reason: ModeChangeError };

Both TUIs read configuration revision 12. A changes the mode and produces revision 13. B’s command expecting 12
receives conflict with the current state. Both clients receive the authoritative update.

Use a configuration revision, rather than the revision bumped by every usage or status update, to avoid
irrelevant conflicts. Check the precondition inside the serialized operation.

Your current “cycle mode” UI computes the target locally. I’d preserve that visible intent with a precondition:
silently recomputing against a newly changed mode could select something the user never saw.

4. Separate durable transcript identity from transport identity.

The current (epoch, seq) identity is useful for the reconnect stream. But durable pagination translates it back
into a database insertion ID, while the TUI merges pages using timestamps and sequence numbers. See
SessionEventStore.list (backend/daemon/src/store/session-events.ts:44).

I’d give each durable event a stable ID and authoritative order that survives daemon restarts. Include that same
identity in live transcript pushes. Return pages with an explicit continuation:

type HistoryPage = {
  items: readonly TranscriptEvent[];
  older:
    | { tag: "end" }
    | { tag: "more"; cursor: HistoryCursor };
};

Then:

- Deduplicate live events and pages by durable event ID.
- Order them by durable order, using timestamps for display.
- Let the server supply the next cursor.
- Distinguish an invalid cursor from the end of history.
- Keep history caches per session.

HistoryCursor.done (frontend/tui/src/fleet-handle.ts:548) currently combines exhaustion, cursor failure, and
hitting the client’s memory cap. Those deserve different states: exhausting a cache budget doesn’t mean the
daemon has no older history.

Reconnect also needs to repair any missing transcript interval. Fetching only the newest page can leave a hole
between an old cached tail and the new page. Either fill that interval or represent it as an explicit gap.

5. Use Loadable for fetching, and domain unions for synchronization and commands.

Your existing Loadable is a good fit for initial history loads, doctor reports, and other independently fetched
resources.

A synchronized resource has another meaningful state: “I have useful data, but it may be stale.” A mutation has
another: “the connection disappeared and I don’t know whether it completed.”

Those deserve their own types:

type Replica<A> =
  | { tag: "initial"; load: Loadable<SyncError, A> }
  | { tag: "live"; value: A; at: StreamPosition }
  | { tag: "stale"; value: A; recovery: Loadable<SyncError, void> };

type Mutation<E, A> =
  | { tag: "idle" }
  | { tag: "pending"; operationId: OperationId }
  | { tag: "uncertain"; operationId: OperationId }
  | { tag: "rejected"; error: E }
  | { tag: "applied"; value: A };

The client already recognizes uncertain completion on disconnect, but request timeouts have the same ambiguity.
Operation IDs allow the daemon to identify retries and return the original result; Stripe’s idempotency API is a
useful reference for that contract. Idempotent requests.

I’d keep confirmed session values visible while showing the local mutation as pending. One client’s pending
intent is separate from the daemon’s current mode.

Use exhaustive folds for rendering these states and pure reducers for their transitions. Runtime decoding of
wire messages matters too: JSON.parse(...) as Frame doesn’t establish the invariants the union claims.

I’d start with complete outstanding-request snapshots and history-only backfill, then centralize
synchronization, then formalize command conflicts and pagination. Those changes should remove substantial
reconciliation code. The key properties to test are that backfill cannot affect current actions, older responses
cannot regress state or resurrect deletions, and two clients converge after concurrent commands and reconnects.

