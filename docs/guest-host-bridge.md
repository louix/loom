# Guest-to-host Git bridge

The read-only prototype works with the installed smolvm 1.8.1. Its
`machine create --mount-socket HOST:GUEST` forwards a chosen host Unix socket
over vsock, with IP networking disabled. No smolvm patch or SSH forwarding is
needed. The earlier investigation missed this option because it checked
`machine run`, where the flag is absent.

This is opt-in test tooling and a standalone experimental host worker. It does
not enable Git bridging in normal daemon or packaged MCP launches.

## Reproduce

From the repository root with Nix, Deno, Git, smolvm and KVM available:

```sh
nix build path:./packaging/runtimes#bridge-probe --out-link /tmp/loom-bridge-probe-runtime
deno test -A test/git-bridge.test.ts
deno run -A scripts/test-git-bridge-vm.ts /tmp/loom-bridge-probe-runtime "$(command -v smolvm)"
```

The integration test creates two disposable repositories, linked worktrees,
host workers and VMs. No user repository or SSH agent is involved.
A non-loopback host IPv4 address is needed for the HTTP positive control.
Successful runs delete fixtures. Failed runs report retained repository fixture
paths; VM state is removed only after successful reaping.

## Implementation

```text
guest socket client -> /run/loom/git.sock -> smolvm vsock
  -> per-session host Unix socket -> standalone Deno worker -> constrained host Git
```

`scripts/lib/bridge-vm.ts` uses create/start/exec/stop/delete in private state.
The socket lives under guest `/run`, outside shared volumes. This avoids the
shared-path collision described in [smolvm issue 864](https://github.com/smol-machines/smolvm/issues/864).
Normal packaged runtimes still use ephemeral `machine run`; migrating their
supervision is a separate change.

The host selects the executable, workspace and Git admin/common directories.
`prepareGitBridge` checks the linked-worktree backlink and common-directory
relationship without trusting the guest's `.git` pointer. Its private metadata
view contains trusted config and links to objects and refs. HEAD is refreshed
atomically per request. Git reads the original worktree index with optional
locks disabled. Objects are never copied; host ref changes are immediately visible.

Original repo/worktree config, includes, hooks and `info/attributes` are excluded.
The Git child gets a cleared environment, no pager/fsmonitor, no external
diff/textconv, no replacement objects or lazy fetch, and no configured filters.
This matters even for read-only commands.

Symlink setup runs in the trusted test supervisor: Deno 2.9.5 requires unscoped
filesystem grants for creating symlinks. The long-lived worker receives scoped
read/write grants, a grant for the exact Git executable and a network grant for
only its exact `unix:` socket. It has no IP grant or inherited host environment.
These Deno grants do not sandbox the native Git child; the deliberately small
command policy is the current boundary for that child.

`runtime/src/git-bridge/main.ts` reads a private host binding file, reports its
socket on stdout and closes it on parent stdin EOF or SIGTERM. EOF during
initialization leaves no ready endpoint. The directory is mode 0700 and socket 0600. Processes running as the same host user remain trusted.

## Protocol

One UTF-8 JSON line per connection, version 1:

| Request                                            | Meaning                                      |
| -------------------------------------------------- | -------------------------------------------- |
| `{"version":1,"op":"status"}`                      | Porcelain status at the bound worktree root  |
| `{"version":1,"op":"diff"}`                        | Unstaged diff                                |
| `{"version":1,"op":"diff","staged":true}`          | Staged diff                                  |
| `{"version":1,"op":"log","limit":10,"ref":"main"}` | Short log for a simple ref; defaults to HEAD |

Execution returns `{version:1,ok:true,code,stdout,stderr}`; `code` is Git's exit
code and can be nonzero. Rejections return
`{version:1,ok:false,error:"invalid-request"}`. Execution/output-limit failures
return `execution-failed` when the connection is still live. Unknown fields,
raw arguments, cwd/session selectors, writes and revision expressions are rejected.

Limits: 4 KiB request, 64 KiB combined output, eight active connections, five
seconds per connection including execution. Oversized/timed-out connections
close; timed-out Git children are killed. This is a small structured API, not
yet a drop-in `git` executable. The native probe has its own smaller reply buffer.

## Verified

Real Linux x86_64 VM checks passed with smolvm reporting 1.8.1:

- Concurrent guests at the same guest socket path see their bound worktrees.
- Status, diff and log work while host metadata and socket paths are unreachable
  from the guest filesystem.
- Guest `.git` replacement and request path overrides cannot retarget the service.
- Host commits and a host-side rebase onto an advanced main are immediately
  visible, without copying Git objects.
- IP fails with `Network unreachable` while the socket works. An explicitly
  IP-enabled VM reaches the same HTTP fixture as a positive control.
- Closing worker stdin revokes access from the running guest.

Host tests also cover executable config traps, malformed included config,
external diff/textconv/filter traps, unchanged index, command rejection,
output limits, idle-client cleanup and parent EOF during startup.

## Remaining scope

The tested layout is a normal SHA-1 linked worktree with loose/packed refs and
normal index. Reftable, SHA-256, split/sparse indexes, submodule status, LFS
filters and platform-specific repository settings are not supported by this
prototype's view. Unsupported layouts need explicit validation before normal
runtime integration. The private view intentionally changes configured Git
behavior; it does not transparently implement arbitrary Git commands.

Before enabling this for sessions:

1. Add the guest Git shim and validate supported layouts. Keep actual metadata
   outside guest mounts and preserve host access to the original worktree.
2. Integrate explicit VM lifecycle supervision, parent-death cleanup and a reaper
   for crashes/SIGKILL. The test helper reaps in `finally`; persistent machines
   can otherwise survive the launching process.
3. Add staging, commits and non-interactive rebase with adversarial tests for
   refs, paths and helper execution. Guest-initiated rebase is not implemented.
   Decide how allowed hooks execute inside the guest.

## Earlier transport experiment

`scripts/test-guest-bridge.ts` remains a separate historical probe. It shows
that a shared socket inode alone cannot bridge separate kernels, while vsock
can. That script uses `--ssh-agent` only with a dummy service and cleared
environment. The Git prototype uses dedicated `--mount-socket` forwarding.
