# MCP servers

Define servers in trusted user configuration and select them under
`session.mcp_servers`. Definitions and preparation do not enable a server.
`source.kind` says where a server runs: `nix` and `runtime` servers run in
their own per-session smolvm container/VM, independently of the agent's
execution mode; `command` servers run on the host (and serve VM sessions only
when relayed); `http` servers are remote.

```jsonc
{
  "mcp_servers": {
    "tilth": {
      "source": {
        "kind": "nix",
        "ref": "path:/absolute/path/to/tilth-package#default",
        "executable": "tilth",
        "args": ["--mcp", "--edit"],
      },
      "grants": { "workspace": "read-write", "network": { "allowed_hosts": [] } },
      "default_for": ["read", "write", "edit", "find", "grep"],
    },
    "kagi": {
      "source": { "kind": "http", "url": "https://mcp.kagi.com/mcp" },
      "auth": { "bearer_token_env": "KAGI_API_KEY" },
      "default_for": ["web_search", "web_fetch"],
    },
  },
  "session": { "mcp_servers": ["tilth", "kagi"] },
}
```

Tilth uses the standalone [example Nix package](../examples/mcp/tilth/README.md).
Copy that package to a durable directory and replace the absolute path above. Kagi uses the existing authenticated
HTTP relay: its API key stays in the relay and is omitted from provider child
environments. No Kagi-specific tools or argument adapters are involved.
Existing inline credentials can use `auth.bearer_token`; a nonempty inline token
takes precedence over `auth.bearer_token_env`.

## Web search

Claude has its own web search, and Codex can keep its native one
(`builtin_web_search`). For other agents, and as an alternative, web search is an
MCP server. Loom's starter config and `config.example.jsonc` define two, inert
until selected; each needs only its API key in the daemon's environment:

```jsonc
{
  "mcp_servers": {
    // Brave's official server (npm; needs Node's npx on the host). A host command,
    // so host sessions only; pass_env copies the key into its environment.
    "brave": {
      "source": {
        "kind": "command",
        "command": "npx",
        "args": ["--yes", "@brave/brave-search-mcp-server@2.1.4", "--transport", "stdio"],
        "pass_env": ["BRAVE_API_KEY"],
      },
      "default_for": ["web_search"],
    },
    // Tavily's official hosted server: works for VM sessions too, and the key
    // stays in Loom's HTTP relay.
    "tavily": {
      "source": { "kind": "http", "url": "https://mcp.tavily.com/mcp/" },
      "auth": { "bearer_token_env": "TAVILY_API_KEY" },
      "default_for": ["web_search", "web_fetch"],
    },
  },
  "session": { "mcp_servers": ["tavily"] },
}
```

Select one search server at a time: each is the `default_for` `web_search`.
Kagi (above) works the same way. Tools keep their servers' names
(`brave_web_search`, `tavily-search`, `kagi_search_fetch`).

The old `search` section (`backend`, `api_key`, `api_key_env`, `api_base`,
`max_results`) configured a Brave/Tavily client built into AISDK sessions. It is
gone: Loom ignores the section and reports it once. Set the same key variable
for the matching server above and select it.

## OAuth for hosted servers

Use `auth.oauth` instead of bearer authentication for a standards-compatible
OAuth MCP server:

```jsonc
{
  "mcp_servers": {
    "work": {
      "source": { "kind": "http", "url": "https://mcp.example.com/mcp" },
      "auth": { "oauth": {} },
    },
  },
  "session": { "mcp_servers": ["work"] },
}
```

```sh
loom mcp login work
loom mcp login work --no-browser
loom mcp status work --json
loom mcp logout work
```

An empty OAuth block uses MCP discovery and dynamic client registration.
For a pre-registered application, set `client_id`, optionally `client_secret_env`
or `client_secret_command` (an argv array), `redirect_port`, and `scopes`.
Secret commands run only during explicit login. Register the callback as
`http://127.0.0.1:<redirect_port>/callback`. Without a fixed port, Loom chooses one.
`--no-browser` prints the login URL; the callback still runs on this host.

Login stores credentials on the host and refreshes them for selected sessions.
Linux uses private state files; macOS uses a dedicated Keychain item without a
plaintext fallback. Native Keychain behavior still needs validation on macOS.
Only the access token reaches Loom's host relay; the guest receives a separate
session capability. Status reads local state without contacting the server.

