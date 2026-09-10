# Remaining work

Loom implements multi-provider sessions, worktrees, compaction, titles, plan
review, subagents, usage accounting and the terminal UI. Current behavior and
configuration live in [README](../README.md), [connectors](connectors.md) and
[isolation](isolation-plan.md). Completed milestone plans are in Git history.

## Isolation

- Live AISDK Google/native Anthropic checks. Codex controlled rotation/expiry VM
  checks pass; natural live OAuth expiry remains untested.
- Standard daemon/TUI launches now allow only Unix IPC; provider/catalog/title
  network calls run in children. Native subprocess confinement still requires VMs.
- Complete the remaining [macOS validation](review-2026-09/macos.md); Intel Mac
  packaging remains unsupported.

## Follow-up reviews

- Provider interaction lifecycle: stale/concurrent plan resolution, retry only
  before a known application boundary, cancellation of parked interactions.
- Control-event overflow and duplicate runtime registration.
- Settings and deferred tools: see [settings](settings-plan.md),
  [tools](tools-plan.md), and [task backlog](todo.md). Those are proposals; check
  current code before treating a historical finding as an outstanding defect.

## Verification

Run `deno task typecheck`, `deno task lint`, and `deno task test:silent`. Native
VM and live-auth acceptance commands are documented with the runtime they test.
Live checks are separate from deterministic tests and may consume provider usage.

Latest bounded review: [isolation and TUI follow-ups](review-2026-09/session-isolation-followups.md).
