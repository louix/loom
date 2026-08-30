# Loom

A per-project daemon that runs and supervises a fleet of coding agents, each
isolated in its own git worktree, viewed and driven from a terminal UI. The
first-class runtime is the Claude Agent SDK; the provider layer takes
OpenAI-compatible models (GLM, DeepSeek, OpenRouter, vLLM, Ollama, OpenAI) via
the Vercel AI SDK.

> Codename "Loom" — rename freely. The design is whatever's written here and in
> `docs/roadmap.md` / `docs/m10-plan.md`. This repo implements **milestones 1-10**:
> the Claude adapter plus a full OpenAI-compatible provider (streaming, tools
> through the permission gate, a first-party bash/edit/grep suite, plan mode,
> Loom-side compaction, `task` sub-agents) and the TUI to pick and switch
> providers/models.

## Status — milestones 1-10

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

- **Provider seam** (`@loom/core`) — the vendor-neutral `AgentProvider` /
  `AgentSession` interfaces and the normalized `HarnessEvent` union. Nothing
  above the connector packages imports a vendor SDK.
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
- **In-place mode** — `[worktree] enabled = false` (or `loom run --in-place`)
  runs the session directly in the repo working dir instead: no branch
  isolation, concurrent sessions can collide, and hard fork is unavailable
  (undo still works). The Detail pane shows the repo's own git state.
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
  `Glob` are disabled outright (`providers.claude.disable_builtin`). If `tilth`
  isn't on `$PATH` the daemon falls back to `npx -y tilth@0.9.0` (and, if `npx`
  is missing too, just runs with the built-ins).

**5 · terminal UI**

- **`loom` with no command** in an interactive terminal — or `loom tui`
  explicitly — opens a full-screen fleet view. It is just another client, with
  reconnect enabled, so the daemon and its sessions outlive it; re-opening
  replays the daemon's buffered event history so the log isn't blank.
- **Fleet pane** — sessions grouped by status in fleet-view order, a braille
  spinner on running rows, cost per session, and a `⟢` cache dot that grades
  green → amber → red as the prompt cache nears expiry (blank once it's cold or
  n/a); `↑`/`↓` (or `j`/`k`) moves the selection.
- **Detail pane** — the selected session's status / mode / model, a
  context-window meter, token and cost totals, its worktree's git facts, and any
  messages queued for it. When it's `awaiting_input` a panel spells out exactly
  what's being approved / denied / asked (the command, the file, the question).
- **Event stream** — the normalized harness events for the selected session,
  colourised by kind and word-wrapped to the pane (never clipped — it scrolls).
  `v` toggles `full` ↔ `chat` (conversation only: tool traffic folds to `⚙ N
  tool calls`, thinking to `· thought for Ns`). `PgUp`/`PgDn` scroll it, `⇥`
  blows it up to fullscreen, and `o` opens the pending request — or the session
  transcript (`[time] · role · body`, tool args as `key: value`) — in `$EDITOR`
  read-only, so you can read and copy without fighting the split.

**Keybinding grammar** (full table in [`docs/keybindings.md`](docs/keybindings.md), or press `?`):

| modifier | means |
|----------|-------|
| bare key | act on the selected session, or move |
| `Shift`+key | the heavier / structural sibling — `Q` quit-all · `R` restart · `X` delete · `F` fork |
| `Ctrl`+key | text editing only, inside the prompt (`⌃a ⌃e ⌃b ⌃f ⌃← ⌃→ ⌃u ⌃k ⌃w`); `⌃c` quits |
| `Alt`+key | run a prompt action without leaving it — `⌥e` `⌥o` `⌥p` `⌥x`; `⌥m` (switch model) also acts from the fleet view |
| `⇧⇥` | cycle the permission mode — on the selection, or inside a prompt (mid-message) |
| `Space` | the command palette — every action valid right now, fuzzy, with its key |

