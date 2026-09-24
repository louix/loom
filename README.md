# Loom

Loom is an agent harness: one terminal UI and one set of configuration for
working with different coding agents.

- **Claude** runs Claude Code headlessly through the Claude Agent SDK, using your
  subscription's OAuth login.
- **Codex** runs Codex headlessly through its app-server, using your subscription's
  OAuth login.
- **Other models** run in Loom's own agent loop via OpenAI-compatible endpoints,
  including local models. Native Anthropic and Google APIs are supported too.

Choose the agent, model and account per session. Loom provides the shared
configuration, tools, Git workflow and execution environment.

## Features

- **Persistent sessions.** A daemon runs your agents; the TUI is a client. Close
  the terminal and reconnect later. Browse multiple sessions, search conversations,
  and inspect changes and activity.
- **Git workspaces.** Separate branches and worktrees by default, with an in-place
  option. Fork conversations, undo supported turns, rebase, archive and resume.
- **Agent controls.** Manual approval, plan, accept-edits and auto modes. Review a
  plan before implementation, switch models, interrupt, queue messages and compact
  context. Follow subagents and background tasks.
- **Usage visibility.** Token counts, context usage, reported or estimated costs,
  and prompt-cache activity where the provider exposes them.
- **Tools and hooks.** Local and HTTP MCP servers, including filesystem tools and
  OAuth services. Hooks for workspace setup, checks and notifications.
- **Nix environments.** Activate a project's devenv, flake or Nix shell for agent
  commands and hooks. Open a shell in the session's environment.

Capabilities such as native undo, history forks and cache reporting vary by provider.

## Isolation

Choose how each agent session runs:

| Execution     | Workspace                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Local         | Host worktree, or the current checkout in in-place mode.                                                                                  |
| VM with mount | A separate VM with the host repository and session worktree mounted. Shared Git metadata is accessible.                                   |
| VM with clone | A separate VM with a private clone. A host relay publishes commits to the session branch without exposing the host repository filesystem. |

Agent VMs use network allowlists for provider access and any extra destinations
you configure. Local MCP servers can run in their own VMs with separate workspace
and network grants; HTTP MCP credentials stay in host relays. Permission modes
govern approvals independently of these boundaries.

Prepare reusable dependency caches with `loom vm prepare`. Use `loom vm list`
and `loom vm inspect` to see VM ownership and state, and `loom vm prune` to clean
up obsolete caches. The TUI's Monitor tab shows session activity and host/daemon
resource counters.

See [isolation](docs/isolation.md), [repository access](docs/repository-mounts.md)
and [session environments](docs/session-environments.md) for configuration and limits.

## Setup

Works on Linux and macOS (Apple Silicon). Nix supplies the dependencies,
including VM runtimes; nothing else to install. With flakes enabled:

```sh
nix profile add github:louix/loom
```

Older Nix versions use `nix profile install github:louix/loom`.
See [packaging](docs/packaged-runtimes.md) for options.

Log in to the providers you want to use: `claude auth login` and/or `codex login`.
For API providers, configure the endpoint, model and credentials instead.

Edit `~/.config/loom/config.jsonc` (or `$XDG_CONFIG_HOME/loom/config.jsonc`).
The [example config](backend/daemon/config.example.jsonc) covers providers,
named accounts, repository overrides, hooks and MCP servers.
Configuration is user-owned; repository-local config files are not read.

Then run Loom from your project:

```sh
loom                                      # open the TUI; daemon starts automatically
loom run --provider claude --mode plan "Explain this codebase"
loom shell <session-id>                    # enter a session's environment
```

Press `n` for a new session, `Space` for the command palette, or `?` for help.
See [keybindings](docs/keybindings.md), [MCP setup](docs/tools.md), and the
[docs index](docs/README.md).

## Development

From a checkout:

```sh
nix develop
deno install
deno task loom
```

Source launches need separately configured artifacts for VM execution.
Run `deno task typecheck`, `deno task lint`, `deno task format:check` and
`deno task test:silent` before submitting code changes.
