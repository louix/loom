# Milestone 10 — non-Claude providers via the Vercel AI SDK

Status: **planning / under review.** Supersedes the "ADK adapter + arbitrary
providers" sketch in `roadmap.md` §10.

## Why not ADK

The `roadmap.md` §10 plan assumed the TypeScript `@google/adk` package mirrors
Python ADK — specifically its `LiteLlm` wrapper for OpenAI-compatible endpoints.
A spike (2026-08-29, `@google/adk@2.0.0`) found:

- **No `LiteLlm`, no OpenAI/Anthropic model backend.** TS ADK model classes are
  `Gemini`, `Vertex`, `ApigeeLlm`, `RoutedLlm` — Google models only. Reaching
  GLM / DeepSeek / OpenRouter / vLLM would mean subclassing `BaseLlm` and writing
  the OpenAI-compatible HTTP + SSE client ourselves anyway.
- **155 MB / 114 transitive packages** — MikroORM (+reflection), 12×
  OpenTelemetry, `@google-cloud/vertexai`, `google-auth-library`, `winston`,
  `adm-zip`. For comparison the Vercel AI SDK adds ~25 MB / ~12 packages, most of
  which (`zod`, parts of the MCP tree) Loom already pulls transitively.
- ADK's genuinely useful pieces here — `MCPToolset`, the context compactors,
  `DatabaseSessionService`, `before_tool_callback` — do not include a Bash /
  file-editor tool suite. The tools, which are the hard part, are still ours to
  build under ADK too.

## Scope decision (2026-08-29, with user)

**Full tool parity.** Non-Claude providers are first-class coding agents, not
"chat + bring-your-own-MCP". That means Loom owns a tool suite for them.

Engine: **Vercel AI SDK** (`ai`). It is the thinnest of the candidates
(vs. `@openai/agents` 70 MB — and it sits on the AI SDK for non-OpenAI models
anyway; vs. LangGraph 63 MB and a churny API; vs. Mastra, an app framework that
wants to own the project). It is pure ESM, ships types, has no decorators or
build step, its `fullStream` parts map almost 1:1 to our `HarnessEvent` union,
and it has a built-in MCP client.

Loom keeps ownership of loop *policy*, the permission gate, compaction, the
message array, and persistence. The SDK does model I/O, tool-call plumbing, and
MCP transport.

## Dependencies

| Package | Notes |
|---|---|
| `ai` | **pinned to the v5 line** (`^5.0.249`, dist-tag `ai-v5`). v6/v7 exist but v5's `LanguageModelV2` usage is a flat `{ inputTokens, outputTokens, cachedInputTokens }` and its `fullStream` parts are stable and well-documented; bump later as a focused upgrade. `streamText`, `stepCountIs`, `tool`, `experimental_createMCPClient`. |
| `@ai-sdk/openai-compatible` | `^1.0.52` (dist-tag `ai-v5`) — `createOpenAICompatible({ name, baseURL, apiKey })` → GLM, DeepSeek, OpenRouter, vLLM, Ollama, OpenAI itself. Dedicated package, cleaner than `@ai-sdk/openai`'s helper. |
| `@ai-sdk/anthropic` / `@ai-sdk/google` | follow-ups, not in M10 |
| `zod` | **already a dependency** (`^4.4.3`) |
| official MCP servers | `@modelcontextprotocol/server-filesystem`, `-git`, `-fetch` — spawned as subprocesses, not linked (M10b) |

Whole trio installs to ~18 MB / 10 packages, most of it shared with what the
Claude SDK already pulls.

No `tiktoken` — context estimate is `chars/4` against a per-model context-window
table (see Compaction).

### `decode` helper — deferred (decided 2026-08-29)

No `Either` / `fp-ts` / `decode` helper for M10. `zod` schemas are used directly
(`safeParse`, fall back to default on failure — the `normalizeConfig` style).
A codec/`Either` refactor across config + provider I/O is a separate later pass.

## Architecture

New package `src/provider/aisdk/`:

| File | Responsibility |
|---|---|
| `adapter.ts` | `AgentProvider` impl; one instance per configured provider *profile* |
| `session.ts` | `AgentSession` impl — owns the `ModelMessage[]`, the `AbortController`, the event queue |
| `loop.ts` | `streamText` call + multi-step loop policy (`stopWhen`, `prepareStep`) |
| `map.ts` | `fullStream` part → `HarnessEvent` |
| `mcp.ts` | `McpServerHandle[]` → AI SDK MCP clients; process supervision |
| `tools/index.ts` | tool registry: hand-built + MCP + the `loom` server shim |
| `tools/bash.ts` | persistent-shell Bash tool |
| `tools/edit.ts` | exact / dedent / unique-substring Edit tool |
| `store.ts` | message-array persistence (SQLite) + resume |
| `tokens.ts` | context-window table + `chars/4` estimate |
| `compact.ts` | Loom-side summarize-and-rebuild |

