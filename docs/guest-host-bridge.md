# Guest-to-host Git bridge: transport prototype

The useful transport is **vsock**, mapped to a session-specific host Unix
socket. It works with smolvm's IP networking disabled. Merely mounting a host
`.sock` file into the guest does not bridge the separate kernels' sockets.

This is an opt-in transport experiment, not a production Git bridge. It does
not change normal runtime launches or execute Git on the host.

## Reproduce

From the repository root, with Nix, Deno, smolvm and KVM available:

```sh
nix build path:./packaging/runtimes#bridge-probe --out-link /tmp/loom-bridge-probe-runtime
deno run -A scripts/test-guest-bridge.ts /tmp/loom-bridge-probe-runtime "$(command -v smolvm)"
```

The optional artifact contains a small native socket client and its Nix
closure. The script creates disposable VM state, workspaces and two dummy
host services. A non-loopback host IPv4 address is required for the IP control.
Successful runs remove their fixtures; failed runs retain the fixture path for
inspection. The backend is reaped after each invocation.

The prototype uses smolvm's existing `--ssh-agent` relay as a raw byte channel.
It clears the inherited environment and explicitly sets `SSH_AUTH_SOCK` to
its **dummy service**, never the user's real SSH agent. Do not copy this flag
into normal runtime configuration. The only accepted operation is a bounded
JSON `ping`; the reply's session identity comes from the host endpoint.

## Observations

Real VM checks on Linux x86_64 with smolvm reporting 1.8.1:

| Check                                                     | Result                                  |
| --------------------------------------------------------- | --------------------------------------- |
| Host Unix listener, host client                           | Successful positive control             |
| Same socket mounted into guest                            | Socket inode visible, connect refused   |
| Guest vsock port 6001, forwarding disabled                | Connection failed                       |
| Guest vsock CID 2, port 6001, forwarding enabled          | Reached the selected dummy service      |
| Guest-local `/tmp/ssh-agent.sock` relay                   | Reached the same service                |
| Unsupported operation or client-supplied session identity | Request rejected                        |
| Unmapped vsock port 65000                                 | Connection failed                       |
| IP explicitly allowed to a local HTTP fixture             | Successful positive control             |
| Same HTTP target with IP disabled and forwarding enabled  | Network unreachable; vsock still worked |
| Two concurrent VMs using port 6001                        | Each reached its own host endpoint      |

These checks establish transport feasibility and per-VM mapping. They are not
an audit of the hypervisor or a proof of a future Git command policy.

## Production shape

Keep the host API independent of the transport:

```text
guest git shim -> vsock -> per-session host Unix socket -> restricted host Git
```

The smolvm source has a vsock service registry (`src/agent/vsock_service.rs`)
backed by libkrun's `krun_add_vsock_port2`. Its SSH relay already supplies the
plumbing demonstrated here. The installed CLI has no general-purpose vsock
mapping option. A focused smolvm extension should expose an explicitly opted-in
mapping with a host-derived socket path and a dedicated, non-reserved guest
port. A guest-local Unix relay is optional; a native shim can use vsock directly.
The existing IP policy should remain disabled. This avoids needing an IP route
to the host or continuing to misuse SSH forwarding.

Then build the Git service in stages:

1. Create and supervise one host endpoint per session. Bind its repository and
   worktree on the host; do not accept a guest-selected host path or session.
   Close it when the session ends, including failed VM startup.
2. Start with a deliberately small read-only Git command grammar and bounded
   requests/output. Execute argument arrays, never shell strings. Sanitize the
   environment and constrain Git's config, helpers, hooks and external commands;
   even read-only commands can otherwise launch host programs.
3. Add staging, commits and non-interactive rebase with adversarial tests for
   arguments, refs, paths and linked-worktree metadata. Decide how allowed hooks
   execute in the guest before enabling them.
4. Hide real Git metadata from the guest and install the shim in packaged
   runtimes. Keep host Git operating on the original linked worktree, so commits
   and rebases appear immediately in host Git/lazygit without copying objects.

The next implementation step is the dedicated socket mapping and a read-only
host service. The transport result does not require changing the shared-worktree
approach.
