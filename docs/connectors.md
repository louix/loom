# Connectors

## Worker boundary

Provider sessions run through worker transports; tests can construct providers
directly. Discovery and titling use short-lived workers.

The private protocol is in `core/src/worker.ts`; the worker entrypoint and framed
transport live in `runtime/src/worker/`. The daemon owns the remote proxy and
launcher in `backend/daemon/src/daemon/worker-{provider,launch}.ts`. Stdout carries
only versioned NDJSON frames. Session snapshots are cached in the proxy, updated
before command acknowledgements; events are ordered and bounded without silent
dropping. Worker exit fails pending requests without replaying them.

The mock launcher uses cached dependencies, a clean environment and an explicit
source-read grant, with no network, write, environment, subprocess or FFI grants.
It requires the source/runtime artifacts and dependencies to be available locally.
Claude's launcher uses a clean, allowlisted environment and explicit runtime,
workspace and profile paths. Each native worker leads a POSIX process group.
Close allows up to five seconds for graceful cleanup, then kills the group;
worker failure also kills the group. On daemon pipe EOF, the worker cleans up
its own group, with a five-second watchdog for a stuck adapter. Ordinary CLI
descendants are covered; deliberately detached descendants require a stronger
boundary such as a cgroup or VM. This backend is supported on POSIX platforms.

Session workers keep filesystem tools, local MCP servers, package installation,
and Loom Git tools. Native provider state stays in its existing profile directory;
no credential copies are made. Named profiles do not receive Deno grants for the
default profile's files. Existing same-profile concurrent CLI state/refresh
semantics are retained. Workers have private scratch directories, removed after
normal shutdown or supervised failure; an abrupt daemon death can leave scratch
directories behind. Neither provider state nor worktrees are removed on close.

Claude utility workers use private working directories without an additional
workspace grant. Titling explicitly disables tools, MCP servers, inherited
settings and session persistence. Model discovery disables tools and inherited
MCP/settings as well. The SDK enumerates its environment, so Claude workers have
Deno environment permission over the curated child environment; unrelated
provider/search keys are not copied. Native launch and existing Git tools require
subprocess permission. FFI stays disabled.

The Claude worker's Deno network allowlist is `api.anthropic.com`, `claude.ai`,
`platform.claude.com`, `registry.npmjs.org` and `npmjs.com`.
`providers.claude.network.allowed_hosts` adds hosts (`host` or `host:port`) to
that list, for a proxy or another API endpoint. The deprecated
`providers.claude.worker_allowed_hosts` still replaces the whole list (an empty
list denies worker network access); Loom warns about it, and ignores it when
`network.allowed_hosts` is also set. These Deno grants
do not constrain native subprocess filesystem or network access. For native confinement, enable [Claude session VMs](claude-session-vm.md).
The Deno-only backend makes no native confinement claim.

Claude Code automatic memory is disabled by default. Set
`providers.claude.auto_memory: true` to enable it; Claude then stores and loads
notes in `<config dir>/projects/<project>/memory/` (`MEMORY.md` and topic files).
The setting can also be set on a `providers.claude.profiles.*` entry or a
matching `repos[]` override.

