# Claude session VM experiment

The opt-in runtime runs the existing Claude connector worker and native Claude
inside one smolvm guest. The normal framed worker protocol travels through
smolvm's exec/vsock transport. The guest mounts only the prepared closure,
a disposable session worktree and a private credential snapshot. Git operations
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
only the allowed Anthropic API endpoint, and a host-visible commit. Fresh login,
OAuth refresh, extended conversations and other models have not been validated.

## Before normal session integration

This is an explicit experiment, not a default connector launcher. Existing
Claude sessions continue using the current host worker. The Claude artifact is
not pulled into the default Loom package.

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
Other state is retained on cleanup failure for diagnosis. Simultaneously killing
both parent and supervisor, or losing the host, still needs a startup orphan sweep;
there is no claim of recovery from those cases yet.

Run the lifecycle acceptance checks without live credentials:

```sh
nix develop --command deno run -A scripts/test-claude-vm-lifecycle.ts \
  /tmp/loom-claude-session-artifact /path/to/smolvm
```

These exercise normal close, startup EOF (including after Git startup), guest-exec,
Git-worker and supervisor SIGKILL, and actual parent SIGKILL during startup and after
worker initialization. Regression tests cover proxy cancellation/connection limits
and credential revocation when VM cleanup fails.

Production work remains: per-session durable profile/history and resume; MCP
endpoint forwarding into the guest; daemon launcher selection; moving the egress
proxy into a scoped worker; and recovery after loss of both owner processes. The
supervisor is trusted host infrastructure and currently runs with full Deno
permissions. This does not yet provide the intended network-free daemon boundary.