Missing credentials fail preflight with a login command. A changed URL or OAuth
configuration requires a new login. Refresh preserves live streams; logout clears
authorization and aborts upstream requests. Requests are never replayed.
Logout reports local deletion separately from remote revocation and exits nonzero
if live relay invalidation could not be confirmed. It also works after removing
the definition from config.

Use distinct server names for different accounts. Login is explicit and requires
one name; device flow, batch login and client ID metadata documents are not
supported. See the [OAuth internals](mcp-oauth.md) for protocol and storage
details.

### AWS

The AWS MCP Server signs in through AWS sign-in with dynamic registration, so an
empty OAuth block is enough. Its tools (`aws___run_script` especially) can
outlast the default 60-second request limit; AWS's own client configuration uses
100 seconds:

```jsonc
{
  "mcp_servers": {
    "aws": {
      "source": { "kind": "http", "url": "https://aws-mcp.us-east-1.api.aws/mcp" },
      "auth": { "oauth": {} },
      "timeout_seconds": 120,
    },
  },
  "session": { "mcp_servers": ["aws"] },
}
```

```sh
loom mcp login aws
```

The identity you sign in as needs the `AWSMCPSignInOAuthAccessPolicy` managed
IAM policy, plus permissions for whatever the tools then call. Access tokens
last an hour and Loom refreshes them, but AWS's refresh tokens are single-use
and expire within 12 hours of login, so expect to run `loom mcp login aws` again
roughly every 12 hours. Loom's discovery and dynamic registration have been
checked against this server; a full login and tool call with it has not been run.

A failed login names its cause, for example
`MCP OAuth: registration_failed: HTTP 400 invalid_client_metadata: …`.

#### Without OAuth: AWS's SigV4 proxy

