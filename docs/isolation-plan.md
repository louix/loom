# Isolation

## Current boundaries

- Built-in connectors run in session-bound Deno workers. Utility jobs (models,
  titles, enumeration) use short-lived host workers. Deno grants do not confine
  native subprocesses; native host workers remain trusted.
- With its provider VM policy configured, each Claude, AISDK or Codex session gets a separate
  smolvm with its own writable profile and its own worktree. It can read and
  modify code. There is no shared provider VM mounting several worktrees.
- The host owns OAuth refresh and sends access-only credentials to those VMs.
  Native history persists across shutdown; archive/delete stop the VM first.
- smolvm denies direct egress. A shared host HTTPS proxy checks each VM's host
  allowlist; private relays expose its MCP endpoints. Claude needs
  `api.anthropic.com`; trusted per-repo config can add dependency registries.
- Packaged command MCPs such as Tilth run in their own offline VMs. External
  services use HTTP MCP relays with separate credentials and Deno grants.
- Host Git operations go through a session-scoped bridge, with repository
  program execution disabled by default. See its documented command limits.
- The daemon remains trusted with config, credentials, database, Git and VM
  lifecycle. Standard daemon/TUI launch paths permit only the repository's daemon
  Unix socket, with no direct TCP/HTTP permission. Networked work runs in children.
  This is a Deno capability boundary, not OS confinement of trusted subprocesses.

The provider VM can read its access credential and worktree. This design does
not promise credential secrecy from code running inside that same VM.

## Configuration and operation

User-owned `~/.config/loom/config.toml` holds global policy and exact-path
`[[repo]]` overrides. Repository files cannot grant themselves network access.
`[repo.provider_access]` selects providers; `[repo.isolation.claude] enabled =
false` disables an inherited VM policy. Restart the daemon after policy changes.
Incompatible or unavailable sessions remain readable and can be continued by
forking into an enabled provider with the current isolation policy.

- [Claude VMs, authentication, recovery and project controls](claude-session-vm.md)
- [Packaged MCP runtimes and Nix variants](packaged-runtimes.md)
- [Git bridge operations and security policy](guest-host-bridge.md)
- [Connector protocol and authoring](connectors.md)

## Remaining work

1. Broaden live-provider validation: AISDK Google/native Anthropic have not had
   VM smoke tests. Codex native VM rotation, 401 recovery and failed-renewal expiry
   shutdown are verified against local fixtures; natural live OAuth expiry remains
   untested. See [AISDK](aisdk-session-vm.md) and [Codex](codex-session-vm.md).
2. Finish the live macOS acceptance checks recorded in the
   [validation record](review-2026-09/macos.md). Linux guest artifacts are built
   separately from the native host launcher.
3. Consider removing provider filesystem and registry access only as a separate
   policy change. It is intentionally available today.

Earlier worker and shared-provider-VM proposals are retained in Git history.
They are not the current topology or an additional implementation requirement.

Latest bounded review: [isolation and TUI follow-ups](review-2026-09/session-isolation-followups.md).

## Host launch and diagnostics

The CLI starts without network permission, resolves the repository, then re-execs
with an exact `unix:<repo>/.loom/daemon.sock` grant. Deno 2.9 requires net permission
for Unix IPC too. Daemon autospawn uses the same grant. Filesystem, environment,
process and FFI capabilities remain trusted. Custom embedded daemon callers must
apply their own launch grants; importing `Daemon` does not change permissions.

OpenAI-compatible catalog probes have a separate worker restricted to the endpoint
host/port; redirects cannot broaden it. Provider workers receive their endpoint and
assigned HTTP MCP destinations. Native CLI subprocesses require VM isolation for
OS-level confinement.

Daemon logs include `session_start` / `session_resume_start`, `worker_ready`,
`adapter_ready` and `first_output`, correlated by session id. Durations use a
monotonic clock and contain no prompts, tokens or API response bodies.