### Seam mapping

| `AgentProvider` / `AgentSession` | Vercel AI SDK |
|---|---|
| `createSession` | build model (`createOpenAICompatible({ baseURL, apiKey })(modelId)`), seed `ModelMessage[]`, start `loop.run()` |
| `events()` | async queue fed by the `map.ts` translation of `result.fullStream` |
| `send(input)` | push a user message, kick `loop.run()` again |
| `respondToPermission` / `answerQuestion` / `respondToPlan` | resolve the promise the tool `execute` wrapper (or the `exit_plan` tool) is blocked on |
| `interrupt()` | `abortController.abort()` — AI SDK stops the stream and the step loop |
| `setMode(mode)` | swap the active tool filter + gate policy; effective next step |
| `setModel(id)` | swap the model object; effective **next turn** (`capabilities.liveModeSwitch = false`) |
| `compact(instructions?)` | `compact.ts`: summarize the array, replace with `[summary, ...tail]`, emit `compact` |
| `resumeSession(ref)` | reload `ModelMessage[]` from `store.ts` by Loom session id |
| `providerRef` | the Loom session id (we own persistence; there is no upstream session) |

### Event mapping (`fullStream` → `HarnessEvent`)

| AI SDK part | HarnessEvent |
|---|---|
| `text-delta` | `assistant_text` (streamed) |
| `reasoning` / `reasoning-delta` | `thinking` |
| `tool-call` | `tool_call` |
| `tool-result` | `tool_result` |
| `tool-call` for the `Task` tool | `subagent_started` (+ `subagent_stopped` on its result) — reuse M9 |
| `tool-call` for the `exit_plan` tool | `plan_review` |
| `finish` (`usage`, `finishReason`) | `usage` then `result` |
| `error` | `error` |
| step boundary with `finishReason: "length"` near the window | trigger auto-compact, emit `compact` |

### The loop

`streamText({ model, messages, tools, stopWhen: stepCountIs(N), abortSignal,
prepareStep })`. Each tool's `execute` is a Loom wrapper:

1. mode filter — is this tool allowed in the current `SessionMode`?
   - `plan` — mutating tools (Bash-write, Edit, Write, MCP writes) are withheld
     from the tool list entirely; the model is given an `exit_plan` tool. Calling
     it emits `plan_review` and blocks until `respondToPlan`.
   - `acceptEdits` — Edit / Write auto-allowed; Bash still asks.
   - `auto` — everything allowed, no prompt.
   - `default` — every non-readonly tool routes through the gate.
2. permission gate — emit `permission_request`, block on `respondToPermission`.
3. run the underlying tool (hand-built fn or MCP call).
4. return the result (or the denial message) to the SDK.

`prepareStep` is where a queued `setModel` / `setMode` / compaction is applied
between turns.

### Persistence

Loom owns the conversation. New table (migration 6):

```sql
CREATE TABLE provider_messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,   -- JSON: ModelMessage
  PRIMARY KEY (session_id, seq)
);
```

Append on every message; `resumeSession` loads them ordered by `seq`. Compaction
rewrites the tail (delete from `seq >= k`, insert the summary).

(`sessions.model` already exists from migration 1, so migration 6 is just the
`provider_messages` table.)

### Compaction (no SDK `/compact`)

`compact.ts`: run a one-shot summarizer turn (cheap model for the profile, or the
main model) over the current array with a "preserve goal, decisions, open
threads, file paths" instruction; replace `messages` with
`[systemPreamble, {role:"user", content: summary}, ...lastNTurns]`; emit a
`compact` event (`before`/`after` from the token estimate). Auto-trigger when the
estimate crosses `contextLimit * 0.85`.

`tokens.ts`: `MODEL_CONTEXT: Record<string, number>` (gpt-5 ~ 400k, deepseek ~
128k, glm-4.6 ~ 200k, …; fallback 128k) and `estimate(messages) = totalChars/4`.
Rough, but it only gates compaction, and the price table already carries the
exact billed numbers from the `usage` part for cost.

### Caching

OpenAI-compatible endpoints cache server-side automatically (OpenAI ≥ 1024
tokens, DeepSeek always). There is no client-side `cache_control` and no TTL
knob. So for aisdk sessions `cache.ttlMinutes = 0` → the TUI cache gauge already
renders "unknown" (`cacheStatus` guard). Detail can show a static
`cache · provider-managed` line instead. `cachedInputTokens` from the `usage`
part still feeds cost when the endpoint reports it.