- **Acting on the selection**, from the verbs the footer offers (the rest live
  in the `Space` palette): `⏎` act on the session — compose a message (running /
  idle / stopped; a stopped session is revived first, so there's no separate
  resume) or take up a pending question / plan; `a` approve a pending permission
  (kept explicit — Enter won't), `d` deny (deny-only — `X` deletes), `c` compact
  the context window (offered once the meter passes half), `i` interrupt, `x`
  mark done. Second-tier, on the palette and `?` help: `⇧⇥` cycle the permission
  mode, `⌥m` switch the model (next turn), `u` undo — rewind an idle session to an
  earlier turn (shows the re-prime cost), `e` rename, `b` set a cost budget,
  `y` copy the branch, `o` view the log in `$EDITOR`, `v` full / chat,
  `F` hard-fork into a new session + worktree, `X` delete (behind a confirm;
  `b` there also deletes the branch). `n` starts a new session — the prompt
  shows the provider / model and `⌥p` changes them; `f` fuzzy-finds a session by
  title or message text.
  Sending to a session that's still working: `Enter` sends now, `⌥⏎` queues it
  for when the turn ends. On an aisdk session "sends now" splices the message
  into the running turn right after the current tool result (the model sees it
  on its next step); on a Claude session the SDK queues it for the next turn
  boundary. Queued messages drain automatically and `⌥x` (in the send prompt)
  or the palette clears them. In a prompt, `Ctrl` carries the readline
  motions; `⌥e` hands the text to `$EDITOR` (event log alongside to copy from;
  nothing is sent until you press enter back in the UI), `⌥o` opens just the log
  read-only, `⌥p` picks the provider-model for a new session, `⇧⇥` / `⌥m` change
  the mode / model (a new session's, or — from a send prompt — the one you're
  messaging, live), `↑`/`↓` recall earlier prompts, and a failed submit reopens
  with the text intact.
- **The daemon, from inside** — `R` restarts it (the client respawns one that
  inherits *this* shell's environment), `Q` quits the UI and stops it; both ask
  first when sessions are live. `q` / `⌃c` just leave the UI. `esc` only backs
  out of overlays — it never quits.

**Permission modes** (`⇧⇥`, or `--mode` on `run`): `manual` prompts for anything
sensitive (the wire / SDK value is still `default`); `plan` keeps the agent
read-only until it presents a plan you approve; `acceptEdits` auto-approves file
edits but still gates commands; `auto` lets the agent proceed on its own but
still stops for anything it judges unsafe (the Claude SDK's own `auto` — not
the flag-gated `bypassPermissions`, which Loom never uses).

**Non-Claude providers (milestone 10)** run on the Vercel AI SDK. Configure them
in the user-level `~/.config/loom/config.toml` (the per-repo `.loom/config.toml`
layers on top); credentials go in as env-var *names* via `api_key_env`, or
inline with `api_key`.

- `[custom-provider.<id>]` — an OpenAI-compatible endpoint (OpenAI, GLM,
  DeepSeek, OpenRouter, vLLM, Ollama). `base_url` required; `<id>` is the
  provider id. This is the form that becomes a plugin.
- `[google]` / `[anthropic]` — one native profile each (`@ai-sdk/google`,
  `@ai-sdk/anthropic`); the provider id is the vendor name.
- `[providers.<id>]` with `adapter = "aisdk"` and `sdk =
  "openai" | "google" | "anthropic"` — the low-level escape hatch, kept for
  several native profiles or unusual setups.

`default_provider` picks which one new sessions use until a session is
actually created — from then on the provider, model, and permission mode it
was created with (or later switched to) become the default for the *next*
`new`, remembered across restarts. Loom persists the transcript itself in
`provider_messages`.

- **10a** — streaming, token usage + price-table cost, cancel, resume.
- **10b** — multi-step tool use. MCP servers (`[[mcp]]`) connect through
  `@ai-sdk/mcp`; the `loom` `ask_user` / `commit` tools are native. Every tool
  call runs through the same permission gate as Claude: read-ish tools pass,
  edits and commands surface a `permission_request` (or run straight through in
  `acceptEdits` / `auto`). A denied call is fed back as a tool error. A turn
  runs up to `max_steps` tool round-trips (default 50, per provider) — but if
  the model is still working when that trips, the turn continues with a fresh
  budget rather than ending; only after five such segments does it stop, with a
  `step_limit` end marker and the session left idle so a message resumes it.
- **10c** — first-party `bash` (persistent shell — cwd and env persist between
  calls), `edit` (exact then whitespace-insensitive string replacement), and
  `grep` (ripgrep) tools, mounted alongside the MCP + `loom` tools and gated the
  same way. A `web_search` tool joins them when `[search]` names a backend
  (`brave` / `tavily`) whose key env var is set.
- **10d** — `plan` mode withholds the mutating tools and offers `exit_plan`;
  approving a plan flips the session to `acceptEdits` and implements it.
  Compaction is Loom's own: a summariser rebuilds the history to one message,
  on demand (`c`) or automatically near the context limit. A `task` tool
  delegates a scoped sub-task to a sub-agent whose steps nest in the log.
- **10e** — the switching UX. `n` opens the new-session prompt with the provider
  and model it will use shown inline; `⌥p` there walks a provider → model picker
  and drops back on the prompt with what you'd typed intact. `⌥m` switches the
  selected session's model (next turn) — from the fleet view or mid-message in a
  send prompt; `⇧⇥` does the same for the permission mode. Each fleet row's id is coloured by its
  provider; the Detail pane spells out `engine · provider / model`.
  `loom providers` and `loom models <provider>` from the CLI. Claude's picker
  list is the CLI's own model catalog, fetched once at daemon start-up (pin
  `[providers.claude] models` to skip that); all four permission modes work,
  including `auto` (Claude proceeds but still stops for anything it judges
  unsafe — not the flag-gated `bypassPermissions`).

OpenAI-compatible profiles need no `model`: the picker list comes from
`{base_url}/models`, and a new session defaults to the last model that provider
ran (remembered in the db, shown by `loom providers`). A model that has since
dropped out of the endpoint's list is skipped, with a notice. Pin `model` /
`models` only for an endpoint whose `/models` is missing or wrong; the native
SDKs (`[google]` / `[anthropic]`) still need a `model` (no probe).
`loom config` (also logged at launch) lints the
loaded config — unset key vars, providers whose model auto-detection found
nothing, a
keyless search backend. A first launch with no `~/.config/loom/config.toml`
drops an annotated copy of `config.example.toml` there.

Cache-liveness in the UI stays Claude-only (OpenAI-compatible endpoints cache
server-side with no TTL to show).

Provider SDKs load lazily — `ProviderRegistry` pulls each adapter's vendor
package (`ai` / `@ai-sdk/*`, or `@anthropic-ai/claude-agent-sdk`) with a dynamic
`import()` the first time a session uses that provider. A Claude-only daemon
never evaluates the Vercel AI SDK, and vice versa. `test/lazy-providers.test.ts`
enforces it with a module-resolve hook.

**Sub-agents.** When a session's agent spawns a sub-agent (Claude's `Task`
tool), the Detail pane shows `⑂ 1/2 sub-agents · reviewer, tester ✓` and the
sub-agent's own event-log rows get a dim `⑂reviewer` prefix and hang one level
in. The set (`{ id, name, active }[]`) rides on the session snapshot as a
runtime overlay — it isn't persisted.

