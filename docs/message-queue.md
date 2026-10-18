# Message queue

Every user or agent message enters a persisted, daemon-owned queue. It enters
the transcript only after consumption evidence; handing it to a provider is
not sufficient. Loom's automated hook feedback, nudges and auto-resume bypass
this queue; discarded automated messages are not retried.

## Dispatch

- `next_boundary` entries go together at the next root tool boundary, or
  start a fresh turn once the root turn ends. Text generation alone is not a
  boundary.
- `end_of_turn` entries go one per idle turn, after background work finishes.
  Boundary entries take precedence.
- Messages can be queued during startup, before the adapter attaches. Dispatch
  pauses during startup, restructuring, pending user input, cancellation,
  clone Git operations, a hold, or an outstanding handover.
- Persist `delivering` before provider I/O. Explicit rejection returns an
  entry to `queued`; an ambiguous outcome marks it uncertain and holds the
  queue. Never automatically retry a message that may have run tools.

Queued entries are editable and reorderable within their delivery group.
Changing delivery appends to the other group. Delivering entries are read-only.
Mutations use revisions; destructive actions name the observed IDs so they
cannot remove messages that arrived after confirmation opened.

## Consumption evidence

- Claude: `command_lifecycle.started`, backed by `user_message_uuids`.
  The lifecycle frames are not in the SDK typings; older CLIs may acknowledge
  folded input only at turn end.
- Codex: a successful `turn/start`; for steering, the `userMessage` item
  with matching `clientId`, falling back to `turn/completed`.
- AISDK: turn start or draining the injection in `prepareStep`.
- Providers without receipts: consume at handover.

Consumption emits `user_message` with the queue entry ID and author.
A missing root tool event can delay delivery until turn end. Codex can discard
steered input on interrupt without a receipt; such entries remain uncertain.

## Interrupt

Set the hold before awaiting cancellation. Return entries the adapter confirms
discarded to their original queue positions; mark unacknowledged deliveries
uncertain. A failed interrupt retains the hold and entries.

Release resumes ordinary queued entries, reviving a cold session first; failed
revival leaves the hold. Uncertain entries require an explicit send-now or
delete decision. Send-now delivers one entry without releasing the rest.
A new user message lifts the hold and goes first, alone; held entries then follow
the ordinary delivery rules.

Restart preserves queued work and marks in-flight deliveries uncertain.
Crashes hold pending work. Resume alone does not release a hold. Archive holds
before closing; delete cascades; forks start with an empty queue.

## Holds

`QueueMachine` in `backend/daemon/src/daemon/queue-machine.ts` owns queue,
handover, hold and supervision decisions. Its pure `step(machine, event, world)`
returns effects; SessionManager persists and executes them. Keep policy there,
rather than adding independent decisions to callers.

| Hold                                               | User message | Supervisor message | Sub-agent report |
| -------------------------------------------------- | ------------ | ------------------ | ---------------- |
| User                                               | lifts        | waits              | waits            |
| Supervisor                                         | lifts        | lifts              | waits            |
| Loom (crash, restart, rejected or discarded input) | lifts        | lifts              | waits            |

A user's stop holds even an empty queue, preventing a later report from waking
the session. A supervisor's stop holds only when entries wait. Stopping only a
compaction also holds only when entries wait.

Race-sensitive rules:

- An existing hold retains its reason. A user's stop takes ownership; other
  stops, crashes and discards cannot downgrade or overwrite it.
- A message that lifts a hold goes first. A new stop before handover cancels
  that priority. A late discard from an already released stop does not re-hold.
- Failed revival withdraws a still-queued message and restores the hold only
  if no later write superseded it. Reports stay queued because no sender remains
  to retry them.
- A failed archive/close restores its hold on the same terms. Reasserting a
  user's stop counts as a write; an unchanged hold from a discard does not.
- Clone Git operations block all dispatch paths. User send/release return
  `busy`; supervisor messages and reports queue until Git finishes.

`test/queue-machine.test.ts` covers transitions and races;
`test/message-queue-daemon.test.ts` covers integration.

## Persistence and limits

Each session allows 100 live entries, 1 MiB per entry and 8 MiB total.
Keep the 200 most recently settled rows, then tombstones for the newest 10,000
IDs. Reusing a known ID with identical text is idempotent; different text
conflicts. These bounds mean idempotency is not permanent.

Undo is allowed with queued/held entries but refused during delivery.
Provider changes preserve the queue and use the new adapter's receipt support.
Queue activity does not promote fleet recency; completed root turns do.

See [keybindings](keybindings.md) for queue controls and
[agents](loom-agents.md#communication) for supervision.
