# Session environments

Enable automatic project shell activation in the trusted user config:

```jsonc
{
  "repos": [
    {
      "path": "~/dev/my-project",
      "session": {
        "auto_nix": true,
        "isolation": { "network_presets": ["nix"] },
      },
    },
  ],
}
```

These are independent controls. `session.auto_nix` permits project shell
activation, locally and in VMs, and defaults to false. The `nix` network preset
allows Nix downloads through the VM proxy; it neither enables activation nor
controls host networking. A cached shell can activate without network access.
Other package registries or custom binary caches may need additional presets or
exact allowed hosts.

Set `session.auto_nix` globally to enable it for all repositories, or override
it in an existing `repos[]` entry. Repository-local Loom config is never read.
Activation executes the project's shell hooks, so enable it for projects you
trust.

## Activation

Loom checks the current checkout root in this order:

1. `devenv.nix`: `devenv shell -- <command>`
2. `flake.nix`:
   `nix develop path:.#default --no-write-lock-file --command <command>`
3. `shell.nix`: `nix-shell ./shell.nix --run <command>`
4. `default.nix`: `nix-shell ./default.nix --run <command>`

No matching file means ordinary startup. `.envrc` never triggers activation.
Loom reports the selected environment. Missing tools or a broken selected shell
stop startup before workspace hooks; Loom does not silently try another file. Devenv
activation enters its shell; Loom does not run `devenv up`.

Every new session worker, including resume and VM replacement, activates its own
checkout. Hooks, agent commands and `loom shell` receive those exports. Already
running workers keep their environment until their next launch. Changes to shell
files or lockfiles take effect on that next launch, even without preparation.

Local activation uses host Nix/devenv. The bundled VM runtime includes both.
Loom supplies a private writable guest Nix store automatically when an
environment is enabled; no store switch is required. Activation permission does
not grant additional network access.

Activation captures exported variables, not shell functions, aliases or
background processes. Worker home, scratch paths, provider executables and
credentials retain their launch values. Local activation is scoped to the
session and never changes the daemon's environment. Unrelated daemon credentials
are not forwarded. Local activation has a 15-minute timeout and is cancelled
when the provider closes.

## Optional preparation

`loom vm prepare` warms a reusable VM cache from a disposable checkout
of committed HEAD. Bare repositories inspect committed HEAD as well. The bundled
providers share one runtime and need one preparation; distinct custom runtimes
are prepared separately. Preparation works even when local execution is the
default or no providers are enabled, and receives no provider credentials.

The reusable disk retains downloaded/built Nix packages and other cached files.
Sessions still activate their current checkout; exported variables are never
restored from a frozen preparation snapshot. If there is no compatible cache,
sessions start from the bundled runtime and build/download what they need under
the configured network policy. This may make first startup slower. Refreshing
the cache after dependency changes is useful but not required for activation.

Project hooks use the activated project environment. `workspace_prepare` runs
in the preparation environment; `workspace_start` runs in the session environment,
regardless of the hook's `kind`. Hooks with `kind: "check"` on `file_write` or
`turn_end` reuse the running session's environment: locally with `auto_nix`,
or inside its VM for both mounted worktrees and private clones. Activation is
refreshed on session startup/resume, not on each check.

Other notification hooks run on the host with the daemon's environment. Since
`kind` defaults to `notify`, set `kind: "check"` explicitly for formatters and
linters. Doctor checks host notification executables against the daemon's PATH;
project executable availability remains unverified until execution. Doctor does
not activate project shells or infer their tools from the host PATH.

Use a `workspace_start` hook for checkout dependencies:

```jsonc
"hooks": [
  { "on": "workspace_start", "run": "deno install --frozen", "timeout": 600 },
]
```

`workspace_start` runs after checkout and activation whenever a worker starts:
creation, resume, or VM replacement, including local workers. It does not repeat
for another message to an already-running worker. Failures are reported to the
agent so it can repair the project. Hooks must be safe to repeat. Dependencies
and conversation history survive VM replacement. `LOOM_START_REASON` is
`create`, `resume`, or `refresh`.

