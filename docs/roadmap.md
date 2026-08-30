# Loom — build plan after milestone 5

Status: milestones 1–5 shipped (daemon, Claude adapter, worktree manager, loom
MCP server, terminal UI). This doc plans the next five:

| # | milestone | size | depends on |
|---|-----------|------|------------|
| 6 | Context compaction | S–M | — |
| 7 | The trio — LLM titles · price-table cost · budgets | S (one pass) | — |
| 8 | Plan review | M | 6 (real "implement fresh") |
| 9 | Sub-agent nesting | M | — |
| 10 | Non-Claude providers (Vercel AI SDK) | L | 6 (non-Claude context mgmt mindset) |

Compaction moved to the front (user, 2026-08-28): it's self-contained, it
unblocks the good version of plan review's *implement fresh*, and it forces the
"manage context without the SDK owning it" thinking that milestone 10 needs. The
trio is independent and tiny, so it could sit either side of 6 — kept second as
a visible quick win.

**On "the spec":** the `design spec §N` references sprinkled through the code
comments (`§3`, `§11.4`, …) do **not** point at any committed document — there
is no external spec. The design is whatever the user specifies in conversation.
This roadmap, plus `README.md`, is the written spec for milestones 6–10. (The
stale `§N` comments can be cleaned up opportunistically as each file is touched.)

---

## Milestone 6 — context compaction ✓ shipped

**Goal.** Explicitly compact a running session's context when its window fills
(the meter in `Detail`), and show when it happens.

**As built.** `AgentSession.compact(instructions?)` on the seam;
`ProviderCapabilities.compaction` flags harness-driven vs. Loom-rebuilt. The
Claude adapter pushes `/compact [instructions]` onto the streaming input; the
mapper turns a `compact_boundary` system message into `CompactEvent { trigger,
before, after, summary? }` (`after` is 0 until the next turn re-measures).
`session.compact` RPC → `SessionManager.compact` forwards and leaves status to
the stream. TUI: `c` (offered once `contextUsed/contextLimit > 0.5`), logged as
`⇊ context compacted …`. CLI: `loom compact <id> [steer…]`.

**SDK surface.** No dedicated `compact()` on `Query`. Compaction is driven by
sending `/compact [instructions]` as a user message on the streaming input;
`PreCompact` / `PostCompact` hooks fire and a `SDKCompactBoundaryMessage`
(system message, `subtype: "compact_boundary"`, with `compact_metadata`) marks
the boundary. `PostCompact` carries `compact_summary`.

**Changes.**

- `AgentSession.compact(instructions?: string)` on the seam — the Claude adapter
  sends `/compact` (+ instructions) via the same channel as `send()`.
- Adapter listens for the `compact_boundary` system message → emit a new
  `CompactEvent { type: "compact"; before: number; after: number; summary?:
  string }` (context tokens before/after). Status is unaffected.
- Daemon: `session.compact { id, instructions? }` RPC; `SessionManager` forwards
  to the live adapter.
- TUI: `c` on the selected session compacts it. When `contextUsed /
  contextLimit > 0.7` the meter goes amber and the footer hints `c compact`; a
  compact event logs as `⇊ context 120k → 24k`.

**Feeds milestone 8.** `implement fresh` = `compact("Keep only the approved plan
and the original goal; drop the investigation.")` then allow `ExitPlanMode`.

**Files.** `src/provider/types.ts` (`compact` on `AgentSession`),
`src/provider/claude/adapter.ts` + `map.ts`, `src/protocol/events.ts`
(`CompactEvent`), `src/daemon/{daemon,session-manager}.ts`, `src/cli/loom.ts`
(a `compact` command), TUI, README.

**Spike first.** Confirm the bundled Claude Code CLI accepts `/compact` over the
SDK streaming input and that the `compact_boundary` message surfaces with
`includePartialMessages: false` (it may need `includeSystemMessages` or similar).

---

## Milestone 7 — the trio

Three small features that all hang off the **usage rollup** in `SessionManager`
(`#trackUsage` / the `onUsage` hook) plus the `result` event, so they land in
one branch / three commits.

### 7a · LLM-generated session titles ✓ shipped

Built as planned: `src/daemon/titler.ts` (`cleanTitle` + `generateTitle`), a
`onResult` manager hook, `Daemon.#maybeAutoTitle` fired after the first
successful turn, a `title_locked` column (migration 2) set by `session.setTitle`.
`CreateSessionOptions.oneShot` + `ProviderCapabilities.oneShot` gate it.


**Goal.** Replace `title = prompt.slice(0, 200)` with a 4–6 word summary after
the first turn, unless the user has renamed the session.

