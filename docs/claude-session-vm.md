# Claude session VMs

The opt-in runtime runs the existing Claude connector worker and native Claude
inside one smolvm guest. The normal framed worker protocol travels through
smolvm's exec/vsock transport. The guest mounts only the prepared closure,
a disposable session worktree, a private persistent Claude profile and a private
credential snapshot. Git operations
use the existing host bridge; commits exist immediately in host Git.

IP networking stays disabled. A loopback proxy in the guest relays through a
separate Unix/vsock endpoint to a host CONNECT proxy. The only permitted target
is exactly `api.anthropic.com:443`. The host resolves this fixed name; requests
cannot supply an IP, alternative port or DNS server. TLS remains end-to-end.
The diagnostic stream records bounded destination names and allow/deny decisions,
never proxy headers or TLS payloads. Optional Deno/Claude update traffic is disabled.

## Run

```sh
# Claude's native package is unfree; allow evaluation for this build only.
NIXPKGS_ALLOW_UNFREE=1 nix build --impure .#claude-session-runtime \
  --out-link /tmp/loom-claude-session-artifact
nix develop --command deno run -A scripts/test-claude-session-vm.ts \
  /tmp/loom-claude-session-artifact
```

The script optionally accepts the smolvm executable as its second argument.
It uses `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or the existing access token
in `CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`). It does not print
credentials or modify the host Claude profile. A private copy is mounted read-only
and removed on shutdown, startup failure or parent death. Claude can read its own
guest credentials; this experiment does not attempt to hide API credentials from
the agent.

This is a **live** acceptance test that consumes Claude usage: Claude creates a file and commits it
in a temporary linked worktree. The test also checks that real host metadata and
the host credential file are absent, direct IP connections report an explicit
network-unreachable error (a timeout is inconclusive and fails the test), and a
proxy request to `example.com:443` is denied. Failed Git fixtures are retained without
the temporary credential copy. The normal test suite covers proxy denial cases
without making API requests.

Verified using smolvm 1.8.1 and native Claude 2.1.245: an existing OAuth token,
only the allowed Anthropic API endpoint, and a host-visible commit. Fresh interactive login remains a host operation. Renewable authentication has
a separate live acceptance check below.

## Supervised lifecycle

VM routing is opt-in. Without the configuration below, Claude uses the host
worker. The Claude artifact is not pulled into the default Loom package.

`launchSessionVm` now returns the existing `WorkerProcess` contract. The live test
uses this launcher rather than owning the VM itself. A detached host supervisor
owns the Git worker, CONNECT proxy and VM. Parent EOF is observed during startup
and execution; Git worker or guest-exec failure also stops the session. Normal
termination requests cleanup, with a bounded grace period before forced termination.
If the supervisor is killed, the surviving parent stops its process group and reaps
the VM. If the parent is killed, the supervisor observes EOF and performs cleanup.

Credentials cross a private bootstrap pipe and are written only once the supervisor
is watching its parent. Cleanup attempts each revocation even if stopping/reaping
fails: it removes the credential copy and closes the capabilities independently.
Other state is retained on cleanup failure for diagnosis. If both owners die, daemon startup recovers the abandoned session using the
host-only ownership record described below.

Run the lifecycle acceptance checks without live credentials:

```sh
nix develop --command deno run -A scripts/test-claude-vm-lifecycle.ts \
  /tmp/loom-claude-session-artifact /path/to/smolvm
