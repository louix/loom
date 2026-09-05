# Connectors

A **connector** is a workspace member that teaches Loom to drive one kind of
model backend:

```
connectors/claude/     @loom/connector-claude     Claude, via @anthropic-ai/claude-agent-sdk
connectors/chatgpt/    @loom/connector-chatgpt    ChatGPT/Codex subscription, via ~/.codex/auth.json
connectors/generic/    @loom/connector-generic    any OpenAI-compatible endpoint + native Anthropic
connectors/gemini/     @loom/connector-gemini     Google Gemini
```

`deno install` at the repo root resolves all of them regardless of which you
actually configure — Deno's workspace model has no equivalent to npm's
`optionalDependencies` for skipping unused ones. `ProviderRegistry` still
loads a connector's code lazily by name at runtime, so an unconfigured
provider never actually executes.

`@loom/connector-mock` is the scriptable, SDK-free provider the test suite and
`loom run --provider fake` use.

## The layers

```
@loom/core        the seam — AgentProvider / AgentSession interfaces, the
                  HarnessEvent union, ConnectorContext, TranscriptStore.
                  No runtime dependency, no model SDK.
   ▲
@loom/aisdk       the shared Vercel AI SDK engine — AisdkSession (owns the
   ▲              ModelMessage[], the permission gate, compaction, plan mode,
   │              sub-agents), the first-party bash/edit/grep/web_search tools,
   │              and makeAisdkProvider(opts, store). Deps: `ai`, `@ai-sdk/mcp`.
   │
@loom/connector-generic / -gemini    each owns the one `@ai-sdk/*` model factory
                  its backend needs and calls makeAisdkProvider.
@loom/connector-chatgpt             vendors a v5-compatible Codex OAuth adapter.
@loom/connector-claude               wraps @anthropic-ai/claude-agent-sdk directly.
```

`@loom/daemon` depends on none of these. The `loom` CLI passes it a
**`ConnectorManifest`** — `{ "@loom/connector-x": () => import("@loom/connector-x"), … }` —
and `ProviderRegistry` invokes a thunk only when a session first uses that
provider. So a Claude-only daemon never evaluates `ai`; an aisdk-only daemon
never evaluates `@anthropic-ai/claude-agent-sdk`. `test/lazy-providers.test.ts`
guards it.

## Writing a connector

A connector package exports one function:

```ts
import type { ConnectorContext } from "@loom/core/connector";
import type { AgentProvider } from "@loom/core/types";

export function createProvider(ctx: ConnectorContext): AgentProvider | Promise<AgentProvider> {
  // ctx.id         — the provider id this instance serves
  // ctx.config     — the resolved config slice (model, models, baseUrl, apiKey,
  //                  sdk, maxSteps, cliPath, promptCacheTtl — all optional)
  // ctx.transcript — a TranscriptStore, for connectors that persist their own
  //                  history (the aisdk kind); omitted for Claude
  // ctx.search     — a resolved web_search config when `[search]` is set
  // ctx.logger     — a scoped Logger
}
```

An OpenAI-compatible connector is a handful of lines on top of `@loom/aisdk`:

```ts
import { makeAisdkProvider } from "@loom/aisdk/provider";

export async function createProvider(ctx: ConnectorContext) {
  if (!ctx.transcript) throw new Error(`${ctx.id}: an aisdk connector needs a transcript store`);
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const p = createOpenAICompatible({
    name: ctx.id,
    baseURL: ctx.config.baseUrl ?? "",
    apiKey: ctx.config.apiKey ?? "",
  });
  return makeAisdkProvider(
    {
      id: ctx.id,
      model: ctx.config.model ?? "",
      models: ctx.config.models ?? [],
      makeModel: (id) => p(id),
    },
    ctx.transcript,
  );
}
```

`deno.json`: `"name": "@my-org/loom-connector-thing"`,
`"exports": { ".": "./src/index.ts" }`. Add it to the root `deno.json`'s
`"workspace"` array and reference any third-party npm deps in its `"imports"`.
No build step — source is `.ts`.

## Routing a config profile to a connector

`ProviderRegistry.#packageFor(id)`:

| provider id / profile                                                  | connector package         |
| ---------------------------------------------------------------------- | ------------------------- |
| `claude`                                                               | `@loom/connector-claude`  |
| `fake` / `mock`                                                        | `@loom/connector-mock`    |
| `[chatgpt]` or `sdk = "chatgpt"`                                       | `@loom/connector-chatgpt` |
| `[google]` or `sdk = "google"`                                         | `@loom/connector-gemini`  |
| `[custom-provider.*]`, `[anthropic]`, `sdk = "openai"` / `"anthropic"` | `@loom/connector-generic` |

Override per profile:

```toml
[providers.my-endpoint]
adapter   = "aisdk"
connector = "@my-org/loom-connector-thing"
base_url  = "https://…"
```

The connector must be a workspace member (in root `deno.json`'s `"workspace"`
array) and listed in the CLI's manifest (`cli/src/connectors.ts`), or
`session.create` fails with _"provider … needs connector … , which isn't in
this build's manifest"_.

## ChatGPT subscription

`[chatgpt]` uses the OAuth session created by `codex login`; it does not read an
OpenAI API key or put a subscription token in Loom's configuration. At daemon
start it lists your account's models and their reasoning efforts through a
short-lived `codex app-server` process (`model/list`), and context limits from
Codex's authenticated `GET /backend-api/codex/models` catalogue. A model pin
remains optional:

```toml
[chatgpt]
# model = "gpt-5.6-terra"           # optional pin / default
# models = ["gpt-5.6-terra"]         # optional curated picker list
# auth_path = "~/.codex/auth.json"  # optional; this is the default
# config_dir = "~/.codex-work"      # optional explicit Codex home (overrides auth_path/CODEX_HOME)
```

Codex's directory is resolved once, in this order: explicit `config_dir` →
legacy `auth_path`'s parent directory → the `CODEX_HOME` environment variable
→ `~/.codex`. Setting both `config_dir` and `auth_path` is only valid when they
name the same directory — Loom rejects the config otherwise. The resolved
directory is used consistently for discovery and for every spawned
`codex app-server` session (as that subprocess's own `CODEX_HOME`), so both
always authenticate against the same `auth.json`.

Run it with `loom run --provider chatgpt "…"`, or set
`default_provider = "chatgpt"` in the same configuration file.

The connector follows each model's `tool_mode` metadata. Models without
`code_mode_only` accept Loom's normal functions, so they can use MCP, web
search, plan tools, and sub-agents (all still governed by Loom's permission
gate). `code_mode_only` models start the local `codex app-server` binary, which
in turn starts Codex's Code Mode host and provides its native patching,
approvals, steering, and sub-agent tools. Install `codex` and run `codex login`
before using one.

Set `codex_cli_path` in `[chatgpt]` (or an `sdk = "chatgpt"` provider profile)
when `codex` is not on `PATH`:

```toml
[chatgpt]
codex_cli_path = "/absolute/path/to/codex"
```

Loom replaces the app-server's `mcp_servers` table for every Code Mode session
with the session's configured Loom mounts. Its tilth / fff servers therefore do
not come from `~/.codex/config.toml`, and Codex approval callbacks are routed
back through Loom's existing permission UI. When `[search] backend = "kagi"`,
Loom also mounts Kagi's hosted MCP server using its configured key. Codex's
native web search remains enabled by default; set
`codex_builtin_web_search = false` to use Kagi alone.

This is a vendored compatibility connector over the private Codex backend,
rather than the public OpenAI API. That backend and its accepted model IDs can
change independently of Loom; model discovery avoids stale IDs.

## Worktrees

Deno's module cache (`DENO_DIR`, `~/.cache/deno` by default) shares one
content-addressed store across every git worktree of the repo, so
`deno install` in a fresh worktree is near-instant. It hardlinks only when the
worktree and `DENO_DIR` are on the same filesystem — a worktree on a different
volume falls back to copying.

Loom's own session worktrees (`.loom/trees/<slug>`) never run an install: the
daemon resolves its imports from where it was launched, and an agent's `bash` /
`git` calls just need a working directory.