**Mechanism.** After a session's first `result` (turns === 1), if
`title === prompt.slice(0, 200)` (untouched since creation), the daemon runs a
throwaway one-shot through the *same provider*: a fresh `query()` with
`maxTurns: 1`, no MCP, no tools, cheap model, prompt =
`"Summarise this coding task in 4–6 words, no trailing punctuation:\n<prompt>"`.
On success → `registry.setFields(id, { title })` + `emitSessionUpdated`.

**Config.** `[titles] enabled = true`, `[titles] model = ""` (empty → a
per-provider cheap default, e.g. a Haiku for `claude`).

**Guard against clobbering a manual rename.** `session.setTitle` already exists;
the auto-titler only fires while the title is still the verbatim prompt slice.
(If that proves fragile, add a `title_locked` column set by `session.setTitle`.)

**Non-Claude providers.** Skip silently if the provider exposes no cheap
one-shot path (checked via a new `capabilities.oneShot?: boolean`).

**Files.** `src/daemon/session-manager.ts` (hook the result), a small
`src/daemon/titler.ts`, `src/config/config.ts` (`[titles]`), README.

### 7b · Price-table cost ✓ shipped

Built as planned: `src/config/pricing.ts` (`loadPriceTable` / `parsePriceTable`
/ `costOf`), computed in `Daemon.#priceUsage` on the usage rollup, `costSource`
(migration 3, `usage.cost_source`) on the snapshot, `pricing.reload` RPC, `~`
prefix in the Detail cost line.


**Goal.** Compute cost from a local per-model price table instead of trusting the
SDK's `costUsd`.

**Table.** Path from `[pricing] table` (default `.loom/models.toml`):

```toml
["claude-sonnet-5"]
input       = 3.00   # USD per million tokens
output      = 15.00
cache_read  = 0.30
cache_write = 3.75
```

**Loader.** `src/config/pricing.ts` — parse + cache at daemon start; a
`pricing.reload` RPC re-reads it. Missing file → empty table (not an error).

