# Session environments

The next-stage design is in [prepared environments and persistent session VMs](prepared-environments-plan.md).

Session VMs can enter a configured environment and run a setup command before
the provider becomes ready. Commands are configured in the trusted user config,
and execute inside the VM, in the session worktree. Claude, Codex and AISDK use
the same setup path. Host workers and packaged MCP VMs do not run these commands.

For this repository, add the following to its existing `[[repo]]` entry in
`~/.config/loom/config.toml` (merge tables rather than duplicating them):

```toml
[[repo]]
path = "~/dev/loom"

[repo.isolation]
network_presets = ["nix", "javascript"]

[repo.isolation.environment]
nix = true
command_prefix = ["nix", "develop", "path:.", "--no-write-lock-file", "--command"]
prepare = "deno install --frozen"
timeout_seconds = 900
```

Keep the existing provider VM settings enabled. Rebuild/upgrade Loom and its
provider runtimes together, then restart the daemon. Older runtime artifacts
are rejected when an environment is configured, with a rebuild diagnostic.

`path:.` explicitly uses the guest's worktree as the flake source. The default
Git flake lookup cannot read the host Git metadata through the VM's limited Git
bridge. This repo has a default flake dev shell, so this command selects it
without invoking its Git-based `shell.nix` compatibility shim. Path sources
include workspace outputs, so a resumed worktree with a large `node_modules`
directory costs more to snapshot. Prepared source/environment caching is future work.

## Configuration contract

- `nix`: enable a private writable Nix store (default false). The runtime already
  contains Nix; enabling this does not run an installer or expose the host daemon.
- `command_prefix`: argument array prepended to a shell command (default empty).
  The prefix must run the executable and arguments appended by Loom, propagate
  failure, and export the desired environment. A repo script ending in
  `exec "$@"` works. Legacy `nix-shell --run` takes a single command string,
  so it needs a wrapper adapting that interface to executable-and-arguments.
- `prepare`: arbitrary shell script (default empty), executed inside that
  environment. Nothing in the launcher assumes a package manager. For example,
  another repo could use `pnpm install --frozen-lockfile` or `./scripts/setup`.
- `timeout_seconds`: total preparation budget, from 1 to 3600 (default 900).
- `memory_mib`: guest RAM in MiB, from 512 to 65536 (default 2048).
- `cpus`: guest virtual CPUs, from 1 to 64 (default 1).

Resource settings apply to both explicit preparation and session VMs on their
next launch. They do not themselves invalidate saved disks or warm bases.
Choose values that leave enough host resources for your concurrent sessions.

Environment activation runs once per VM launch. The setup script runs next,
then Loom captures exported variables for the worker and its subprocesses.
Shell-local functions, aliases, and activation processes are not retained.
The Git bridge/provider executable paths and proxy/bootstrap settings are retained.
Setup must succeed before initialization completes; failure or timeout aborts
startup, cleans up the VM and reports a fixed diagnostic. Normal session startup
discards raw command output. Explicit repo preparation streams it separately
from the worker protocol, without attaching provider credentials.
Setup has no interactive stdin and should be repeatable.

Setup runs on both create and resume. Environment-enabled sessions retain their
private guest disks across shutdown, including the Nix store and caches under
`/storage/loom-cache` and `/storage/loom-data`. Worktree outputs such as
`node_modules` remain in the host-mounted session worktree. Archiving retains
the disks; deleting a session removes them. A runtime/backend or Nix-setting
change blocks reuse and asks you to fork, preserving the existing worktree and
history. Exact runtime/backend packages are retained as Nix GC roots.

## Prepare a warm base

Run `loom environment prepare` before starting sessions in a slow repo. It
creates a disposable worktree at committed HEAD, enters the configured shell,
runs the arbitrary `prepare` command, and saves a private copy of both VM disks.
Activation and setup output stream directly to the terminal. For a shell taking
30 minutes to build, set `timeout_seconds = 3600` to cover activation and setup.

Rerun the same command to refresh, reusing the previous compatible base. Failed
or cancelled preparation retains the previous selection. New sessions clone
the base and rerun setup in their own host worktree; existing session disks stay
independent. The worktree's `node_modules` is not baked into the base: package
stores/caches supply the new installation. Package managers must support copying
across the guest disk and host mount; configure this in your setup command when
necessary. Exports from that command also let you choose custom guest cache paths.

