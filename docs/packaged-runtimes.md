# Packaged MCP runtimes

Loom can run prepared command MCP packages in per-session smolvm guests. This
backend supports Linux/KVM and Apple Silicon macOS. Unified MCP definitions grant
workspace and network access separately; legacy VM tools retain a writable
workspace and offline networking. No host credentials are inherited. HTTP MCPs continue to
use the external HTTP worker. Host command MCPs remain available through
explicit `command` entries.

See [MCP server configuration](tools.md) for the unified schema and
`loom mcp prepare|status|update`. Generic Nix packages can now be wrapped by Loom;
the artifact-level workflow below remains available.

## Prepare MCP servers

Configure an ordinary Nix package under `mcp_servers`, then run
`loom mcp prepare <name>`. Loom wraps its executable and closure as an immutable
runtime. The [Tilth example](../examples/mcp/tilth/README.md) includes its Git
dependency and patch. Tilth is not bundled with Loom and has no built-in runtime
recipe. HTTP servers such as Kagi need only configuration and credentials.

Preparation is the network-enabled installation step; session launch never runs
Nix or downloads dependencies. Missing artifacts fail launch. Updates are
explicit through `loom mcp update <name>`; failed updates preserve the previous
selection. Existing sessions keep their running servers.

Preparation pins smolvm from PATH, or from `--smolvm /nix/store/.../bin/smolvm`.
These commands work outside a repository using user configuration and never
start the daemon. Doctor enumerates selected servers and reports their prepared
artifacts and filesystem/network grants.

Each prepared source has a versioned `lock.json` under
`$XDG_DATA_HOME/loom/runtimes` (default `~/.local/share/loom/runtimes`).
A `current` symlink switches atomically after validation. Artifacts and the
backend are rooted against Nix garbage collection; active generations survive
runtime pruning.

## Agent runtimes and custom artifacts

The default Loom Nix package bundles Claude, Codex and AISDK session runtimes
and smolvm. The `withClaude`, `withCodex` and `withAisdk` overrides control
those bundles. Session isolation remains opt-in through
`session.isolation.enabled`. Bundled agent runtimes update with Loom.

For an existing flake producing a complete Loom artifact, use
`source.kind: "runtime"` with its explicit flake reference.
`loom runtime prepare|status|update` remains the artifact-level interface;
without a reference it operates only on configured runtime sources.

Loom exports `lib.mkRuntime` from both the root flake and the server-independent
`packaging/runtimes` flake:

```nix
packages.x86_64-linux.loom-runtime = loom.lib.mkRuntime {
  inherit pkgs;
  package = myMcpPackage;
  executable = "my-mcp";
  args = [ "--stdio" ];
};
```

Package all interpreters and subprocess dependencies, wrapping PATH when needed.
Custom MCP packages target Linux; preparation on macOS requires a configured
Linux builder. The automatic macOS builder below applies to bundled agent
runtimes.

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
than silently ignoring them. Runtime and host command configurations are
mutually exclusive.

Bundled agent session artifacts additionally declare `"guestImage":
"guest-image.tar"`. This fixed filename contains a Debian slim image and the
selected Nix runtime closure. smolvm unpacks it inside the guest, avoiding an
extra runtime mount and preserving Linux filesystem semantics on macOS. No
registry reference or arbitrary image path is accepted in the manifest. Generic
command MCP artifacts retain their existing execution contract.

Each session gets its own Deno supervisor, authenticated loopback HTTP endpoint,
smolvm guest and private state directory. The supervisor translates MCP HTTP to
stdio, preserving tool names, argument schemas and results. It supports request
cancellation and bounded server-notification streams; it advertises no client
sampling or elicitation capabilities. Neither artifact paths nor native launch
commands are sent to the connector worker.

The native guest has one CPU and 512 MiB. It sees the prepared closure read-only
at `/nix/store`. Repository/worktree mounts follow the configured workspace
grant: absent, read-only, or read-write, at their original absolute paths. Its HOME/cache are guest-local and disposable. Host home configuration,
credentials, and the host's complete Nix store are not mounted. Native command
permissions come from smolvm; Deno permissions alone do not constrain native
subprocesses.

