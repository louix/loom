# Loom

A per-project daemon that runs and supervises a fleet of coding agents, each
isolated in its own git worktree, viewed and driven from a terminal UI. V1 runs
on the Claude Agent SDK; the provider layer is built so Google ADK can drop in
as a second adapter.

> Codename "Loom" — rename freely. See the design spec for the full picture;
> this repo currently implements **milestones 1-5** of the build order.

## Status — milestones 1-5

**1 · daemon skeleton**

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

**2 · Claude adapter**

- **Provider seam** (`src/provider/`) — the vendor-neutral `AgentProvider` /
  `AgentSession` interfaces and the normalized `HarnessEvent` union. Nothing
  above the adapter imports a vendor SDK.
- **Claude adapter** — wraps `@anthropic-ai/claude-agent-sdk` in
  streaming-input mode: one `query()` per session, `canUseTool` surfaces
  permission prompts as events, `SDKMessage`s are normalized (text / thinking /
  tool calls + results / usage / result), mode & model changes are live
  control calls, and `interrupt()` stops a turn. Auth is the SDK's own OAuth in
  `~/.claude` — Loom brokers nothing.
- **Session manager** — one pump task per live session drains the adapter's
  event stream into the push log, derives status from it (design spec §4), and
  rolls usage / cost / context up into the store.
- **`fake` provider** — a scriptable, SDK-free adapter used by the tests (and
  `loom run --provider fake`) so the manager, status machine and rollups run
  offline.

**3 · worktree manager**

- **One worktree + branch per session** — `git worktree add .loom/trees/<slug>
  -b loom/<slug>` off the configured base (`base_branch`, else `HEAD`). The
  slug is derived from the prompt; uniqueness is enforced with a short suffix.
  The session's adapter runs with that worktree as its cwd.
- **Distinct commit identity** — `git config --worktree user.name/email` set to
  `Loom (claude) <loom+claude@localhost>` so tool commits are never confused
  with yours.
- **Pre-push guard** — a worktree-scoped `core.hooksPath` with a `pre-push`
  hook that hard-fails. Loom runs no remote operations itself.
- **Git facts on every snapshot** — branch, commit count, ahead/behind base,
  dirty/clean, last commit subject (cached ~2s).
- **`gc`** — removes worktrees for sessions you've marked `done`; the session
  row and the branch are kept.

**4 · loom MCP server**

- **In-process `loom` server** — mounted into every Claude session (before the
  configured stdio servers), running in the daemon so its tools reach Loom's
  own state. Two tools:
  - **`ask_user`** — the agent puts a question to you and blocks. Surfaces as a
    `question` event → the session goes `awaiting_input` / `question`; you reply
    with `loom answer <id> <reqId> <text>` and the turn resumes.
  - **`commit`** — commits the session's worktree under its pinned
    `Loom (claude)` identity, no shelling out to git. Returns the short hash,
    subject and diffstat; refuses cleanly when there's nothing to commit.
- **Tool steer** — a system-prompt append points file writes at tilth
  (`tilth_write` / `tilth_edit`) and search at fff; Claude's built-in `Grep` /
  `Glob` are disabled outright (`providers.claude.disable_builtin`).

**5 · terminal UI**

- **`loom` with no command** in an interactive terminal — or `loom tui`
  explicitly — opens a full-screen fleet view. It is just another client, with
  reconnect enabled, so the daemon and its sessions outlive it; re-opening
  replays the daemon's buffered event history so the log isn't blank.
- **Fleet pane** — sessions grouped by status in fleet-view order, a braille
  spinner on running rows, cost per session; `↑`/`↓` (or `j`/`k`) moves the
  selection.
- **Detail pane** — the selected session's status / mode / model, a
  context-window meter, token and cost totals, its worktree's git facts, and any
  messages queued for it. When it's `awaiting_input` a panel spells out exactly
  what's being approved / denied / asked (the command, the file, the question).
- **Event stream** — the normalized harness events for the selected session
  (`f` toggles to all sessions), colourised by kind and wrapped to the pane.
  `PgUp`/`PgDn` scroll it, `⇥` blows it up to fullscreen, and `⌃o` opens the
  pending request — or the visible log — in `$EDITOR` read-only, so you can read
  and copy without fighting the split.
