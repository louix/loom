# Loom

A cross-provider agent harness with sandboxing built in: every session can run
in its own microVM (via [smolvm](https://github.com/smol-machines/smolvm)), and
so can its MCP servers.

Ever wanted to just let agents go wild? Start a session with VM isolation and a
private clone. The agent gets a fresh machine with a copy of your repository and
nothing else. Its commits come back to its own branch on your host.

Runs Claude Code and Codex on your subscriptions, plus any OpenAI-compatible
endpoint (local models too), and the native Anthropic and Google APIs.

## Features

- **One central config.** Providers, accounts, models, MCP servers, skills and
  hooks, for every agent, in one file.
- **Cross-provider sub-agents.** Have Opus hand the work to Codex. Any
  session can start, steer and stop sub-agents on any provider, and you can
  talk to each of them directly.
- **Agent profiles.** Set up a model as your reviewer, another as an overseer,
  a cheap one as your implementer, or something more exotic. Profiles choose the
  provider, model, effort, MCP servers and skills.
- **First-class sandboxing.** Sessions, and the MCP servers they use, run in
  separate microVMs with their own network allowlists.
- **Persistent sessions.** A daemon runs your agents; the TUI is just a client.
  Close the terminal and pick up later. Each session keeps its own worktree or
  clone, conversation and branch.
- **Git built in.** A branch per session, worktrees or clones, forks, rebase,
  undo, archive and resume.
- **Nix environments.** Agent commands run inside your project's devenv, flake
  or Nix shell, in a VM or on the host.
- **Know what it costs.** Tokens, context, cache activity, and costs per session
  and across a whole tree of sub-agents.

## Isolation

Choose how each session runs:

| Execution     | Workspace                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Local         | A host worktree, or your checkout in place.                                                             |
| VM with mount | Its own VM, with the session worktree and the repository's Git metadata mounted.                        |
| VM with clone | Its own VM with a private clone. A host relay publishes its commits to the session branch, and no more. |

In a VM the agent has no SSH keys, no credentials but its own provider's, and
none of your files beyond its workspace. On a subscription it doesn't even see
its own refresh token: Loom renews the login on the host and hands the VM
short-lived access tokens. Network access is an
allowlist of exact hosts. Local MCP servers run in their own VMs with their own
grants, and remote MCP credentials stay on the host. A host command you trust,
such as a browser driver, can be relayed in explicitly.

See [isolation](docs/isolation.md), [repository access](docs/repository-mounts.md)
and [session environments](docs/session-environments.md) for configuration and limits.

## Compared with

### Claude Code in Docker

- A microVM doesn't share the host kernel; a container does.
- Claude Code on its own can reach everything you can. In Loom's clone mode it
  reaches nothing but its clone and the hosts you allow.
- Loom isn't tied to one agent: Claude, Codex and API models side by side, with
  the same tools and isolation.

### Docker Sandboxes

- Docker Sandboxes also use microVMs, but local stdio MCP servers run on the
  host. In Loom they get their own VMs.
- Loom has multi-agent built in: profiles, cross-provider sub-agents and a
  fleet view to follow them.

## Setup

Works on Linux and macOS (Apple Silicon). Nix supplies the dependencies,
including VM runtimes; nothing else to install. With flakes enabled:

```sh
nix profile add github:louix/loom
```

Older Nix versions use `nix profile install github:louix/loom`.
See [packaging](docs/packaged-runtimes.md) for options. On Apple Silicon, the
first VM session after installing or upgrading may build Loom's Linux guest
runtime (15–60 minutes, shown as session progress; `loom runtime update` does it
ahead of time); later sessions reuse it.

Log in to the providers you want to use: `claude auth login` and/or `codex login`.
For API providers, configure the endpoint, model and credentials instead.

Edit `~/.config/loom/config.jsonc` (or `$XDG_CONFIG_HOME/loom/config.jsonc`).
The [example config](backend/daemon/config.example.jsonc) covers providers,
named accounts, repository overrides, hooks and MCP servers.
Configuration is user-owned; repository-local config files are not read.

Agents see the repository's `AGENTS.md` once each: Codex and Claude Code read it
themselves (Claude Code unless a `CLAUDE.md` takes precedence without importing
it), and Loom adds it to the system prompt of every other session.

Loom writes nothing into your checkout. Per repository, keyed by its path:

| What                                      | Where                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Daemon socket                             | `$XDG_RUNTIME_DIR/loom/<repo>-<hash>/` (`/tmp/loom-<uid>/<repo>-<hash>/` without it, as on macOS) |
| Database, daemon lock, logs, theme, hooks | `$XDG_STATE_HOME/loom/repos/<repo>-<hash>/` (`~/.local/state`)                                    |
| VM package cache                          | `$XDG_CACHE_HOME/loom/<repo>-<hash>/package-cache/` (`~/.cache`)                                  |
| Session worktrees                         | `$XDG_DATA_HOME/loom/worktrees/<repo>-<hash>/` (`~/.local/share`), or `session.worktree_dir`      |

Older versions kept this in `<repo>/.loom/`. The first daemon of this version
moves it there (keeping the database where it was if the copy cannot be
verified) and removes `.loom` once it is empty. A daemon an older version
started keeps running from `.loom` until you stop it with `loom stop`. After
moving a checkout, run `loom repo move <old> <new>` to carry its state along.

Then run Loom from your project:

```sh
loom                                      # open the TUI; daemon starts automatically
loom run --profile reviewer "Explain this codebase"
# Or override a profile's model and mode for this run:
loom run --profile reviewer --model claude-opus-4-1 --mode plan "Explain this codebase"
loom shell <session-id>                    # enter a session's environment
```

Press `n` for a new session or `Space` for the command palette — every command
with its key, and why it is unavailable when it is.
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
