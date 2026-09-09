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

On Linux, startup scans this repository's persistent session directories. A held
ownership lock is left alone. For an abandoned active marker, recovery validates
its version, directory identity, ownership stamp and pinned smolvm executable.
Helpers are recorded with the host boot ID and process start time. Native smolvm
commands wait behind a pipe gate until that record is durable, closing the window
between spawning a helper and recording it. Git workers likewise receive their
capability only after their process identity has been recorded.

On the same boot, recovery uses libc pidfd functions to signal verified helpers,
revokes credentials, and reaps the VM through its private smolvm state. It retains
the worktree and Claude history. A durable `reaped` marker makes interrupted state
removal retryable. On a different boot, old PIDs are never signalled: those VMs
cannot have survived the reboot. Missing temporary state on the same boot is
ambiguous unless shutdown was already recorded, so recovery fails closed.

Archive/delete hold the ownership lock through recovery and filesystem removal.
Resume retries recovery before launching. Startup stops admitting further cleanup
after 30 seconds; individual process waits and smolvm commands are also bounded.
Failures are logged and recorded as a session error when a matching row exists;
they do not prevent the rest of the daemon from starting. Retrying resume/archive/
delete attempts recovery again. Recovery never restarts a conversation, including
through auto-resume for sessions handled by the startup sweep.

An old or malformed marker, missing executable, substituted path, or unverifiable
surviving helper leaves the session blocked for inspection. Records created before
this recovery format are not guessed at. Automatic process recovery currently
requires Linux `/proc` and libc pidfd support; no PID-only fallback is used.

The credential-free live check kills both owners during startup and while a VM is
ready, then verifies daemon recovery, history retention and a new VM owner:

```sh
nix develop --command deno run -A scripts/test-claude-vm-recovery.ts \
  /path/to/claude-session-runtime /path/to/smolvm
```

Unit tests also simulate reboot/missing-state cases and interrupted recovery, and
check process identity mismatch, ownership substitution and cleanup locking.
