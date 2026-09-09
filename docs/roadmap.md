# Remaining work

Loom implements multi-provider sessions, worktrees, compaction, titles, plan
review, subagents, usage accounting and the terminal UI. Current behavior and
configuration live in [README](../README.md), [connectors](connectors.md) and
[isolation](isolation-plan.md). Completed milestone plans are in Git history.

## Isolation

- Codex session VMs and credential ownership; wider live validation of AISDK VMs.
- Remaining daemon catalog/title network paths, then daemon/TUI Deno isolation.
- macOS runtime support; Linux guest packaging is already separated from the
  host launcher.

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
