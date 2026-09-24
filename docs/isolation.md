# Session isolation

Local execution is the default. Set `session.isolation.enabled: true` in
`~/.config/loom/config.jsonc` to default to VMs, or override it under
`repos[].session`. This setting chooses the default; it does not prohibit an
explicit VM choice. Use `loom run --isolation vm` or the new-session prompt's
`Alt+i` to choose per session. VM execution requires a worktree and an available
runtime; see [packaged runtimes](packaged-runtimes.md).

Sessions retain their execution choice through restart and resume. To change it,
fork the session with `F`, then change isolation with `i`. Cross-environment
forks start a fresh provider session with saved conversation context.

## Boundaries

- Each VM session has separate execution, writable provider state and credentials.
  The host owns OAuth refresh and supplies access-only snapshots to provider VMs.
  Code inside a provider VM can read that VM's access credential.
- Agent VM direct networking is disabled. A host HTTPS proxy checks exact allowed
  destinations; trusted user configuration can add dependency registries.
  Repository files cannot grant themselves network access.
- The default `checkout.mode: "mount"` exposes the repository, selected worktree
  and shared Git metadata. Agent-written Git hooks/config can affect later host
  Git commands. Worktrees nested in the repository are also exposed.
- Opt-in `checkout.mode: "clone"` mounts a private workspace instead. A host Git
  relay accepts pushes only to the session branch; host Git never executes the
  clone's hooks/config. Repository history is still considered readable.
  See [repository access](repository-mounts.md) for limitations.
- Local MCP servers configured under `mcp_servers` run in separate VMs with
  explicit workspace and network grants. HTTP MCP credentials stay in host
  relays. Legacy host tools remain trusted, unsandboxed integrations and cannot
  be selected by VM agents. See [tools](tools.md).
- The daemon remains trusted with configuration, credentials, files, Git and VM
  lifecycle. Standard CLI/TUI/daemon launches allow only the repository's Unix
  socket; networked work runs in children. Deno permissions do not confine native
  subprocesses or custom embedded callers.

Permission modes control approval behavior; they do not change these filesystem
or network boundaries.

## Configuration and operation

Only the trusted user configuration is read. Use `repos[].path` for repository
overrides and `session.provider_access` to restrict providers. Restart the daemon
after changing isolation or provider policy. Unavailable sessions remain readable
and can be continued by forking into an enabled provider.

- [Claude VMs](claude-session-vm.md): authentication, recovery and diagnostics.
- [Codex VMs](codex-session-vm.md): subscription authentication and native history.
- [AI SDK VMs](aisdk-session-vm.md): API-provider execution and acceptance commands.
- [Session environments](session-environments.md): Nix activation, preparation,
  private workspaces, shells and cleanup.
- [Roadmap](roadmap.md): remaining validation and proposals.
