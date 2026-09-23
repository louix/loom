# MCP servers

Define servers in trusted user configuration and select them under
`session.mcp_servers`. Definitions and preparation do not enable a server.
Each local server runs in its own per-session smolvm container/VM, independently
of the agent's execution mode.

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
      "execution": "vm",
      "grants": { "workspace": "read-write", "network": [] },
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

## Permissions

Local definitions require `execution: "vm"`. Omitted grants mean
`{ "workspace": "none", "network": [] }`.

- `workspace`: `none`, `read-only`, or `read-write`. The VM mount enforces
  read-only access. No workspace grant means no repository mount and a disposable
  guest working directory.
- `network`: exact DNS names, e.g. `["api.example.com"]`. Empty means offline.
  This uses smolvm's `--allow-host`: names resolve at VM start and permit traffic
  to those IP addresses on all ports. It is an IP allowlist, not an HTTPS
  hostname/path filter; other services sharing an allowed IP are reachable.
  There is no automatic inheritance from agent or build-time network access.

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
      "execution": "vm",
      "grants": { "workspace": "read-only", "network": ["api.example.com"] },
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
Definitions merge using the existing trusted user-config rules. Existing sessions
retain their running servers and grants. Restart the daemon to apply changed
definitions or selections; new/resumed sessions then use the current configuration.
There is no live tool-list refresh or grant mutation.

## Legacy tool selections

The existing `local_tools`, `vm_tools`, and `remote_tools` definitions and lists
remain supported. They can coexist with unified definitions, but selecting the
same server name twice is an error. Legacy VM definitions retain read-write
workspace access and offline networking. Host commands remain explicitly
unsandboxed local integrations.

# Legacy configuration examples

Loom separates host commands, separate tool VMs, and remote MCP services. Define
integrations once in the trusted user config, then select them globally or per
repo. Defining or bundling a tool does not enable it. With no selections, agents
use their native tools and Loom's session tools. These lists configure Loom-managed
integrations; provider-native settings and plugins remain separate.

```jsonc
{
  "local_tools": {
    "tilth": {
      "command": "tilth",
      "args": ["--mcp", "--edit"],
      "default_for": ["read", "write", "edit"],
    },
    "fff": {
      "command": "fff-mcp",
      "default_for": ["find", "grep"],
    },
  },
  "vm_tools": {
    "tilth": {
      "runtime": "tilth",
      "default_for": ["read", "write", "edit", "find", "grep"],
    },
  },
  "remote_tools": {
    "docs": {
      "url": "https://docs.example.com/mcp",
      "bearer_token_env": "DOCS_TOKEN",
    },
  },
  "session": {
    "local_tools": [],
    "vm_tools": [],
    "remote_tools": [],
  },
}
```

`tools` are executables installed on the host. Arguments are an array, never a
shell command string. `vm_tools` use packaged runtimes in separate offline VMs;
their manifests supply commands and arguments. They receive the repository mounts,
including shared Git metadata, without host credentials. `remote_tools` receive
per-session HTTP relays; inline `bearer_token` overrides `bearer_token_env`.

All selected tools are required. Missing executables, runtime artifacts or selected
remote credentials fail preflight. Connection failures are surfaced rather than
silently dropping selected integrations. Availability checks do not boot VMs or
prove remote connectivity; those are checked during launch. Unselected definitions
are syntax-validated but do not require installation or credentials.

## Common configurations

Add these settings to the matching `repos` array in your user config. Each example
assumes the definitions above. Host/VM agent execution still uses the existing
`isolation` settings; `session` contains tool selections only.

### Host agent and host tools, in the current checkout

```jsonc
{
  "repos": [
    {
      "path": "~/dev/project",
      "session": {
        "local_tools": ["tilth", "fff"],
        "vm_tools": [],
        "remote_tools": [],
        "worktree": {
          "enabled": false,
        },
        "isolation": {
          "enabled": false,
        },
      },
    },
  ],
}
```

Set `repos[].session.worktree.enabled = true` for separate branches and worktrees while
keeping agent and tool execution on the host.

### Host agent and a separate Tilth VM

Keep the host execution settings above and replace the tool selections:

```jsonc
{
  "repos": [
    {
      "path": "~/dev/project",
      "session": {
        "local_tools": [],
        "vm_tools": ["tilth"],
        "remote_tools": [],
      },
    },
  ],
}
```

Only Tilth is confined in a VM. The agent still runs on the host.

### VM agent and a separate Tilth VM

```jsonc
{
  "repos": [
    {
      "path": "~/dev/project",
      "session": {
        "local_tools": [],
        "vm_tools": ["tilth"],
        "remote_tools": ["docs"],
        "worktree": {
          "enabled": true,
        },
        "isolation": {
          "enabled": true,
        },
      },
    },
  ],
}
```

Agent VMs reject selected host tools before session resources are created. A host
tool is never silently moved into a VM, and a failed VM never falls back to host
execution. Node, Python and other programs inside the agent VM belong to its
[development environment](session-environments.md), not `vm_tools`.

## Selection and diagnostics

Each list inherits independently from `session`; `repos[].session` replaces only
the lists it specifies. `[]` clears a group. Unknown selections, duplicate names
within a list, or selecting the same name from different groups are errors.
Definitions can share a name across groups, as Tilth does above.

`default_for` is a capability preference, not a tool allowlist or renaming rule.
Only one selected tool can be preferred for each capability. Unselected definitions
can declare overlapping preferences. Native tools remain available as fallbacks
where the agent supports them; selecting a required integration still requires it
to connect.

`loom doctor` reports selected tools with host, separate VM or remote placement
and warns about host tools incompatible with configured VM agents. Changes apply
after restarting the daemon; resumed sessions receive the current selections.

The old `[[mcp]]`, `[[command-mcp]]` and `[[http-mcp]]` syntax is rejected. There is
no compatibility mode or implicit Tilth/fff selection.