Where OAuth sign-in is unavailable (an organization can withhold
`signin:AuthorizeOAuth2Access`), AWS's [MCP Proxy for
AWS](https://github.com/aws/mcp-proxy-for-aws) signs the same server's requests
with your AWS CLI credentials. It is a [host command](#host-commands);
[relayed](#relaying-a-host-command-to-vm-sessions), VM sessions can use it too:

```jsonc
{
  "mcp_servers": {
    "aws": {
      "source": {
        "kind": "command",
        "command": "uvx",
        "args": [
          "mcp-proxy-for-aws-cli@1.7.0",
          "https://aws-mcp.us-east-1.api.aws/mcp",
          // Hides tools not annotated read-only; drop it to let agents change resources.
          "--read-only",
          // Optional: default region for AWS operations, otherwise the profile's.
          // After the URL: --metadata takes the arguments that follow it.
          "--metadata",
          "AWS_REGION=eu-west-1",
        ],
        "env": { "AWS_PROFILE": "my-profile" },
      },
      "vm_sessions": "relay",
      "timeout_seconds": 120,
    },
  },
  "session": { "mcp_servers": ["aws"] },
}
```

**The proxy runs on the host with your AWS credentials, and VM agents can call
it.** Whatever that profile may do in AWS, an agent can now ask for.

- **Credentials.** The proxy reads `~/.aws` like the AWS CLI, with the profile
  from `env.AWS_PROFILE` (or the daemon's own `AWS_PROFILE`, inherited). Signing
  in is yours to do (`aws sso login --profile my-profile` or `aws login`). The
  proxy rereads credentials on every request, so a refreshed sign-in applies to a
  running session; a session that started while signed out fails with
  `MCP initialization failed: No AWS credentials available…`, and needs resuming.
- **Permissions.** No MCP-specific IAM action, and not
  `AWSMCPSignInOAuthAccessPolicy`: each call needs the profile's own permission
  for the AWS action it makes. AWS marks those requests with the
  `aws:ViaAWSMCPService` condition key, which an organization's policies can deny.
- **First start.** `uvx` downloads the proxy and its dependencies (about 230 MB
  of cache) the first time, taking tens of seconds; run
  `uvx mcp-proxy-for-aws-cli@1.7.0 --help` once beforehand. The pinned
  `-cli` package freezes its whole dependency tree.
- **NixOS and Guix System.** A Python that uv downloads cannot run there (there
  is no `/lib64` loader): put `uv` and `python3` in a profile on the daemon's
  `PATH` (`nix profile add nixpkgs#uv nixpkgs#python3`) and add
  `"UV_PYTHON_DOWNLOADS": "never"` to `env`.

## claude.ai connectors

Claude Code can also load the connectors connected to a Claude account on
claude.ai (Datadog, Atlassian, GitHub, …) by itself. Loom turns this off by
default. These connectors are not Loom MCP servers: they are remote services
called through Anthropic's MCP proxy (`mcp-proxy.anthropic.com`), Loom neither
defines nor prepares them, and `session.mcp_servers`, agent profiles' allow/deny
lists and Loom's network grants do not apply to them.

```jsonc
{
  "providers": {
    "claude": {
      "claude_ai_connectors": true,
      // or per account:
      "profiles": { "work": { "config_dir": "~/.claude-work", "claude_ai_connectors": true } },
    },
  },
}
```

A matching `repos[]` entry can set it for one repository; like other provider
settings, a change applies after a daemon restart. When it is off, Loom
starts Claude Code with the `disableClaudeAiConnectors` setting and
`ENABLE_CLAUDEAI_MCP_SERVERS=false`. When it is on, Loom sets neither, and a
[Claude session VM](claude-session-vm.md) may also reach `mcp-proxy.anthropic.com`
besides `api.anthropic.com`. A `disableClaudeAiConnectors: true` in the account's
own Claude settings still wins. Connectors need a claude.ai login; an API key or a
`claude setup-token` token disables them.

## Permissions

A local `source` (`nix`, `runtime`) always runs in a VM; the old
`execution: "vm"` is no longer needed and is ignored. Omitted grants mean
`{ "workspace": "none", "network": { "allowed_hosts": [], "presets": [] } }`.

- `workspace`: `none`, `read-only`, or `read-write`. The VM mount enforces
  read-only access. No workspace grant means no repository mount and a disposable
  guest working directory.
- `network.allowed_hosts`: exact DNS names, e.g. `["api.example.com"]`. Empty means offline.
  A name grants only itself, not its subdomains; there are no wildcards (a
  `*.` grant would admit a public suffix such as `*.github.io` as readily as
  one organisation's domain), so list each host. This uses smolvm's
  `--allow-host-pattern` with each exact name: the guest can
  resolve only granted names, exact names also resolve at VM start, and traffic
  is permitted to the resolved IP addresses on all ports. It is an IP allowlist,
  not an HTTPS hostname/path filter; other services sharing an allowed IP are
  reachable.
  There is no automatic inheritance from agent or build-time network access.
- `network.presets`: named host sets (`nix`, `javascript`, `python`, `rust`), the
  same as for session VMs, added to `allowed_hosts`.
- A plain host list, `"network": ["api.example.com"]`, is the old form: it still
  reads as `allowed_hosts`, and Loom reports it once.

Workspace access follows the session's existing checkout layout. Mounted Git
worktrees can require the main repository and shared Git metadata; their grants
cover those mounts too. Private-clone sessions expose their private workspace
instead. Read-only also prevents writes to the exposed Git metadata and caches.

Artifacts cannot grant permissions. Extra host mounts, persistent server caches,
and local secret injection are not supported by this initial schema. Unknown
grant fields fail validation. HTTP definitions reject local grants and
`execution`: Loom controls the endpoint and authentication, not the remote
service's operating system.

## Packaging and preparation

Use a Nix package for a new local MCP; Loom builds its runtime wrapper:

```jsonc
{
  "mcp_servers": {
    "my-tools": {
      "source": {
        "kind": "nix",
        "ref": "github:your-org/your-tools/<revision>#my-mcp",
        "executable": "my-mcp",
        "args": ["--stdio"],
      },
      "grants": { "workspace": "read-only", "network": { "allowed_hosts": ["api.example.com"] } },
    },
  },
}
```

The package must include its interpreters and subprocess dependencies.
Preparation resolves the flake to an immutable reference and wraps the package
using Loom's pinned nixpkgs and runtime helper. Package lookup checks
`packages.<linux-system>.<attribute>`, then `legacyPackages`, then the full
attribute path. No fragment means `default`. Arguments are data, never shell
commands or Nix expressions. Guest packages target the matching Linux CPU;
builds on macOS need a configured Linux builder.

```sh
loom mcp prepare my-tools
loom mcp status
loom mcp update my-tools
```

Commands accept `--json`, `--repo`, and `--smolvm`. A name addresses a definition,
even if unselected; without a name they operate on selected unified definitions.
HTTP servers need no package: these commands check credential availability, while
connectivity and tool discovery are checked at session launch.

Preparation may fetch/build dependencies, validates the artifact and roots it
against Nix GC. A successful generation is reused until explicitly updated.
Failed updates preserve the previous selection. Source/entrypoint/argument changes
get a new artifact identity; permission changes do not rebuild the package.
Launch never installs dependencies.

`source: { "kind": "runtime", "ref": "github:your-org/tools/<revision>#loom-runtime" }`
selects a flake producing a complete Loom artifact. There are no built-in MCP
server aliases; Tilth and Kagi are ordinary configured servers.
`loom runtime prepare|status|update|prune` remains available.
`loom vm prepare` exclusively prepares the repository development environment.

## Selection and lifetime

All selected servers are required. Missing artifacts or credentials fail
preflight; connection failures fail launch. Definitions are syntax-validated even
when unselected. Duplicate selections, unknown names and competing
`default_for` preferences fail validation.

Repository `session.mcp_servers` lists replace the global list; `[]` clears it.
Definitions merge using the existing trusted user-config rules. The daemon
re-reads the config when the file changes, and changed definitions or selections
apply to every session started or resumed after that, without a restart. Running
sessions retain their servers and grants; there is no live tool-list refresh or
grant mutation.

## Request timeouts

One MCP request may take 60 seconds unless its server sets `timeout_seconds`,
a whole number from 1 to 3600:

```jsonc
{
  "mcp_servers": {
    "slow": {
      "source": { "kind": "http", "url": "https://mcp.example.com/mcp" },
      "timeout_seconds": 300,
    },
  },
}
```

For `http`, `nix` and `runtime` sources, Loom's relay enforces it: the HTTP
relay aborts the upstream request (and its response stream), and a VM server's
stdio bridge answers the agent with an error and sends the server
`notifications/cancelled`. Claude and Codex also receive it as that server's
tool-call timeout (`timeout` and `tool_timeout_sec`). Codex's own default is
also 60 seconds, so a longer limit has to reach it too.
A `command` source has no Loom relay in a host session; there the setting
only sets the Claude or Codex tool-call timeout. One [relayed to a VM
session](#relaying-a-host-command-to-vm-sessions) has its bridge enforce it too. AISDK agents' MCP client sets no per-call
limit, so there the setting applies through Loom's relays alone.

## Host commands

A `command` source runs an executable on the host, unconfined, as the agent's
own MCP client starts it:

```jsonc
{
  "mcp_servers": {
    "fff": {
      "source": {
        "kind": "command",
        "command": "fff-mcp", // looked up on PATH, or an absolute path
        "args": ["--stdio"], // an array, never a shell command string
        "env": { "FFF_LOG": "warn" }, // added to the environment it inherits
        "cwd": "~/tools/fff", // absolute or ~/; omitted: the session's worktree
      },
      "default_for": ["find", "grep"],
    },
  },
  "session": { "mcp_servers": ["fff"] },
}
```

By default only sessions that run on the host can use one. Selecting a host
command for a session whose agent runs in a VM (`session.defaults.isolation:
"vm"`, or a VM runtime for that provider) fails before any session resources are
created; a host command is never silently moved into a VM, and a failed VM never
falls back to the host. Package the server with Nix (`source.kind: "nix"`) to run
it beside a VM agent, or [relay it](#relaying-a-host-command-to-vm-sessions).
`grants` do not apply to a host command and are rejected. A missing executable
fails preflight.

Some MCP clients give a host command only a few variables (`PATH`, `HOME`, …).
`pass_env` names variables to copy from the daemon's environment when a session
starts, such as an API key; one that is unset fails preflight.

### Relaying a host command to VM sessions

`vm_sessions: "relay"` lets VM sessions use a host command too: Loom runs the
command on the host and relays it into the session's VM, as it does for remote
servers. The default, `"refuse"`, is the behaviour above. Only `command` sources
take the field.

**The command still runs unconfined on the host, and the VM agent drives it.**
Whatever the command can do, the agent can now do from inside its VM: for a
browser, read the files the browser can open and run scripts in your real
browser, including on sites you are signed in to. Relay only a command you would
let the agent run on the host.

The motivating case is [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
driving a host Chromium, so a VM agent can debug the dev server on your
`localhost` — which the browser reaches because it runs on the host, outside the
VM's network policy:

```jsonc
{
  "mcp_servers": {
    "chrome-devtools": {
      "source": {
        "kind": "command",
        "command": "npx",
        "args": [
          "--yes",
          "chrome-devtools-mcp@1.10.1",
          // A throwaway profile, not your everyday one.
          "--isolated",
          "--executablePath=/usr/bin/chromium",
          // Send nothing to Google: no usage statistics, no CrUX lookups for
          // the URLs the agent traces.
          "--no-usage-statistics",
          "--performance-crux=false",
        ],
      },
      "vm_sessions": "relay",
    },
  },
  "session": { "mcp_servers": ["chrome-devtools"] },
}
```

- **One process per session.** Each VM session that selects the server gets its
  own process, started before its VM boots and stopped with the session; sessions
  never share one. A command that exits ends its session's run; resume the session
  to start it again.
- **Startup.** The session starts once the command answers MCP `initialize`,
  within `timeout_seconds` (omitted: 60). A failure, with the command's error and
  the end of its stderr, stops the session from starting.
- **No orphans.** The process runs in a process group Loom ends — SIGTERM, then
  SIGKILL after 2 seconds — when the session stops, when the daemon stops, and
  when the daemon dies. A descendant that puts itself in a process group of its
  own, as browser launchers commonly do, is outside that and is stopped by the
  command's own SIGTERM handling.
- **Environment.** The command inherits the daemon's environment, with `env` and
  `pass_env` applied as for a host session.
- **Working directory.** `cwd` when set; otherwise your home directory — not,
  as for a host session, the session's worktree. Do not point `cwd` at a directory
  the VM agent can write, such as a worktree: a command that loads code or
  configuration from its working directory, as `npx` does, would run what the
  agent planted there on the host.
- **Limits.** Those of Loom's HTTP relay: a request times out after
  `timeout_seconds` (omitted: 60), a request is at most 1 MiB and a response
  8 MiB, and at most 32 requests are in flight. A larger message from the command ends the session's run.

Preflight is unchanged: the command must be on the daemon's `PATH` and every
`pass_env` variable set before any session resources are created. Agent
profiles' `mcp_servers` and `session.mcp_servers` select a relayed server like
any other.

## Common configurations

Add these to the matching `repos` entry of your user config, assuming the
definitions above. Host/VM agent execution and the workspace come from
`session.defaults`.

```jsonc
{
  "repos": [
    {
      "path": "~/dev/project",
      "session": {
        // Host agent, host tools, in the current checkout.
        "mcp_servers": ["fff"],
        "defaults": { "isolation": "none", "workspace": "in-place" },
      },
    },
    {
      "path": "~/dev/other",
      "session": {
        // VM agent; Tilth in its own VM, Kagi remote.
        "mcp_servers": ["tilth", "kagi"],
        "defaults": { "isolation": "vm", "workspace": "worktree" },
      },
    },
  ],
}
```

Node, Python and other programs inside an agent VM belong to its
[development environment](session-environments.md), not to an MCP server.
`loom doctor` reports the selected servers with their placement and warns about
host commands, not relayed, that configured VM agents would refuse.

## Old tool catalogs

`local_tools`, `vm_tools` and `remote_tools`, and their `session` lists, are
the old form. Loom still reads them, folds them into `mcp_servers` and
`session.mcp_servers`, and reports each once (`loom doctor`, `config.check`):

| Old                                               | New `mcp_servers.<name>`                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `local_tools.<name>: { command, args }`           | `source: { kind: "command", command, args }`                                     |
| `vm_tools.<name>: { runtime }`                    | `source: { kind: "runtime", ref: runtime }, grants: { workspace: "read-write" }` |
| `remote_tools.<name>: { url, bearer_token_env }`  | `source: { kind: "http", url }, auth: { bearer_token_env }`                      |
| `session.local_tools`, `vm_tools`, `remote_tools` | `session.mcp_servers`, in that order, before its own names                       |

`default_for` carries over. Each config layer is folded on its own, so a
`repos[]` entry that sets any of the old lists now replaces the whole
`session.mcp_servers` list rather than one group. A name defined in two old
catalogs, or in an old catalog and `mcp_servers`, is an error naming the
entries to write instead.

The old `[[mcp]]`, `[[command-mcp]]` and `[[http-mcp]]` syntax is rejected. There is
no implicit Tilth/fff selection.
