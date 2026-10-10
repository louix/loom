# TUI state and request feedback

The daemon publishes replacement session snapshots. Clients keep connection state
separate from selected-session transcript loading, and transcripts use bounded
history pages rather than embedding the whole log in fleet updates.

Each reconnect waits for a fresh fleet snapshot, then the TUI reloads the selected
session's newest history page and resets its scroll position. Pending questions,
permissions and plans come from the snapshot. Durable row IDs merge history with
concurrent live output without duplicates. There is no transport replay or event
ring buffer; transient notices and raw `loom tail` output while disconnected may
be missed. Requests with uncertain outcomes fail explicitly and are never retried
automatically. Protocol v5 requires matching client and daemon versions.

Session startup and cold resume publish `starting` before launching a worker or
VM. Submitting a new message closes the composer so the STARTING state is visible.
A structurally valid create request gets a row and opening message before provider,
model or worktree setup. Startup/send failures are persisted in session events;
a notice reports the failure without changing the current selection or restoring
a draft. Malformed requests and
transport failures still retain draft recovery. Ambiguous timeout/disconnect outcomes
require review before resending; the client does not automatically replay the request.

Reply Up-arrow recall queries the selected session's latest 50 distinct user
messages directly, independently of loaded transcript pages and intervening tool
traffic. Other sessions cannot replace its recall list. New-session prompts retain
local submission history. Cancelled-message drafts remain separate.

Missing/disabled providers and incompatible isolation histories remain readable.
The DETAIL pane explains the reason; handoff forks use an enabled provider
and the current isolation policy.

Mode selection shows its target immediately; the existing 300ms debounce delays
the RPC, not local feedback. The mode chip is clickable in DETAIL and in new/reply
composers. Pending or uncertain sends disable composer mode changes.

Queued messages are the daemon's ([message queue](message-queue.md)): every send
enters the session's queue, every client draws it — and when each entry goes —
from the snapshot, and a message reaches the log only once the agent has taken
it. The TUI's outbox holds only what its RPC is doing: a `session.send` in flight,
and one whose reply never came or was refused (held). A held message is never
re-sent by itself; opening that session's send prompt hands it back, and sending
it unchanged reuses its entry id, so a send that did arrive is answered rather
than queued twice. A late callback cannot consume a newer send. Disconnection
retains unsent text while disabling daemon actions.

See [keybindings](keybindings.md) for controls. Regression coverage lives in
`test/tui-model.test.ts`, `test/tui-render.test.ts`, `test/session-manager.test.ts`
and the client/daemon transport tests. Historical migration plans and benchmark
reports are retained in Git history.

## Fleet ordering and focus

Daemon and TUI share `core/src/session-order.ts`: status group, then creation
time descending, then ID ascending. Activity does not reshuffle peers.
Rows can still move when groups change, children expand or the viewport scrolls.
Search retains relevance ordering. Selection tracks a session ID, not a row index.

Creating a session keeps the current selection. Completion, cancellation and
accepted startup failure report a notice without selecting that session later.
Users can select its STARTING row explicitly. An empty fleet selects its first
arriving row through normal reconciliation.

## Forks and undo

Undo/rewind depends on provider capabilities.

`F` opens the fork wizard: provider, then history, then (for a handoff) the
destination's catalogue model and effort, then workspace, then a confirmation
that states what will cross. Each step's `Esc` goes back one step. A fork waits
for a settled turn. The source keeps its history, workspace and usage.

- **Native history** resumes a copy of the provider's own history: Loom's
  transcript for aisdk, `forkSession` for Claude, `thread/fork` for Codex. It is
  offered only on the source's own provider, under Local isolation, while the
  source is resumable; the snapshot's `nativeForkBlockedReason` says why not.
  The copy's provider ref is recorded before its first turn.
- **Handoff** starts a fresh session on any available provider. Its opening
  prompt quotes up to 100 user/assistant messages (64 KiB, newest first) from
  Loom's stored transcript. It names what was omitted: tool activity, sub-agent
  messages, earlier history and oversized messages. It says that hidden
  provider state did not cross. It works when the source's provider is
  disabled or gone. A handoff of a handoff carries the original messages, not
  the earlier prompt.

The row records `parentId`, `forkTurn`, `forkKind` and, for a handoff, the
handoff itself. DETAIL shows them. Usage starts at zero. A native Claude copy
seeds its ledger at resume, so the source's spend is never charged again.

A **copied** workspace is a new worktree at the source's actual HEAD, with its
staged, unstaged and nonignored untracked work copied separately. In-progress
Git operations and submodule changes are rejected. Private-clone forks instead
start from the published tip; see
[repository access](repository-mounts.md#clone-mode). A **shared** workspace
is the source's own worktree and branch, recorded as `worktreeOwner`. It needs
Local isolation on both sessions. The sharing fork never removes the tree or
its branch. The owner cannot be archived or removed while a sharing fork still
holds it.

A fork that fails to start, or is cancelled while starting (`F` on the source,
or interrupt on the STARTING row), leaves no row behind. Its worktree copy and
branch are removed too.
