# Tool selection

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