**Compute.** In the usage rollup, for a `usage` event with token deltas:
`cost = Σ(delta_k × price_k) / 1e6` from the table row for the session's model.
Fallbacks: table → SDK's `costDeltaUsd` → `0`. Add `costSource: "table" |
"provider" | "none"` to the snapshot so the TUI can show a `~` when estimated.

**Files.** `src/config/pricing.ts`, `src/daemon/session-manager.ts`,
`src/protocol/wire.ts` (`costSource` on `SessionSnapshot`), TUI `Detail`
(`~$1.20` when `costSource === "table"`), `config.example.toml`, README.

### 7c · Budgets ✓ shipped

Built as planned: budget_state column (migration 4), Daemon.#enforceBudget on
the usage rollup (soft → warned, hard → SessionManager.haltForBudget →
interrupted/budget), session.setBudget RPC clears the state, config default cap
applied at session.create. TUI `b` + a Detail budget bar; `loom budget` CLI.

**Goal.** Enforce `[budget]` / per-session `SessionBudget` (`maxTokens`,
`maxCostUsd`, `maxTurns` — already plumbed through `CreateSessionOptions.budget`).

**Enforcement.** After each usage rollup, compare running totals to the budget.
Track `budgetState: "ok" | "warned" | "halted"` on the session row:

- **soft** (`on_breach = "soft"`, the default): first breach → `budgetState =
  "warned"`, a `notice`-worthy `session_updated`; the session keeps running.
- **hard**: first breach → `session.interrupt(id)`, status → `interrupted` with
  reason `budget`, `budgetState = "halted"`.

**Raise the cap.** New RPC `session.setBudget { id, maxCostUsd?, maxTokens?,
maxTurns? }`. In the TUI, `b` on the selected session opens a prompt for a new
`maxCostUsd`; setting it clears `warned`/`halted` and (if halted) offers
`resume`.

**Files.** `src/daemon/session-manager.ts`, `src/daemon/daemon.ts`
(`session.setBudget`), `src/protocol/wire.ts` (`budgetState`), TUI (`Detail`
budget line `$1.20 / $5.00` with a bar; `b` key; footer hint), README.

**Tests.** fake-provider drives usage past a cap → assert `warned` then (hard)
`halted` + interrupt; `session.setBudget` clears it.

---

## Milestone 8 — plan review ✓ shipped

Built as planned. `PlanReviewEvent` + `AgentSession.respondToPlan(id, decision)`
(`PlanDecision` = implement | implement_fresh | revise{plan} | discuss{message}).
The Claude adapter intercepts `ExitPlanMode` in `canUseTool` and emits
`plan_review` instead of `permission_request`; `implement` resolves `allow`, the
other three resolve `deny` and re-drive the session deterministically
(implement_fresh runs `compact` first; revise/implement_fresh then
`setMode("acceptEdits")` + `send`). `session.respondPlan` RPC,
`SessionManager.respondToPlan` + `pendingPlans` set, status-machine
`plan_review → awaiting_input/plan_review`. TUI: `a` opens a `PlanReview`
overlay (`i`/`f`/`e`/`d`, esc inert), a request-panel plan case, `loom plan`
CLI.

**Open questions, resolved:** `plan` mode is not auto-engaged — the user picks
it (`⇧⇥` / `--mode plan`), unchanged. Non-Claude plan-mode enforcement is
deferred to M10 (no non-Claude provider exists yet); the fake provider just
records the decision.


**Goal.** In `plan` mode the agent calls `ExitPlanMode` with the plan text.
Instead of showing that as a generic permission prompt, give it a first-class
review flow.

### Protocol

- New event `PlanReviewEvent { type: "plan_review"; id: string; plan: string }`
  (add to the `HarnessEvent` union; `AwaitReason: "plan_review"` is already
  reserved). Status machine: `plan_review` → `awaiting_input` / `plan_review`.
- New seam method `AgentSession.respondToPlan(id, decision)` where `decision` is
  one of:
  - `{ action: "implement" }` — resolve `canUseTool` `{ behavior: "allow" }`;
    the SDK exits plan mode and proceeds in the same context.
  - `{ action: "implement_fresh" }` — allow, then `session.compact(...)` (M6)
    scoped to keep the plan + goal, so implementation starts on a lean context.
  - `{ action: "revise"; plan: string }` — the user edited the plan; resolve
    `{ behavior: "allow", updatedInput: { plan } }` if the SDK honours
    `updatedInput` for `ExitPlanMode`, else `deny` + `send(<edited plan as an
    instruction>)`.
  - `{ action: "discuss"; message: string }` — resolve `{ behavior: "deny",
    message }`; the agent gets the message and iterates, staying in plan mode.
- Claude adapter: in `canUseTool`, branch on `toolName === "ExitPlanMode"` (or
  the SDK's `exit_plan_mode`) → emit `plan_review` instead of
  `permission_request`; keep the resolver keyed by id like permissions.
- Daemon: `session.respondPlan` RPC; `SessionManager` tracks pending plan
  reviews alongside perms/questions.

### TUI — the post-planning UX (user-specified)

When `awaitReason === "plan_review"`, a prominent overlay shows the plan text,
with four actions:

| key | action | what it does |
|-----|--------|--------------|
| `i` | **implement** | accept, agent continues in this context |
| `f` | **implement fresh** | accept, then compact to plan + goal before implementing |
| `e` | **edit plan** | open the plan in `$EDITOR`; **`:w` sends the revised plan** back (`respondPlan {action:"revise"}`), `:wq` returns |
| `d` | **discuss** | opens a message prompt; your text goes back to the agent (`respondPlan {action:"discuss"}`) to change the plan or redirect |

`⌃o` opens the plan read-only (as elsewhere). `esc` does nothing here (a plan
review must be answered) — `i`/`f` move forward, `d` to talk.

### Open questions (confirm with the user before building)

- Does `plan` mode auto-engage on session start, or only when asked?
- Non-Claude providers have no built-in plan mode — Loom would enforce it in a
  pre-tool hook (block mutating tools until a "present plan" tool is called).
  Confirm that's the intended shape.

---

## Milestone 9 — sub-agent nesting ✓ shipped

Built as planned. The Claude mapper synthesises subagent_started (on a `Task`
tool_use, name from `subagent_type` / `description`) and subagent_stopped (on
the matching tool_result). SessionManager keeps a per-session
Map<subagentId,{name,startedAt,active}> and exposes subagentsOf(); an
onSubagents hook re-emits session_updated. Daemon.#enrich overlays
`subagents: {id,name,active}[]` onto the snapshot (runtime-only). TUI: a Detail
line `⑂ N/M sub-agents · names` and a dim `⑂name` prefix + hanging indent on
sub-agent log rows (LogLine.agentId).

**Goal.** Make the sub-agents a session spawns (Claude's Task tool / defined
agents) visible.

**What exists.** `SubagentStartedEvent { subagentId, name }`,
`SubagentStoppedEvent { subagentId }`, and `HarnessEventBase.agentId` tags every
event with its sub-agent. The Claude mapper already sets `agentId` from
`parent_tool_use_id`.

**Changes.**

- `SessionManager` keeps a per-session `Map<subagentId, { name, startedAt,
  active }>` from the started/stopped events; expose it on the snapshot as
  `subagents: Array<{ id, name, active }>`.
- TUI: `Detail` shows `⑂ 2 sub-agents · reviewer, tester`. Event-log rows for a
  sub-agent get its name as a dim prefix / one level of indent.
- Optional: a tree view (fullscreen, like the event log) grouping events by
  agent. Defer if it bloats the milestone.

**Note — two kinds of nesting.** (a) SDK sub-agents *within* one Loom session
(this milestone). (b) Loom **child sessions** (`parentId` on the session row,
used by future explicit spawns). Keep them distinct in the UI: sub-agents live
inside a session card; child sessions are their own rows with a parent link.

**Files.** `src/daemon/session-manager.ts`, `src/protocol/wire.ts`
(`subagents` on `SessionSnapshot`), TUI `Detail` + `EventLog`, README.

---

## Milestone 10 — non-Claude providers (Vercel AI SDK)

**Full plan: [`m10-plan.md`](m10-plan.md).** M10a–e shipped — milestone 10 complete.

The original sketch here was an **ADK adapter**, on the assumption that TS
`@google/adk` carries Python ADK's `LiteLlm` wrapper for OpenAI-compatible
endpoints. A spike (2026-08-29, `@google/adk@2.0.0`) killed that: no `LiteLlm`,
no OpenAI/Anthropic model backend (Gemini/Vertex only), and 155 MB / 114
transitive packages. Details in `m10-plan.md` §"Why not ADK".

**Direction now.** Full tool parity for non-Claude providers, built on the
**Vercel AI SDK** (`ai@^5` + `@ai-sdk/openai-compatible@^1`), which reaches GLM /
DeepSeek / OpenRouter / vLLM / Ollama via `createOpenAICompatible`. Loom owns the
loop policy, permission gate, compaction, and message persistence; the SDK does
model I/O, tool-call plumbing, and MCP transport. Tools: official MCP servers
(`server-filesystem`, `-git`, `-fetch`) plus two hand-built ones (a
persistent-shell Bash, a fuzzy-match Edit). Sub-milestones M10a–e (skeleton →
MCP → hand-built tools → modes/compaction/subagents → provider/model switching
UX).

`[providers.adk]` config stub is retired; `[providers.<id>]` gains an `adapter`
key (`"claude"` | `"aisdk"`) and the registry builds its factory map from
config-declared provider profiles.

**M10a — shipped.** aisdk profiles + `default_provider` in config;
`src/provider/aisdk/` (`adapter`, `session`, `loop`, `map`, `store`, `tokens`);
single tool-free `streamText` step per turn; `fullStream`→`HarnessEvent` with a
cached-token split; `interrupt` via `AbortController`; transcript in
`provider_messages` (migration 6), reloaded by `resumeSession`; one-shot path so
auto-titling covers aisdk. Cost rides the existing price-table path.

**M10b — shipped.** `@ai-sdk/mcp@^0.0.31` client (`mcp.ts` `McpHub`: stdio +
HTTP, tool merge, teardown, skip-on-failure); `loom` `ask_user`/`commit` as
native `tool()` defs (`loom-tools.ts`); permission gate + mode filter
(`gate.ts`: readonly/edit name heuristics, `policy`, `wrapToolSet` →
`permission_request`, deny throws so the model sees a tool error); multi-step
turns; daemon mounts loom + MCP for aisdk with an `AISDK_SYSTEM` prompt;
`SessionManager.#trackPerms` clears on `tool_result` only. Verified live against
an OpenAI-compatible endpoint editing a file via the official filesystem MCP
server.

