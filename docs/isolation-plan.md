# Isolation

## Current boundaries

- Claude and mock connectors run in session-bound Deno workers. Claude utility
  jobs (models, titles, enumeration) use short-lived host workers. Deno grants
  do not confine native subprocesses.
- With `[isolation.claude]` configured, each Claude session gets a separate
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
  lifecycle. Daemon/TUI network permission removal is unfinished.

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

1. Move Codex sessions across the VM boundary with packaged native execution,
   private durable history and credential lifecycle handling. AISDK session VMs
   now use a session-scoped host transcript channel; see [AISDK VMs](aisdk-session-vm.md).
2. Move remaining catalog/title network calls out of the daemon, then remove
   daemon/TUI network grants.
3. Implement the macOS host runtime backend while preserving Linux guest
   artifacts. Current production VM execution is Linux/KVM.
4. Consider removing provider filesystem and registry access only as a separate
   policy change. It is intentionally available today.

Earlier worker and shared-provider-VM proposals are retained in Git history.
They are not the current topology or an additional implementation requirement.