For setup that can overlap with agent work, opt into background initialization:

```jsonc
"hooks": [
  { "on": "workspace_start", "run": "pnpm install --frozen-lockfile", "timeout": 600, "async": true },
]
```

Blocking hooks finish first; async hooks then run alongside the agent. The agent
receives “Initialization is running: `<command>`” and completion or failure
context. AI SDK sessions expose the task through `background_output` and
`background_kill`. Claude uses native async hooks, with output and exit-status
file paths in its context. Claude's wrapper uses Bash and GNU `timeout`
(included in Loom's runtime). Hook timeouts still apply. AI SDK init tasks
survive turn interruption and are stopped when the session closes.

`async` is only valid for hooks whose sole event is `workspace_start`. Claude
and AI SDK providers support it; other connectors retain blocking initialization.
Async hooks run again on resume or VM replacement.

## Advanced VM setup

These optional `session.isolation.environment` settings are for custom VM setup.
They are not needed for automatic Nix activation:

- `command_prefix`: argv used to enter a custom environment at preparation and
  every session launch. It executes the appended command and propagates its exit
  status. A nonempty prefix takes precedence over automatic detection. A named
  flake shell can use
  `["nix", "develop", "path:.#ci", "--no-write-lock-file", "--command"]`.
- `timeout_seconds`: activation budget, 1–2073600 seconds (default
  900).
- `memory_mib`: VM memory, 512–65536 MiB (default 2048).
- `cpus`: VM virtual CPUs, 1–64 (default 1).

Local sessions use automatic detection and host resources; these advanced VM
settings do not apply to them.

On Linux, large installs can exhaust the **host VM process's** open-file limit
even when the guest's `ulimit -n` is high. Virtiofs retains host descriptors for
guest inode lookups. If an install reports `EMFILE`, inspect
`/proc/<host-vmm-pid>/limits` as well as the guest limit. A limit of 100,000 was
insufficient for a tested pnpm monorepo; 1,048,576 allowed it to complete.
Set an adequate soft and hard limit for the login or service that launches Loom,
then restart that launcher and its VMs. Raising a guest limit alone will not
change the host limit. Loom does not raise host hard limits itself.

## Migrating older configuration

Replace `session.environment.nix.auto_activate` with `session.auto_nix`, and
remove `session.environment`. Automatic activation now defaults to false. Remove
`session.isolation.environment.nix`; the writable store is automatic. The old
`dev_shell` setting is removed; custom VM shell selection can use a prefix.

Preparation no longer saves exported variables for later sessions. Move exports
from a custom `prepare` command into the project shell or `command_prefix`.
Replace hook event `init` with `workspace_start`. Move
`session.isolation.environment.prepare` into a `workspace_prepare` hook and
`environment.init` into a `workspace_start` hook, then remove those settings.
A hook can select both workspace events if it is blocking. Preparation hooks
run in configuration order after activation, without provider credentials;
failure aborts publication. Each hook has its own `timeout` (up to 3600 seconds).
Updated guest runtimes use environment format 7 and include devenv.
Upgrade/rebuild older runtimes; older prepared disks are incompatible, but a new
preparation is optional. On Apple Silicon, rebuilding the packaged runtime
requires regenerating the macOS runtime hashes.

## Updating the base

Preparation uses a disposable checkout at committed HEAD, with no provider
credentials. Output streams to the terminal. Existing sessions and new launches
can continue using the previous base during preparation. Failure or cancellation
keeps that base and all existing sessions intact.

Successful preparation atomically selects the new base. New launches use it;
live VMs switch after the agent becomes idle and pending operations, hooks,
background tasks and user interactions have finished. The TUI shows STARTING and
environment-update progress. Messages arriving during replacement wait for
resume. A replacement failure is reported on the session, leaving its host files
and history available for a later resume.

Linux uses small qcow2 writable layers; macOS uses APFS clones. Old backing
bytes remain available to VMs still using them and are reclaimed when those VMs
close. This temporarily requires room for both old and new bases. Guest-only
files and processes are disposable. Host worktrees, including staged, unstaged
and untracked changes, and native conversation profiles persist.
`workspace_start` runs during this handover to reconcile dependencies such as
`node_modules` and `.venv`, which should live in the checkout.

There is one current base per repo and runtime. Bundled providers use the same
base; distinct custom runtimes keep separate bases. The shared image contains
provider executables, never provider credentials. Preparation receives no
provider credentials; each session receives only its selected authentication
source and has private writable disks, credentials and native provider history.
Bundled runtimes keep the guest image and its registered Nix tools separate from
Loom's application code, which is mounted read-only on each launch. Source-only
Loom upgrades reuse prepared bases. Compatibility follows the stable guest image
and an explicit environment-format epoch, plus the host architecture/OS, exact
smolvm executable identity and writable-Nix setting. Guest OS/tool changes or an
incompatible environment-format change skip the old cache and start cold. Custom
session runtimes must use the same current image format and include the
environment identity metadata.

The TUI checks enabled VM providers for missing or incompatible runtime images.
Upgrade Loom or rebuild the configured runtime when needed. A missing prepared
cache does not produce a warning or block startup. No VM is started or image
rebuilt by this check.

In the TUI, use **Space → Prepare repo environment**. The CLI owns the terminal
until preparation finishes; Enter returns to the TUI and Ctrl-C cancels
preparation. The daemon and existing sessions keep running throughout.

## Image cleanup

Successful preparation and `loom vm prune` remove bases for runtime
images that are no longer configured, along with abandoned preparation
directories. A missing or incompatible replacement does not preserve all
historical images: you can reclaim obsolete images before preparing the new
runtime. The current selection for each configured image is retained, including
custom runtimes and legacy selections still used by a configured image. Bases
used by live VMs retain both their disk files and Nix GC roots; shutdown or
recovery retries cleanup after releasing them. Active preparation and unfinished
recovery state are retained. Pruning lists each retained base and its reason;
`--json` includes the same details in `retainedBases`. A deferred runtime cache
cleanup is separate from this repository's environment base cleanup.

Run `loom vm prune` to retry cleanup for this repo without rebuilding.
It also removes legacy persistent disks and interrupted disk copies from stopped
sessions, preserving their conversation profiles. Live sessions and sessions
with unfinished recovery are skipped. Daemon startup also removes legacy disks
after confirming that each session's VM has stopped.

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

## Private prepared workspaces

With `session.isolation.checkout.mode: "clone"`, preparation builds a clean
independent clone and a sibling cache directory. A new session gets a private
copy of both, mounted together at `/workspace`. Its working directory is
`/workspace/checkout`; `LOOM_WORKSPACE`, `LOOM_CHECKOUT`, and `LOOM_CACHE`
expose these paths. The host repository and Git directory are not mounted.
Git fetch/push goes through the host relay; only the session's branch is writable.
Repository history must be considered readable, regardless of advertised refs.

Configure installation using generic commands in your trusted repo settings:

```jsonc
"session": {
  "isolation": {
    "checkout": { "mode": "clone" },
    "network_presets": ["javascript"],
    "idle_timeout_minutes": 10,
  },
},
"hooks": [
  {
    "on": ["workspace_prepare", "workspace_start"],
    "run": "pnpm install --frozen-lockfile --store-dir \"$LOOM_CACHE/pnpm\"",
    "timeout": 600,
  },
]
```

The example requires pnpm in the project shell or runtime. `workspace_prepare`
runs during `loom vm prepare`, without provider credentials. `workspace_start`
runs after checkout and activation on every worker start, including resume.
Preparation must leave tracked files unchanged; generated dependencies and
caches are retained. A preparation failure aborts publication; a startup hook
failure is reported to the agent for repair.

New sessions start at their host branch's current tip even if preparation is
older. Existing sessions retain local edits and commits. A new preparation does
not overwrite existing workspaces; their next `workspace_start` reconciles dependencies.

Copying preserves hard links inside each private workspace, allowing pnpm or uv
to link between the cache and checkout on one guest device. Sessions and the
prepared base never share writable inodes. Files use reflinks when available
and ordinary copies otherwise. On ext4 without reflink support, each session
still needs a full private copy; idle shutdown does not reclaim those files.
Other package managers use the same model, with their own cache options and
workspace hooks. Keep relocatable state under the stable guest paths.

Filesystem MCP VMs mount the same private workspace and retain separate
execution, credentials and egress policies. This does not introduce new
fs/network MCP kinds or combine tool network grants.

Idle session VMs stop after ten minutes plus up to one sweep interval (30 seconds).
Open shells, active work, outstanding requests, background tasks and keep-warm
sessions prevent suspension. Set `idle_timeout_minutes: 0` to disable it.
The next message resumes the provider using its saved history and workspace.
Local-provider sessions are not suspended by this policy. Confirmed-clean
stopped inventory records are pruned after an hour; recoverable states remain.

Archiving retains clone files unless forced. Removing a clone requires explicit
force because host code does not run Git in guest-writable repositories.
Failed automatic publication is reported in the conversation; push successfully
before discarding the workspace. Package caches and ignored files are never
silently evicted.

Upgrade/rebuild the session runtime (environment version 7), then run
`loom vm prepare` to populate the new layout. Existing legacy clone paths and
mounted sessions retain their original layout.

## Host package caches (legacy mounted sessions)

Session and preparation VMs use `<repo>/.loom/package-cache`, through the
existing repository mount. It is shared by the repo's VMs and survives failed
preparation, VM replacement and daemon restarts. It contains no shared installed
project environment.

Loom sets `XDG_DATA_HOME`, `DENO_DIR`, `npm_config_cache`, `PIP_CACHE_DIR` and
`UV_CACHE_DIR` to subdirectories there. `XDG_CACHE_HOME` uses guest-owned
`/storage/loom-cache`, because Nix's Git cache rejects host-mounted directories
whose ownership differs from the guest user. Nix's cache and store contents
remain in the prepared guest base. Non-VM sessions keep using their normal host
package-cache settings. Configured network presets apply to preparation, init
and agents.

The guest preserves its temporary directory for pnpm install scripts by setting
`pnpm_config_unsafe_perm=true` (and the older `npm_config_unsafe_perm`
spelling). Otherwise pnpm's root-user mode redirects temporary files into the
host-mounted `node_modules` tree, where node-gyp cannot apply tarball ownership
(`EPERM: fchown`). This setting applies inside the session VM; plain
`pnpm install` needs no additional flags.

For pnpm, an init command can explicitly select a shared store and copy imports:

```jsonc
{
  "repos": [
    {
      "path": "~/dev/project",
      "hooks": [
        {
          "name": "install dependencies",
          "on": "workspace_start",
          "run": "pnpm install --frozen-lockfile --store-dir=\"$XDG_DATA_HOME/pnpm/store\" --package-import-method=copy",
          "timeout": 600,
        },
      ],
    },
  ],
}
```

Installed dependencies stay per worktree. Shared caches use the package
manager's own concurrency support. Guest memory and CPU settings should leave
room for preparation alongside active sessions.

Bundled session runtimes use a pinned Debian guest image, supplied with the
runtime. No Docker daemon or runtime image download is required. Linux
validation uses real VMs; Apple Silicon releases additionally require
regenerated runtime hashes and host validation as described in the packaging
documentation.

## Network presets

Presets compose with `extra_allowed_hosts`, using the same exact-name HTTPS:443
policy. They grant access to the whole session VM, not just setup commands.

- `nix`: `cache.nixos.org`, `devenv.cachix.org`, `channels.nixos.org`,
  `releases.nixos.org`, `tarballs.nixos.org`, `github.com`, `api.github.com`,
  `codeload.github.com`, `raw.githubusercontent.com`,
  `release-assets.githubusercontent.com`. This covers the official cache and
  common flake input/registry downloads, including this repo's locked GitHub
  inputs.
- `javascript`: `registry.npmjs.org`, `jsr.io`, `npm.jsr.io`, and `nodejs.org`
  (Node headers for native dependency builds with node-gyp).
- `python`: `pypi.org` and `files.pythonhosted.org` (PyPI indexes, wheels and
  source distributions for pip, uv and other Python package managers).
- `rust`: `crates.io`, `index.crates.io`, `static.crates.io`,
  `static.rust-lang.org`, and `sh.rustup.rs` (Cargo dependencies and rustup
  toolchains).

For a repo using all four, set
`network_presets = ["nix", "javascript", "python", "rust"]` under
`repos[].session.isolation`.

Nix builds that fetch Rust crates also need `rust`; the `nix` preset alone does
not grant crate downloads. If preparation fails with a proxy `403 Forbidden` for
`static.crates.io`, add `rust` to the repo's existing `network_presets` in the
trusted user config and rerun `loom vm prepare`.

Custom registries, source downloads and redirects may need additional exact
hosts. Presets do not install tools, grant arbitrary internet access, or change
Nix cache signature trust. Direct guest IP networking remains disabled. Both
uppercase and lowercase proxy variables are supplied for package tools.

## Store layout and validation

The immutable runtime is mounted read-only. Its closure is the OverlayFS lower
layer; upper/work directories and the private Nix database live on smolvm's ext4
`/storage` disk. The root filesystem itself is overlay-backed and cannot serve
as an upper layer. Closure registration and GC roots keep the runtime's
dependencies valid while additional packages are downloaded/built privately.
Build temporary files also use `/storage`, rather than guest RAM.

Tests cover configuration scope, init failures, fork initialization, pending
operations/interactions, and messages arriving during VM replacement. Real-VM
checks are available without provider credentials:

```sh
# Automatic Nix: cold startup, fresh exports, optional preparation and offline reuse.
deno run -A scripts/test-auto-nix-vm.ts /path/to/session-runtime /path/to/smolvm
# Small fixture: publication, cache reuse, failure, cancellation and a live old VM.
deno run -A scripts/test-prepared-environment-vm.ts /path/to/aisdk-runtime /path/to/smolvm
# Heavier fixture: this repository's actual Nix development shell.
deno run -A scripts/test-session-environment-vm.ts /path/to/aisdk-runtime /path/to/smolvm
# Native addon compilation with Nix-provided pnpm and a mounted worktree.
deno run -A scripts/test-pnpm-environment-vm.ts /path/to/session-runtime /path/to/smolvm
```

Apple Silicon disk cloning and runtime hash regeneration need validation on a
Mac.

### Package-manager networking

The guest exports HTTP(S) proxy variables and `NODE_USE_ENV_PROXY=1` during
preparation and session activation. Node/Corepack need this opt-in to use the
proxy (Node 24.5+ or 22.21+); older Node versions need their own proxy support.
Direct guest DNS/network access is unavailable.

VM-backed Codex sessions permit network access within their filesystem sandbox
so commands can reach the guest proxy. Loom's host proxy still enforces the
selected network presets and exact extra hosts on HTTPS port 443. Host Codex
sessions keep network access disabled. Changing package installation from
environment preparation to an init hook does not itself fix networking; it
installs dependencies in the conversation's worktree.

## VM execution without a worktree

VM execution and Git worktrees are independent.
`loom run --isolation vm --in-place` runs inside a session VM with the existing
repository checkout as its working directory. Use worktrees when sessions need
separate working copies and branches. In-place sessions share files and Git
state; archiving or deleting one preserves the checkout, including uncommitted
changes. VM profiles and history remain private per session. Bare repositories
still require a worktree.

## Session shells

Run `loom shell <session>` (a short session ID works) to open an interactive
shell in the session's repository or worktree. Local sessions use `$SHELL`; VM
sessions enter their running VM with its activated tools and environment. Exit
the shell to return to your terminal. The agent can keep working while the shell
is open.

The VM must already be running; this command does not start or resume a session.
VMs started before shell support need to be archived and resumed first. While a
shell is open, archive, delete and provider changes are blocked, and automatic
VM environment replacement waits for the shell to exit.

On Linux, the credential-free terminal smoke check exercises both workspace
layouts locally and in a real VM:

```sh
deno run -A scripts/test-session-shell-vm.ts /path/to/session-runtime /path/to/smolvm
```
