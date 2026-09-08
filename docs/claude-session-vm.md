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
and removed on normal cleanup. Claude can read its own guest credentials; this
experiment does not attempt to hide API credentials from the agent.

This is a **live** acceptance test that consumes Claude usage: Claude creates a file and commits it
in a temporary linked worktree. The test also checks that real host metadata and
the host credential file are absent, direct IP connections fail, and a proxy
request to `example.com:443` is denied. Failed Git fixtures are retained without
the temporary credential copy. The normal test suite covers proxy denial cases
without making API requests.

Verified using smolvm 1.8.1 and native Claude 2.1.245: an existing OAuth token,
only the allowed Anthropic API endpoint, and a host-visible commit. Fresh login,
OAuth refresh, extended conversations and other models have not been validated.

## Before normal session integration

This is an explicit experiment, not a default connector launcher. Existing
Claude sessions continue using the current host worker. The Claude artifact is
not pulled into the default Loom package.

Production work remains: per-session durable profile/history and resume; MCP
endpoint forwarding into the guest; daemon launcher selection; moving the egress
proxy into a scoped worker; and parent-death/forced-crash cleanup for this combined
launcher. The test runner currently has host permissions and cleans up on normal
exit/error; do not treat it as the finished daemon supervision boundary.
