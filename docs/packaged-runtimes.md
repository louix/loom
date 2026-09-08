# Packaged MCP runtimes

Loom can run prepared command MCP packages in per-session smolvm guests. This
first backend supports Linux/KVM, a writable session workspace, and **no guest
network access or credentials**. HTTP MCPs continue to use the external HTTP
worker. Host command MCPs remain available through explicit `command` entries.

## Use tilth

The Linux development shell (`nix develop`) includes smolvm. Outside that shell,
install a Nix-packaged smolvm, then configure:

```toml
[[command-mcp]]
name = "tilth"
runtime = "tilth"
isolation = "vm"
default_for = ["read", "write", "edit", "find", "grep"]
```

Replace the old tilth `command` entry; do not keep both with the same name.
The runtime supplies its own `--mcp --edit` arguments. `default_for` remains a
capability preference, not a tool-name or schema adapter.

```sh
loom runtime prepare
loom runtime status
```

Preparation finds smolvm on PATH and pins its real Nix store executable. If it
isn't on PATH, pass `--smolvm /nix/store/.../bin/smolvm`. You can prepare just one
runtime with `loom runtime prepare tilth`. These commands also work outside a
repository, using the user config, and never connect to or start the daemon.
`--json` produces structured results. `status` reports missing artifacts with a
nonzero exit status. The doctor view includes prepared-runtime diagnostics.

Preparation is the network-enabled step. It invokes Nix, builds/downloads the
runtime closure, validates its manifest, and roots both the artifact and smolvm
against Nix garbage collection. Nothing runs Nix or downloads dependencies when
a session starts. If an artifact or backend is missing, the session fails with
an actionable error; there is no fallback to host execution.

```sh
loom runtime update tilth
```

Updates are explicit. For `tilth`, this selects the recipe pinned by your installed
Loom version, not upstream `main`. For a custom flake reference, it reevaluates
that reference. A successful prepare is reused unchanged; a damaged selection
requires restoration or an explicit update. Install a newer Loom to receive a
new maintained tilth pin.

Updates reuse the selected smolvm executable unless `--smolvm` supplies a replacement.

Each selected runtime has a versioned `lock.json` under
`$XDG_DATA_HOME/loom/runtimes` (default `~/.local/share/loom/runtimes`). It records
the configured source, immutable artifact path, backend executable, and preparation
time. A `current` symlink switches atomically after successful validation. Old
generations and GC roots remain for active sessions and recovery. Automatic runtime
GC and a rollback CLI are not implemented yet.

## Package another MCP

Use a Nix flake reference as the runtime value, for example:

```toml
[[command-mcp]]
name = "my-tools"
runtime = "github:your-org/your-tools/<revision>#loom-runtime"
isolation = "vm"
```

The selected output must be a **Loom runtime artifact**, not just an arbitrary
binary package. Loom exports a reusable Nix helper:

```nix
packages.x86_64-linux.loom-runtime = loom.lib.mkRuntime {
  inherit pkgs;
  package = myMcpPackage;
  executable = "my-mcp"; # package/bin/my-mcp
  args = [ "--stdio" ];
};
```

Package the executable's complete runtime dependencies, including programs it
launches. Nix cannot discover arbitrary subprocesses looked up on PATH: wrap the
executable to add those dependencies. Tilth uses real Git for upstream tests and
Loom's controlled Git shim at runtime, with tests left enabled. The artifact helper
includes that shim and its closure; packages should preserve `/run/loom/bin` on
PATH or explicitly wrap their Git calls with the shim.

The maintained recipe is also an independent flake:

```sh
nix build ./packaging/runtimes#tilth-runtime
```

Its default output is the same runtime artifact; `#tilth` is the binary package.
Installing the base Loom package does not build or install these optional outputs.
The helper is available as `lib.mkRuntime` from both Loom and the runtime flake.

## Artifact and execution contracts

An artifact contains `manifest.json`, `store-paths`, and a staged `nix/store/`
containing only the complete selected runtime closure. The manifest shape is:

```json
{
  "version": 1,
  "system": "x86_64-linux",
  "backend": "smolvm",
  "entrypoint": "/nix/store/<hash>-package/bin/my-mcp",
  "args": ["--stdio"]
}
```

Manifests cannot grant permissions. Unknown manifest fields are rejected. This
version rejects per-runtime environment, network, host and mount options rather
than silently ignoring them. Runtime and host command configurations are mutually
exclusive.

Each session gets its own Deno supervisor, authenticated loopback HTTP endpoint,
smolvm guest and private state directory. The supervisor translates MCP HTTP to
stdio, preserving tool names, argument schemas and results. It supports request
cancellation and bounded server-notification streams; it advertises no client
sampling or elicitation capabilities. Neither artifact paths nor native launch
commands are sent to the connector worker.

The native guest has one CPU and 512 MiB. It sees the prepared closure read-only
at `/nix/store` and the session workspace read-write at its original absolute
path. Its HOME/cache are guest-local and disposable. Host configuration, credentials,
and the host's complete Nix store are not mounted. Native command permissions
come from smolvm; Deno permissions alone do not constrain native subprocesses.

Parent EOF closes the supervisor even during startup. Shutdown first allows MCP
EOF, then explicitly stops/deletes any remaining private VM. The daemon also
reaps after supervisor death. Cleanup has bounded retries for smolvm's asynchronous
registry removal; unresolved state is retained with its path in the error.

Supported linked Git worktrees automatically get a separate host Git worker and
a dedicated vsock endpoint. Controlled Git operations use the guest shim; actual
repository metadata stays outside the mount. Run `loom runtime update tilth` once
for older prepared artifacts. See [session Git bridge](guest-host-bridge.md) for
commands, layout checks, lifecycle and remaining limitations. Main checkouts with
a `.git` directory are rejected rather than mounting their metadata. Workspace
mounts do not hide secrets already stored inside the workspace itself.

## Verification

Ordinary tests cover config validation, launch policy, manifest authority,
connector boundaries, real HTTP MCP client calls, cancellation and notifications.
Run the opt-in KVM acceptance test after preparation:

```sh
deno run -A scripts/test-runtime-vm.ts tilth
deno run -A scripts/test-session-git-vm.ts tilth
```

It uses only disposable files and checks tool discovery, read, hash edits, write
and search through the daemon's launcher, plus normal close, daemon EOF,
supervisor SIGKILL, and daemon EOF during boot. It also checks denial of unmounted
host files and symlinks to them through the bridge.

Guest-root probes use the production mount/environment policy to verify the
read-only runtime closure, its exact store inventory, and denial of host files
and the Nix daemon socket. Network controls require a non-loopback host IPv4
address reachable from a guest: a temporary HTTP fixture must be reachable with
that IP explicitly allowed, then unreachable with the default network policy.
Host firewall rules can make the positive control fail. Failed runs retain their
fixture paths for diagnosis. These checks replace the removed tilth spike suite.

Tested here with Linux x86_64, tilth 0.10.1 and smolvm 1.8.1. Other architectures,
networked command MCPs and packaged connector CLIs remain follow-up work.