**M10c — shipped.** First-party tools under `src/provider/aisdk/tools/`:
`bash.ts` (persistent `bash` child, sentinel-framed commands, per-command
timeout → kill+reset, output clamp), `edit.ts` (`applyEdit` — exact →
trailing-whitespace-insensitive → dedented tiers, uniqueness check), `grep.ts`
(`rg` wrapper), `builtins.ts` (`BuiltinTools` owns the shell lifecycle).
Mounted for aisdk sessions alongside MCP + loom tools, all gated. Verified live
against an OpenAI-compatible endpoint: model ran a script, edited it, re-ran it.
198 tests.

**M10d — shipped.** `#turnToolSet` filters tools per turn by mode: `plan` keeps only readonly + `ask_user` + `exit_plan`. `exit_plan` emits `plan_review`, blocks on `respondToPlan`, then on approval flips the session to `acceptEdits` and chains a fresh implementation turn (`implement_fresh` compacts first; `discuss` stays planning). Loom-side compaction: `session.compact` + an 0.85·limit auto-trigger run a tool-free summariser, rebuild the history to one message (`store.replaceFrom`), emit `compact`. `task` tool spawns a depth-1 sub-agent (own mapper, `agentId`-tagged events, `subagent_started/stopped`). `capabilities.subagents = true`.

**M10e — shipped.** User-level config at `$XDG_CONFIG_HOME/loom/config.toml`,
deep-merged *under* the per-repo file (`loadConfig(repo, user)` + `deepMerge`).
`providers.list` / `providers.probeModels` RPCs; `ProviderInfo` on the wire.
TUI: `N` runs a provider → model picker before the new-session prompt (`n`
unchanged); `M` live-switches the selected session's model (next turn); `f` is
now find-a-session (fuzzy over title + buffered message text), `F` took the old
log-scope toggle. A generic `PickerState` + `Picker` overlay backs all three.
Fleet-row session ids are coloured by provider (palette auto-assigned in config
order, `color` to override); the Detail `engine · provider / model` line
matches. `loom providers` / `loom models <provider>` CLI. migration-free.

