# Session environments

Prepared bases are shared; each VM launch gets disposable writable disks.

Session VMs can enter a configured environment and run a setup command before
the provider becomes ready. Commands are configured in the trusted user config,
and execute inside the VM, in the session worktree. Claude, Codex and AISDK use
the same setup path. Host workers and packaged MCP VMs do not run these commands.

Bundled session runtimes use a digest-pinned Debian slim guest image so native
packages see a glibc environment consistent with Nix tools. The image ships with
the runtime and is unpacked inside smolvm; Docker/Podman and runtime image
downloads are not required. This applies to Linux and Apple Silicon guest
artifacts. Apple Silicon releases require regenerated runtime hashes and host
validation as described in the packaging documentation.

Upgrading the runtime (including its guest image) invalidates older prepared
bases. Run `loom environment prepare` after upgrading and restarting the daemon;
an incompatible base is skipped, and the previous base remains until a new
preparation succeeds. Existing sessions retain their host worktrees and history
and use the current environment when resumed.

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

`path:.` explicitly uses the worktree as the flake source. Normal Git-based flake
lookup also works: repository metadata is mounted at its host path. Path sources
include workspace outputs, so large `node_modules` directories cost more to snapshot.

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
- `timeout_seconds`: total preparation budget, from 1 to 2073600 (24 days;
  default 900). Set `timeout_seconds = 2073600` for the maximum.
- `memory_mib`: guest RAM in MiB, from 512 to 65536 (default 2048).
- `cpus`: guest virtual CPUs, from 1 to 64 (default 1).

Resource settings apply to both explicit preparation and session VMs on their
next launch. They do not themselves invalidate warm bases.
Choose values that leave enough host resources for your concurrent sessions.

Environment activation runs once per VM launch. The setup script runs next,
then Loom captures exported variables for the worker and its subprocesses.
Shell-local functions, aliases, and activation processes are not retained.
Activation, preparation and agents use real Git inside the VM. The whole repo,
including Git metadata, is mounted alongside the selected worktree. Hooks and
config are shared with host Git; the configured network policy still applies.
Provider executable paths and proxy/bootstrap settings are retained.
Setup must succeed before initialization completes; failure or timeout aborts
startup, cleans up the VM and reports a fixed diagnostic. During STARTING, the
TUI EVENTS pane shows runtime preparation, disk creation, VM boot, Nix activation,
the prepare command, and agent readiness. Normal session startup discards raw
command output. Explicit repo preparation streams it separately
from the worker protocol, without attaching provider credentials.
Setup has no interactive stdin and should be repeatable.

Setup runs on both create and resume. Linux creates small qcow2 writable disks
over the read-only prepared base using smolvm's bundled libkrun. macOS uses APFS
clones. These writable disks are removed when the VM stops. Guest-only package
installs, files and caches are disposable; prepare the base to retain them for
future launches. Host worktrees (including staged, unstaged and untracked files),
`node_modules`, and native conversation profiles remain on the host. Existing
persistent guest disks from older versions are discarded on their next launch
or after successful preparation. Prepared runtime/backend packages retain Nix GC roots.

## Prepare a warm base

Run `loom environment prepare` before starting sessions in a slow repo. It
creates a disposable worktree at committed HEAD, enters the configured shell,
runs the arbitrary `prepare` command, and saves a private copy of both VM disks.
Activation and setup output stream directly to the terminal. For a shell taking
30 minutes to build, set `timeout_seconds = 3600` to cover activation and setup.

Rerun the same command to refresh, reusing the previous compatible base. Preparation
blocks new session VM launches, stops the repo daemon and waits for session VMs
to shut down before doing any work. Failed or cancelled preparation retains the
previous base. Successful preparation replaces it for every subsequent launch,
including resumed conversations. Host worktrees and profiles are untouched.
The worktree's `node_modules` is not baked into the base: package
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
The repo's sessions are stopped; resume them after preparation finishes.

## Network presets

Presets compose with `extra_allowed_hosts`, using the same exact-name HTTPS:443
policy. They grant access to the whole session VM, not just setup commands.

- `nix`: `cache.nixos.org`, `channels.nixos.org`, `releases.nixos.org`,
  `tarballs.nixos.org`, `github.com`, `api.github.com`, `codeload.github.com`,
  `raw.githubusercontent.com`, `release-assets.githubusercontent.com`. This covers the official cache and common flake
  input/registry downloads, including this repo's locked GitHub inputs.
- `javascript`: `registry.npmjs.org`, `jsr.io`, `npm.jsr.io`, and `nodejs.org`
  (Node headers for native dependency builds with node-gyp).
- `python`: `pypi.org` and `files.pythonhosted.org` (PyPI indexes, wheels and
  source distributions for pip, uv and other Python package managers).

For a repo using all three, set `network_presets = ["nix", "javascript", "python"]`
under `[repo.isolation]`.

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
