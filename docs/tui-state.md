# TUI state and request feedback

The daemon publishes replacement session snapshots. Clients keep connection state
separate from selected-session transcript loading, and transcripts use bounded
history pages rather than embedding the whole log in fleet updates.

Session startup and cold resume publish `starting` before launching a worker or
VM. Submitting a new message closes the composer so the STARTING state is visible.
Once a session exists, startup/send failures are persisted with the attempted
message in session events; the TUI selects that session without restoring a draft.
Pre-acceptance failures retain draft recovery. Ambiguous timeout/disconnect outcomes
require review before resending; the client does not automatically replay the request.

Up-arrow recall combines local submissions with saved user messages as transcript
pages load. It is deduplicated and capped at 50 entries; it is separate from the
cancelled-message draft and from the complete durable chat history.

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
