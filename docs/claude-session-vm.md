# Claude session VMs

The opt-in runtime runs the existing Claude connector worker and native Claude
inside one smolvm guest. The normal framed worker protocol travels through
smolvm's exec/vsock transport. The guest has a private persistent Claude profile and credential snapshot.
The default mounted checkout exposes the host repository and selected worktree;
Git changes there are immediately visible to host Git. Opt-in clone mode exposes
a private workspace and publishes commits through a host relay instead. See
[repository access](repository-mounts.md).

IP networking stays disabled. A loopback proxy in the guest relays through a
separate Unix/vsock endpoint to a host CONNECT proxy. The default permitted target
is `api.anthropic.com:443`; trusted repo policy can add exact HTTPS hosts. The host resolves this fixed name; requests
cannot supply an IP, alternative port or DNS server. TLS remains end-to-end.
The diagnostic stream records bounded destination names and allow/deny decisions,
never proxy headers or TLS payloads. Optional Deno/Claude update traffic is disabled.

## Run

```sh
# Claude's native package is unfree; allow evaluation for this build only.
NIXPKGS_ALLOW_UNFREE=1 nix build --impure .#session-runtime \
  --out-link /tmp/loom-claude-session-artifact
nix develop --command deno run -A scripts/test-claude-session-vm.ts \
  /tmp/loom-claude-session-artifact
```

The script optionally accepts the smolvm executable as its second argument.
It uses `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or the existing access token
in `CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`). It does not print
credentials or modify the host Claude profile. A private copy is mounted read-only
and removed on shutdown, startup failure or parent death. Claude can read its own
guest credentials; this boundary does not attempt to hide API credentials from
the agent.

This is a **live** acceptance test that consumes Claude usage: Claude creates a file and commits it
in a temporary linked worktree. The test also checks that repository Git metadata
is accessible and the host credential file is absent, direct IP connections report
an explicit network-unreachable error (a timeout is inconclusive and fails the test), and a
proxy request to `example.com:443` is denied. Failed Git fixtures are retained without
the temporary credential copy. The normal test suite covers proxy denial cases
without making API requests.

Verified using smolvm 1.8.1 and native Claude 2.1.245: an existing OAuth token,
only the allowed Anthropic API endpoint, and a host-visible commit. Fresh interactive login remains a host operation. Renewable authentication has
a separate live acceptance check below.

## Extra hosts for worktree commands

For automatic environment activation and dependency setup, see
[session environments](session-environments.md). These settings also apply to
Codex and AISDK session VMs.

The repo's session/worktree VM can receive additional HTTPS destinations from the
trusted user config. This applies to commands the agent runs, such as `deno install`,
inside the same VM; it is not a grant limited to the Claude process.

```jsonc
{
  "repos": [
    {
      "path": "~/dev/loom",
      "session": {
        "isolation": {
          "extra_allowed_hosts": ["registry.npmjs.org"],
        },
      },
    },
  ],
}
```

The setting belongs to repo isolation, independently of provider authentication.
The current Claude-backed session VM adds it to the required Anthropic API host.
Other repo entries retain their own policy; packaged MCPs stay offline.
Entries are exact DNS names (case-insensitive), HTTPS port 443 only: no URLs,
wildcards, IP literals or alternate ports. Redirects to another host need their
own entry. Direct guest IP networking remains disabled. Subprocesses inherit the
local proxy settings, and must use that proxy for external connections.

Policy is captured at launch. Restart the daemon and resume affected sessions to
apply changes, including revocations. Existing VM connections are not hot-updated.

Credential-free acceptance test, using the selected repo policy in a disposable
worktree: installs an npm dependency with a fresh Deno cache, then checks denied
hosts, ports and direct IP access.

```sh
nix develop --command deno run -A scripts/test-claude-vm-egress.ts ~/dev/loom
```

## Supervised lifecycle

VM routing is opt-in. Without the configuration below, Claude uses the host
worker. The Claude artifact is not pulled into the default Loom package.

`launchSessionVm` now returns the existing `WorkerProcess` contract. The live test
uses this launcher rather than owning the VM itself. A detached host supervisor
owns the CONNECT proxy and VM. Parent EOF is observed during startup
and execution; guest-exec failure also stops the session. Normal
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
permissions. Standard daemon/TUI launch paths now grant only the daemon Unix
socket; networked provider, catalog and title work runs in children.

## Renewable authentication

`launchSessionVm` accepts a shared `ClaudeAuthOwner` instead of static `auth`.
This keeps refresh tokens in the host profile, renews before expiry, and
distributes access-only snapshots to active sessions.
The follow-up implementation is `ClaudeAuthOwner` in the daemon package. Callers
share one owner per provider profile and pass it as `authOwner` to
`launchSessionVm`. Close the owner when its provider shuts down. The VM launcher
unsubscribes on exit and waits for an in-flight publication before fallback cleanup;
publication cannot recreate a removed session directory.

The owner reads the host Claude profile, refreshes five minutes before expiry,
and polls once per second for credentials updated by other host Claude processes.
`current(true)` requests an immediate refresh. A narrow Deno subprocess exchanges
the refresh token directly at `https://platform.claude.com/v1/oauth/token`; the
daemon retains `--deny-net`. The helper can access only the selected profile,
its native refresh lock, and that HTTPS endpoint (plus Keychain on macOS).
It neither runs `claude auth login` nor clears account configuration. It preserves
unrelated credential fields and writes the existing storage backend: atomic
mode-0600 file replacement, or the exact Keychain entry used to read credentials.