**Plan review.** In `plan` mode the agent presents its plan through the
harness's plan tool; instead of a generic permission prompt, the session goes
`awaiting_input` / `plan_review` and `a` opens a review overlay with four
choices: `i` implement (proceed here), `f` implement fresh (compact the context
to the plan + goal first), `e` edit the plan in `$EDITOR` then implement what
you saved, `d` discuss (send a note back; the agent keeps planning). `esc` does
nothing — a plan review must be answered. `session.respondPlan` is the RPC;
`loom plan <id> <reqId> implement|fresh|revise|discuss` from the CLI.

**Budgets.** No session is capped by default — Loom has no way to know what a
provider or account should be spending, so it doesn't invent a number and
call it a limit. `b` in the UI or `loom budget <id> <usd>` sets a cost /
token / turn cap on a session; `[budget] default_max_cost_usd` (optionally
overridden per provider under `[budget.per_provider]`) applies one to every
new session if you want that instead. On breach a `soft` policy (the default)
marks the session `warned` and it keeps going; `hard` marks it `halted` and
interrupts it (`reason: budget`). Raising the cap clears the state and
re-arms the check. For Claude, the cost cap also rides along as the SDK's own
`maxBudgetUsd`, so a single runaway turn is cut off mid-flight
(`error_max_budget_usd`) instead of only being caught after it finishes.
Without an explicit cap, the Detail pane just shows the running cost.

