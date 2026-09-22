# FLEET ordering and creation focus

## Findings

The daemon's Registry.listSorted sorted snapshots by status and updatedAt.
STARTING shared RUNNING's rank; AWAITING INPUT used oldest activity first,
whereas the other groups used newest activity first.

The client passes the authoritative snapshot through. The TUI's
applyClientState sorted it again, using a different policy: STARTING had its
own rank below RUNNING, and every group used newest activity first. The
renderer grouped those rows without another within-group sort. The UI's
updatedAt comparison was the direct cause of activity reshuffling peers.

Selection tracks a session ID, not a row index. Reordering therefore usually
moves the highlighted row rather than selecting another session. Removing or
archiving the selected session intentionally selects a nearby surviving row.
Fleet scrolling follows selection, so section/child growth can also move the
visible viewport. Search uses a flat relevance-ranked list.

New-session submission closes the composer immediately. The daemon publishes
the STARTING row before creating its workspace and provider session, but the
create RPC completes after startup. The TUI unconditionally selected the
returned ID on completion. The accepted-failure handler also selected the
failed session. Either completion could arrive while the user was replying
elsewhere.

## Policy

Daemon ordering, TUI ordering and rendered section order now use
core/src/session-order.ts. Status ranks are exhaustive over SessionStateKind.
Within every group, creation time descending and ID ascending define a total
order. Activity and input snapshot order cannot affect it. The daemon and UI
still each sort at their own boundary, but invoke the same function.

Existing peers keep their relative order. Rows can still shift vertically
when other rows enter or leave, groups change, children expand, or the
viewport scrolls. A session returning to a group returns to its creation-order
position. Reconnecting reproduces the same order without a position cache.
Search intentionally retains relevance ordering.

Creating a session keeps the current selection. Completion, cancellation and
accepted startup failure report a notice and never select the session later.
A user can select the STARTING row explicitly. An empty fleet still selects
its first arriving row through normal selection reconciliation.

This requires no new pending-focus state or delayed selection intent. The
existing pendingSelectId hold remains for explicit selections whose snapshot
has not arrived yet (for example, a fork or find result).