Claude Code's claude.ai connectors are also off by default; see
[claude.ai connectors](tools.md#claudeai-connectors). Loom passes the
`disableClaudeAiConnectors` setting and `ENABLE_CLAUDEAI_MCP_SERVERS=false` unless
`providers.claude.claude_ai_connectors` is `true` (globally, on a profile, or in a
`repos[]` override).

See [MCP servers](tools.md) for tool configuration and relay boundaries.

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
`loom run --provider fake` use. Mock and fake remain manually driven test providers.

To show **Echo** in the TUI provider picker, add this to your Loom config:

```jsonc
{
  "providers": {
    "echo": {},
  },
}
```

Echo replies with `Echo: <your message>` and finishes each turn with zero usage
and cost. It needs no credentials and runs locally (no VM backend). Omit the
entry to hide it. Provider access rules still apply.

## Dependencies

`@loom/core` defines `AgentProvider`, `AgentSession`, `HarnessEvent` and
`ConnectorContext` without importing model SDKs. Generic and Gemini connectors
use the shared `@loom/aisdk` engine; Claude wraps its agent SDK; Codex drives
`codex app-server`.

The CLI supplies a lazy `ConnectorManifest` to the daemon. An unused provider's
SDK is never evaluated (`test/lazy-providers.test.ts`), though Deno installs
all workspace dependencies.

## Writing a connector

For a complete SDK-free example, see the [Echo plugin](../connectors/echo/README.md).
It implements the session interface directly and runs through the same worker path.

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

| Config family                                        | Connector package         |
| ---------------------------------------------------- | ------------------------- |
| `providers.claude`                                   | `@loom/connector-claude`  |
| `fake` / `mock`                                      | `@loom/connector-mock`    |
| `providers.echo`                                     | `@loom/connector-echo`    |
| `providers.codex`                                    | `@loom/connector-chatgpt` |
| `providers.google`                                   | `@loom/connector-gemini`  |
| `providers.openai_compatible`, `providers.anthropic` | `@loom/connector-generic` |

Connector routing is internal to Loom. To add a connector, register its package
in the CLI manifest (`cli/src/connectors.ts`) and its route in `ProviderRegistry`.
The config family selects the backend; named accounts live in its `profiles` map.
The internal Codex connector package retains its existing name.

## Codex subscription

`providers.codex` uses the OAuth session created by `codex login`; it does not read an
OpenAI API key or put a subscription token in Loom's configuration. At daemon
start it lists your account's models and their reasoning efforts through a
short-lived `codex app-server` process (`model/list`), and context limits from
Codex's authenticated `GET /backend-api/codex/models` catalogue. A model pin
remains optional:

```jsonc
{
  "providers": {
    "codex": {},
  },
}
```

Codex's directory is resolved once, in this order: explicit `config_dir` →
the `CODEX_HOME` environment variable → `~/.codex`. The resolved
directory is used consistently for discovery and for every spawned
`codex app-server` session (as that subprocess's own `CODEX_HOME`), so both
always authenticate against the same `auth.json`.

Run it with `loom run --provider codex "…"`, or set
`"default_provider": "codex"` in the same configuration file.

Sessions run through `codex app-server`, including Code Mode models. Install
`codex` and run `codex login` before using the connector.

Set `cli_path` in `providers.codex` or one of its profiles
when `codex` is not on `PATH`:

```jsonc
{
  "providers": {
    "codex": {
      "cli_path": "/absolute/path/to/codex",
    },
  },
}
```

Loom replaces the app-server's `mcp_servers` table for every Code Mode session
with the session's configured Loom mounts. Its tilth / fff servers therefore do
not come from `~/.codex/config.toml`, and Codex approval callbacks are routed
back through Loom's existing permission UI. HTTP MCP mounts use session relays;
the native client receives a local access token rather than the upstream key.
Set `"builtin_web_search": true` to also expose Codex's native web search.

Automatic classifier denials offer manual review with the denied action and
the classifier's reason. Codex collects these reviews at the end of the turn;
approving records the native denied-action approval and starts a retry turn.
Claude pauses in its `PermissionDenied` hook and grants one matching retry
after approval (same tool, arguments, working directory, session and agent).
Unused Claude grants expire after the retry turn or when the user sends new
input, changes mode, interrupts, or closes the session. Auto mode stays selected.
This uses Codex 0.160's review protocol and Claude's `PermissionDenied` hook;
older CLIs without those events cannot offer this fallback.

The native app-server protocol and authenticated model catalogue can change
independently of Loom; discovery avoids hard-coded model IDs.

## Worktrees

Deno's module cache (`DENO_DIR`, `~/.cache/deno` by default) shares one
content-addressed store across every git worktree of the repo, so
`deno install` in a fresh worktree is near-instant. It hardlinks only when the
worktree and `DENO_DIR` are on the same filesystem — a worktree on a different
volume falls back to copying.

Loom's own session worktrees (`$XDG_DATA_HOME/loom/worktrees/<repo>-<hash>/<slug>`) never run an install: the
daemon resolves its imports from where it was launched, and an agent's `bash` /
`git` calls just need a working directory.

## Cost accounting

Context occupancy is the last main-loop request's input size; compaction can
lower it without reducing spend. Usage deltas count new pipeline activity,
including native sub-agents and compaction where reported. Provider totals
belong to one provider session ID; Loom session cost accumulates deltas across
processes. Subscription quota windows are separate from dollar estimates.

Provider cost is an API-equivalent estimate, not a subscription bill. The UI
distinguishes reported, table-estimated, mixed, partially unpriced and unavailable
cost. Storage remains per session; supervisor totals are display aggregates.

Claude restores `total_cost_usd` and `modelUsage` from history. Before releasing
a resumed query's first prompt or mapping results, Loom seeds its baseline with
`get_usage`, emitting no usage. The hold expires after ten seconds; late seeds
are ignored because a turn may already be running.

If that experimental API fails, use persisted `usage.provider_total` only for a
matching provider ref. After a crash, the CLI can restore an older stamp; the
fallback then undercounts until spend passes Loom's last observation. This is
an accepted trade-off to avoid charging history twice.

- Difference cumulative reports against a high-water baseline; duplicates,
  partial reports and smaller totals alone do not start a new ledger.
- Explicit `conversation_reset` carries charged spend and clears the baseline.
  Query replacement carries only post-seed spend.
- Forward trailing usage after interruption; it can contain real spend.
- Persist provider-ref changes after undo, clear and fresh implementation so
  resume and fallback refer to the same ledger.
- Native forks seed copied history without inheriting the source Loom cost.

Pre-fix stored totals cannot be repaired from the database alone.
Implementation lives in `connectors/claude/src/{adapter,map}.ts` and
`backend/daemon/src/store/sessions.ts`. The cost-accounting fixtures model
CLI 2.1.280's restore/reset behavior, not captured model traffic.
