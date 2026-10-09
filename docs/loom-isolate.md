# loom-isolate

`loom-isolate` runs a command in a smolvm VM over a directory you choose,
without the Loom daemon, TUI or agents. It uses the same isolation library and
session runtime as Loom's VM sessions. Linux and Apple Silicon macOS only.

```sh
nix build .#loom-isolate     # from a checkout: deno task isolate exec -w DIR -- CMD
cd ~/src/project
loom-isolate exec -- make test
loom-isolate exec -t -- bash        # interactive shell with a terminal
loom-isolate exec --allow-host registry.npmjs.org -- npm ci
```

## Commands

| Command                      | Effect                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| `exec [options] -- CMD ARG…` | Boot the environment, run `CMD` with literal arguments, stop the VM |
| `prepare`                    | Verify the runtime, boot once, and record the runtime selection     |
| `inspect [--all] [--json]`   | Show environments, their owner, VM state and runtime                |
| `cleanup [--all]`            | Recover a crashed VM, then remove loom-isolate's state              |

Options: `-w DIR` selects the workspace (default: current directory); `-n NAME`
selects one of its environments (default `default`); `--artifact` and
`--smolvm` choose the runtime; `-q` hides startup progress. `exec` also accepts
`-t` (terminal), `--no-stdin` and repeatable `--allow-host HOST`.

Everything after `--` is passed to the guest unchanged: no shell, glob or
variable expansion. Stdin, stdout and stderr pass through. `exec` exits with
the command's status, `128+N` when it ends by signal `N`, `125` when
loom-isolate itself fails, and `2` for usage errors.

## Runtime

The Nix package bundles a session runtime and smolvm. Otherwise pass
`--artifact` (a Loom session runtime, e.g. `nix build .#session-runtime`) and
`--smolvm`. Flags win over the packaged default, which wins over the runtime
recorded by the last `prepare`. Nothing is fetched or built at run time.

## Ownership and lifetime

Ownership is foreground only. The `exec` or `prepare` process owns its
environment for its whole run and stops the VM before exiting. Nothing keeps
running in the background.

- One process owns an environment at a time. A second `exec` on the same
  workspace and name fails with status 125 and the owner's pid. Use `-n` to run
  commands side by side.
- Ctrl-C is sent to the guest command as SIGINT, which decides how to exit.
  Without `-t`, the signal goes to the command's top process, not to a process
  group. With `-t`, the guest terminal handles ^C as a local terminal would, and
  window resizes are forwarded.
- SIGTERM, SIGHUP or losing the parent process sends SIGTERM to the command. If
  it is still running 3 seconds later, loom-isolate ends the transport and stops
  the VM.
- If loom-isolate is killed outright, the VM supervisor stops the VM when its
  parent disappears. The next command on that environment, or `cleanup`, recovers
  anything left over.

## State and boundaries

State lives in `${XDG_STATE_HOME:-~/.local/state}/loom-isolate/environments/`,
one directory per workspace and name. Each holds a record, an owner lock and the
VM's persistent state. Guest disks are discarded on every boot; besides the
workspace, only the guest profile directory (`~/.claude`) persists between runs
until `cleanup`.

- The workspace is mounted read-write, not copied. A Git worktree also mounts
  its repository's toplevel and shared Git metadata, as in Loom's mount mode.
  Private clones are not available yet.
- loom-isolate refuses workspaces whose mounts would overlap Loom's VM state
  (`$XDG_STATE_HOME/loom`) or its own state. It never adopts a directory it did
  not create, nor a state directory reached through a symlink.
- Network access is denied. Each `--allow-host` permits HTTPS to one exact DNS
  name through the host proxy.
- VMs appear in `loom vm list` with workload `loom-isolate exec`. `loom vm stop`
  can stop them. The smolvm disk template cache and runtime maintenance lock are
  shared with Loom.
