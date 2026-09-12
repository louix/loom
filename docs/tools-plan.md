# Agent tools — background tasks, git status (shipped); check (deferred)

Design from 2026-09, user-reviewed. Approved scope: background process tools for
aisdk sessions and a `status` tool on both tool stacks. The `check` tool was
deferred — its design is captured in the last section for when it's revisited.

## Where tools mount

Two first-party tool surfaces, kept in name-parity:

- **Claude**: the in-process `loom` MCP server (`connectors/claude/src/loom-mcp.ts`).
- **aisdk** (OpenAI-compatible, Gemini, …): builtins in `aisdk/src/tools/`
  (registered only for names no configured MCP server claimed) plus loom tools in
  `aisdk/src/loom-tools.ts`.

SDK-agnostic helpers live in `core/src/` with no vendor imports (`commit.ts`, now
`status.ts`) so both stacks share one implementation. Config reaches tools through
`ConnectorContext` (built in the daemon's `provider-registry.ts`) — the same seam
`[search]` → `web_search` uses.

## Shipped: background tasks (aisdk only)

Foreground `bash` uses a fresh `bash --noprofile --norc -c` process for each call.
It inherits the session's prepared environment and defaults to the worktree;
optional `cwd` is absolute or relative to that worktree. `cd`, `export` and shell
options do not persist between calls. Output is bounded, and timeout, interruption
or command exit clean up its process group. Use `background` for jobs that must
outlive a foreground command.

Claude Code has native `run_in_background` / `BashOutput` / `KillShell`, so this is
aisdk-only. `aisdk/src/tools/background.ts`:

| Tool                | Input                       | Result                                                                                   |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `background`        | `command`, `timeout_ms?`    | `{ id: "bg-N" }` — detached `bash -c`, own process group, returns immediately            |
| `background_output` | `id`, `wait_ms?`, `filter?` | `{ running, exit_code, timed_out, output }` — output since the last read (cursor resets) |
| `background_kill`   | `id`                        | kills the process group (descendants included), returns the unread tail                  |

- Default timeout 10 minutes; `timeout_ms: 0` runs until exit / kill / session
  close. On expiry the task is SIGKILL'd as a group and `timed_out: true` is
  reported; the final buffer stays readable.
- Per-task unread buffer clamped live (head + tail, reusing bash.ts's
  `collapseLive`) with a dropped-character counter — an hour of dev-server logging
  cannot grow memory.
- `wait_ms` (default 30 s, no upper cap) resolves early on new output or exit;
  `filter` is a JS regex applied line-wise with a match-count header.
- Max 8 concurrently running tasks; `BuiltinTools.close()` kills everything.
- `background_output` is classified readonly in `aisdk/src/gate.ts` (plan mode
  keeps it); `background` / `background_kill` stay permission-gated.

## Shipped: `status` (both stacks)

`core/src/status.ts` → `statusInWorktree(cwd, { base?, patch? })`:

- `git status --porcelain=v1 -b` — branch line + raw porcelain entries (models
  parse `XY` codes natively; no reformatting). Detached HEAD is named by short sha.
- `worktree: <abs path>` on the line after the branch — the session's checkout
  root (what the daemon anchors MCP stdio servers' cwd to), so models pass a
  real `root` to tilth instead of guessing a mount location.
- `base` → `git rev-list --left-right --count <base>...HEAD` → ` [+2 -1 vs main]`
  on the branch line; silently omitted when the base ref is unknown or 0/0.
- `git diff HEAD --shortstat` compacted to `2 files changed, +18 -4`; a fully
  clean worktree prints `worktree clean`.
- `patch: true` appends `git diff HEAD` clamped head+tail (120 KB cap). Untracked
  file _contents_ are not in the diff (no index mutation) — documented limitation.
- Mounted as `status` on the Claude `loom` MCP server and in aisdk
  `loom-tools.ts`, next to `commit`. The daemon passes its `base_branch` through
  `ConnectorContext.baseBranch` → provider/session options → the tool.
- `status` is classified readonly in `aisdk/src/gate.ts`.

## Deferred: `check` (design captured, not built)

User decision: valuable, but deferred because the config plumbing wasn't obvious
("config doesn't know about any specific repo atm"). Resolution for whoever picks
it up: the daemon loads matching `[[repo]]` overrides from the user config
(deep-merged over global defaults) and routes per-feature config to tools through
`ConnectorContext` — `[search]` → `web_search` is the working proof. A `[check]`
section needs no new infrastructure:

```toml
[check]
timeout_ms = 600_000

[check.commands]        # keys become the check tool's `name` argument
typecheck = "tsc --noEmit"
test = "node --import @oxc-node/core/register --test \"test/*.test.ts\""
```

Tool behavior when built: `check(name, full?, filter?, timeout_ms?)`; pass →
`"typecheck passed (exit 0)"` (the errors-only context diet); failure → merged
stdout+stderr clamped head+tail with the exit code; optional regex line filter.
Registered only when ≥ 1 command is configured. Runner in `core/src/check.ts`:
one-shot detached `bash -c` with a bounded output buffer, group SIGKILL on timeout,
and `check` added to
`READONLY_EXACT` in `aisdk/src/gate.ts`.
