# Codex session VMs

ChatGPT/Codex profiles can run native `codex app-server` in a separate Linux VM
per session. The guest artifact includes the pinned Codex executable; the host
still needs Codex for model discovery, titles and credential renewal.

```sh
nix build .#codex-session-runtime --out-link /tmp/loom-codex-runtime
```

```toml
# ~/.config/loom/config.toml; also valid under [repo.isolation.codex]
[isolation.codex]
enabled = true # use the runtime bundled with the Linux Nix package
```

`enabled = false` disables an inherited policy. Restart the daemon after changes.
AISDK and Claude VM policies are independent. Old host sessions remain readable;
fork them to continue under the new policy.

## Files, network and lifecycle

The VM mounts only its worktree, packaged runtime, private native profile and
session-scoped bridges. Codex history survives VM shutdown and is used by
`thread/resume` in a fresh VM. Archive/delete stop the VM before removing the
profile or worktree. Host Git is available through the existing bridge; native
shell and filesystem tools run inside the VM.

Direct egress is disabled. The host HTTPS proxy permits `chatgpt.com:443` plus
trusted `isolation.extra_allowed_hosts` for worktree commands. MCP endpoints use
private relays. Native web search remains controlled by the provider's existing
`codex_builtin_web_search` setting.

## Authentication

One host credential owner per profile reads Codex's `auth.json`. It sends only
access token, identity token and account id to private read-only guest snapshots.
The refresh token stays in the host profile. Guest `auth.json` links to the
snapshot and carries an empty refresh token.

The owner refreshes ten minutes before expiry, ahead of native Codex's own
five-minute proactive refresh window. It shares Claude's tested lifecycle: per-profile
OS locking across Loom daemons, one-second polling, serialized atomic publication,
retry backoff and independent expiry timers that terminate a VM whose last
published credential expires. Renewal uses a short-lived host `codex app-server`
with `account/read { refreshToken: true }`; Codex persists rotated credentials.
Unrelated host Codex processes do not participate in Loom's lock. A rejected
refresh requires host login; errors do not include credential/native stderr data.

A live probe against the pinned Codex version confirmed an access-only profile
can recover after its invalid token file is replaced with a valid one. This uses
normal file authentication, not the unstable internal `chatgptAuthTokens` login
interface. The native VM fixture also verifies renewal during an active stream,
401 recovery in the same process, and VM shutdown at expiry when renewal fails.

## Verification

The deterministic credential tests cover coalescing, lock contention, expiry,
publication failures and stripping refresh secrets. The opt-in live acceptance
check starts a turn, resumes the native thread in a fresh VM, recalls earlier
context, switches mode and writes a file using the guest's native shell:

```sh
deno run -A scripts/test-codex-session-vm.ts ARTIFACT SMOLVM HOST_CODEX PROFILE_DIR
```

It uses a throwaway Git fixture and three short provider turns. It may refresh the
selected host profile if its token is near expiry. Verified with pinned Codex
0.149.0 on Linux/KVM; newer host Codex can own the same profile.

The credential boundary check uses real native Codex and smolvm against local
synthetic OAuth and model endpoints, without reading or changing your login:

```sh
deno run -A scripts/test-codex-auth-vm.ts ARTIFACT SMOLVM HOST_CODEX
```

It holds a model stream open while the host performs a native refresh exchange,
checks guest publication excludes the refresh token, then returns a 401 for the
cached token and verifies recovery without restarting Codex. A second open stream
survives until a deliberately short-lived credential expires; failed renewal must
then stop the VM promptly. Verified with pinned Codex 0.149.0 on Linux/KVM.
This exercises controlled expiry and server rejection, not a wait for a real
OpenAI-issued token to expire or a live OAuth authority exchange.