```

These exercise normal close, startup EOF (including after Git startup), guest-exec,
Git-worker and supervisor SIGKILL, and actual parent SIGKILL during startup and after
worker initialization. Regression tests cover proxy cancellation/connection limits
and credential revocation when VM cleanup fails.

Further restriction of host infrastructure remains. The
supervisor is trusted host infrastructure and currently runs with full Deno
permissions. This does not yet provide the intended network-free daemon boundary.

## Renewable authentication

`launchSessionVm` accepts a shared `ClaudeAuthOwner` instead of static `auth`.
This keeps refresh tokens in the host profile, refreshes through the pinned Claude
CLI before expiry, and distributes access-only snapshots to active sessions.
See [the auth implementation and live acceptance check](claude-auth-spike.md#implemented-credential-owner).
The original live experiment above uses a static snapshot; the auth acceptance
check exercises renewal and distribution to two VMs.

## Daemon integration

Build the artifact above, then opt in for Claude sessions:

```toml
[isolation.claude]
artifact = "/absolute/path/to/claude-session-runtime"
smolvm = "/absolute/path/to/smolvm" # defaults to smolvm on PATH
```

Each regular Claude session gets its own VM. Discovery and one-shot title jobs
still use host workers. The host Claude executable is also needed for OAuth
refresh; initial login stays on the host. API-key and explicit OAuth-token
environment overrides use static snapshots instead of managed refresh.

The private profile lives under
`$XDG_STATE_HOME/loom/session-vms/<repository-hash>/<session-id>/profile`
(default `~/.local/state`). It contains native history and guest settings, without
copying the host profile. Only this subdirectory is mounted into the guest.
Credential snapshots remain separate and read-only. Native history uses a fixed
project directory name so resume survives a changed worktree path.

Archive stops the VM before removing the worktree, retaining native history for
resume. Delete also removes the saved profile. Cleanup failure aborts these
operations and retains the session for retry. A host-only lock prevents overlapping
VMs for the same session. An `active.json` marker blocks resume and destructive
cleanup if ownership was lost before reaping could be confirmed. Startup and
session operations now attempt recovery before releasing that block. Empty directories and lock files
remain after deletion to avoid races caused by replacing lock inodes.

Existing host-worker history is not imported automatically: those sessions report
a clear missing-VM-history error when resumed under this configuration.

Configured HTTP MCP workers and packaged MCP runtimes are forwarded into the VM
through individual Unix/vsock endpoints. Each relay connects only to its assigned
host loopback port and preserves HTTP authentication. Guest IP networking stays
disabled. Arbitrary host stdio commands are rejected for VM sessions; package them
as a runtime first.

Live daemon acceptance (consumes Claude usage):

```sh
nix develop --command deno run -A scripts/test-claude-vm-daemon.ts \
  /path/to/claude-session-runtime /path/to/smolvm /path/to/claude
```

This checks an MCP tool call, daemon restart, archive/resume at a different
worktree path, and deletion of persistent history.

## Abandoned VM recovery

The daemon handles SIGINT/SIGTERM; each TypeScript supervisor also watches its
parent pipe for EOF. Signals, parent death and guest exit all trigger the same
cleanup path. Recovery delegates VM process management to smolvm's list/stop/delete
commands. There is no host process scanner, pidfd FFI, boot-ID lookup or shell gate.

Startup scans this repository's private session directories and leaves held
ownership locks alone. For an abandoned marker, it validates the state ownership
stamp, revokes credentials and asks smolvm to reap the machine. A fully started
session also requires the Git worker's shutdown acknowledgement: its pipe EOF
handler writes that only after host Git operations have drained. History and
worktrees are retained; recovery does not restart the conversation.

Archive/delete hold the ownership lock through recovery and removal. Resume retries
recovery before launching. A durable completion marker makes interrupted state
removal retryable. Startup stops admitting cleanup after 30 seconds, and individual
commands/waits are bounded. Failures are reported on the affected session without
preventing the rest of the daemon from starting.

If both owners die during startup, temporary state is missing, the Git worker
cannot confirm shutdown, or a record is incompatible/corrupt, the session stays
blocked for inspection. We deliberately do not guess which host PIDs to kill.
Records from the earlier process-tracking implementation require manual recovery.

This removes the Linux-specific recovery implementation. macOS runtime packaging,
path handling and actual Mac lifecycle validation remain separate work.

Credential-free acceptance test for a ready VM whose two owners are killed:

```sh
nix develop --command deno run -A scripts/test-claude-vm-recovery.ts \
  /path/to/claude-session-runtime /path/to/smolvm
```

Unit tests cover blocked startup/missing-state cases, retryable cleanup, ownership
substitution and locking.
