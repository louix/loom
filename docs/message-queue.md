# A9: message queue

Status: implementation spec for Track A stage A9, against `ba2887e5`. Port the
queue review UX of main-new (`frontend/tui/src/conversation-queue.tsx`,
submissions in `client/src/conversation-journal.ts`) into the old owners:
SessionManager, the session DB and A2's command model. Do not import main-new's
journal, owner or conversation service.

## Goal

Every message to a busy session enters a daemon-owned, persisted per-session
queue. It reaches the chat log only when the agent has taken it, every client
shows when it will be taken, and an interrupt stops the turn while keeping what
never reached the agent.

## Today

- Enter on a busy session calls `session.send`; `SessionManager.send`
  (`backend/daemon/src/daemon/session-manager.ts:724`) hands it to the adapter
  and `daemon.ts:3459` emits `user_message {injected: true}` immediately. The
  TUI notes "lands after the current tool call" (`fleet-handle.ts:1899`).
- ⌥q (`fleet-handle.ts:2428`) and sends typed during compaction (`code:"busy"`)
  use a TUI-local, in-memory outbox (`frontend/tui/src/composer.ts`), visible to
  one client, drained one message per `idle`; ⌥x clears it; `views.ts:163` draws
  it as queued lines.
- Claude pushes onto the adapter `#inbox` (`connectors/claude/src/adapter.ts`
  :899) with a UUID per message (:332); the CLI folds queued commands into the
  turn at the next tool boundary or runs them as the next turn. Since
  `0c83cb8a`, interrupt drains `#inbox` and sends `cancel_queued`, whose receipt
  lists `cancelled` UUIDs. Codex uses `turn/steer` mid-turn and `turn/start`
  otherwise (`connectors/chatgpt/src/app-server.ts:567`). AISDK pushes onto
  `#injections`, drained by `prepareStep` (`aisdk/src/session.ts:289`, :1041).
- Loom's own messages use `automated: true` and are echoed at once: hook
  feedback (`daemon.ts:456`), auto-resume (:2214), rebase nudge (:2403), commit
  reminder (:2444).
- `backend/daemon/src/daemon/session-queue.ts` serializes whole commands; it is
  not a message queue and is unchanged. New code is named `message-queue`.

## main-new reference

Durable submission IDs with states queued, dispatching, delivered, settled, held
and cancelled; one prompt in flight, the rest wait for the native outcome. Codex
steering promotes only the first queued prompt (`s`); Claude has none. Owner
loss or a rejected settings change/compaction holds in-flight work, never
replayed. The ⌥q view lists `state · text` with the receipt; `x` discards, `c`
clears queued+held after a confirm, `e` copies to the draft; it warns "Held work
may have reached the agent". Actions carry observed IDs, so a late arrival is
never swept by an open confirm. The status line shows `N queued/active · ⌥q` and
`N interrupted (not queued) · ⌥q review`. Limits: 100 entries, 8 MiB.

A9 differs: entries reach the agent mid-turn by default; entries are editable,
reorderable and switchable between delivery modes; interrupt holds the queue
(main-new lets it continue), and a user's interrupt holds it even when empty.

## Model

One queue per root session; child rows (sub-agents, background tasks) have none.

```ts
// core/src/message-queue.ts (new; schemas re-exported from wire.ts)
type Delivery = "next_boundary" | "end_of_turn";
type EntryState = "queued" | "delivering" | "consumed" | "cancelled";
interface QueueEntry {
  id: string; // client UUID: idempotency key, also the Claude message uuid
  text: string;
  author: string; // the submitting client's id; Loom's own messages never queue
  delivery: Delivery;
  state: EntryState;
  uncertain: boolean; // handed over; whether the provider took it is unknown
  revision: number; // bumped by every edit, move and state change
  createdAt: number;
  deliveredAt?: number;
  consumedAt?: number;
}
type QueueHold = "interrupt" | "restart" | "crash" | "rejected" | null;
type QueueHoldBy = "user" | "supervisor"; // whose stop; absent for Loom's own
```