**Plan usage.** For a claude.ai subscription session (not an API key), the
Detail pane also shows the account's rate-limit windows (`five_hour`,
`seven_day`, …) as Claude itself reports them — the same data behind
Claude Code's own `/usage`. API-key / Bedrock / Vertex sessions have no such
window and show nothing here.

**Price-table cost.** Drop a `.loom/models.toml` with per-model USD-per-million
prices (`input` / `output` / `cache_read` / `cache_write`) and the daemon costs
each usage delta from it instead of trusting the provider's figure; the snapshot
carries `costSource` (`table` / `provider` / `none`) and the UI shows a `~` in
front of a table estimate. `pricing.reload` re-reads the file without a restart.

**Session titles.** A session's title starts as its first message clipped to 200
chars; after the first successful turn the daemon replaces it with a 4–6 word
summary from a cheap one-shot through the same provider (`[titles]` config, off
with `enabled = false`). Renaming it yourself (`e` in the UI / `loom` …) pins
the title and the auto-titler leaves it alone.

**Prompt-cache liveness.** The Detail pane shows `cache ⟢ warm ~47:12 · last
turn hit` (green) or `cache ⟢ cold` once the window lapses, and each fleet row
carries a `⟢` dot graded green (>⅓ of the TTL left) → amber → red (<8%). The
countdown runs from the last turn against the configured
`[providers.claude] prompt_cache_ttl`
(`1h` by default — Loom pins it via `CLAUDE_CODE_PROMPT_CACHE_TTL` so the timer
is exact rather than a guess); `last turn hit` / `rewrote` is the ground truth
from that turn's cache read/write split. It's still an estimate — a context
edit, a tool-list change, or server-side eviction drops the cache regardless of
the clock.

**Context compaction.** `c` on a running or idle session opens a one-line focus
prompt (blank compacts the whole history; text steers what the summary keeps) —
or `loom compact <id> [steer…]`. It drives the provider's own compaction: for
Claude, `/compact` over the streaming input; for aisdk sessions, a Loom-side
summariser. Summarising a long history takes a while, so aisdk sessions tick a
`compact_progress` heartbeat — the Detail pane shows `⇊ compacting… Ns` and the
Fleet row a `⇊` dot — with a 15-minute hard ceiling. When the boundary lands it
shows in the event log as `⇊ context compacted 154k → …`; the context meter
re-measures on the next turn. `session.compact` is the RPC.

## Requirements

- Node **≥ 24** (uses native TypeScript type-stripping and `node:sqlite`; no
  build step, no native modules of our own).
- `git` on `PATH`.
- For the `claude` provider: Claude OAuth already set up in `~/.claude`. The
  `@anthropic-ai/claude-agent-sdk` dependency bundles the Claude Code CLI it
  drives.
- The TUI is built with Ink (React for terminals) — the one place Loom leans on
  a UI framework. It still runs straight through Node's type-stripping: the
  components use `createElement`, no JSX, no build step. Type-stripping works
  across the pnpm workspace too — packages import each other as `.ts` through
  their `node_modules` symlink; `.d.ts` is a publish-only concern.
- **pnpm ≥ 11.23** — provisioned by corepack (`corepack enable`, once per
  machine; the version is pinned in `packageManager`). Where corepack can't
  write a global shim, run it as `corepack pnpm …` or install pnpm standalone.

```sh
pnpm install
```

`virtualStoreType: global` (in `pnpm-workspace.yaml`) keeps one content-addressable
store shared across every git worktree of the repo, so `pnpm install` in a fresh
worktree is near-instant and near-free on disk. Keep worktrees on the same
filesystem as `~/.local/share/pnpm` or the store falls back to copying.

**Providers ship as separate packages.** A production install of `loom` has no
connector and no model SDK — add what you use:

