# Connectors

A **connector** is a package that teaches Loom to drive one kind of model
backend. Loom ships none — you install what you use:

```sh
pnpm add @loom/connector-claude     # Claude, via @anthropic-ai/claude-agent-sdk
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
  const p = createOpenAICompatible({ name: ctx.id, baseURL: ctx.config.baseUrl ?? "", apiKey: ctx.config.apiKey ?? "" });
  return makeAisdkProvider(
    { id: ctx.id, model: ctx.config.model ?? "", models: ctx.config.models ?? [], makeModel: (id) => p(id) },
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

| provider id / profile | connector package |
|---|---|
| `claude` | `@loom/connector-claude` |
| `fake` / `mock` | `@loom/connector-mock` |
| `[google]` or `sdk = "google"` | `@loom/connector-gemini` |
| `[custom-provider.*]`, `[anthropic]`, `sdk = "openai"` / `"anthropic"` | `@loom/connector-generic` |

Override per profile:

```toml
[providers.my-endpoint]
adapter   = "aisdk"
connector = "@my-org/loom-connector-thing"
base_url  = "https://…"
```

The connector must be resolvable from the `loom` package (`pnpm add` it) and
listed in the CLI's manifest, or `session.create` fails with *"provider … needs
connector … , which is not installed"*.

## Worktrees

`virtualStoreType: global` (in `pnpm-workspace.yaml`) shares one
content-addressable store across every git worktree of the repo, so
`pnpm install` in a fresh worktree is near-instant. It hardlinks only when the
worktree and `~/.local/share/pnpm` are on the same filesystem — a worktree on a
different volume falls back to copying.

Loom's own session worktrees (`.loom/trees/<slug>`) never run an install: the
daemon resolves its imports from where it was launched, and an agent's `bash` /
`git` calls just need a working directory.