- `queued`: in Loom; editable, deletable, movable, switchable, sendable now.
- `delivering`: handed to the provider, not yet consumed; read-only. With
  `uncertain` it is shown as "may have reached the agent" (main-new's warning).
- `consumed`: evidence the agent took it ([below](#consumption-evidence)); the
  only point where `user_message` is emitted.
- `cancelled`: deleted or cleared.
- Order: all `next_boundary` by `seq`, then all `end_of_turn` by `seq`; views
  show the same two groups. Moves reorder within a group; switching delivery
  appends to the other group. A mid-turn message is never delayed by an earlier
  end-of-turn one.
- Hold: a session-level flag; while set nothing is dispatched automatically.
  It records its cause: the reason (`interrupt`, `restart`, `crash`,
  `rejected`) and, for a stop, whose it is (`by`: the user's, or a Loom
  supervisor's on its child). Loom's own holds (a crash, a restart, a doubtful
  hand-over) are no one's. Who sets, lifts and combines holds is defined in
  one place, [Holds](#holds).
- Any client may act on any entry (single user). Authors render as you or
  another client. Loom's own messages (hook feedback, nudges) bypass the queue
  ([decision 3](#decisions)).
- Limits (main-new's): 100 live entries, 1 MiB per entry, 8 MiB per session;
  past them enqueue fails with `queue_full`. Consumed/cancelled rows are kept,
  pruned to the 200 most recently settled (by settlement order, not `seq`); a
  pruned row leaves its id, a hash of its text and its final state behind
  (the newest 10,000 per session). Re-enqueueing a known `id` with the same
  text returns it (or, pruned, just its state) and different text is a
  `conflict`.

## Dispatch

`backend/daemon/src/daemon/message-queue.ts` (new) is a pure policy,
`nextAction(queue, hold, run) → none | handover(ids, freshTurn)`, re-evaluated
after every state transition, queue mutation and RPC, and after every event
that moved what it reads off the run (state, root tool in flight,
restructuring, stopping, backoff) — a text delta does not, and costs no query.
It reads entries without their text. SessionManager executes it under its op
gate (`#enqueue`).

1. Nothing is dispatched while held; while `starting`, restructuring (compact,
   rewind, provider switch), stopping or cancellation `failed`; while
   `awaiting_input` (permission, question, plan review); while a clone's
   guest Git runs ([busy](#holds), H7); or while a handover is outstanding.
2. **Boundary window.** While a live root turn has a root tool call in flight (a
   `tool_call` without `agentId` and without its `tool_result`, not blocked on a
   permission), every queued `next_boundary` entry is handed over in order. All
   providers fold input in at that tool's boundary: the Claude CLI attaches
   queued commands with the tool results, Codex reads steered input before its
   next sampling, AISDK drains in `prepareStep`. Entries stay editable until a
   tool is actually running.
3. While the model only generates text, `next_boundary` entries wait in Loom.
4. **Turn ended** (`idle`, unheld `interrupted`, or `working_background`): all
   queued `next_boundary` entries go over as one fresh turn — the first starts
   it; Claude coalesces the rest, Codex steers them in, AISDK injects them.
5. **Idle** with no `next_boundary` left: the head `end_of_turn` entry starts a
   turn; one per turn, the next waits for the following `idle`. This keeps
   today's ⌥q meaning, "when the agent has finished", background work included.
   A stopped or failed turn has finished too, so a released queue goes on
   from `interrupted`.
6. `session.send` to an idle, unheld session still creates an entry; rule 4
   dispatches it at once, so idle sends behave as today.

Handover is `AgentSession.send(text, { inputId, midTurn })`: Claude `#inbox`,
Codex `turn/steer` with `expectedTurnId` (or `turn/start`), AISDK `#injections`.
`delivering` is committed before the call (main-new: record dispatch before
native I/O). An explicit rejection (Codex `expectedTurnId` mismatch because the
turn just ended) returns the entry to `queued` for rule 4. An uncertain
transport outcome (worker frame timeout, disconnect) marks it `uncertain` and
sets hold `rejected`; handovers are never retried automatically.

A3: `run.userTurn` is armed when a user entry is handed over, fresh or folded,
as `send` does today; Loom's direct sends stay `automated`. `#lastSend` (checkpoint and
auto-title seed) is set only when a user entry starts a fresh turn.

A7: on a resumed Claude query `afterReady` gates `#inbox` until the cost
baseline is seeded (`adapter.ts:647`). An entry handed over then is still inside
the adapter: not consumed, and if an interrupt drains it the adapter must report
it as cancelled.

## Consumption evidence

Adapters emit a new `HarnessEvent`, `input_consumed { inputId, midTurn }`.
SessionManager marks the entry consumed, then emits
`user_message { text, injected: midTurn, queueEntryId, author }` with the
consumption time, so the log shows the message where the agent saw it. A new
`providerCapabilitiesSchema` flag, `inputReceipts`, says whether an adapter
emits it.

- **Claude.** The adapter stamps each input with the entry id as its uuid. A
  live probe (CLI 2.1.280, no extra flags) shows the CLI emitting
  `command_lifecycle {command_uuid, state}` frames: `queued` on receipt,
  `started` when it takes the command up — at turn start, or right after the
  tool result it folds into — and `completed` / `cancelled`. `started` is the
  receipt. `user_message_uuids` on assistant and `result` frames (which do list
  folds into typed-prompt turns on the `result`) back it up.
  `--replay-user-messages` is not needed.
- **Codex.** `turn/start` and `turn/steer` take `clientUserMessageId`, and the
  `userMessage` thread item echoes it as `clientId` (protocol schema of codex
  0.156.1). A started turn consumed its input at the `turn/start` reply; a
  steer is consumed when its `userMessage` item arrives, and, as a fallback
  for servers that do not echo it, at that turn's `turn/completed`.
- **AISDK.** Exact, in-process: at turn start, and when `prepareStep` /
  `#flushInjections` drains an injection. The worker forwards it as an event.
- **No receipts.** The entry is consumed at handover and `user_message` is
  emitted then — today's behaviour. On interrupt, receipt-less delivering
  entries not listed as cancelled become `uncertain`.

## Interrupt

The keys (`i`, ⌥i) and `session.interrupt` are unchanged. In
`SessionManager.interrupt` (:798):

1. Before calling the adapter, set hold `interrupt` — always for the user's
   stop, even with nothing queued; for a Loom agent supervisor's
   (`agent_interrupt`) only if any entry is queued or delivering — so dispatch
   cannot race the stop. A user's stop is a hold, so what is queued after it
   (a Loom agent's notification, [loom-agents.md](loom-agents.md#communication))
   waits behind it instead of starting a turn. The same holds for a user
   interrupting a session still starting, and for stopping its VM. A user's
   interrupt joining one already under way sets the hold too. An interrupt
   that only cancels a compaction on a settled session stops no turn: it
   holds only if entries wait, like a supervisor's, and the hold is the
   stopper's ([Holds](#holds), H1).
2. The adapter reports what the stop discarded as an `input_discarded` event
   (`2930534f`), which may land just before or after `interrupt()` settles:
   Claude reports drained `#inbox` IDs plus the receipt's `cancelled`; AISDK
   the injections it dropped; Codex nothing.
3. Cancelled delivering entries return to `queued` with their `seq`, so order
   survives, whichever way round the event and the settled interrupt arrive.
   Delivering entries neither cancelled nor consumed when the interrupt settles
   become `uncertain`; a later discard of one still returns it to `queued`. A
   discarded item that is no queue entry — a Loom message sent directly — is
   dropped ([decision 3](#decisions)).
4. A notice says "Interrupted · 3 messages held · q to review". Nothing is
   removed from the log, because unconsumed entries never entered it.

A failed interrupt leaves entries and the hold in place; a retry repeats 2–3.

`session.queueRelease` clears the hold and rules 4–5 resume; uncertain entries
are not released with it and each needs send now or delete. A cold session
(stopped, crashed, restarted) with entries to release is revived first, as a
send would revive it, and released once it is back, so a failed revival leaves
the hold in place; released with nothing queued, the hold is simply gone. A
clone whose guest Git is under way refuses the release as `busy`, as it
refuses a send ([Holds](#holds), H7). Send now on one entry delivers it and
leaves the rest held. A new message typed while held is sent first and alone
— a new turn, or a hand-over to a live one — not queued behind the held
entries, and sending it releases the hold as `r` would: the held entries then
follow the ordinary rules relative to the turn it started, so a held
`end_of_turn` entry goes at that turn's end ([decision 2](#decisions)).

- **Daemon restart:** queued entries persist; delivering ones become `uncertain`
  with hold `restart`. Auto-resume (`#autoResumeInterrupted`) bypasses the queue
  — it continues a cut-off turn. With nothing in flight, queued entries keep
  their rules relative to the resumed turn.
- **Worker crash / session error:** hold `crash`; delivering entries become
  uncertain.
- **Cold resume** (by send or `session.resume`) leaves the queue and its hold
  alone. **Archive** is a stop like an interrupt, by whoever archives: the
  hold is set in `SessionManager.close(by)` before the close awaits anything,
  as for a VM stop, so nothing queued during the close (a child's report)
  reaches the closing adapter or revives it (H6). **Delete** cascades.
  **Forks** start with an empty queue.

## Holds

A hold is a cause: a reason and whose it is (`by`: `user`, `supervisor`, or
none for Loom's own). Every write of it goes through one function,
`MessageQueueStore.applyHold`, which applies the combine rule (H1) to the hold
as it is, in one step. `SessionManager` reaches it through `#applyHold`, which
also drops a pending forced entry (H3); the restart recovery calls it inside
the store. Nothing else writes the hold, and `hold()` is read off
`holdCause()`.

| Cause                    | Set by                                                                                                                                                                                                   | Lifted by                                            | A child's notification behind it | A supervisor's `agent_message` behind it | Arriving on an existing hold (H1)                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `interrupt` · user       | The user's stop — `session.interrupt` (joining one under way, or of a session still starting), a VM stop, an archive — even with nothing queued; the user stopping a compaction, only while entries wait | The user's send or release (`r`)                     | waits                            | waits                                    | Keeps the existing reason; makes the hold the user's |
| `interrupt` · supervisor | `agent_interrupt`, `agent_stop`, the supervisor stopping a compaction — only while entries wait                                                                                                          | The user's send or release; the supervisor's message | waits                            | lifts it and goes first                  | Changes nothing                                      |
| `interrupt` · Loom's own | Input the adapter discarded with no one's stop under way, put back in the queue                                                                                                                          | The user's send or release; the supervisor's message | waits                            | lifts it and goes first                  | Changes nothing                                      |
| `crash`                  | A fatal root error, or the stream ending unexpectedly, while entries wait                                                                                                                                | The user's send or release; the supervisor's message | waits                            | lifts it and goes first, reviving        | Changes nothing                                      |
| `restart`                | The daemon starting with entries left `delivering` (`recoverAfterRestart`)                                                                                                                               | The user's send or release; the supervisor's message | waits                            | lifts it and goes first, reviving        | Changes nothing                                      |
| `rejected`               | A hand-over whose outcome is unknown (`DeliveryUncertainError`): the entry turns `uncertain`                                                                                                             | The user's send or release; the supervisor's message | waits                            | lifts it and goes first, reviving        | Changes nothing                                      |

- **H1 Combine.** A hold already set keeps its reason. Only a user's stop
  changes anything about it: it becomes the user's. Everything else that
  would set a hold — a supervisor's stop, a crash, a restart, a doubtful
  hand-over, a requeued discard, a close not the user's — leaves an existing
  hold exactly as it is. So a user's hold is never downgraded, overwritten or
  re-attributed by any path but the user lifting it (or H5 and H6 undoing a
  hold that never took effect). A requeued discard is no stop of its own: it
  belongs to the stop that discarded it (the latest one asked of the run),
  and reported after that stop's hold was lifted — the user's send or
  release, a supervisor's message — it holds nothing: the lift stands, and
  its entries go back behind what lifted it.
- **H2 Wait or lift** is decided once, by `SessionManager.enqueue`, as the
  message is queued: the user's send lifts any hold; a supervisor's message
  any but the user's; a child's notification none. `applyHold`'s lift then
  clears the hold unconditionally. A message that lifts goes first and alone
  (at the head, forced); one that waits joins the held entries at the back
  and wakes nothing, a cold session included. The enqueue answers whether
  the session must be revived for the message (it is cold — no adapter, one
  whose stream ended, or one a start, an idle shutdown or an environment
  refresh under way may stop or replace, which the revival waits out — and
  the message does not wait); the daemon revives only then and decides
  nothing itself. A message that does not wait on a live session is
  dispatched, never revived for.
- **H3 A hold beats a forced entry not yet handed over.** A message that
  lifted a hold, or one sent now, goes alone whatever the hold; but a hold
  applied before it is handed over (a stop while a cold session comes back
  for it) drops that, and the entry waits at the head, held. A requeued
  discard never drops it (H1): it is no one's new stop.
- **H4 Send now** delivers one entry through any hold and leaves the hold.
- **H5 A revival that fails** for a message withdraws the message and puts
  back the hold it lifted, unless the hold was written since: as if it was
  never sent, and the sender is told. A message no longer queued — handed
  over meanwhile — is not taken back, the hold stays lifted, and the send
  succeeds. A revival that outlasts the send (a VM runtime build) answers
  at once with the message queued; if it fails later, or the environment
  refresh it waited out does, the message is withdrawn and the hold put
  back then, on the same terms, and the failure is reported on the session.
- **H6 A stop that does not complete.** A close by someone
  (`SessionManager.close(by)`: an archive, a VM stop) applies its stop
  before it awaits anything. If the close fails, or the archive around it
  does (a worktree that will not go), the hold goes back to what it was,
  unless it was written since: no user's hold outlives an archive that did
  not happen. Written since means changed — or re-asserted by a user's stop;
  anything that leaves the hold as it was (a discard put back as the
  adapter closes, a crash, a supervisor's stop on it) writes nothing and
  voids no undo. Write numbers are never reused, so a session forgotten and
  written again cannot match an older undo.
- **H7 Busy.** While a clone's guest Git runs for the daemon — its turn-end
  sync, a rebase, republishing a renamed branch — the daemon marks the
  session busy in `SessionManager` (`setBusy`). Dispatch reads it with the
  rest of rule 1, so it stops every path alike: the pump, a send, a release,
  send now, notifications and agents' messages. Only the user's
  `session.send` and `session.queueRelease` are refused as `busy` meanwhile
  (their contract); everything else is queued as usual and goes when the
  operation ends, which re-evaluates the queue.

These rules were reached race by race; the planned refactor into a single
state transition is under Known issues in `docs/loom-agents.md`.

## Interactions

| Concern              | Rule                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Hook feedback        | Bypasses the queue: the direct `automated` send at `daemon.ts:457`, echoed at once, as today. A Stop that discards it drops it.            |
| Rebase/commit nudges | Bypass the queue, as hook feedback; a discarded nudge is dropped, never surfaced as a user entry ([decision 3](#decisions)).               |
| Auto-resume          | Bypasses the queue.                                                                                                                        |
| Keep-warm            | Bypasses the queue; never sent while an entry is dispatchable; allowed while held.                                                         |
| Requests, plans      | Answers bypass the queue; nothing dispatches during `awaiting_input`. Claude's "plan is approved" send (`adapter.ts:1096`) stays internal. |
| Compaction           | Dispatch pauses while restructuring; `session.send` then enqueues instead of failing `busy`, retiring the TUI's busy reroute.              |
| Undo/rewind          | Allowed with queued or held entries (they are not history); refused while an entry is delivering.                                          |
| Provider switch      | The queue survives; dispatch uses the new adapter's capabilities.                                                                          |
| A3 ordering          | Unchanged: the root result is the boundary; enqueueing never promotes a row.                                                               |

## Wire, RPC, events

`PROTOCOL_VERSION` becomes 5 (`core/src/wire.ts:26`).

`SessionSnapshot.queue` is `{ hold, holdBy?, entries }`; each entry carries `id`,
`author`, `delivery`, `state`, `uncertain`, `revision`, `preview`, `bytes` and
`dequeue`. `preview` is the first 200 characters; full text comes from
`session.queueEntry`, because fleet snapshots republish often. `dequeue` is a
daemon-computed `DequeueHint`, so every client says the same thing:
`tool_boundary {tool}` ("lands when Bash finishes"), `next_tool_or_turn_end`,
`turn_end {ahead}` ("when the agent finishes, 2nd in line"), `after_request`,
`after_compaction`, `held {reason}` ("held · r releases") and `session_stopped`
("sending revives it").

RPCs (`core/src/rpc-params.ts`). Every entry mutation carries the `revision` the
client saw; a stale one gets `conflict` and changes nothing.

- `session.send` gains `entryId?` (UUID) and `delivery?` (default
  `next_boundary`) and returns `{ entryId, state }` with the snapshot;
  `injected` is removed. It enqueues on any non-terminal session (reviving a
  cold one first, as today). The handler no longer emits `user_message`; on
  failure it emits only the `error` event, since unconsumed text never enters
  the log.
- `session.queueEntry {id, entryId}` returns the full entry.
- `session.queueEdit {id, entryId, revision, text}`: only while `queued`.
- `session.queueMove {id, entryId, revision, direction}`: up or down within the
  group. `session.queueSetDelivery {id, entryId, revision, delivery}`.
- `session.queueSendNow {id, entryId, revision, confirm?}`: on a running
  session, moves to the head of `next_boundary`; on an idle or held one, starts
  a turn with that entry alone. An uncertain entry needs `confirm` (it may
  duplicate).
- `session.queueRemove {id, entries: [{entryId, revision}]}` cancels queued and
  uncertain entries. A delivering, certain entry is refused ("already handed to
  the agent") until an adapter offers per-input cancel (Claude's
  `cancel_async_message` exists in the CLI protocol but not in the SDK API).
- `session.queueRelease {id}`; `session.queueClear {id, entryIds}` clears only
  the observed IDs (main-new `cancelMany`).
- CLI: `loom send --end-of-turn`; `loom queue <id> [--release]`.

Worker protocol (`core/src/worker.ts:82`, `runtime/src/worker/serve.ts`,
`backend/daemon/src/daemon/worker-provider.ts:232`): `send` takes
`[text, {inputId, midTurn}]`; `interrupt` is unchanged (discards travel as the
`input_discarded` event); `input_consumed` is an ordinary event frame. `opts` stays optional for the echo
connector.

Events: `userMessageEventSchema` (`core/src/events.ts:355`) gains
`queueEntryId?` and `author?`; its comment now says "consumed". Queue changes
are snapshot state, not events; the interrupt notice uses the notice path.

Multi-client: all clients render the queue and hints from the snapshot. The TUI
outbox shrinks to RPC state (`sending`, and `held` for an uncertain or rejected
`session.send`); its `queued`, `due`, `advance` and `drainQueues` paths go.
Retrying an uncertain send with the same `entryId` is deduplicated, but still
never automatic (`docs/tui-state.md`). A concurrent edit gets `conflict` and the
losing client keeps its text as a draft.

## DB migration 31

The current highest in `backend/daemon/src/store/migrations.ts` is 30. Store
code goes in `backend/daemon/src/store/message-queue.ts`.

```sql
CREATE TABLE session_queue (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('next_boundary','end_of_turn')),
  state TEXT NOT NULL CHECK (state IN ('queued','delivering','consumed','cancelled')),
  uncertain INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, delivered_at INTEGER, consumed_at INTEGER,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX session_queue_live ON session_queue(session_id, state, seq);
ALTER TABLE sessions ADD COLUMN queue_hold TEXT
  CHECK (queue_hold IN ('interrupt','restart','crash','rejected'));
-- migration 34: whose stop the hold is
ALTER TABLE sessions ADD COLUMN queue_hold_by TEXT
  CHECK (queue_hold_by IN ('user','supervisor'));
```

## TUI and commands (A2)

Every command below is a `COMMANDS` entry in `frontend/tui/src/commands.ts` with
its availability beside the others. `CommandSurface` gains `"queue"`. Queue
commands target `{sessionId, entryId, revision}` and are re-described before
running, like every A2 target. Session commands stay hidden on child rows.

| Command                         | Browse  | Composer | Queue view  | Notes and disabled reasons                                                       |
| ------------------------------- | ------- | -------- | ----------- | -------------------------------------------------------------------------------- |
| `send`                          | `⏎`     | `⏎`      |             | On a busy target the label is "queue · next tool boundary".                      |
| `enqueueEndOfTurn`              |         | `⌥q`     |             | "queued send"; a plain send on an idle, unheld target (as today).                |
| `queue`                         | `q`     | palette  |             | Bar label "queue" / "3 held". "No queued messages."                              |
| `queueEdit`                     |         |          | `e`         | "Already handed to the agent." · "Loom's own messages can't be edited."          |
| `queueRemove`                   |         |          | `x`         | "Already handed to the agent."                                                   |
| `queueMoveUp` / `queueMoveDown` |         |          | `⇧↑` / `⇧↓` | Aliases `K` / `J`. "First in its group." / "Last in its group."                  |
| `queueToggleDelivery`           |         |          | `t`         | "queued send" / "next boundary" (its new group). "Already handed to the agent."  |
| `queueSendNow`                  |         |          | `s`         | "Answer the pending request first." An uncertain entry confirms "may duplicate". |
| `queueRelease`                  | palette |          | `r`         | "The queue is not held."                                                         |
| `clearqueue`                    | `⌥x`    | `⌥x`     | `c`         | Confirms "Clear N?" over the IDs shown. "No queued messages."                    |
| `quit`                          | `⌃c`    |          |             | `q` no longer quits; also in the palette.                                        |
| `quitall`                       | palette |          |             | "Quit and stop the daemon", behind its confirm; `Q` is unbound (decision 1).     |

Queue view (`frontend/tui/src/queue-view.tsx`, adapted from
`ConversationQueue`): two groups, "Next tool boundary" and "When the agent
finishes"; rows `state · author · first line`; the selected entry shows its
hint, full text (`session.queueEntry`) and, when uncertain, the warning. `↑↓`
select, `Esc` back; the footer is A2's projection of the `queue` surface. `e`
opens the send composer prefilled and Enter saves through `queueEdit`; a
conflict reopens it with the text and the reason. Selection is by ID and
survives arrivals; a clear confirm covers only the IDs shown (main-new test
"queue review freezes clear selection across arrivals").

Chat log: `views.ts:163` draws trailing lines from `snapshot.queue` instead of
the outbox, one per kind of wait (`⧗ 3 messages queued for after the current
tool call. press q to view/manage.`, `… queued for when the agent finishes. …`,
`… held. …`; previews only in the queue view). A consumed entry becomes a
normal `user_message`; mid-turn ones keep the `»` glyph and "sent mid-turn"
(`transcript.ts:379`). DETAIL's status line appends `· 3 queued` or
`· 3 held · q review`.

Docs: `docs/keybindings.md` (`q` opens the queue, ⌥q and ⏎ wording, a Queue
overlay section) and the outbox paragraph of `docs/tui-state.md`.

## Commits

(1) Migration 31 and store; (2) pure dispatch policy; (3) adapter contract:
`send` options, `input_consumed`, `inputReceipts`, worker frames, AISDK
receipts; (4) daemon wiring: enqueueing `session.send`, `user_message` on
consumption, interrupt hold, restart recovery, queue RPCs; (5) TUI:
snapshot-driven queued lines, outbox reduction, A2 commands, queue view; (6)
Claude and Codex receipts, behind `inputReceipts`; (7) docs and CLI. Each lands with its tests.

## Tests and acceptance

- Store (`test/message-queue-store.test.ts`): group ordering, idempotent enqueue
  and text conflict, limits, stale-revision conflict for every mutation,
  pruning, migration on a copied pre-31 DB.
- Policy (`test/message-queue-policy.test.ts`): a table case per rule — no
  dispatch while held, awaiting input, restructuring or stopping; the boundary
  window needs a root tool in flight that is not blocked on a permission;
  leftover `next_boundary` entries batch into one turn; one `end_of_turn` per
  `idle`.
- SessionManager (`test/session-manager.test.ts`, fake adapter): no
  `user_message` before `input_consumed`, and echo at handover without receipts;
  interrupt requeues cancelled entries in order, marks the rest uncertain and
  holds; release resumes; send now on a held queue leaves the rest held; a
  rejected steer requeues; an uncertain handover holds; restart recovery marks
  delivering entries uncertain while auto-resume bypasses; Loom's direct sends
  bypass the queue and a discarded one is dropped; a new message on a held
  queue goes first and releases it; one `end_of_turn` entry per `idle`; only
  user entries arm `userTurn`.
- Adapters: Claude reports `cancelled` and drained `#inbox` IDs, including in
  the A7 seeding window (`test/claude-adapter.test.ts`); AISDK injection
  receipts; a Codex steer rejection maps to requeue, with a recorded
  `userMessage` fixture when available.
- TUI (`test/tui-model.test.ts`, `test/tui-render.test.ts`): every new command
  in the palette with its reasons; `q` opens the queue and quit stays reachable;
  selection stable across arrivals; an edit conflict keeps the draft; every
  `DequeueHint` renders; two clients show the same queue.
- Live (`scripts/test-live-daemon-acceptance.ts`, `claude:personal` and default
  `codex`): a message queued during a long `Bash` reaches the log only after
  that tool finishes and the agent acknowledges it; interrupt with three entries
  leaves three held; release delivers them in order.

Acceptance: every pending message and its expected dequeue point is visible;
nothing enters the log before the agent has it, except through the documented
receipt-less fallback; after an interrupt nothing queued reaches the agent until
the user releases or sends it; order survives interrupts and daemon restarts.

## Decisions

The open questions, as the user answered them:

1. **Quit keys.** `⌃c` quits the UI, as today. `q` opens the selected session's
   queue view. `Q` is unbound; "Quit and stop the daemon" is a Space palette
   command (behind the existing confirm), and plain quit stays on `⌃c` and in
   the palette.
2. **A new message on a held queue.** It is sent first, alone — as a new turn,
   or handed to the live one — not queued behind the held entries, and sending
   it releases the hold as usual. The held entries then follow the ordinary
   rules: one held `end_of_turn` entry is delivered at the end of the turn the
   new message started. Uncertain entries still need send now or delete.
3. **Loom's own messages.** Hook feedback and the rebase / commit nudges do not
   go through the user queue: they keep today's direct, `automated` send. If a
   Stop cancels one it is dropped — not re-sent and not surfaced as an entry.
4. **`end_of_turn` timing.** Today's ⌥q semantics: an entry goes when the
   session is `idle` (background work included), one per idle. No new waiting
   rules.

## Risks

- Claude's `command_lifecycle` frames are not in the SDK's typings; an older CLI
  without them still lists folds in the `result`'s `user_message_uuids`, so a
  fold then reaches the log at turn end.
- Boundary detection depends on tracking root tool calls. A missed `tool_result`
  makes handover late, never early; the fallback is turn end. Codex reported a
  command only once it completed; it now reports the call at `item/started` so
  the window can open.
- Codex drops steered input on interrupt without a receipt; those entries become
  uncertain and need a user decision.
- Protocol v5 forces the TUI and daemon to upgrade together (already the rule).
