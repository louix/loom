# Claude credential replacement spike

The per-session VM design can use access-token-only credential snapshots. Claude
2.1.245 reloads a replaced `.credentials.json` without restarting its process.
The host profile and refresh token were not modified by these experiments.

## Findings

- **Native CLI, one query:** start with an invalid access token. A local test
  endpoint returns 401 and atomically installs the real access token. The same
  query retries successfully against Anthropic. No refresh token is present in
  the test profile.
- **Native CLI, three turns:** valid token succeeds; an invalid replacement is
  observed in the next request and rejected; restoring the valid token succeeds
  on the third turn. The test logs credential identity as booleans, never tokens.
- **VM, three turns:** the same valid/invalid/valid sequence works with the
  credential file supplied through the existing read-only private mount and a
  symlink from the guest Claude directory. The native Claude PID stays unchanged.
- **Propagation matters:** immediately sending after the host rename initially
  used the previous credential. The successful VM test waits for a non-secret
  generation marker to become visible inside the guest, then waits another 500ms.
  This is an observed settling interval, not a guaranteed delivery bound.
- A guest-local polling/copy loop also passed. It is an optional alternative,
  not needed for the successful direct-mount experiment.

The native SDK can report `subtype: "success"` alongside `is_error: true` for
an authentication failure. The native test checks both request identity and
`is_error`; the VM test checks actual assistant output and Loom's result.

## Shape for integration

One credential owner per provider profile handles refresh and keeps the refresh
token outside session VMs. On changes, publish `{claudeAiOauth: {accessToken,
expiresAt, scopes}}` to each active session's private directory using a temporary
file plus atomic rename. A session's writable Claude directory links its
`.credentials.json` to that read-only snapshot. Do not also set
`CLAUDE_CODE_OAUTH_TOKEN`: that environment variable takes precedence over the
credential file and is fixed for the process lifetime.

Publish before expiry and account for propagation; the integration should not
assume that returning from a host write means every guest has observed it. Keep
persistent Claude history separate from the ephemeral credential snapshot.

This spike verifies replacement and recovery, including a simulated 401. It does
**not** exchange a real refresh token, implement the refresh owner or fan-out,
measure a natural eight-hour expiry, or test refreshing during an active tool
call/stream. It makes no production launcher changes.

## Reproduce

These are opt-in live tests which consume a few short Haiku responses. They read
the existing unexpired login access token from `CLAUDE_CONFIG_DIR` or `~/.claude`;
only access token, expiry and scopes enter temporary session state. Temporary
credentials are removed on ordinary completion/failure and VM supervisor cleanup.

```sh
# Native CLI retry after 401, then replacement between turns.
deno run -A scripts/spike-claude-auth.ts /path/to/claude
deno run -A scripts/spike-claude-auth.ts /path/to/claude rotate

# Existing opt-in Claude artifact; smolvm available from nix develop.
deno run -A scripts/spike-claude-vm-auth.ts /path/to/claude-artifact /path/to/smolvm
# Optional guest-local sync comparison:
deno run -A scripts/spike-claude-vm-auth.ts /path/to/claude-artifact /path/to/smolvm sync
```

Claude also documents a separate, one-year inference token from
[`claude setup-token`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
That is an alternative provisioning choice, not the ordinary login access token
used in these experiments.

## Implemented credential owner

The follow-up implementation is `ClaudeAuthOwner` in the daemon package. Callers
share one owner per provider profile and pass it as `authOwner` to
`launchSessionVm`. Close the owner when its provider shuts down. The VM launcher
unsubscribes on exit and waits for an in-flight publication before fallback cleanup;
publication cannot recreate a removed session directory.

The owner reads the host Claude profile, refreshes five minutes before expiry,
and polls once per second for credentials updated by other host Claude processes.
`current(true)` requests an immediate refresh. It invokes the pinned CLI's
`claude auth login --claudeai` with the refresh token and scopes in the child
environment; the CLI persists any rotated refresh token. It never logs raw CLI
output or passes a refresh token into a VM. A per-profile OS file lock serializes
Loom owners across processes, with a second credential read after locking to avoid
repeating a completed refresh. This lock does not coordinate unrelated Claude
processes; the owner rereads persisted credentials after failures to recognize
concurrent or partially completed rotations.

Refresh attempts have a 60-second timeout; waiting for the profile lock has a
70-second timeout and is cancellable. Transient failures retain a still-valid
token and retry with exponential backoff up to 60 seconds. A rejected refresh
token requires login instead of repeated automatic exchanges. A changed host
credential is picked up automatically. Independent per-subscriber expiry timers
stop a session whose last published credential expires, even during a blocked
refresh or failed publication. Closing the owner revokes its attached sessions.

The guest bootstrap links its local `.credentials.json` to the read-only
access-token snapshot. No fixed OAuth environment variable is set in managed
mode. Refreshed snapshots are atomically replaced with mode 0600. Host publication
is not an acknowledgement from Claude itself; refreshing five minutes early
provides margin for the measured guest propagation delay. Automatic recovery from
an early API 401 is not yet connected to `current(true)` at the daemon layer.

Real refresh and two-VM distribution have now been verified: Claude returned a
fresh token with eight hours of validity, both VMs observed the updated snapshot,
and the same native Claude process completed another turn. Run this acceptance
check with the rebuilt artifact:

```sh
deno run -A scripts/test-claude-auth-vm.ts \
  /path/to/claude-artifact /path/to/smolvm /path/to/host-claude
```

Unlike the earlier replacement-only spikes, this command **does refresh the host
Claude profile** using the CLI's normal credential persistence. The narrow
`spike-claude-refresh.ts /path/to/host-claude` command exercises just that exchange.
The main daemon still uses its existing connector launcher; durable VM history,
resume and archive/delete integration remain separate work.