A per-profile OS file lock serializes Loom owners. The helper additionally uses
Claude's `proper-lockfile` directory convention, `realpath(profile) + ".lock"`,
with a five-second heartbeat and ten-second stale threshold. It rereads after
acquiring that lock and immediately before persistence, recognizing another
process's rotation or explicit login. Refresh tokens never enter VM snapshots.
No model request, user hook, plugin, or MCP server runs during renewal.

Refresh attempts have a 60-second timeout; waiting for the profile lock has a
70-second timeout and is cancellable. Transient failures retain a still-valid
token and retry with exponential backoff up to 60 seconds. Only a structured
`invalid_grant` response from the token endpoint on HTTP 400/401 stops retries
and requires login; bare HTTP statuses remain retryable. Logs retain status and
allowlisted error codes, never raw response bodies. A changed host credential
is picked up automatically. Independent per-subscriber expiry timers
stop a session whose last published credential expires, even during a blocked
refresh or failed publication. Closing the owner revokes its attached sessions.

The guest bootstrap links its local `.credentials.json` to the read-only
access-token snapshot. No fixed OAuth environment variable is set in managed
mode. Refreshed snapshots are atomically replaced with mode 0600. Host publication
is not an acknowledgement from Claude itself; refreshing five minutes early
provides margin for the measured guest propagation delay. An early provider 401
requests one forced host refresh per mounted session. The error remains visible
immediately; Loom never automatically replays the turn, which may have run tools.

Real refresh and two-VM distribution have now been verified: Claude returned a
fresh token with eight hours of validity, both VMs observed the updated snapshot,
and the same native Claude process completed another turn. Run this acceptance
check with the rebuilt artifact:

```sh
deno run -A scripts/test-claude-auth-vm.ts \
  /path/to/claude-artifact /path/to/smolvm /path/to/host-claude
```

Unlike replacement-only spikes, these commands **refresh the host Claude
profile**. Run `deno run -A --deny-net scripts/spike-claude-refresh.ts /path/to/profile`
to verify the direct exchange, access-only snapshot, and preservation of account
configuration and unrelated credential metadata. The previous live two-VM check
used CLI login-based renewal; repeat it with the updated artifact for VM acceptance.

## Daemon integration

The Linux Nix package bundles the runtime. Opt in for all providers in this project:

```jsonc
{
  "session": {
    "isolation": {
      "enabled": true,
    },
  },
}
```

Each regular Claude session gets its own VM. Discovery and one-shot title jobs
still use host workers. Initial login stays on the host; the credential owner handles renewal. API-key and explicit OAuth-token
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

Sessions retain their saved execution choice when the configured default changes.
Unavailable histories remain readable; use a continuation fork to change provider
or execution environment. See [isolation](isolation.md) and
[TUI state](tui-state.md) for fork and startup behavior.

Configured HTTP MCP workers and packaged MCP runtimes are forwarded into the VM
through individual Unix/vsock endpoints. Each relay connects only to its assigned
host loopback port and preserves HTTP authentication. Guest IP networking stays
disabled. Arbitrary host stdio commands are rejected for VM sessions; package them
as a runtime first.

Live daemon acceptance (consumes Claude usage):

```sh
nix develop --command deno run -A scripts/test-claude-vm-daemon.ts \
  /path/to/session-runtime /path/to/smolvm /path/to/claude
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
stamp, revokes credentials and asks smolvm to reap the machine. History and worktrees are retained; recovery does not restart the conversation.
Old bridge-based active markers require shutdown with the previous Loom version
before upgrading.

Archive/delete hold the ownership lock through recovery and removal. Resume retries
recovery before launching. A durable completion marker makes interrupted state
removal retryable. Startup stops admitting cleanup after 30 seconds, and individual
commands/waits are bounded. Failures are reported on the affected session without
preventing the rest of the daemon from starting.

If temporary state is missing or a record is incompatible/corrupt, the session stays
blocked for inspection. We deliberately do not guess which host PIDs to kill.
Records from the earlier process-tracking implementation require manual recovery.

Recovery uses the same supervisor contract on Linux and Apple Silicon macOS.
On macOS, temporary state uses canonical paths and a short directory name to
leave room for smolvm's Unix sockets. See [packaging](packaged-runtimes.md) and
the [remaining validation work](roadmap.md#validation).

Credential-free acceptance test for a ready VM whose two owners are killed:

```sh
nix develop --command deno run -A scripts/test-claude-vm-recovery.ts \
  /path/to/session-runtime /path/to/smolvm
```

Unit tests cover blocked startup/missing-state cases, retryable cleanup, ownership
substitution and locking.

## Project controls

Repository overrides and execution defaults are described in [isolation](isolation.md).
Set `repos[].session.provider_access.only` to restrict a project to selected profiles,
or `disabled` to exclude profiles. Remove development runtime pins to follow package
upgrades. Restart the daemon after changing provider or isolation policy.

## Startup timing

The host caches immutable smolvm base disk templates keyed by the smolvm executable.
Session overlays, credentials and workspaces remain private. A missing or unusable
cache falls back to normal boot.

Logs distinguish `session_start` / `session_resume_start`, `worker_ready`,
`adapter_ready` and `first_output` by session id. Worker readiness measures its
connect/initialize phase; adapter readiness includes provider create/resume (and
VM/auth setup); first output measures from create or the latest idle-session send.
They are observable software boundaries, not separate DNS/TLS/model-inference
timers. Durations use a monotonic clock. No provider request bodies are logged.

## macOS credentials

The host credential owner reads Claude Code's macOS Keychain entry, falling back
to the profile's `.credentials.json` when no usable Keychain entry is available.
Named profiles use their own service names; they never borrow the default
profile's credentials. The host credential owner refreshes and persists tokens
through the same storage backend.
Only access-token snapshots enter session VMs.

## File-limit failures

Large dependency installs can exhaust the Linux host VM backend's file-descriptor
limit, causing unrelated guest reads—including credential reads—to fail with
`EMFILE`. Raising only the guest limit does not help. Follow the host-limit
[troubleshooting guidance](session-environments.md#advanced-vm-setup).
Re-login does not address descriptor exhaustion. A generic authentication failure
alone is insufficient evidence that this is the cause.