Parent EOF closes the supervisor even during startup. Shutdown first allows MCP
EOF, then explicitly stops/deletes any remaining private VM. The daemon also
reaps after supervisor death. Cleanup has bounded retries for smolvm's
asynchronous registry removal; unresolved state is retained with its path in the
error.

When workspace access is granted, the whole repository and selected worktree
are mounted at their host paths.
Git metadata is shared, so native Git, hooks and config work normally and commits
are immediately visible on the host. With read-write access, sessions can modify shared Git metadata and
other worktrees within the mounted repo. Hooks/config modified by an agent can
affect later host Git commands. Secrets inside the repo are also accessible.

## Verification

Ordinary tests cover config validation, launch policy, manifest authority,
connector boundaries, real HTTP MCP client calls, cancellation and
notifications. Run the opt-in VM acceptance test after preparation:

```sh
deno run -A scripts/test-runtime-vm.ts tilth
deno run -A scripts/test-real-git-vm.ts /path/to/aisdk-runtime /path/to/smolvm
deno run -A scripts/test-guest-checkout-vm.ts /path/to/session-runtime /path/to/smolvm
deno run -A scripts/test-large-frame-vm.ts /path/to/session-runtime /path/to/smolvm
```

It uses only disposable files and checks tool discovery, read, hash edits, write
and search through the daemon's launcher, plus normal close, daemon EOF,
supervisor SIGKILL, and daemon EOF during boot. It also checks denial of
unmounted host files and symlinks to them. The Git fixture checks root discovery,
shared hooks/config, host-visible commits and guest dependency clones.

Guest-root probes use the production mount/environment policy to verify the
read-only runtime closure, its exact store inventory, and denial of host files
and the Nix daemon socket. Network controls require a non-loopback host IPv4
address reachable from a guest: a temporary HTTP fixture must be reachable with
that IP explicitly allowed, then unreachable with the default network policy.
Host firewall rules can make the positive control fail. Failed runs retain their
fixture paths for diagnosis. These checks replace the removed tilth spike suite.

Linux x86_64 and Apple Silicon validation use Tilth 0.10.1 and smolvm 1.8.1. See
the [macOS validation record](review-2026-09/macos.md) for exact coverage and
remaining live checks. Unified command MCP definitions can grant exact DNS names through smolvm;
these resolve to IP allowlists at startup, permitting all ports on those IPs.

## Host and guest packaging boundary

The root flake selects native Loom, provider CLIs and smolvm for the host. Guest
artifacts always contain Linux packages for the matching CPU architecture. The
guest's Git links resolve inside its staged store; the host does not need the
Linux executables installed separately.

On Apple Silicon, a fixed-output Nix derivation starts a disposable smolvm
builder, bootstraps pinned Linux Nix, and builds the locked runtime recipes. The
builder has networking and a private writable store. It sees source files and an
output directory, without provider credentials or host configuration. The Linux
closure is stored in a read-only EROFS image, preserving case-sensitive
filenames even on default macOS filesystems. The guest mounts that image at
`/nix/store`. An archive transports the image and launcher metadata while
preserving executable permissions. Nix verifies the finished artifact against
its pinned hash. The builder is stopped and deleted on completion or failure.

This happens at package build time. Session VMs still receive only their
prepared read-only store; they do not contain Nix or run a builder. A first
installation can take tens of minutes and download Linux build dependencies. No
host Linux builder, Docker installation, administrator artifact import or extra
trusted Nix key is required. Intel macOS is not supported by the pinned package
inputs.

With Nix's `nix-command` and `flakes` features enabled, install from a checkout:

```sh
nix profile add .
```

Older Nix releases, including 2.28, call this command `nix profile install .`.

Configure isolation and provider login as above. Package upgrades update
runtimes as well as Loom; nothing downloads when starting a session.

Maintainers update the Apple Silicon output hashes after changing guest source:

```sh
deno task runtime:hashes  # run on an Apple Silicon Mac with Nix
```

Commit `packaging/macos/runtime-hashes.json` with the code. Its source and image
recipe fingerprints prevent a cached artifact from silently retaining older code
or packaging.
The generator uses the same builder, registers each completed artifact in the
local Nix store, and records its hash after checking that source is unchanged.
Interrupted runs reuse completed local artifacts; installation need not compile
them again. Hash metadata, docs and tests are excluded from guest source to
avoid self-reference and unnecessary runtime rebuilds.
