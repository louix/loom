# Loom — build plan after milestone 5

Status: milestones 1–5 shipped (daemon, Claude adapter, worktree manager, loom
MCP server, terminal UI). This doc plans the next five:

| # | milestone | size | depends on |
|---|-----------|------|------------|
| 6 | Context compaction | S–M | — |
| 7 | The trio — LLM titles · price-table cost · budgets | S (one pass) | — |
| 8 | Plan review | M | 6 (real "implement fresh") |
| 9 | Sub-agent nesting | M | — |
| 10 | ADK adapter + arbitrary providers | L | 6 (non-Claude context mgmt mindset) |

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

## Milestone 10 — ADK adapter + arbitrary providers

**Goal.** A second provider adapter using the **TypeScript** ADK
(`@google/adk`, `@google/adk-devtools` — both on npm, so this is a normal Node
dependency, no Python sidecar). ADK's `LiteLlm` model wrapper reaches any
OpenAI-compatible endpoint, so "support GLM / DeepSeek / OpenRouter / local
vLLM" falls out of building this — there is no separate "generic provider"
milestone.

**What exists.** `[providers.adk]` config stub (`model`, `auth`),
`ProviderRegistry` has a factory map keyed by id, and the seam
(`AgentProvider` / `AgentSession` + normalized `HarnessEvent`) is provider-
neutral. `defaultId` stays `"claude"`.

### Mapping ADK → the Loom seam

| Loom seam | ADK |
|-----------|-----|
| `AgentProvider.createSession` | build an `LlmAgent` + `Runner` + a `SessionService` session; one runner per Loom session |
| model | `LiteLlm({ model, api_base, api_key })` (OpenAI-compatible) or native Gemini; from `[providers.adk]` + a new `[providers.adk.litellm]` block (`base_url`, `api_key_env`) |
| tools | Loom's `McpServerHandle[]` → ADK `McpToolset`; the in-process `loom` server (ask_user, commit) needs an ADK-native shim or an MCP bridge |
| `events()` | `Runner.runAsync()` yields ADK `Event`s → map: content→`assistant_text`/`thinking`, `function_call`→`tool_call`, `function_response`→`tool_result`, `usage_metadata`→`usage` |
| permissions | ADK `before_tool_callback` → Loom's permission gate → `permission_request`; the callback blocks on the resolver |
| modes (`plan`/`acceptEdits`/`auto`) | ADK has none built-in — implement in `before_tool_callback` (plan = block mutating tools until a plan tool; acceptEdits = auto-allow edit tools; auto = allow all) |
| compaction (M6) | ADK has no `/compact` — Loom summarises the ADK session history itself and rebuilds the session, or leans on ADK's own context management if it has one |
| `resumeSession` | `providerRef` = ADK session id; ADK `SessionService` persistence |
| `setModel` / `setMode` | ADK likely needs a new turn (set `capabilities.liveModeSwitch = false`) |
| `interrupt` | cancel the `runAsync` iterator / ADK run |

**Capabilities.** `{ liveModeSwitch: false, forking: false (initially),
subagents: true, partialTokens: ? , oneShot: true }`.

**Unknowns to spike before committing.**

- Does the **TS** `@google/adk` have parity with Python ADK for `LiteLlm`,
  `McpToolset`, `before_tool_callback`, and session persistence? (The Python one
  definitely does; the TS package is newer.)
- Streaming granularity of ADK `Event`s vs. our `HarnessEvent` expectations.
- How `auto` / `bypassPermissions` semantics translate without an SDK that owns
  a sandbox — Loom may need to own tool execution for non-Claude providers.
- Compaction for a non-Claude provider (see the row above) — probably a
  Loom-side summarise-and-rebuild.

**Files.** `src/provider/adk/` (new: `adapter.ts`, `map.ts`),
`src/provider/registry.ts` (factory entry), `src/config/config.ts`
(`[providers.adk.litellm]`), `package.json` (`@google/adk`),
`config.example.toml`, README.

---

## Prompt-cache liveness gauge ✓ shipped (post-M9, pre-M10)

User-requested. `[providers.claude] prompt_cache_ttl` (`5m` / `1h` / `""`,
default `1h`); the adapter injects `CLAUDE_CODE_PROMPT_CACHE_TTL` into the CLI
env (which "wins" over settings) so the TTL is known exactly. migration 5 adds
`usage.last_turn_at` / `last_cache_read` / `last_cache_write`, filled from the
per-turn `usage` event in the rollup. `SessionSnapshot.cache = { ttlMinutes,
lastTurnAt, lastRead, lastWrite }` — `ttlMinutes` overlaid by `Daemon.#enrich`
(claude sessions only). `cacheStatus(snapshot, now)` selector →
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

Fork / undo tree ([[tui-fork-tree]]) and mid-tool steering are still on the
backlog, after this batch.
