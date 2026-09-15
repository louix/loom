# Session environments

Loom separates reusable environment preparation from session initialization.

- `loom environment prepare` builds a VM base from committed HEAD. The bundled
  Claude, Codex and AISDK providers share one image and need one preparation.
  Distinct custom runtime images are prepared separately. `--provider P` selects
  that provider's runtime. Nix activation
  and `isolation.environment.prepare` must succeed before the base is published.
- a `hooks` entry with `"on": "init"` runs once when a conversation is created, before its opening
  turn, inside its VM or on the host for a non-VM session. A failed init hook is
  shown in EVENTS and included in the agent's opening prompt so it can repair the
  project. Init does not run on resume or VM replacement.
- Package caches live on the host; worktree dependencies and conversation history
  survive VM replacement.

## Configuration

Add to the existing matching `repo` array entry in the trusted user config:

```jsonc
{
  "repo": [
    {
      "path": "~/dev/loom",
      "isolation": {
        "network_presets": ["nix", "javascript"],
        "environment": {
          "nix": true,
          "command_prefix": ["nix", "develop", "path:.", "--no-write-lock-file", "--command"],
          "prepare": "",
          "timeout_seconds": 900,
        },
      },
      "hooks": [
        {
          "name": "install dependencies",
          "on": "init",
          "run": "deno install --frozen",
          "timeout": 600,
        },
      ],
    },
  ],
}
```

Set `isolation.enabled` to true for projects that should default to VM execution. Non-VM sessions use the same
init hook mechanism in their host working environment; the VM base settings do
not affect them. Hooks can also be scoped with the existing `project` setting.
Init hooks execute serially in configuration order. Both check and notify init
hooks report failures to the agent; notification-only behavior of other events
is unchanged. Existing Git commit hooks continue to run through Git.

The environment settings are:

- `nix`: private writable guest Nix store (default false). Does not expose the host store or daemon.
- `command_prefix`: argument array used to enter the environment during explicit preparation.
  It must execute the appended command and propagate its exit status.
- `prepare`: optional shell command executed inside that environment during explicit preparation.
  Use it for reusable base setup. Worktree dependency installation belongs in init hooks.
- `timeout_seconds`: preparation budget, 1–2073600 seconds (default 900).
- `memory_mib`: VM memory, 512–65536 MiB (default 2048).
- `cpus`: VM virtual CPUs, 1–64 (default 1).

Preparation captures exported environment variables in the base. Session boots
restore them without evaluating the current worktree's flake or rerunning the
prepare command. Exported paths into the preparation checkout are mapped to the
session's worktree. Shell functions, aliases and background processes are not
captured. Provider executables and launch-specific proxy/bootstrap settings retain
precedence. A missing or incompatible base requires explicit preparation before
starting a session with environment settings enabled.

## Updating the base

Preparation uses a disposable worktree at committed HEAD, with no provider
credentials. Output streams to the terminal. Existing sessions and new launches
can continue using the previous base during preparation. Failure or cancellation
keeps that base and all existing sessions intact.

Successful preparation atomically selects the new base. New launches use it;
live VMs switch after the agent becomes idle and pending operations, hooks,
background tasks and user interactions have finished. The TUI shows STARTING and
environment-update progress. Messages arriving during replacement wait for resume.
A replacement failure is reported on the session, leaving its host files and
history available for a later resume.

Linux uses small qcow2 writable layers; macOS uses APFS clones. Old backing bytes
remain available to VMs still using them and are reclaimed when those VMs close.
This temporarily requires room for both old and new bases. Guest-only files and
processes are disposable. Host worktrees, including staged, unstaged and untracked
changes, and native conversation profiles persist. Init is not rerun during this
handover; dependencies such as `node_modules` and `.venv` should live in the worktree.
If a new base changes the interpreter/ABI they need, the agent may need to reinstall them.

There is one current base per repo and runtime. Bundled providers use the same
base; distinct custom runtimes keep separate bases. The shared image contains
provider executables, never provider credentials. Preparation receives no provider
credentials; each session receives only its selected authentication source and
has private writable disks, credentials and native provider history.
Bundled runtimes keep the guest image and its registered Nix tools separate from
Loom's application code, which is mounted read-only on each launch. Source-only
Loom upgrades reuse prepared bases. Compatibility follows the stable guest image
and an explicit environment-format epoch, plus the host architecture/OS, exact
smolvm executable identity and writable-Nix setting. Guest OS/tool changes or an
incompatible environment-format change require preparation again. Custom runtimes
without the compatibility metadata retain exact artifact matching.

The transition to this layout requires one new preparation; older bases remain
available until replacements are prepared. Changing a repo's development dependencies or preparation command still
requires explicit preparation to capture those changes. The TUI checks enabled
VM providers on launch and shows a persistent warning for missing or incompatible
images, with **Space → Prepare repo environment** as the remedy. It rechecks after
preparation. No VM is started or image rebuilt by this check.

