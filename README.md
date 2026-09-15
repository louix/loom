# Loom

A per-project daemon that runs and supervises a fleet of coding agents, each
isolated in its own git worktree, viewed and driven from a terminal UI. The
first-class runtime is the Claude Agent SDK; the provider layer takes
OpenAI-compatible models (GLM, DeepSeek, OpenRouter, vLLM, Ollama, OpenAI) via
the Vercel AI SDK.

> Codename "Loom" — rename freely. The design is whatever's written here and in
> `docs/roadmap.md`. This repo implements **milestones 1-10**:
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
- **Reconnect** — replaces the fleet snapshot and reloads the selected transcript
  from durable session history. Transient notices during a disconnect may be lost.
- **SQLite store** (`node:sqlite`, WAL) — `sessions`, `status_history`,
  `usage`, `runtime_children`; append-only versioned migrations.
- **Session registry** — write-through over the store, per-session version
  counter, fleet-view sort (status group order: awaiting_input → running →
  interrupted → idle → error → done; recency within a group).
- **Restart hygiene** — on startup: mid-run sessions become `interrupted`,
  then `auto_resume` re-drives the ones that were actively working (a
  `loom` message tells the agent to pick its turn back up from the persisted
  transcript; permission/question-blocked sessions stay interrupted), child
  processes from a previous daemon epoch are signalled to exit, stale git
  index locks are cleared and worktrees pruned.
- **Thin client + `loom` CLI** — connect-or-spawn the daemon, `hello`
  handshake, request/response, automatic reconnect with a fresh snapshot.

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

- **Repository layouts** — launch Loom from a normal checkout, a linked worktree,
  or a bare repository. A bare repository and all its worktrees share the bare
  repository root, including when passed through `--repo`. Their daemon, sessions,
  and `.loom/trees/` all live under `<bare-repo>/.loom/`. Other checkouts retain
  their own worktree root. Subdirectories and symlinks resolve to the same root.
  Existing `.loom/` state in a bare repository's linked worktrees is not migrated.
- **One worktree + branch per session** — `git worktree add .loom/trees/<id>
-b loom/<id>` off the configured base (`base_branch`, else `HEAD`), where `<id>`
  is the session id truncated to its 8-char short form; uniqueness is enforced
  with a short suffix. The session's adapter runs with that worktree as its cwd.
- **In-place mode** — `worktree.enabled = false` (or `loom run --in-place`)
  runs the session directly in the repo working dir instead: no branch
  isolation, concurrent sessions can collide, and hard fork is unavailable
  (undo still works). The Detail pane shows the repo's own git state. Bare
  repositories require worktrees and reject in-place sessions. Their configured
  base branch (or fallback `HEAD`) belongs to the bare repository, regardless of
  which worktree you launch Loom from.
- **Distinct commit identity** — `git config --worktree user.name/email` set to
  `Loom (<model>) <loom+<model>@localhost>` (e.g. `Loom (claude-sonnet-5)`) so
  tool commits are never confused with yours and say which model ran them.
- **Pre-push guard** — a worktree-scoped `core.hooksPath` with a `pre-push`
  hook that hard-fails. Loom runs no remote operations itself.
- **Git facts on every snapshot** — branch, commit count, ahead/behind base,
  dirty/clean, last commit subject (cached ~2s).
- **Auto-rebase** — `auto_rebase.enabled = true`: whenever a session goes
  idle and its base branch has moved, the daemon replays the branch onto the
  new base (`mode = "merge"` for a merge commit instead). A clean update is
  silent bar an operator notice; a conflict — or an uncommitted worktree —
  leaves the tree untouched and sends the agent a message to integrate the
  base itself, once per base commit. Never fetches: it reacts to the local
  base ref moving. Off by default.
- **Commit reminder** — `commit_reminder` (on by default): when a session goes
  idle with uncommitted changes in its worktree, the daemon sends the agent a
  one-off message suggesting it commit. One reminder per commit boundary — a
  tree left dirty on purpose stops nagging until the next commit. Never commits
  anything itself; in-place sessions are exempt.
- **Archive (`done`)** — stops a session and removes its worktree, so in git the
  branch just looks like any other branch. The row, the branch, and the stored
  transcript are kept; messaging the session again checks the branch back out
  into a fresh worktree and resumes on it. A dirty worktree needs `force`.
- **`gc`** — repair sweep: reclaims the worktree of a `done` (or explicitly
  targeted `error`) session whose tree removal failed when it was archived. The
  row and the branch are kept.