### Subagents

The `Task` tool = a recursive `loop.run()` with its own tool set, budget, and a
child event stream tagged with an `agentId`. Emits `subagent_started` /
`subagent_stopped` — the M9 daemon overlay and TUI prefixing work unchanged.

## Tools — parity checklist

| Claude Code built-in | aisdk source |
|---|---|
| Read | `@modelcontextprotocol/server-filesystem` |
| Write | `server-filesystem` (gated) |
| Glob | `server-filesystem` |
| Grep | shell-out to `rg` inside a thin first-party `Grep` tool (deterministic schema) |
| Edit | **hand-built** `tools/edit.ts` — exact match → dedent-normalized match → unique-substring match; returns a unified diff; `replace_all` flag |
| Bash | **hand-built** `tools/bash.ts` — one long-lived `bash` child per session (`node:child_process`), sentinel-delimited command framing so `cwd` / exported env persist between calls; wall-clock timeout; output byte cap; gated |
| WebFetch | `@modelcontextprotocol/server-fetch` |
| WebSearch | out of scope for M10 (needs a search provider; follow-up) |
| TodoWrite | first-party in-memory tool, mirrors the Claude one |
| NotebookEdit | out of scope for M10 |
| Task | **hand-built** recursive loop (see Subagents) |
| git commit / ask_user | the existing in-process `loom` MCP server, exposed to the SDK as tools via `mcp.ts` |

Default MCP server set is configurable; `filesystem` + `fetch` on by default,
`git` opt-in (the `loom` server already owns commit).

## Provider & model switching — UX / UI

### Config: provider *profiles*

`[providers.<id>]` gains an `adapter` key. Built-in `claude` keeps
`adapter = "claude"`; everything else is `adapter = "aisdk"`.

```toml
[providers.claude]                     # unchanged
model = "claude-sonnet-5"

[providers.openai]
adapter = "aisdk"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "gpt-5"                        # default for new sessions
models = ["gpt-5", "gpt-5-mini", "o4-mini"]   # offered in the picker
title_model = "gpt-5-mini"            # optional; else falls back to titles.model
tag = "oai"                           # Fleet-row label for non-default providers (optional)

[providers.deepseek]
adapter = "aisdk"
base_url = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"
model = "deepseek-chat"
models = ["deepseek-chat", "deepseek-reasoner"]

[providers.local]
adapter = "aisdk"
base_url = "http://localhost:11434/v1"
api_key_env = ""                       # none for local
model = "qwen2.5-coder:32b"
models = ["qwen2.5-coder:32b", "llama3.3:70b"]
```

`ProviderRegistry` builds its factory map from the config-declared providers
instead of the hardcoded `claude` / `fake` pair. `defaultId` = `claude` unless
config sets a top-level `default_provider`.

### Rule: provider fixed at creation, model switchable within it

Switching *provider* mid-session would change the tool set, the message-format
normalization, the resume ref, the MCP wiring, and pricing semantics — that is a
different session, and the fork-tree backlog item is the right home for
"same task, different provider". Switching *model within one provider* is just
the next `streamText` call, so that is supported live (next turn).

### Creation flow (`n` new session)

- 0 or 1 non-`fake` provider configured → no change (today's flow: straight to
  the prompt, provider = default).
- ≥ 2 providers → insert a **provider step** (list configured ids, default
  highlighted) then a **model step** (that provider's `models`, its `model`
  preselected). Both are single-keypress lists in the existing overlay style.

### Live switch (`M`)

New key **`M`** (Shift-m — lowercase `m` is unused; `⇧⇥` still cycles permission
mode). Opens a model picker scoped to the current session's provider.

- Applies from the **next turn**. If the session is running, the choice is
  queued (reuse the send-queue mechanism) and a toast says
  `model → deepseek-reasoner · applies next turn`.
- For a `claude` session, `capabilities.liveModeSwitch = true` → the toast says
  `applies now` and the adapter calls the SDK mid-stream as it does today.
- RPC: `session.setModel { id, model }` → `store.setFields({ model })` +
  `session.setModel()` on the adapter.

### Model discovery

The `models` list in config is authoritative (keeps sessions deterministic and
reviewable). A convenience CLI — `loom models <provider>` — hits
`GET {base_url}/models` and prints the ids so config is easy to populate. Not
consulted at runtime.

### Display

- **Detail** — new line under the title: `engine · claude / sonnet-5` or
  `engine · deepseek / deepseek-reasoner`.
- **Fleet row** — space is tight. Show a short dim provider tag before the title
  **only when the session's provider ≠ `defaultId`**, so all-Claude fleets look
  exactly as they do now. The tag string comes from the profile's `tag` key
  (fallback: the provider id, truncated). Final placement tuned in M10e against
  the real layout.