In the TUI, use **Space → Prepare repo environment**. The CLI owns the terminal
until preparation finishes; Enter returns to the TUI and Ctrl-C cancels preparation.
The daemon and existing sessions keep running throughout.

## Image cleanup

Successful preparation prunes obsolete bases once every configured VM runtime
has a compatible replacement. This includes bases from older Loom releases,
superseded compatibility keys and abandoned preparation directories. Bases used
by live VMs retain both their disk files and Nix GC roots; shutdown or recovery
retries cleanup after releasing them. Active preparation and unfinished recovery
state are retained. Other configured runtime images are preserved.

Run `loom environment prune` to retry cleanup for this repo without rebuilding.
It also attempts runtime cache cleanup. `loom runtime prune` cleans only old
custom runtime generations and backend disk-template caches; runtime updates
attempt this automatically. Current generations and explicit runtime pins from
all trusted repo configurations are retained. Global cache cleanup is deferred
while a VM is running, starting, or has retained recovery state, or while a
runtime update is in progress.

These commands support `--json` and report removal counts. They delete obsolete
disk files and release their Nix GC roots, but do not invoke system-wide Nix
garbage collection. Released Nix store paths are reclaimed by normal Nix GC,
provided no other roots (such as older profile generations) still retain them.
Host worktrees, conversation profiles and package-manager caches are preserved.

## Host package caches

Session and preparation VMs use `<repo>/.loom/package-cache`, through the existing
repository mount. It is shared by the repo's VMs and survives failed preparation,
VM replacement and daemon restarts. It contains no shared installed project environment.

Loom sets `XDG_DATA_HOME`, `DENO_DIR`, `npm_config_cache`, `PIP_CACHE_DIR` and
`UV_CACHE_DIR` to subdirectories there. `XDG_CACHE_HOME` uses guest-owned
`/storage/loom-cache`, because Nix's Git cache rejects host-mounted directories
whose ownership differs from the guest user. Nix's cache and store contents remain
in the prepared guest base. Non-VM sessions keep using their normal host
package-cache settings. Configured network presets apply to preparation, init and agents.

The guest preserves its temporary directory for pnpm install scripts by setting
`pnpm_config_unsafe_perm=true` (and the older `npm_config_unsafe_perm` spelling).
Otherwise pnpm's root-user mode redirects temporary
files into the host-mounted `node_modules` tree, where node-gyp cannot apply
tarball ownership (`EPERM: fchown`). This setting applies inside the session VM;
plain `pnpm install` needs no additional flags.

For pnpm, an init command can explicitly select a shared store and copy imports:

```jsonc
{
  "repo": [
    {
      "path": "~/dev/project",
      "hooks": [
        {
          "name": "install dependencies",
          "on": "init",
          "run": "pnpm install --frozen-lockfile --store-dir=\"$XDG_DATA_HOME/pnpm/store\" --package-import-method=copy",
          "timeout": 600,
        },
      ],
    },
  ],
}
```

Installed dependencies stay per worktree. Shared caches use the package manager's
own concurrency support. Guest memory and CPU settings should leave room for
preparation alongside active sessions.

Bundled session runtimes use a pinned Debian guest image, supplied with the
runtime. No Docker daemon or runtime image download is required. Linux validation
uses real VMs; Apple Silicon releases additionally require regenerated runtime
hashes and host validation as described in the packaging documentation.

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
under `repo.isolation`.

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

Tests cover configuration scope, init failures, fork initialization, pending
operations/interactions, and messages arriving during VM replacement. Real-VM
checks are available without provider credentials:

```sh
# Small fixture: publication, cache reuse, failure, cancellation and a live old VM.
deno run -A scripts/test-prepared-environment-vm.ts /path/to/aisdk-runtime /path/to/smolvm
# The same lifecycle with a writable private Nix store.
deno run -A scripts/test-prepared-environment-vm.ts /path/to/aisdk-runtime /path/to/smolvm --nix
# Heavier fixture: this repository's actual Nix development shell.
deno run -A scripts/test-session-environment-vm.ts /path/to/aisdk-runtime /path/to/smolvm
# Native addon compilation with Nix-provided pnpm and a mounted worktree.
deno run -A scripts/test-pnpm-environment-vm.ts /path/to/session-runtime /path/to/smolvm
```

Apple Silicon disk cloning and runtime hash regeneration need validation on a Mac.

### Package-manager networking

The guest exports HTTP(S) proxy variables and `NODE_USE_ENV_PROXY=1` during
preparation and session startup, including after restoring a prepared environment.
Node/Corepack need this opt-in to use the proxy (Node 24.5+ or 22.21+); older
Node versions need their own proxy support. Direct guest DNS/network access is
unavailable.

VM-backed Codex sessions permit network access within their filesystem sandbox so
commands can reach the guest proxy. Loom's host proxy still enforces the selected
network presets and exact extra hosts on HTTPS port 443. Host Codex sessions keep
network access disabled. Changing package installation from environment preparation
to an init hook does not itself fix networking; it installs dependencies in the
conversation's worktree.
