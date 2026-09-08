# Tilth in smolvm

Standalone feasibility spike for a packaged command MCP. This does not add a Loom
configuration option or change how existing sessions launch MCPs.

## Prepare once, with networking

Requirements: Nix with flakes, Deno, Linux with working KVM, and an installed
smolvm (tested with 1.8.1). The package architecture must match the guest.

From the repository root:

```sh
nix build "path:$PWD/spikes/tilth-vm" --out-link /tmp/loom-tilth-vm-runtime
deno run -A spikes/tilth-vm/smoke.ts /tmp/loom-tilth-vm-runtime /absolute/path/to/smolvm
```

The flake pins tilth and its transitive Nix inputs. The host fetches sources and
builds the package, then stages its entire runtime closure under one directory.
Keep the result link as a GC root while using it. Preparation requires network
access on a cold cache; the prepared guest does not install Nix or fetch packages.

Upstream tilth's flake omits Git, which its diff tests and runtime need. Our package
override supplies Git during tests and wraps the binary with Git on PATH. It keeps
upstream tests enabled. Adding Git also adds its runtime dependencies to the
staged closure.

## Guest contract

The runner uses smolvm's bundled base image and two mounts:

- Prepared runtime closure → `/nix/store`, read-only.
- Temporary fixture workspace → `/workspace`, read-write.

It runs the pinned store entrypoint with `--mcp --edit`, preserving MCP JSON-RPC
on stdin/stdout. smolvm diagnostics use stderr. Each invocation is ephemeral,
with one CPU, 512 MiB, a 30-second timeout, and no network flags. Host environment
inheritance is disabled; smolvm itself gets private HOME/XDG state and PATH, and
the guest gets its own HOME/cache paths. No user credentials are mounted.

Only the selected closure is visible at `/nix/store`, not the host's whole store.
Copying closure contents into one volume avoids one mount per store path and
retains the absolute interpreter/library paths Nix binaries expect.

## Checks

The smoke runner creates only disposable fixtures. It exercises MCP initialize,
tool discovery, read, hash-anchored edit, file creation, and search. Host reads
verify both writes. Direct host paths and a workspace symlink to an unmounted
host file must fail through MCP. Guest-root shell probes check the same boundary,
the absence of the Nix daemon socket, and the runtime mount's read-only flag.

For network denial, a temporary HTTP server binds the first non-loopback host
IPv4 address. A separate control VM must reach it with that single IP explicitly
allowed. The default VM must report network unreachable and cause no additional
HTTP requests. This needs an interface reachable from the guest; host firewall
rules can make the positive control fail. The fixture serves only a fixed string.

Closing MCP stdin must terminate the guest successfully and leave no registered
machines. On failure, any remaining machine state is retained and its private
state directory reported instead of deleting files underneath a guest.

## Next integration step

Add an explicit packaged `command-mcp` backend with a prepared runtime artifact,
guest executable/arguments, session workspace, and network policy. Resolve/build
artifacts before session execution, then launch them through the existing MCP
worker contract. Fail startup if an artifact is absent or a VM cannot start;
never silently fall back to unrestricted host execution.

Before enabling that backend by default, cover daemon/worker death, cancellation,
restart, VM reaping, per-session writable cache policy, host/guest path mapping,
and linked Git worktrees whose `.git` file points outside the mounted workspace.
Networked command MCPs need separate allowlist and credential-delivery tests.
This spike does not establish those properties or a complete security proof.

## Observed result (2026-09-08)

Passed on Linux x86_64 with smolvm 1.8.1 and pinned tilth 0.10.1:

- Upstream package checks: 649 library tests and 4 binary tests passed.
- Runtime closure: 35 store paths, approximately 194 MiB staged.
- MCP read, hash edit, create, search, and both host-file denial checks passed.
- Network positive control succeeded; the same request with networking disabled
  failed with `Network unreachable`.
- Stdin close exited in 5 ms. smolvm briefly reported the exited machine as
  `unreachable`; polling for at most five seconds observed the registry empty.

Two runner details matter: use a short state directory under `/tmp` (the nested
Nix-shell temporary path caused a pre-boot `EINVAL`, consistent with Unix socket
path limits), and allow asynchronous registry cleanup after the process exits.