- **Acting on the selection**, from the verbs the footer offers: `a` approve or
  answer, `d` deny, `s` send a turn, `i` interrupt, `r` resume (also from
  `error`), `x` mark done, `e` rename, `⇧⇥` cycle the permission mode, `⌃y` copy
  the branch to the clipboard, `n` start a new session. Sending to a session
  that's still working asks first: **asap** (delivered at the next tool
  boundary) or **queue** for when the turn ends; queued messages drain
  automatically and `⌃x` clears them. In a prompt, `⌃e` hands the text to
  `$EDITOR` (with the event log opened alongside to copy from; nothing is sent
  until you press enter back in the UI), `⌃o` opens just the log read-only,
  `↑`/`↓` recall earlier prompts, and a failed submit reopens with the text
  intact.
- **The daemon, from inside** — `R` restarts it (the client respawns one that
  inherits *this* shell's environment), `Q` quits the UI and stops it; both ask
  first when sessions are live. `q` / `⌃c` just leave the UI. `esc` only backs
  out of overlays — it never quits.

**Permission modes** (`⇧⇥`, or `--mode` on `run`): `default` prompts for
anything sensitive; `plan` keeps the agent read-only until it presents a plan
you approve; `acceptEdits` auto-approves file edits but still gates commands;
`auto` runs everything without asking (maps to the SDK's `bypassPermissions`).

Not yet implemented (later milestones): LLM-generated session titles,
price-table cost, budgets, plan review, sub-agent nesting.

## Requirements

- Node **≥ 24** (uses native TypeScript type-stripping and `node:sqlite`; no
  build step, no native modules of our own).
- `git` on `PATH`.
- For the `claude` provider: Claude OAuth already set up in `~/.claude`. The
  `@anthropic-ai/claude-agent-sdk` dependency bundles the Claude Code CLI it
  drives.
- The TUI is built with Ink (React for terminals) — the one place Loom leans on
  a UI framework. It still runs straight through Node's type-stripping: the
  components use `createElement`, no JSX, no build step.

```sh
npm install
```

## Usage

Everything is driven through `loom`; the daemon starts automatically on first
use and writes to `<repo>/.loom/`.

```sh
node src/cli/loom.ts                  # no command in a TTY → the fleet UI
node src/cli/loom.ts tui             # the same, explicitly
node src/cli/loom.ts status          # daemon health and counts
node src/cli/loom.ts ls              # sessions, in fleet-view order
node src/cli/loom.ts ls --json
node src/cli/loom.ts ping            # round-trip latency
node src/cli/loom.ts tail            # live event feed (Ctrl-C to stop)
node src/cli/loom.ts stop            # shut the daemon down
```

Run and drive a session (V1 provider is `claude`; needs its OAuth in `~/.claude`):

```sh
node src/cli/loom.ts run "add a --json flag to the CLI" --mode plan
node src/cli/loom.ts tail                       # watch it; note permission req= ids
node src/cli/loom.ts approve <id> <requestId>   # or: deny <id> <requestId> --text "why"
node src/cli/loom.ts answer <id> <requestId> "use sqlite"   # reply to an ask_user question
node src/cli/loom.ts send <id> "also update the README"
node src/cli/loom.ts mode <id> acceptEdits
node src/cli/loom.ts interrupt <id>
node src/cli/loom.ts get <id>                   # snapshot: status, usage, cost, context, git
node src/cli/loom.ts done <id>                  # mark complete (worktree kept)
node src/cli/loom.ts gc --force                # remove worktrees for done sessions
```

Each session gets its own worktree under `.loom/trees/<slug>` on a
`loom/<slug>` branch, committed under a `Loom (claude)` identity, with pushing
blocked. Integrate the branch yourself, in your own git — Loom never does.

`--provider fake` swaps in the scriptable no-SDK adapter — the session starts
and takes turn control, but only emits events a test drives into it.

Development hooks (pure event-log / registry pokes, no adapter):

```sh
node src/cli/loom.ts stub "placeholder" --status awaiting_input --reason permission
node src/cli/loom.ts set-status <id> running
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
npm test             # node:test — 125 cases
```

### Layout

```
src/
  protocol/   wire frames + the normalized HarnessEvent union
  store/      node:sqlite: schema, migrations, repositories
  config/     .loom/config.toml loader
  provider/   the vendor-neutral seam; claude/ (SDK adapter + event map +
              in-process loom MCP server), fake/ (scriptable test adapter),
              registry
  daemon/     event log, RPC dispatch, socket server, registry, hygiene,
              lifecycle, session manager, status machine, worktree
              manager, and the Daemon
  client/     thin client (connect-or-spawn, reconnect, gap replay)
  tui/        Ink fleet UI: model/reducer, editor, theme, components, entry
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
| `trees/<slug>/`      | one git worktree per session                     |
| `hooks/pre-push`     | the push-blocking hook, shared by every worktree |
| `config.toml`        | optional; falls back to built-in defaults       |