For a large pnpm workspace, for example, add these settings to the existing
`[repo.isolation.environment]` table, keeping its Nix activation configuration:

```toml
memory_mib = 8192
cpus = 2
timeout_seconds = 3600
prepare = """
pnpm install --frozen-lockfile --store-dir=/storage/pnpm-store --package-import-method=copy --network-concurrency=8 --child-concurrency=2
"""
```

The explicit store path retains downloads on the guest disk. A `.pnpm-store`
inside the disposable preparation worktree is removed with that worktree and
does not warm the base. Copy imports support the separate host worktree mount;
see [pnpm's store settings](https://pnpm.io/settings). Lower concurrency can
reduce resource pressure and competition for the proxy's 32 simultaneous tunnels.
These are repo-configured commands, not package-manager defaults imposed by Loom.
Failed preparation discards its candidate disks, including newly downloaded
packages; only the previous successfully prepared base is retained.

A child process reporting `SIGKILL` before the preparation deadline may have
exhausted guest memory. Increasing `timeout_seconds` does not increase RAM.
The signal alone is not proof of an out-of-memory kill; guest kernel diagnostics
are needed to confirm that cause.

The command uses the configured default provider's runtime, or `--provider ID`.
There is one current base per repo. Sessions using a different runtime/backend
or Nix setting start cold; prepare again for that runtime to replace the base.
This version has no automatic input invalidation or background preparation.

In the TUI, press `Space`, choose **Prepare repo environment**, and press Enter.
The TUI hands over the terminal to the same CLI command. Press Enter after it
finishes to return, or Ctrl-C during preparation to cancel and return after cleanup.
Running sessions continue on their own disks.

## Network presets

Presets compose with `extra_allowed_hosts`, using the same exact-name HTTPS:443
policy. They grant access to the whole session VM, not just setup commands.

- `nix`: `cache.nixos.org`, `channels.nixos.org`, `releases.nixos.org`,
  `tarballs.nixos.org`, `github.com`, `api.github.com`, `codeload.github.com`,
  `raw.githubusercontent.com`, `release-assets.githubusercontent.com`. This covers the official cache and common flake
  input/registry downloads, including this repo's locked GitHub inputs.
- `javascript`: `registry.npmjs.org`, `jsr.io`, `npm.jsr.io`.

Custom registries, source downloads and redirects may need additional exact
hosts. Presets do not install tools, grant arbitrary internet access, or change
Nix cache signature trust. Direct guest IP networking remains disabled. Both
uppercase and lowercase proxy variables are supplied for package tools.

## Store layout and validation

The immutable runtime is mounted read-only. Its closure is the OverlayFS lower
layer; upper/work directories and the private Nix database live on smolvm's
ext4 `/storage` disk. The root filesystem itself is overlay-backed and cannot
serve as an upper layer. Closure registration and GC roots keep the runtime's
dependencies valid while additional packages are downloaded/built privately.
Build temporary files also use `/storage`, rather than guest RAM.

Tests cover configuration scope, preset validation, arbitrary activation/setup,
export propagation, failure, timeout, and immutable mount policy. The live check
below runs this repository's actual setup in a disposable worktree without API
credentials or provider requests:

```sh
deno run -A scripts/test-session-environment-vm.ts /path/to/aisdk-runtime /path/to/smolvm
```

Verified on Linux with smolvm 1.8.1: this repo's first launch reached readiness
in 188 seconds; a complete VM relaunch took 4.7 seconds. Both launches activated
Nix and ran the locked dependency installation without provider credentials.
The test checks a guest-side counter to verify disk persistence. These timings
measure reuse of a session disk, not cloning a prepared repo base.

`scripts/test-prepared-environment-vm.ts` verifies the real CLI's live output,
offline Deno installation in a fresh worktree cloned from the base, refresh,
failed setup, cancellation, and isolation from an existing session. Linux is
verified; Apple Silicon disk cloning and runtime hash regeneration still need
validation on a Mac.