```sh
pnpm add @loom/connector-claude    # Claude, via @anthropic-ai/claude-agent-sdk
pnpm add @loom/connector-generic   # any OpenAI-compatible endpoint + native Anthropic
pnpm add @loom/connector-gemini    # Google Gemini
```

New dependencies observe a 7-day release cooldown (`minimumReleaseAge` in
`pnpm-workspace.yaml`) and pin exact (`save-exact` in `.npmrc`).

## Usage

Everything is driven through `loom`; the daemon starts automatically on first
use and writes to `<repo>/.loom/`.

```sh
loom                  # no command in a TTY → the fleet UI  (or: pnpm loom)
loom tui             # the same, explicitly
loom status          # daemon health and counts
loom ls              # sessions, in fleet-view order
loom ls --json
loom ping            # round-trip latency
loom tail            # live event feed (Ctrl-C to stop)
loom stop            # shut the daemon down
```

Run and drive a session (V1 provider is `claude`; needs its OAuth in `~/.claude`):

```sh
loom run "add a --json flag to the CLI" --mode plan
loom tail                       # watch it; note permission req= ids
loom approve <id> <requestId>   # or: deny <id> <requestId> --text "why"
loom answer <id> <requestId> "use sqlite"   # reply to an ask_user question
loom send <id> "also update the README"
loom compact <id> "keep the plan, drop the investigation"
loom mode <id> acceptEdits
loom interrupt <id>
loom get <id>                   # snapshot: status, usage, cost, context, git
loom done <id>                  # mark complete (worktree kept)
loom gc --force                # remove worktrees for done sessions
```

Each session gets its own worktree under `.loom/trees/<slug>` on a
`loom/<slug>` branch, committed under a `Loom (claude)` identity, with pushing
blocked. Integrate the branch yourself, in your own git — Loom never does.

`--provider fake` swaps in the scriptable no-SDK adapter — the session starts
and takes turn control, but only emits events a test drives into it.

Development hooks (pure event-log / registry pokes, no adapter):

```sh
loom stub "placeholder" --status awaiting_input --reason permission
loom set-status <id> running
loom emit <id> assistant_text --text "hello"
```

Run the daemon in the foreground (normally auto-spawned) — useful with
`--log-level debug`:

```sh
loomd --repo . --log-level debug
```

## Development

```sh
pnpm run typecheck   # tsc --noEmit across the workspace
pnpm test            # node:test — 305 cases
```

### Layout — a pnpm workspace

```
core/                @loom/core   the seam + zero-dep helpers, no model SDK —
                     events, wire, provider types, connector contract,
                     TranscriptStore, AsyncChannel, logger, commit, tokens, paths
client/              @loom/client   thin daemon client (connect-or-spawn, reconnect)
aisdk/               @loom/aisdk    the shared Vercel AI SDK engine — session/loop/
                     map/mcp/gate/tools + makeAisdkProvider; deps `ai` + `@ai-sdk/mcp`
backend/daemon/      @loom/daemon   src/{daemon,store,config}/ — RPC, socket server,
                     event log, session manager, status machine, worktree manager,
                     the Daemon, the SQLite store, the config loader, provider-registry
frontend/tui/        @loom/tui      Ink fleet UI: model/reducer, editor, theme, components
connectors/
  mock/              @loom/connector-mock      the scriptable SDK-free provider (tests)
  claude/            @loom/connector-claude     @anthropic-ai/claude-agent-sdk
  generic/           @loom/connector-generic    OpenAI-compatible + native Anthropic
  gemini/            @loom/connector-gemini     Google Gemini (@ai-sdk/google)
cli/                 loom           the `loom` + `loomd` bins; builds the connector manifest
harness/             @loom/harness  makeHarness — a private devDependency of the tests
test/                the cross-package integration suite (`node --test`)
```

Connectors are `optionalDependencies` of `loom`: dev and CI get all of them, a
`--prod` / `--no-optional` install gets none. `ProviderRegistry` loads one lazily
by package name from a manifest the CLI supplies — the daemon package names
connectors only as strings, so it never evaluates a model SDK it doesn't use.
See [`docs/connectors.md`](docs/connectors.md) for the `createProvider` contract.

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
| `models.toml`        | optional per-model price table (`pricing.reload`) |
