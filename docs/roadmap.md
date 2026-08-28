# Loom — build plan after milestone 5

Status: milestones 1–5 shipped (daemon, Claude adapter, worktree manager, loom
MCP server, terminal UI). This doc plans the next five, in the agreed order:

| # | milestone | size | depends on |
|---|-----------|------|------------|
| 6 | The trio — LLM titles · price-table cost · budgets | S (one pass) | — |
| 7 | Plan review | M | design spec §? (get it into the repo) |
| 8 | Sub-agent nesting | M | — |
| 9 | Context compaction | S–M | — |
| 10 | ADK adapter + arbitrary providers | L | 9 (for "implement fresh") |

**Open cross-cutting item:** the design spec is cited all through the code
("design spec §3", "§11.4"…) but is *not in the repo* — only `README.md` is.
Commit it as `docs/spec.md` (or paste the relevant sections) before milestone 7.

---

## Milestone 6 — the trio

All three hang off the **usage rollup** in `SessionManager` (`#trackUsage` /
the `onUsage` hook) plus the `result` event, so they land together.

### 6a · LLM-generated session titles

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

### 6b · Price-table cost

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

### 6c · Budgets

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

## Milestone 7 — plan review

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
  - `{ action: "implement_fresh" }` — same allow, then trigger a context
    compaction scoped to keep the plan (see M9). Until M9 lands, this instead
    spawns a **child session** (`parentId` set) seeded with `plan + goal`.
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
with four actions (names chosen here — adjust to taste):

| key | action | what it does |
|-----|--------|--------------|
| `i` | **implement** | accept, agent continues in this context |
| `f` | **implement fresh** | accept, but implement with a cleared context (M9) / child session until then |
| `e` | **edit plan** | open the plan in `$EDITOR`; **`:w` sends the revised plan** back (`respondPlan {action:"revise"}`), `:wq` returns |
| `d` | **discuss** | opens a message prompt; your text goes back to the agent (`respondPlan {action:"discuss"}`) to change the plan or redirect |

`⌃o` opens the plan read-only (as elsewhere). `esc` does nothing here (a plan
review must be answered) — `i`/`f` are the only ways forward, `d` to talk.

### Open questions (need the spec)

- Does `plan` mode auto-engage on session start, or only when asked?
- Non-Claude providers have no built-in plan mode — Loom would enforce it in a
  pre-tool hook (block mutating tools until a "present plan" tool is called).
  Confirm that's the intended shape.
- Should `implement fresh` be a compaction or a child session by default?

---

## Milestone 8 — sub-agent nesting

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
used by plan review's "implement fresh" and future explicit spawns). Keep them
distinct in the UI: sub-agents live inside a session card; child sessions are
their own rows with a parent link.

**Files.** `src/daemon/session-manager.ts`, `src/protocol/wire.ts`
(`subagents` on `SessionSnapshot`), TUI `Detail` + `EventLog`, README.

---

## Milestone 9 — context compaction

**Goal.** Explicitly compact a running session's context when its window fills
(the meter in `Detail`), and show when it happens.

**SDK surface.** No dedicated `compact()` on `Query`. Compaction is driven by
sending `/compact [instructions]` as a user message on the streaming input;
`PreCompact` / `PostCompact` hooks fire and a `SDKCompactBoundaryMessage`
(system message, `subtype: "compact_boundary"`, with `compact_metadata`) marks
the boundary. `PostCompact` carries `compact_summary`.

**Changes.**

- `AgentSession.compact(instructions?: string)` — the Claude adapter sends
  `/compact` (+ instructions) via the same channel as `send()`.
- Adapter listens for the `compact_boundary` system message → emit a new
  `CompactEvent { type: "compact"; before: number; after: number; summary?:
  string }` (context tokens before/after). Status is unaffected.
- Daemon: `session.compact { id, instructions? }` RPC.
- TUI: `c` on the selected session compacts it. When `contextUsed /
  contextLimit > 0.7` the meter goes amber and the footer hints `c compact`; a
  compact event logs as `⇊ context 120k → 24k`.

**Ties into M7.** `implement fresh` = `compact("Keep only the approved plan and
the original goal; drop the investigation.")` then allow `ExitPlanMode`.

**Files.** `src/provider/types.ts` (`compact` on `AgentSession`),
`src/provider/claude/adapter.ts` + `map.ts`, `src/protocol/events.ts`
(`CompactEvent`), `src/daemon/{daemon,session-manager}.ts`, TUI, README.

**Open question.** Confirm the bundled Claude Code CLI accepts `/compact` over
the SDK streaming input (spike first).

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

**Files.** `src/provider/adk/` (new: `adapter.ts`, `map.ts`),
`src/provider/registry.ts` (factory entry), `src/config/config.ts`
(`[providers.adk.litellm]`), `package.json` (`@google/adk`),
`config.example.toml`, README.

---

## Rough sequencing notes

- 6 is independent and small — do it first, one branch, three commits.
- 7 needs the spec section in the repo. Its `implement fresh` action degrades
  gracefully (child session) until 9 lands, so 7 before 9 is fine.
- 8 is self-contained; slot it wherever.
- 9 unblocks the *good* version of 7's `implement fresh` and is a prerequisite
  mindset for 10 (non-Claude context management).
- 10 is the big one; keep it last and spike the TS-ADK unknowns before writing
  the adapter.

Fork / undo tree ([[tui-fork-tree]]) and mid-tool steering are still on the
backlog, after this batch.
