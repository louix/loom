# TUI state and request feedback

The daemon publishes replacement session snapshots. Clients keep connection state
separate from selected-session transcript loading, and transcripts use bounded
history pages rather than embedding the whole log in fleet updates.

Session startup and cold resume publish `starting` before launching a worker or
VM. Submitting a new message closes the composer so the STARTING state is visible.
A structurally valid create request gets a row and opening message before provider,
model or worktree setup. Startup/send failures are persisted in session events;
the TUI selects that session without restoring a draft. Malformed requests and
transport failures still retain draft recovery. Ambiguous timeout/disconnect outcomes
require review before resending; the client does not automatically replay the request.

Reply Up-arrow recall queries the selected session's latest 50 distinct user
messages directly, independently of loaded transcript pages and intervening tool
traffic. Other sessions cannot replace its recall list. New-session prompts retain
local submission history. Cancelled-message drafts remain separate.

Missing/disabled providers and incompatible isolation histories remain readable.
The DETAIL pane explains the reason; continuation forks use an enabled provider
and the current isolation policy.

Mode selection shows its target immediately; the existing 300ms debounce delays
the RPC, not local feedback. The mode chip is clickable in DETAIL and in new/reply
composers. Pending or uncertain sends disable composer mode changes.

Outbox entries own their operation identity. Clearing waiting messages preserves
a send already in flight. A late callback cannot consume a newer or identical
message. Disconnection retains unsent text while disabling daemon actions.

See [keybindings](keybindings.md) for controls. Regression coverage lives in
`test/tui-model.test.ts`, `test/tui-render.test.ts`, `test/session-manager.test.ts`
and the client/daemon transport tests. Historical migration plans and benchmark
reports are retained in Git history.