**Lazy vendor loading (post-M10).** `ProviderRegistry` factories use dynamic
`import()`, so a Claude-only daemon never evaluates `ai` / `@ai-sdk/*` and an
aisdk-only daemon never evaluates `@anthropic-ai/claude-agent-sdk` — smaller
attack surface, faster start. `registry.get()` is now `async`;
`commitInWorktree` moved to the SDK-free `src/provider/commit.ts`.
`test/lazy-providers.test.ts` asserts it via a `module.registerHooks` resolve
hook.

**Native Google + Anthropic (post-M10).** An aisdk profile takes
`sdk = "openai" | "google" | "anthropic"` (default openai). One session class;
`resolveModelFactory` in `aisdk/adapter.ts` dynamically imports just the one
`@ai-sdk/*` the profile needs (so Gemini's dep tree only loads if configured).
`google` / `anthropic` profiles don't need a `base_url`.

**Resume re-mounts MCP servers (post-M10).** `SessionRef.mcpServers?`; the
daemon's `session.resume` passes `#mcpHandles()`; both adapters use
`ref.mcpServers ?? []` instead of a hardcoded `[]`. A resumed session gets its
configured `[[mcp]]` servers back, not just the `loom` tools.

**Undo — fork-tree F1 (post-M10).** Full plan in
[`fork-tree-plan.md`](fork-tree-plan.md); the interactive tree was parked
(doesn't fit a code harness), leaving `undo` + a later `hard fork`. F1:
migration 7 (`checkpoints` + `sessions.fork_turn`), a checkpoint per `result`,
`AgentSession.rewind(keep)` + `capabilities.rewind` (aisdk only for now),
`session.checkpoints` / `session.rewind` RPCs (with a server-side re-prime cost
estimate), TUI `u` undo picker, `RewindEvent`. Conversation-only — the worktree
is left as-is.

**Hard fork — fork-tree F2 (post-M10).** `session.fork` (aisdk): a new session
row (`parent_id` + `fork_turn`), a worktree off the parent's branch, the
transcript copied over. `⌃f` in the TUI; the fork shows a `⑂` in the fleet and
`forked from <id> @ turn N` in Detail.

**`web_search` tool (post-M10).** aisdk sessions get a first-party `web_search`
tool alongside `bash` / `edit` / `grep`, mounted only when `[search]` names a
backend (`brave` / `tavily`) whose `api_key_env` var is set — off by default,
and Claude sessions keep their own. `runSearch` normalises Brave
(`GET /web/search`) and Tavily (`POST /search`) to a numbered
title / url / snippet list; the tool is readonly (never prompts). Resolved once
in `ProviderRegistry.#resolveSearch()` and handed to every aisdk provider.

**Mid-turn message injection (post-M10).** The send-choice modal's "asap" is now
"inject now". A `session.send` while a turn is live no longer blocks: aisdk
`AisdkSession` queues it in `#injections`, and `runTurn`'s `prepareStep` splices
it into the messages right after the current tool result (re-applied each step —
the AI SDK drops a `prepareStep` message override after its step) and persists
it in order via incremental `onStepFinish` appends. A message that misses the
last `prepareStep` rides a chained turn. Claude just streams onto `#inbox`; the
SDK queues it for the next turn boundary. Neither path interrupts the stream.
The daemon emits a `user_message` event (`injected: true`) so every client sees
it land; the TUI drops its local echo on that path. `deriveStatus` unchanged —
a send during `running` / `awaiting_input` leaves the status alone. 234 tests.

**Fresh-eyes review pass (post-M10).** Five parallel review agents over the whole
codebase; ~50 findings triaged into 11 commits (`23aa4bf`..`c62a376`). Highlights:
a `bash` spawn failure crashed the daemon (no `error` listener); the permission
gate classed `search_and_replace` / `get_or_create` as read-only so the model
could mutate the fs in plan mode; `#turnRunning` could stick true and wedge an
aisdk session; the send/echo path had a TOCTOU that could drop the sender's own
message; undo after a compaction restored a garbage transcript; a late
permission answer un-interrupted a stopped session; a daemon restart's seq /
version reset was invisible to a reconnecting client (added a hello `epoch`);
`session.fork` / `session.create` leaked worktrees on failure; the TUI editor
overdrew the body on a >8-line paste and overlay keys double-fired on a batched
keypress. Path confinement for the aisdk `edit`/`bash`/`grep` tools in
acceptEdits/auto mode is a known gap, parked by choice — see the note below.
A second round of three agents reviewed that pass's own diff (`d23c35b`) and
caught a handful of regressions it introduced: the `bash -n` pre-check rejected
valid extglob, the synchronous `#turnRunning` claim in `send()` could re-wedge,
the map-flush-on-abort was dead code, `#enrich(git:false)` emitted a git-less
snapshot, and the TUI queue-drain guard could strand an item on a rejected
send. 252 tests.

**Compaction heartbeat + steer (post-M10).** Summarising a long history is a
single completion that can run for minutes, so `session.compact` no longer hides
behind a short RPC timeout. The aisdk session ticks a `compact_progress` event
(elapsed + chars-generated, backing off 2s→10s) for the duration; the TUI shows
`⇊ compacting… Ns` in the Detail pane and a `⇊` in the Fleet row's cache-dot
slot (never logged — it's a bare heartbeat, cleared by `compact` / a fatal
`error` / a resync). The summariser's hard abort and the client's
`session.compact` timeout are both 15 min (`SUMMARISE_TIMEOUT_MS`). TUI `c` now
opens a one-line focus prompt (blank = full compaction) — the RPC and CLI
already took `instructions`. 255 tests.

**Worktree in-place mode + TUI log fixes (post-M10).** `[worktree] enabled =
false` (or `session.create { worktree: false }` / `loom run --in-place`) runs a
session in the repo working dir — no dedicated worktree, `in_place` column
(migration 8), repo-root git facts, hard fork refused (undo still works). Then
three TUI fixes from user feedback: (1) the blank screen after `$EDITOR` — the
manual `clear()`+`rerender()` left Ink's diff state stale; now uses Ink 7.1's
`useApp().suspendTerminal`, handoff moved into `App` (`editor-handoff.ts`). (2)
the event log no longer truncates — every body word-wraps to width, pane
scrolls, wrap memoised. (3) `F` is now `full` ↔ `chat` (tool runs →
`⚙ N tool calls`, thinking → `· thought for Ns`), the "all sessions" log mode is
gone, and `⌃o` writes a `[time] · role · body` transcript with `key: value` tool
args instead of raw log lines / JSON. 264 tests.

---

## Prompt-cache liveness gauge ✓ shipped (post-M9, pre-M10)

User-requested. `[providers.claude] prompt_cache_ttl` (`5m` / `1h` / `""`,
default `1h`); the adapter injects `CLAUDE_CODE_PROMPT_CACHE_TTL` into the CLI
env (which "wins" over settings) so the TTL is known exactly. migration 5 adds
`usage.last_turn_at` / `last_cache_read` / `last_cache_write`, filled from the
per-turn `usage` event in the rollup. `SessionSnapshot.cache = { ttlMinutes,
lastTurnAt, lastRead, lastWrite }` — `ttlMinutes` overlaid by `Daemon.#enrich`
(claude sessions only). Fleet rows carry a `⟢` dot graded by TTL fraction (`cacheHeat`: fresh >0.33, fading, expiring <0.08). `cacheStatus(snapshot, now)` selector →
warm/cold/unknown + a `hit`/`rewrote` read of the last turn's split. Detail
line `cache ⟢ warm ~M:SS · last turn hit`. Estimate only — blind to mid-turn
refreshes, prefix invalidation, server-side eviction.

## Rough sequencing notes

- **6** first: self-contained, small SDK spike, and everything after it benefits
  (8's *implement fresh*, 10's non-Claude context thinking).
- **7** is independent and tiny — one branch, three commits. Could swap with 6.
- **8** builds cleanly once 6 exists. Needs the plan-mode open questions answered.
- **9** is self-contained; slot it wherever it fits.
- **10** is the big one; keep it last and spike the TS-ADK unknowns before
  writing the adapter.

Fork-tree F3 (Claude rewind / fork) is paused on the backlog; mid-turn message
injection shipped post-M10 (see above).

## Backlog (2026-08-29, from the user)

Ordered roughly by value / independence. Items 1–2 are in progress.

### 1 · Compaction polish
- **Heartbeat + no arbitrary timeout** — ✓ shipped (see "Compaction heartbeat +
  steer" above). A `>15 min` hard timeout stays as the real backstop.
- **Steer the summary** — ✓ the RPC/CLI/TUI all take a focus string now.
- **Consequences estimate on the confirm prompt** — before compacting, show
  projected tokens (have `estimateTokens`), the summariser call's cost (needs a
  per-model $/Mtok table — also seeds a general cost readout), and the fact the
  KV cache resets (next turn re-pays full input). The cache line is the point:
  "is now the right time" ≈ "enough cache-warm turns left to amortise a bust".
- A true percentage bar isn't possible for one streamed completion; elapsed +
  generated-chars is the honest signal.

### 2 · Worktree in-place toggle — ✓ shipped
`[worktree] enabled = true|false` (default true) + a per-session `worktree`
boolean on `session.create` (`loom run --in-place` / `--worktree`). Off → the
session runs in the repo working dir: `worktree`/`branch` null, `cwd` = repo
root, `in_place` column (migration 8) set. No branch isolation, concurrent
sessions can collide. Hard fork is refused (needs an isolated branch); undo
(conversation-only) still works. The Detail pane shows the repo's own git
state with an `in-place` tag; `⌃f` explains why it's unavailable. Unblocks
mentor mode. Follow-up if wanted: a TUI new-prompt toggle (no free key under
the current grammar, so left for the CLI + config for now).

### 3 · Mentor / pair mode
A new `SessionMode`. Reuses `gate.ts` `isReadonly` to deny mutating tools
(essentially permanent plan-mode minus the "now produce a plan" framing). System
prompt shift: *you* do the work; the agent explains approach / which files / how
things work, reviews your changes (a "review my diff" affordance running `git
diff`), and never writes unless you explicitly ask or switch modes. Pairs with
#2 (wants in-place by default).

### 4 · External worktree deletion handling
An out-of-band `git worktree remove` / `rm -rf` currently makes the pump error
ugly. Detect worktree-gone on the next git/tool op → mark the session `error`
with a readable reason, offer re-create or archive. Defensive; opportunistic.

### 5 · Named worktree pool + rename on title-gen
Pregenerate a wordlist; assign one memorable name per session as a stable prefix;
when the auto-title job runs also rename the branch to `<name>/<slug>` (`git
branch -m` always, best-effort `git worktree move` — the dir move fails if the
user is `cd`'d in from another terminal). Update `sessions.worktree` + the
`#worktrees` facts cache + push a `session_updated`. Collisions: large pool +
`git branch --list` check, hex fallback when exhausted.

### 6 · pnpm monorepo + plugin packages
The provider seam (`src/provider/types.ts`) was built for this, so it's
repackaging, not rearchitecting — but it's the biggest item and touches config
discovery, `registry.ts`, the test layout, and versioning.
- **Decide the plugin model first:** in-process (`import()` a package exporting
  an `AgentProvider` factory) vs out-of-process (subprocess speaking a protocol,
  MCP-style). Everything today is in-process; go in-process now, leave subprocess
  isolation for untrusted plugins later.
- No-build-step works across a pnpm workspace internally; published packages want
  `.d.ts`, so build only at publish.
- Connectors as packages: `gemini` (google), `claude` (claude sdk), generic /
  openai-compatible (vercel ai sdk), `mock`, `openai` (future). North star: loom
  ships with no connectors and near-zero deps by default.
- `fake` → `@loom/connector-mock`, a real package the tests depend on.

### 7 · Approval-prompt UX (user, 2026-08-29 — "for after") — ✓ shipped (2026-08-30)
- **Request panel at the bottom** — `RequestPanel` renders full-width just above
  the footer (in `browse` / `prompt` modes), where the eye already is for the
  keybinds; body height reserves `REQUEST_PANEL_ROWS` for it.
- **"TUI modes"** — `footerHints(state)` is the one table the footer reads:
  every overlay (`picker` / `confirm` / `plan` / `sendChoice` / `help`) has a
  fixed key set; `browse` delegates to `actionsFor`, which now early-returns for
  `awaiting_input` with just approve/answer/deny + interrupt + globals. ⇧⇥ / M /
  ⌃f are gated on `allowed` so the keymap matches the footer.
- **Starter XDG config** — `scaffoldUserConfig()` copies `config.example.toml`
  to `$XDG_CONFIG_HOME/loom/config.toml` on the first non-standalone daemon
  launch when none exists.

### 7b · More seamless-daemon + TUI polish — ✓ shipped (2026-08-30)
- **Alt-screen exit** — the TUI renders with Ink 7.1 `alternateScreen: true`;
  quitting restores the primary buffer with no half-drawn frame left behind.
- **`d` deletes a session** — new `session.remove` RPC (closes the run, removes
  the worktree — not the repo root for in-place — drops the row + cascades,
  broadcasts `session_removed`). TUI `d` with nothing pending → delete confirm;
  `loom rm <id>` on the CLI. The branch is kept, like `gc`.
- **`loom <cmd> --help`** — per-command `USAGE` blurbs; `loom providers` shows
  `[default]` instead of a `* ` gutter.
- **`[custom-provider.<id>]` + `[google]` / `[anthropic]`** config namespaces —
  the OpenAI-compatible case drops `adapter` / `sdk`; `[providers.<id>]
  adapter = "aisdk"` stays as the escape hatch and wins a duplicate id.
  `custom-provider` is the future plugin seam.
- **Live config reload** — the daemon watches repo + user config.toml;
  `[worktree] enabled` / `[budget]` / `[notify]` / `[titles]` / idle minutes
  hot-apply, anything structural pushes a "press R to restart" `NoticePush`.
- **Version-mismatch auto-respawn** — the TUI bounces the daemon once when
  `daemon.version` != its own `LOOM_VERSION` (rebuild while the old one ran).
- **tilth npx fallback** — `resolveMcpCommand` rewrites a missing `tilth` to
  `npx -y tilth@0.9.0`; falls through to the built-ins if npx is missing too.

### 8 · aisdk provider config conveniences — ✓ shipped (`18305c8`)
- **Auto model detection** — omit `model` + `models` from an openai-sdk profile
  and the daemon probes `{base_url}/models` at start-up (`autoModels`, bounded
  8s, best-effort). `google` / `anthropic` still need an explicit model.
- **Inline `api_key`** — on a profile and `[search]`, alongside `api_key_env`;
  inline wins. `resolveApiKey()` centralises inline → env → "".
- **`lintConfig()`** — logged at daemon start + `config.check` RPC / `loom
  config` CLI: unset key vars, providers pending auto-detect, keyless search.
- Fixed a latent test leak: `makeHarness` now isolates `XDG_CONFIG_HOME` so the
  dev's real `~/.config/loom/config.toml` doesn't merge into test daemons.
- **`N` flow (`6561099`):** the model step always shows after the provider is
  chosen (was skipped when a provider had no model list); an empty picker
  carries an explanatory `emptyText` and Enter continues with just the provider.
- **Permission prompt stuck behind `running` (`a34e1f1`):** a new aisdk session
  making parallel tool calls never surfaced the approval panel. `deriveStatus`
  no longer lets a content event clear `awaiting_input` (some OpenAI-compatible
  providers flush buffered assistant text *after* the `permission_request`); the
  aisdk mapper flushes open text/reasoning on `tool-call` + `finish-step`; and
  parallel requests are handled — `#resumeAfterAnswer` waits for the last, the
  TUI queues pending permissions (`Pending.permissions`) and shows "(1 of N)".

### 9 · Provider / model UX + lifecycle — ✓ shipped (2026-08-30)
From a user brain-dump. 287 → 294 tests.
- **`N` merged into `n`.** The new-session prompt now shows the provider and
  model it will use (`ProviderInfo.defaultModel` on the wire); `⌃P` in that
  prompt walks the provider → model picker and returns to the prompt with what
  you'd typed intact (`PickerState.ctx.draft`). The standalone `N` key is gone.
- **No `model` needed in config.** OpenAI-compatible profiles rely on the
  `{base_url}/models` probe for the list; a new session defaults to the **last
  model that provider ran**, persisted as `default_model:<id>` in the `meta`
  key/value table (`ProviderDefaultStore`, no migration). `session.create`
  (implicit or explicit model) and `session.setModel` both record it;
  `#defaultModelFor()` resolves remembered → config pin → first detected.
  `model` / `models` stay parseable as an optional pin (kept in
  `config.example.toml` as a commented "only if /models is wrong" note).
- **Stale default handling.** A remembered / row model that has dropped out of
  the detected list is skipped: `session.create` emits a `NoticePush` and falls
  back; `session.resume` swaps the row to the current default (notice) instead
  of failing turn 1. `lintConfig`'s auto-detect line now fires only on a *failed*
  probe (moved after `#resolveAutoModels` at start-up) and is worded as an error.
- **`d` can also delete the branch.** The delete confirm carries a `b` toggle
  when the session has a branch (`ConfirmState.branchName` / `deleteBranch`,
  `toggleConfirmBranch` action); `session.remove` takes `deleteBranch` and runs
  `WorktreeManager.deleteBranch()` (`git branch -D`, best-effort) after the
  worktree is gone, returns `branchDeleted`. `loom rm --delete-branch`.
- `loom providers` prints the resolved default model: `<id> [default]  <model>  (N models)`.

## Known gaps (parked)

- **aisdk tool path confinement.** In `acceptEdits` / `auto` mode the
  first-party `edit` / `bash` / `grep` tools run with no `cwd` sandbox — the
  model can read or overwrite files outside the session's worktree (`~/.bashrc`,
  etc). The permission gate is the only control and it's name-based. Deferred by
  choice (2026-08-29); revisit with a real confinement design (reject / prompt
  on out-of-tree paths, or a sandbox) rather than a piecemeal check.
- **Provider credentials are read once** at provider-construction time
  (`registry.#build` / `resolveModelFactory`), so a rotated key needs a daemon
  restart. Consistent across all three read sites; low priority.
- **The `pre-push` hook** installed into session worktrees is `#!/bin/sh`; on a
  host without a POSIX `sh` (native Windows git, no Git-Bash) it can't run and
  the "push is blocked in session worktrees" guarantee silently doesn't hold.
- **`map.ts` treats every stream `error` part as fatal** — a transient/retryable
  provider error tears the aisdk session down instead of surfacing a `notice`.