**4 · loom MCP server**

- **In-process `loom` server** — mounted into every Claude session (before the
  configured stdio servers), running in the daemon so its tools reach Loom's
  own state. Two tools:
  - **`ask_user`** — the agent puts a question to you and blocks. Surfaces as a
    `question` event → the session goes `awaiting_input` / `question`; you reply
    with `loom answer <id> <reqId> <text>` and the turn resumes.
  - **`commit`** — commits the session's worktree under its
    `Loom (<model>)` identity, no shelling out to git. Returns the short hash,
    subject and diffstat; refuses cleanly when there's nothing to commit.
- **Tool selection** — define host commands in `local_tools.<name>`, separate
  offline VM runtimes in `vm_tools.<name>`, and remote services in
  `remote_tools.<name>`. Select them with `tools`, `vm_tools`, and
  `remote_tools` lists under `session` or `repos[].session`. Definitions
  alone enable nothing; no external tools are selected by default. Selected
  tools are required. Agent VMs reject host tool selections before startup.
  `default_for` declares capability preferences without renaming tools or
  schemas; native tools remain available where supported. See
  [tool configuration and common setups](docs/tools.md).

**5 · terminal UI**

For mosh or terminals with misplaced redraws, run `LOOM_TUI_COMPAT=1 loom`.
This uses full redraws instead of incremental rendering. Leave it unset (or set
it to `0`) for incremental rendering. Mosh is not detected automatically because
it advertises a normal xterm terminal type without a unique environment marker.

- **`loom` with no command** in an interactive terminal — or `loom tui`
  explicitly — opens a full-screen fleet view. It is just another client, with
  reconnect enabled, so the daemon and its sessions outlive it; re-opening
  loads the selected session's newest history page from SQLite.
- **Fleet pane** — sessions grouped by status in fleet-view order, a braille
  spinner on running rows, cost per session, and a `⟢` cache dot that grades
  green → amber → red as the prompt cache nears expiry (blank once it's cold or
  n/a); `↑`/`↓` (or `j`/`k`) moves the selection, and `→` drills into a
  session's live sub-agents & background tasks (`←`/`Esc` backs out, `↑`/`↓`
  picks among the children).
- **Detail pane** — the selected session's status / mode / model, a
  context-window meter, token and cost totals, its worktree's git facts, and any
  messages queued for it. When it's `awaiting_input` a panel spells out exactly
  what's being approved / denied / asked (the command, the file, the question).
- **Event stream** — the normalized harness events for the selected session,
  colourised by kind and word-wrapped to the pane (never clipped — it scrolls).
  While the fleet is drilled into a child, it narrows to just that sub-agent's
  (or task's) own events. `v` toggles `full` ↔ `chat` (conversation only: tool
  traffic folds to `⚙ N
tool calls`, thinking to `· thought for Ns`). `PgUp`/`PgDn` scroll it (`Home`/`End`
  jump to the first line / the live tail; a scrolled-back log stays put as new
  events land rather than chasing the tail), `⇥`
  toggles the fleet list — hiding it gives the session's detail + stream the
  whole width — and `o` opens the pending request — or the session transcript
  (`[time] · role · body`, tool args as `key: value`) — in `$EDITOR` read-only,
  so you can read and copy without fighting the split.

**Keybinding grammar** (full table in [`docs/keybindings.md`](docs/keybindings.md), or press `?`):

| modifier    | means                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| bare key    | act on the selected session, or move                                                                            |
| `Shift`+key | the heavier / structural sibling — `Q` quit-all · `R` restart · `X` delete · `F` fork                           |
| `Ctrl`+key  | text editing only, inside the prompt (`⌃a ⌃e ⌃b ⌃f ⌃← ⌃→ ⌃u ⌃k ⌃w`); `⌃c` quits                                 |
| `Alt`+key   | run a prompt action without leaving it — `⌥e` `⌥o` `⌥p` `⌥x`; `⌥m` (switch model) also acts from the fleet view |
| `⇧⇥`        | cycle the permission mode — on the selection, or inside a prompt (mid-message)                                  |
| `Space`     | the command palette — every action valid right now, fuzzy, with its key                                         |