- **Cost** — the price table is model-keyed, so a mid-session model switch
  re-prices subsequent turns with no extra work; `costSource` still reads
  `table` / `provider`.

## Capabilities matrix

| capability | `claude` | `aisdk` |
|---|---|---|
| `liveModeSwitch` | true | **false** (next turn) |
| `forking` | false | false (initially) |
| `subagents` | true | true |
| `compaction` | true (SDK `/compact`) | **false** — Loom rebuilds history |
| `oneShot` | true | true |
| `partialTokens` | true | true (`text-delta` + interim `usage` where the endpoint streams it) |
| `permissionModes` | all four | all four (enforced Loom-side) |
| `models` | from config | from the profile's `models` |

## Sub-milestones

Commit as each lands. **Stop for review after M10a.**

| # | deliverable | tests |
|---|---|---|
| **M10a** ✓ | aisdk provider skeleton: `[providers.<id>]` profiles + `default_provider`, `AisdkProvider`/`AisdkSession` over `createOpenAICompatible`, `streamText` single-step loop, `fullStream`→`HarnessEvent` mapper, usage with cached-token split, price-table cost (existing daemon path), `interrupt` via `AbortController`, resume via `provider_messages` (migration 6), registry built from config, one-shot path so auto-titling works. **No tools.** | `test/aisdk.test.ts` (mapper shapes, `runTurn`, session create/interrupt/resume, SessionManager rollup) + `test/config.test.ts` (profile parsing). `MockLanguageModelV2` from `ai/test`. |
| **M10b** | MCP client (`experimental_createMCPClient`), `McpServerHandle` mapping, process supervision, default server set, the `loom` server exposed as tools | fake stdio MCP server in-test; tool discovery + call + teardown; zombie check |
| **M10c** | hand-built `bash.ts` + `edit.ts`; the `execute` wrapper (mode filter + permission gate); `Grep`/`TodoWrite` first-party; parity checklist green | Edit match tiers; Bash cwd/env persistence + timeout + cap; gate allow/deny path |
| **M10d** | mode enforcement (`plan` withholds mutators + `exit_plan` → `plan_review`; `acceptEdits`; `auto`); Loom-side compaction + `tokens.ts`; `Task` subagents | plan-mode blocks Write then implements on `respondToPlan`; compaction rewrites the tail + emits `compact`; subagent start/stop on snapshot |
| **M10e** | provider/model switching: config profiles + `adapter` key, registry from config, creation provider+model steps, `M` live-switch, `session.setModel` RPC, migration 6 (`sessions.model`), Detail `engine` line, Fleet provider tag, `loom models` CLI | config parse of profiles; registry construction; reducer for the two new creation steps + the `M` picker; RPC round-trip; render test for the `engine` line |

## Decisions (resolved 2026-08-29)

1. **`decode` helper** — no `Either` / `fp-ts` / helper for M10; use `zod`
   directly, refactor later.
2. **Fleet provider indicator** — a `tag` key in the provider profile
   (alongside `base_url` / `api_key_env`); rendered for non-default providers.
3. **Default-on MCP servers** — `filesystem` + `fetch`; `git` opt-in.
4. **Grep** — first-party `rg` shell-out.
5. **`@ai-sdk/anthropic` / `@ai-sdk/google`** — follow-ups, not in M10.

## Risks

- **Tool-parity maintenance** — our Bash/Edit chase Claude Code's semantics
  forever. Mitigated by leaning on official MCP servers for everything except the
  two that have no good equivalent.
- **Per-model context / tokenizer drift** — `chars/4` + a static table is
  approximate; a model with an unusual tokenizer could compact early or late.
  Only affects *when* we compact, not cost.
- **MCP subprocess supervision** — lifecycle, restart, zombie reaping across
  daemon restarts. `mcp.ts` owns this; needs the same care as the worktree
  manager.
- **Streaming quirks** — reasoning-model `reasoning` parts, fragmented
  `tool-call` argument deltas, endpoints that don't stream `usage`. Covered by
  the `map.ts` test matrix.
- **No prompt-cache control** — long non-Claude sessions cost more than the
  equivalent Claude session and the TUI can't show a cache countdown for them.
  Documented, not fixable from our side.

## Non-goals for M10

- Gemini / Vertex-native via ADK.
- Realtime / voice, A2A, the ADK skills ecosystem.
- Client-side fine-grained cache control for non-Claude providers.
- WebSearch / NotebookEdit tools (follow-ups).
- Switching a live session's *provider* (that's the fork-tree backlog item).
