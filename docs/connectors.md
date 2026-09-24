# Connectors

## Worker migration

The CLI's mock/fake and Claude connectors run through `WorkerProvider`: a
short-lived capability probe followed by one local Deno child per active session.
Tests can still construct providers directly. Other connectors retain their
existing in-process path until their migration lands. Claude model discovery,
persisted-session enumeration and titling also run in dedicated short-lived
workers; enumeration preserves the adapter's current empty-result behavior.

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

`providers.claude.worker_allowed_hosts` replaces the Deno network allowlist.
Defaults are `api.anthropic.com`, `claude.ai`, `platform.claude.com`,
`registry.npmjs.org` and `npmjs.com`; an empty list denies worker network access.
Additional proxy/API endpoints must be configured explicitly. These Deno grants
do not constrain native subprocess filesystem or network access. For native confinement, enable [Claude session VMs](claude-session-vm.md).
The Deno-only backend makes no native confinement claim.

Validation uses the installed real Claude SDK with a local CLI fixture, including
discovery, permission/question/plan callbacks, filesystem and Loom Git tools,
compaction, persisted SDK rewind, resume, profile sharing and process cleanup.
This does not validate live provider authentication or token refresh.

See [isolation](isolation.md) for current boundaries and remaining provider
and daemon/TUI work. The connector-authoring
interface below remains the worker-side interface during this migration.

### External MCP workers

Define host commands under `local_tools.<name>`, separate offline packaged VMs
under `vm_tools.<name>`, and remote services under `remote_tools.<name>`.
Select names with the three corresponding lists under `session` or
`repos[].session`. There are no implicit external tools. See
[tool selection](tools.md) and [packaged runtimes](packaged-runtimes.md).
Each active session gets a separate relay for each remote service. Only selected
remote credentials are required; inline `bearer_token` overrides the env var.
Names must be unique across selected tools; `loom` is reserved.

`default_for` declares capability preferences, not tool aliases. Supported values
are `read`, `write`, `edit`, `find`, `grep`, `web_search` and `web_fetch`.
Only one server may be the default for each capability. Omit it to mount a server
without making it a default. Agents see the actual advertised tool names and
schemas and instructions to prefer that server for the selected capabilities.
Built-ins remain fallbacks where available, subject to the connector's existing
tool settings. Permission checks are unchanged. This is agent guidance, not a
guarantee that every call uses the preferred server.

```jsonc
{
  "remote_tools": {
    "kagi": {
      "url": "https://mcp.kagi.com/mcp",
      "bearer_token_env": "KAGI_API_KEY",
      "default_for": ["web_search", "web_fetch"],
    },
  },
  "local_tools": {
    "tilth": {
      "command": "tilth",
      "args": ["--mcp", "--edit"],
      "default_for": ["read", "write", "edit"],
    },
  },
  "session": {
    "local_tools": ["tilth"],
    "remote_tools": ["kagi"],
  },
}
```

Kagi is a normal MCP server: its tools keep their advertised names, such as
`kagi_search_fetch` and `kagi_extract`. Loom supplies no Kagi-specific wrappers
or argument translations. `[[mcp]]` and `[search] backend = "kagi"` are rejected;
use named definitions and explicit selections. Brave and Tavily remain
optional first-party `search` backends.

Only the relay receives the upstream URL and HTTP credentials, over private
stdin after a version handshake. Its launch policy grants the configured host
and port plus an ephemeral loopback listener; it has no inherited environment,
filesystem, subprocess, FFI or system grants. The connector receives a loopback
HTTP endpoint and a random per-worker bearer token. This is an MCP transport,
not a daemon admin endpoint. The URL and upstream credentials cannot be changed
by requests. Redirects, browser Origin requests and sibling tokens are rejected.
The proxy forwards MCP session/protocol headers and streams responses with
backpressure. Requests are limited to 1 MiB, responses to 8 MiB, concurrency to
32 and request/stream lifetime to 60 seconds.

Close, connector event-stream completion and failed session construction release
the relay. Unexpected relay exit closes its owning session and emits a fatal
diagnostic; no tool call is retried. Daemon pipe EOF stops the relay, with a
one-second shutdown limit. Resume creates fresh endpoints and tokens. The daemon
supervises processes over stdio and does not perform their upstream HTTP calls.

These are local Deno workers, not containers or microVMs yet. Loopback endpoints
will need guest routing when the launcher gains VM support. The daemon still
resolves credentials; unmigrated connectors still share its process, and native
CLIs still have host authority. Removing explicit upstream keys from connector
configuration does not prevent native code from reading host credentials.

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
entry or set `"enabled": false` to hide it. Provider access rules still apply.

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
  // ctx.search     — a resolved web_search config when `search` is set
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
`default_provider = "codex"` in the same configuration file.

The connector follows each model's `tool_mode` metadata. Models without
`code_mode_only` accept Loom's normal functions, so they can use MCP, web
search, plan tools, and sub-agents (all still governed by Loom's permission
gate). `code_mode_only` models start the local `codex app-server` binary, which
in turn starts Codex's Code Mode host and provides its native patching,
approvals, steering, and sub-agent tools. Install `codex` and run `codex login`
before using one.

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
Set `builtin_web_search = true` to also expose Codex's native web search.

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