- **Acting on the selection**, from the verbs the footer offers (the rest live
  in the `Space` palette): `⏎` act on the session — compose a message (running /
  idle / stopped; a stopped session is revived first, so there's no separate
  resume) or take up a pending question / plan; `a` approve a pending permission
  (kept explicit — Enter won't), `d` deny (deny-only — `X` deletes), `c` compact
  the context window (offered once the meter passes half), `i` interrupt, `x`
  mark done. Second-tier, on the palette and `?` help: `⇧⇥` cycle the permission
  mode, `⌥m` switch the model (next turn), `u` undo — rewind an idle session to an
  earlier turn (shows the re-prime cost), `e` rename,
  `y` copy the branch, `o` view the log in `$EDITOR`, `v` full / chat,
  `F` hard-fork into a new session + worktree, `X` delete (behind a confirm;
  `b` there also deletes the branch). `n` starts a new session — the prompt
  shows the provider / model and `⌥p` changes them; `/` filters the fleet in
  place — type to narrow the list (ranked: titles first, then your messages,
  then the agent's; `'text` pins a literal substring), `↑↓` keep moving the
  selection, `enter` accepts, `esc` clears.
  Sending to a session that's still working: `Enter` sends now, `⌥⏎` queues it
  for when the turn ends. On an aisdk session "sends now" splices the message
  into the running turn right after the current tool result (the model sees it
  on its next step); on a Claude session the SDK queues it for the next turn
  boundary. Queued messages drain automatically and `⌥x` (in the send prompt)
  or the palette clears them. In a prompt — and on a picker's filter line — `Ctrl` carries the readline
  motions; `⌥e` hands the text to `$EDITOR` (event log alongside to copy from;
  nothing is sent until you press enter back in the UI), `⌥o` opens just the log
  read-only, `⌥p` picks the provider-model for a new session, `⇧⇥` / `⌥m` change
  the mode / model (a new session's, or — from a send prompt — the one you're
  messaging, live), `↑`/`↓` recall earlier prompts, and a failed submit reopens
  with the text intact.
- **The daemon, from inside** — `R` restarts it (the client respawns one that
  inherits _this_ shell's environment), `Q` quits the UI and stops it; both ask
  first when sessions are live. `q` / `⌃c` just leave the UI. `esc` only backs
  out of overlays — it never quits.

**Permission modes** (`⇧⇥`, or `--mode` on `run`): `manual` prompts for anything
sensitive (the wire / SDK value is still `default`); `plan` keeps the agent
read-only until it presents a plan you approve; `acceptEdits` auto-approves file
edits but still gates commands; `auto` lets the agent proceed on its own but
still stops for anything it judges unsafe (the Claude SDK's own `auto` — not
the flag-gated `bypassPermissions`, which Loom never uses).

**Provider configuration** lives under `providers`, grouped by family:

- `providers.claude` — Claude CLI settings, including `cli_path` and `title_model`.
  Named accounts go in `profiles`, with `config_dir` and optional `color`.
- `providers.codex` — the subscription authenticated by `codex login`.
  Set `cli_path`, `config_dir`, or `builtin_web_search` here; named profiles inherit
  these defaults and may override them. No API key is required.
- `providers.google` / `providers.anthropic` — native API providers. Supply a
  `model` and credentials through `api_key_env` or `api_key`.
- `providers.openai_compatible.profiles.<name>` — endpoints such as OpenAI,
  OpenRouter, DeepSeek, vLLM, and Ollama. Each needs a `base_url`.

For CLI and native API families, omitting `profiles` selects the default account. Named accounts have ids
such as `claude:work` and `codex:personal`; a profile named `default` uses the family
name alone. OpenAI-compatible endpoints use their profile name as their id.

```jsonc
{
  "providers": {
    "claude": {
      "profiles": { "work": { "config_dir": "~/.claude-work" } },
    },
    "codex": {
      "cli_path": "/path/to/codex",
      "profiles": {
        "default": { "config_dir": "~/.codex" },
        "personal": { "config_dir": "~/.codex-personal" },
      },
    },
    "openai_compatible": {
      "profiles": { "local": { "base_url": "http://localhost:11434/v1" } },
    },
  },
}
```

Automatic titles use a cheap default for each provider. Set `title_model` in
that provider's settings to override it. `session.titles.enabled = false`
disables automatic titles. Session behavior belongs under `session`: `worktree`,
`auto_rebase`, `auto_resume`, `commit_reminder`, `titles`, `notify`, `isolation`,
`provider_access`, and the three tool-selection lists. Tool definitions remain
at the top level in `local_tools`, `vm_tools`, and `remote_tools`.

`default_provider` picks which one new sessions use until a session is
actually created — from then on the provider, model, and permission mode it
was created with (or later switched to) become the default for the _next_
`new`, remembered across restarts. Loom persists the transcript itself in
`provider_messages`.

- **10a** — streaming, token usage + price-table cost, cancel, resume.
- **10b** — multi-step tool use. Selected MCP tools connect through
  `@ai-sdk/mcp`; the `loom` `ask_user` / `commit` tools are native. Every tool
  call runs through the same permission gate as Claude: read-ish tools pass,
  edits and commands surface a `permission_request` (or run straight through in
  `acceptEdits` / `auto`). A denied call is fed back as a tool error. A turn
  runs up to 50 tool round-trips per segment — if
  the model is still working when that trips, the turn continues with a fresh
  budget rather than ending; only after five such segments does it stop, with a
  `step_limit` end marker and the session left idle so a message resumes it.
- **10c** — first-party `bash` (now a fresh process per call, with explicit `cwd`
  and the session environment), `edit` (exact then whitespace-insensitive string replacement), and
  `grep` (ripgrep) tools, mounted alongside the MCP + `loom` tools and gated the
  same way. A `web_search` tool joins them when `search` names a backend
  (`brave` / `tavily` / `kagi`) whose key env var is set — `kagi` talks to
  Kagi's hosted MCP server (`mcp.kagi.com`, key as a bearer token) and brings
  `web_fetch` with it: a page's full content as markdown, so a search hit can
  be read in full.
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
  `providers.claude.models` to skip that); all four permission modes work,
  including `auto` (Claude proceeds but still stops for anything it judges
  unsafe — not the flag-gated `bypassPermissions`).

OpenAI-compatible profiles need no `model`: the picker list comes from
`{base_url}/models`, and a new session defaults to the last model that provider
ran (remembered in the db, shown by `loom providers`). A model that has since
dropped out of the endpoint's list is skipped, with a notice. Pin `model` /
`models` only for an endpoint whose `/models` is missing or wrong; `providers.codex`
uses Codex's authenticated catalogue (including each model's maximum context), while the native Google and Anthropic
SDKs still need a `model` (no probe).
`loom config` (also logged at launch) lints the
loaded config — unset key vars, providers whose model auto-detection found
nothing, a
keyless search backend. A first launch with no `~/.config/loom/config.jsonc`
creates a small starter config there. See [the annotated example](backend/daemon/config.example.jsonc) for more settings.

**Context windows.** When the endpoint advertises one on its `/models` rows
(`context_length` on OpenRouter, `context_tokens` on sference, `max_model_len`
on vLLM, `max_input_tokens` on LiteLLM, …) it wins over the built-in per-model
prefix table that otherwise drives the context meter. Endpoints that report
nothing use that built-in table.

**Advertised pricing and names.** `/models` rows that carry per-model pricing
(sference's `input_per_million_usd`, OpenRouter's per-token `pricing`) feed the
provider-scoped fallback estimates, shown with `~`. Reported cost always wins.
Rates are fetched at startup, expire after one hour, and refresh on demand. Display names (`display_name`) label the
model picker.

**Streaming usage.** Loom asks endpoints to include token usage in streamed
responses (`stream_options.include_usage`) — without it, endpoints like
sference stream no usage at all and the context meter and cost stay at zero.
Set `include_usage = false` on a provider whose endpoint rejects the field.

**Prompt caching on `anthropic`.** `@ai-sdk/anthropic` sets no cache
breakpoint of its own, so Loom asks for one on every request — the API places
it on the last cacheable block, which caches the conversation so far for the
next turn to read back. `prompt_cache_ttl` on the profile picks the lifetime
(`5m` / `1h`; unset = the API's own default of five minutes, `off` = don't ask,
and pay full input price for the whole history every turn). A 1h write costs 2×
base input against 1.25× for 5m, so it only pays off across gaps longer than
five minutes. The cache gauge, hit rate and `loom cache` work here exactly as
they do for Claude — the TTL comes from the same measured `cache_creation`
split. Ignored by the other backends: OpenAI-compatible endpoints cache
implicitly server-side with no request field to set and no TTL to show, and
Gemini has its own scheme.

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
you saved, `d` discuss (send a note back; the agent keeps planning). The overlay
shows the session's context meter — full context is the argument for `f` — and
the permission mode the implementation will run in; `⇧⇥` cycles it
(manual → acceptEdits → auto), and `i` / `f` / `e` all implement in the mode
shown. `⌥p` retargets `f` (implement fresh) — the provider → model →
thinking-effort wizard, pre-selected to the session's current settings; a
model / effort change rides on the decision, a different provider forks a fresh
session seeded with the plan + goal and parks this one. A long plan scrolls with
`PgUp` / `PgDn` / the mouse wheel (`o` still opens it in `$EDITOR`). `esc` backs
out to the fleet without answering — the review stays pending and `a` re-opens
it. `session.respondPlan` is the RPC (implementing
actions carry the chosen `mode`, and `implement_fresh` an optional
`model` / `effort` / `provider`); `loom plan <id> <reqId>
implement|fresh|revise|discuss [--mode M]` from the CLI.

**Plan usage.** No session is cost-capped — Loom has no way to know what a
provider or account should be spending, so it doesn't invent a number and
call it a limit; the Detail pane just shows the running cost. For a claude.ai
subscription session (not an API key), it also shows the account's rate-limit
windows (`five_hour`, `seven_day`, …) as Claude itself reports them — the same
data behind Claude Code's own `/usage`. API-key / Bedrock / Vertex sessions
have no such window and show nothing here.

**Cost.** Provider-reported cost, including an explicit zero, is authoritative.
When absent, Loom uses fresh prices advertised by that provider's `/models`
endpoint. Prices are isolated by provider, endpoint and credentials; no embedded
or local `models.toml` table participates. `pricing.reload` refreshes endpoint
prices without a restart. An unavailable rate is unknown, not free.

Unknown or incomplete lifetime cost displays as `--`; a known zero displays as
`$0.00`. Estimates and mixed reported/estimated totals carry `~`. The snapshot's
`costSource` is `provider`, `table` (endpoint estimate), `mixed`, `none`, or
`partial` (some spend is unpriced). Stored totals are not retrospectively repriced.
Reported ephemeral cache-write splits can supply the five-minute/hour write
multipliers when the endpoint advertises base input but omits the write rate.

Account-plan readings are stored separately from session spend. Sessions on the
same account/profile share the latest reading, including across daemon restarts.
Readings expire at their reported reset; those without a reset expire after five
minutes. Claude refreshes on initialization and after completed turns, throttled
to once per minute. These are last observed values, not a live account balance.

**Repository configuration.** All configuration lives in
`$XDG_CONFIG_HOME/loom/config.jsonc` (default `~/.config/loom/config.jsonc`).
JSONC supports comments and trailing commas. Each object in the `repos` array
overrides defaults for one project:

```jsonc
{
  "repos": [
    {
      "path": "~/dev/my-project",
      "base_branch": "main",
      "session": {
        "worktree": {
          "enabled": true,
        },
      },
    },
  ],
}
```

Matching resolves both the launch path and `repos[].path` to the same Git repository
identity, including symlinks and subdirectories. For a bare repository, prefer its
own path (for example `/project/.bare`); paths to its linked worktrees also match
that repository. Multiple entries resolving to the same root are duplicates.
Independent nested repositories remain separate. Missing paths can stay configured.
Nested objects merge with global defaults; arrays replace them. Malformed repo
entries are errors. Update the path if you move a repository. Only the user config is
watched for reloads; settings that require a daemon restart still report that.
Repository-local config files are not read or created. `.loom/LOOM.md` remains
available for project instructions.

**Session isolation.** `session.isolation.enabled = true` defaults every provider to VM
execution. Set `repos[].session.isolation.enabled = false` in a `repos` array entry to run
that project locally. Unlisted repositories inherit the global default (Local
when omitted).
In the new-session prompt, `⌥i` switches VM/Local; the CLI equivalent is
`loom run --isolation local <prompt>` (or `--isolation vm`). VM selection requires
a configured or package-bundled runtime. A disabled default still permits an
explicit VM choice when that runtime is available.

The fleet and Detail pane show `[VM]` or `[Local]`. Each session keeps its choice
through restart, resume, and archive/reopen, even when the default changes.
Local execution can still use a Git worktree; VM execution requires one.
To change an existing session's environment, press `F` to fork, then `i` to change
the inherited isolation before confirming. Cross-environment and native-provider
forks start a fresh session with saved conversation context, rather than importing
native history. Existing sessions are classified from saved VM state when upgrading.

**Hooks (`hooks` array).** Commands run asynchronously in the session's worktree.
Declare them in `~/.config/loom/config.jsonc`. Use `repos` array overrides or the
hook’s `project` field to scope them; override arrays replace global arrays.
Changes hot-apply; changing hooks cancels old runs and clears their feedback state.

| key       | meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `kind`    | `"notify"` (default) never messages the agent; `"check"` sends failures back      |
| `on`      | event or list; checks accept only `file_write` and `turn_end`                     |
| `run`     | command passed to `sh -c`                                                         |
| `name`    | optional display label, defaults to the command's first word; duplicates are fine |
| `project` | repo-root glob, with `~` expansion; empty means every repo                        |
| `match`   | path glob or list, matched against absolute and worktree-relative paths           |
| `timeout` | seconds; default 30, clamped to 1–600                                             |

`file_write` runs once per successfully written path. Each hook runs serially:
if another write arrives while it runs, that path is retained for a later run.
Repeated pending writes to the same path collapse into one run. This is
asynchronous: it does not hold the agent's next tool call until formatting ends.
`turn_end` carries the turn's written paths, including an empty list when no
files were written. Pending turn-end runs merge their path sets. A `match`
filter excludes events without matching paths.

Notifications also accept `waiting` (any blocked reason), `permission`,
`question`, `plan_review`, `user_question`, `error`, and `interrupted`.
Subscribing to both `waiting` and a specific reason delivers both events.
`match` only applies to write events.

Environment: `LOOM_HOOK`, `LOOM_HOOK_EVENT`, `LOOM_SESSION_ID`,
`LOOM_SESSION_TITLE`, `LOOM_SESSION_PROVIDER`, `LOOM_SESSION_MODEL`,
`LOOM_SESSION_STATUS`, `LOOM_WORKTREE`, `LOOM_BRANCH`, `LOOM_REPO_ROOT`,
`LOOM_AWAIT_REASON`, `LOOM_DETAIL`, and `LOOM_MESSAGE` (a toast summary).
`LOOM_FILES` is newline-separated; `LOOM_FILE` is the first path and is the
single changed path for `file_write`. Quote shell variables normally.

A failed check sends bounded command output to the agent. Repeated identical
output is suppressed; at most three failure messages are sent per hook and
session until a successful run resets the limit. Notification failures only
raise an operator notice. Interrupting, closing, or removing a session cancels
its outstanding runs and feedback. Entering a human-input wait cancels pending
runs before firing waiting notifications. Timeouts and cancellation kill the
command's process group.

Write detection covers Claude's editors, aisdk `edit`, tilth write/edit, and
ChatGPT file changes. Arbitrary shell commands are not inspected for writes.

```jsonc
{
  "hooks": [
    {
      "kind": "check",
      "on": "turn_end",
      "match": ["**/*.ts"],
      "run": "deno task lint",
    },
    {
      "on": ["waiting", "turn_end"],
      "run": "notify-send \"loom\" \"$LOOM_MESSAGE\"",
    },
    {
      "kind": "check",
      "on": "file_write",
      "project": "~/dev/loom",
      "run": "oxfmt \"$LOOM_FILE\"",
    },
  ],
}
```

Invalid hook kinds, events, and missing commands are rejected. An invalid
reload keeps the running configuration and reports the error.

**Session titles.** A session's title starts as its first message clipped to 200
chars; after a successful turn the daemon tries to replace it with a 4–6 word
summary through the same provider (`titles` config, off with `enabled = false`).
Failed requests retry after later successful turns; completed titles survive
daemon restarts. A generic `loom/<id>` branch is named from the generated title,
or the existing title if generation fails. Branch rename failures retry without
regenerating a completed title. Descriptive branch names stay stable. Renaming
the title yourself pins it and also names a still-generic branch.

**Prompt-cache liveness.** The Detail pane shows `cache ⟢ warm ~47:12 · last
turn hit` (green) or `cache ⟢ cold` once the window lapses, and each fleet row
carries a `⟢` dot graded green (>⅓ of the TTL left) → amber → red (<8%). The
countdown runs from the last turn against the TTL the provider was last seen
_actually_ writing at — Loom reads the ephemeral bucket back off the response's
`usage.cache_creation`, so the timer is measured, not assumed. Until the session
has written cache once it falls back to the configured
`providers.claude.prompt_cache_ttl` (unset by default — the CLI decides, 1h on
a subscription within its usage limits and 5m on an API key, Bedrock, Vertex or
Foundry) and the cache line says `· ttl assumed`; unset and unmeasured, the row
is hidden entirely. Setting the knob pins `CLAUDE_CODE_PROMPT_CACHE_TTL`, but a
pin is only a request — the same platforms can serve a 5m cache anyway — so when
the measured TTL disagrees with the configured one, the daemon says so once.
`last turn hit` / `rewrote` is the ground truth from that turn's cache
read/write split. It's still an estimate — a context edit, a tool-list change,
or server-side eviction drops the cache regardless of the clock. Switching a
session's model or provider (`⌥p`) forgets the measurement: cache entries are
scoped to a provider+model pair, so the new one starts cold and unmeasured
rather than inheriting a countdown it cannot hit.

Note the knob covers the _main conversation_ only. Subagents, workflows and
background helpers run on the CLI's separate `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`
knob (5m unless `ENABLE_PROMPT_CACHING_1H=1`); Loom does not set it, and the
countdown does not model it.

**Keep-warm.** For any session with a known TTL — Claude, or `anthropic` once
it has written cache once — the `Space` palette's _keep cache warm_ toggle has
the daemon babysit the cache: while the session sits idle and its cache is about
to lapse (the `⟢` dot's red band, <8% of the TTL left, widened to a minute on a
short TTL so the 30s sweep cannot step over it), the daemon sends a one-line
"no-op" turn to re-read the cached prefix and restart the clock, so the next real
message still hits cache. Each ping is a real (cheap) turn and lands
in the transcript; it gives up after six pings with no reply from you, and any
message you send resets that count. The Detail pane's cache line shows
`· keep-warm` while it's on.

**Cache effectiveness.** The Detail pane's `tokens` row ends with
`· 87% cached` — the share of prompt tokens the session served from cache over
its life (cache reads over reads + writes + uncached input). `loom cache`
(`loom cache <id>` for one session) breaks the same spend out per
provider+model, with the read/write split and the prompt-cache TTL each pair was
last observed writing at; a session that switched models blends into one row in
the pane but stays separate here. A long session sitting at a low hit rate means
something is invalidating the prefix between turns.

Each row also carries `≥Nm warm`: the longest observed gap followed by a cache
hit, rounded down. Only prompt-usage observations move that clock; context
updates and turn bookkeeping do not. `minMissGapSec` in `loom cache --json`
records the shortest gap followed by a miss after observed cache activity.
Neither is a guaranteed TTL: misses can mean prefix changes or eviction, and
aggregated turn reports can include fresh writes followed by hits. The figures
are observational evidence, kept per session/provider/model and aggregated for
comparison. They do not drive the cache countdown.

**Context compaction.** `c` on a running or idle session opens a one-line prompt
— blank gives a best-effort summary of everything; text is the advanced path,
steering what the summary keeps (e.g. `keep the plan, drop the investigation`) —
or `loom compact <id> [steer…]`. It drives the provider's own compaction: for
Claude, `/compact` over the streaming input (Loom tracks the wait and ticks the
heartbeat itself — the CLI reports no progress); for aisdk sessions, a Loom-side
summariser. Summarising a long history takes a while, so both tick a
`compact_progress` heartbeat — the Detail pane shows `⇊ compacting… Ns` and the
Fleet row a `⇊` dot — with a 15-minute hard ceiling, and the indicator is
snapshot-backed: close and reopen the TUI (or open a second one) mid-compaction
and it's still there. While it runs, the session's op gate is held — sends
bounce with `busy` and the TUI queues them until the boundary lands. When the
boundary lands it
shows in the event log as `⇊ context compacted 154k → …`; the context meter
re-measures on the next turn. `session.compact` is the RPC.

## Requirements

- **Deno ≥ 2.2** (native TypeScript + JSX, no build step, no loader). Source
  uses `node:sqlite` (Deno's own native implementation, exposed under the
  Node-compatible module name — nothing to migrate there). The daemon's
  Unix-socket IPC runs on `Deno.listen`/`Deno.connect({ transport: "unix" })`
  directly, and `process.*` has been fully replaced with `Deno.*`
  equivalents — `node:child_process` and a handful of other `node:*` modules
  (`fs`, `path`, `os`, `crypto`, `util`) are the only Node-compat surface
  left, used the same way idiomatic Deno code uses them.
- `git` on `PATH`.
- For the `claude` provider: Claude OAuth already set up in `~/.claude`. The
  `@anthropic-ai/claude-agent-sdk` dependency bundles the Claude Code CLI it
  drives.
- The TUI is built with Ink (React for terminals) — the one place Loom leans on
  a UI framework, and the one place JSX shows up (`.tsx`). Deno transpiles it
  natively, no build step. Workspace packages import each other as bare
  specifiers (`@loom/core/paths`) resolved by each member's `deno.json` name —
  no `node_modules` symlink walk.

```sh
deno install
```

Deno's module cache (`DENO_DIR`, `~/.cache/deno` by default) hard-links into
every project's `node_modules` from one shared, content-addressed store, with
no extra config — so a fresh git worktree's `deno install` is near-instant and
near-free on disk, the same property `pnpm`'s `virtualStoreType: global` used
to need spelling out explicitly.

**Providers ship as separate workspace members** under `connectors/` — `deno
install` at the repo root still resolves every one of them regardless of which
you actually use. Deno's workspace model has no equivalent to npm's
`optionalDependencies` for skipping unused ones; `ProviderRegistry` still loads
each connector's code lazily by name at runtime, so an unconfigured provider's
module never actually executes, but its dependencies do land in
`node_modules`. Accepted gap, not silently worked around.

## Usage

Everything is driven through `loom`; the daemon starts automatically on first
use and writes to `<repo>/.loom/`.

```sh
loom                  # no command in a TTY → the fleet UI  (or: deno task loom)
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
loom done <id>                  # archive: stop it, drop the worktree, keep the branch + chat
loom gc --force                # repair sweep for worktrees an archive left behind
```

Each session gets its own worktree under `.loom/trees/<id>` on a
`loom/<id>` branch, committed under a `Loom (<model>)` identity, with pushing
blocked. Integrate the branch yourself, in your own git — Loom never does.

Repo-specific steering goes in `.loom/LOOM.md` — init commands, how to
typecheck, house conventions. When present, its content is injected into every
new session's system prompt.

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
deno task typecheck    # deno check . across the workspace
deno task test          # node:test-authored suite run under deno test — 634 cases
deno task test:silent   # same suite; prints only failures
deno task test:timing   # per-file duration table (deno test has one process, not
                         # one child per file, so there's no wall-vs-Σ overlap ratio)
```

### Layout — a Deno workspace

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
  chatgpt/           @loom/connector-chatgpt    ChatGPT/Codex OAuth subscription
  generic/           @loom/connector-generic    OpenAI-compatible + native Anthropic
  gemini/            @loom/connector-gemini     Google Gemini (@ai-sdk/google)
cli/                 loom           the `loom` + `loomd` bins; builds the connector manifest
harness/             @loom/harness  makeHarness — a private devDependency of the tests
test/                the cross-package integration suite (`node:test`, run via `deno test`)
```

`ProviderRegistry` loads a connector lazily by package name from a manifest the
CLI supplies — the daemon names connectors only as strings, so it never
evaluates a model SDK it isn't configured to use, even though `deno install`
resolves every connector's dependencies up front (see Requirements above).
See [`docs/connectors.md`](docs/connectors.md) for the `createProvider` contract.

### `.loom/` runtime directory

Created in whatever repo the daemon runs against; the runtime state is
gitignored:

| path             | what                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `daemon.sock`    | the client↔daemon Unix domain socket                                    |
| `daemon.pid`     | single-instance guard                                                   |
| `daemon.log`     | rolling daemon log (JSON lines)                                         |
| `loom.db`        | SQLite: sessions, history, usage                                        |
| `trees/<id>/`    | one git worktree per session                                            |
| `hooks/pre-push` | the push-blocking hook, shared by every worktree                        |
| `models.toml`    | legacy price table; no longer used for runtime costs                    |
| `LOOM.md`        | optional repo instructions, injected into every session's system prompt |

To enable the repository pre-commit checks locally:

```sh
deno task prepare
```

The hook runs `deno task format:check` and `deno task lint`.

### Config editor support

Keep this property at the top of `~/.config/loom/config.jsonc`:

```jsonc
{
  "$schema": "./config.schema.json",
}
```

At startup, Loom generates `config.schema.json` from its Zod definitions in
`$XDG_CONFIG_HOME/loom` (default `~/.config/loom`). The schema is refreshed even
when a config already exists; existing config contents are preserved.
Editors with JSON Schema support use it for property completion, allowed values,
and inline diagnostics. It works offline; in VS Code, use **JSON with Comments**
for the file's language mode. Other editors need their JSON language server enabled.

The schema describes config inputs; runtime checks still resolve paths, provider
availability, and relationships between settings. Contributors regenerate it from
Zod with `deno task config:schema`. Tests check that the reference schema is current; startup generation needs no packaged schema file.
