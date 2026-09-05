# Connectors

A **connector** is a package that teaches Loom to drive one kind of model
backend. Loom ships none — you install what you use:

```sh
pnpm add @loom/connector-claude     # Claude, via @anthropic-ai/claude-agent-sdk
pnpm add @loom/connector-chatgpt    # ChatGPT/Codex subscription, via ~/.codex/auth.json
pnpm add @loom/connector-generic    # any OpenAI-compatible endpoint + native Anthropic
pnpm add @loom/connector-gemini     # Google Gemini
```

`@loom/connector-mock` (a devDependency) is the scriptable, SDK-free provider the
test suite and `loom run --provider fake` use.

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

`package.json`: `"type": "module"`, `"exports": { ".": "./src/index.ts" }`,
`"dependencies": { "@loom/core": "…", "@loom/aisdk": "…", "@ai-sdk/…": "…" }`.
No build step — source is `.ts`; add a `tsconfig.build.json` only if you publish
`.d.ts`.

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

The connector must be resolvable from the `loom` package (`pnpm add` it) and
listed in the CLI's manifest, or `session.create` fails with _"provider … needs
connector … , which is not installed"_.

## ChatGPT subscription

`[chatgpt]` uses the OAuth session created by `codex login`; it does not read an
OpenAI API key or put a subscription token in Loom's configuration. At daemon
start it queries Codex's authenticated `GET /backend-api/codex/models` catalogue
and uses its account-specific model list, maximum context limits, display names, and
reasoning levels. A model pin remains optional:

```toml
[chatgpt]
# model = "gpt-5.6-terra"           # optional pin / default
# models = ["gpt-5.6-terra"]         # optional curated picker list
# auth_path = "~/.codex/auth.json"  # optional; this is the default
```

Run it with `loom run --provider chatgpt "…"`, or set
`default_provider = "chatgpt"` in the same configuration file.

The connector follows each model's `tool_mode` metadata. Models without
`code_mode_only` accept Loom's normal functions, so they can use MCP, web
search, plan tools, and sub-agents (all still governed by Loom's permission
gate). `code_mode_only` models start the local `codex app-server` binary, which
in turn starts Codex's Code Mode host and provides its native patching,
approvals, steering, and sub-agent tools. Install `codex` and run `codex login`
before using one.

Loom replaces the app-server's `mcp_servers` table for every Code Mode session
with the session's configured Loom mounts. Its tilth / fff servers therefore do
not come from `~/.codex/config.toml`, and Codex approval callbacks are routed
back through Loom's existing permission UI.

This is a vendored compatibility connector over the private Codex backend,
rather than the public OpenAI API. That backend and its accepted model IDs can
change independently of Loom; model discovery avoids stale IDs.

## Worktrees

`virtualStoreType: global` (in `pnpm-workspace.yaml`) shares one
content-addressable store across every git worktree of the repo, so
`pnpm install` in a fresh worktree is near-instant. It hardlinks only when the
worktree and `~/.local/share/pnpm` are on the same filesystem — a worktree on a
different volume falls back to copying.

Loom's own session worktrees (`.loom/trees/<slug>`) never run an install: the
daemon resolves its imports from where it was launched, and an agent's `bash` /
`git` calls just need a working directory.
