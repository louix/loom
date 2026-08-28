# Loom

A per-project daemon that runs and supervises a fleet of coding agents, each
isolated in its own git worktree, viewed and driven from a terminal UI. V1 runs
on the Claude Agent SDK; the provider layer is built so Google ADK can drop in
as a second adapter.

> Codename "Loom" — rename freely. See the design spec for the full picture;
> this repo currently implements **milestone 1** of the build order.

## Status — milestone 1: daemon skeleton

Implemented:

- **Daemon (`loomd`)** — one long-lived process per repo, listening on a Unix
  domain socket at `<repo>/.loom/daemon.sock`. Single-instance guard via a
  pidfile; optional idle shutdown.
- **Wire protocol** — newline-delimited JSON over the socket. One connection
  multiplexes request/response and a server→client push stream; every push
  frame carries a monotonic `seq`.
- **In-memory event log** — sequenced ring buffer with `since(seq)` gap replay
  for client reconnect, and rolled-past detection that triggers a `resync`.
- **SQLite store** (`node:sqlite`, WAL) — `sessions`, `status_history`,
  `usage`, `runtime_children`; append-only versioned migrations.
- **Session registry** — write-through over the store, per-session version
  counter, fleet-view sort (status group order: awaiting_input → running →
  interrupted → idle → error → done; recency within a group).
- **Restart hygiene** — on startup: mid-run sessions become `interrupted`
  (never auto-resumed), child processes from a previous daemon epoch are
  signalled to exit, stale git index locks are cleared and worktrees pruned.
- **Thin client + `loom` CLI** — connect-or-spawn the daemon, `hello`
  handshake, request/response, automatic reconnect with gap replay.

Not yet implemented (later milestones): provider adapters (Claude, then ADK),
the worktree manager, the `loom` MCP server, the real TUI, accounting/budgets,
plan review, sub-agent nesting. There is **no agent execution yet** — sessions
are created through development RPC hooks.

## Requirements

- Node **≥ 24** (uses native TypeScript type-stripping and `node:sqlite`; no
  build step, no native modules).
- `git` on `PATH`.

```sh
npm install
```

## Usage

Everything is driven through `loom`; the daemon starts automatically on first
use and writes to `<repo>/.loom/`.

```sh
node src/cli/loom.ts status          # daemon health and counts
node src/cli/loom.ts ls              # sessions, in fleet-view order
node src/cli/loom.ts ls --json
node src/cli/loom.ts ping            # round-trip latency
node src/cli/loom.ts tail            # live event feed (Ctrl-C to stop)
node src/cli/loom.ts stop            # shut the daemon down
```

Development hooks that stand in for a provider adapter:

```sh
# create a placeholder session in a given status
node src/cli/loom.ts stub "refactor the auth module" --status awaiting_input --reason permission

# drive a session's status (broadcasts session_updated)
node src/cli/loom.ts set-status <id> running

# inject a synthetic event onto the push stream
node src/cli/loom.ts emit <id> assistant_text --text "hello"
```

Run the daemon in the foreground (normally auto-spawned) — useful with
`--log-level debug`:

```sh
node src/cli/loomd.ts --repo . --log-level debug
```

## Development

```sh
npm run typecheck    # tsc --noEmit
npm test             # node:test — 28 cases
```

### Layout

```
src/
  protocol/   wire frames + the normalized HarnessEvent union
  store/      node:sqlite: schema, migrations, repositories
  config/     .loom/config.toml loader
  daemon/     event log, RPC dispatch, socket server, registry,
              hygiene, lifecycle, and the Daemon that wires them
  client/     thin client (connect-or-spawn, reconnect, gap replay)
  cli/        loom (client) and loomd (daemon) entrypoints
```

### `.loom/` runtime directory

Created in whatever repo the daemon runs against; all of it is gitignored:

| path                 | what                                            |
| -------------------- | ----------------------------------------------- |
| `daemon.sock`        | the client↔daemon Unix domain socket            |
| `daemon.pid`         | single-instance guard                           |
| `daemon.log`         | rolling daemon log (JSON lines)                 |
| `loom.db`            | SQLite: sessions, history, usage                |
| `trees/`             | one git worktree per session (later milestones) |
| `config.toml`        | optional; falls back to built-in defaults       |
