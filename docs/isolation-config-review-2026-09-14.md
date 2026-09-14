# Isolation and configuration architecture review

Review of the working tree on 2026-09-14. Recommendations below are proposals,
not implemented configuration. Existing unrelated working-tree edits were left
alone. This reviews Loom as a product; the separate isolation-only fork proposal
is not treated as current behavior. Verification was source inspection, not live
provider or VM execution.

## Assessment

The implementation has useful execution boundaries, but configuration exposes
their implementation details before explaining the user's choices. Four concerns
need distinct names: checkout, execution, tools, and development environment.
Permission prompts are a fifth concern: they govern approval behavior, not the
VM's filesystem or network authority.

The clearest concrete problem is that opting into agent VM isolation does not
produce a usable configuration from the shipped defaults: those defaults select
host Tilth and fff commands, which the VM provider rejects.

## What happens today

| Choice                                      | Actual behavior                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Default session                             | Host agent execution, separate Git worktree, host `tilth` and `fff-mcp` requested.                                          |
| `--in-place` / `[worktree] enabled = false` | Changes checkout choice. Does not turn agent VM configuration off.                                                          |
| `[isolation.claude/codex/aisdk]`            | Chooses agent VM execution by engine family. Tool selection remains the same.                                               |
| MCP `command = "tilth"`                     | Uses the host executable; bundling the Tilth VM does not satisfy this command.                                              |
| MCP `runtime = "tilth", isolation = "vm"`   | Separate offline Tilth VM per session, usable by host agents and VM agents.                                                 |
| HTTP MCP                                    | Daemon-managed per-session restricted relay to the configured service; VM agents receive a fixed relay endpoint.            |
| `default_for`                               | Preference for advertised capabilities. Does not install a tool, select a sandbox, or restrict tools to those capabilities. |
| `isolation.environment`                     | VM base preparation/settings. Does not configure the host development environment.                                          |
| Init hooks                                  | Run once for a new conversation in its execution environment, including on the host for host sessions.                      |

Agent VMs accept only daemon-managed HTTP endpoints, including those produced by
packaged MCP VMs. Host command MCP entries are rejected. A host agent can use a
Tilth VM without itself being VM-isolated; that confines Tilth only.

In-place plus VM is inconsistent across the lifecycle: session creation passes
the checkout choice through, while resume explicitly rejects VM-backed in-place
sessions. It should not be presented as a supported combination until creation,
resume, archive, and fork agree.

Sources: [defaults and normalization](../backend/daemon/src/config/config.ts),
[MCP ownership](../backend/daemon/src/daemon/mcp-provider.ts),
[VM MCP validation](../backend/daemon/src/daemon/vm-provider.ts),
[creation and resume](../backend/daemon/src/daemon/daemon.ts),
[Claude resume validation](../backend/daemon/src/daemon/session-vm-state.ts),
[package wrapper](../flake.nix).

## Where the boundaries are unclear

1. **A security choice depends on the selected provider.** A repo can enable
   Claude VMs while other engines remain on the host. Changing providers can
   therefore change execution authority. Engine-specific runtime selection is
   necessary internally, but should sit below a repo/session execution policy.
   A requested VM policy should fail if an engine cannot support it.

2. **Tool definition also means tool selection.** Every configured command/HTTP
   MCP is mounted into ordinary sessions. There is no separate catalog and
   selection. Repo arrays replace the inherited arrays wholesale: changing Tilth
   requires restating the other command MCPs you still want. Package inclusion,
   availability, selection, preference, and actual connection are different
   states, but are easy to confuse.

3. **Tilth has two installation contracts hidden behind one name.** The normal
   package bundles its VM artifact; the default config asks for a host binary.
   Missing host Tilth gets a log note, and AISDK skips failed MCP connections.
   A missing packaged runtime fails startup. Required versus optional tools
   should be a declared choice, not a consequence of transport or connector.
   Switching to VM execution also requires replacing/removing the default fff
   command, not merely changing Tilth.

4. **“Included in isolation” has several meanings.** Guest executables come
   from the runtime and prepared base; MCPs are separately selected services;
   filesystem mounts and network destinations are grants; credentials have
   separate ownership. Network presets allow downloads but do not install
   programs. The current schema gives packaged MCPs fixed repository access and
   no networking; users cannot choose arbitrary per-MCP mounts/hosts.

5. **Worktree separation is not a security boundary.** The VM mount resolver
   includes the repository containing shared Git metadata. With the usual
   `.loom/trees` layout, other worktrees are visible too. The current promise is
   confinement outside granted repository mounts, not isolation from sibling
   sessions. UI copy should say “separate branch/worktree” and show actual mounts.

6. **Diagnostics describe parts rather than the selected launch.** Doctor can
   report a host executable as available even though the chosen VM engine rejects
   it. The TUI exposes in-place Git state and environment preparation warnings,
   but lacks one complete execution/tool/access summary. Config changes can also
   make existing conversations unresumable; that deserves an explicit transition
   model rather than discovery after restart.

7. **Environment lifecycle and documentation are difficult to follow.** Runtime
   preparation, repo-base preparation, and per-conversation initialization are
   distinct useful operations. Their names and examples should make this clear.
   The example config still discusses early milestones, suggests preparing bundled
   Tilth, and describes some repo overrides with older terminology. Packaged-runtime
   docs also contain older claims about cleanup, optional outputs, and guest Nix
   that conflict with newer sections or session-environment documentation.

Sources: [config merge/selection](../backend/daemon/src/config/config.ts),
[provider routing](../backend/daemon/src/daemon/provider-registry.ts),
[Tilth resolution](../backend/daemon/src/daemon/mcp-fallback.ts),
[AISDK connection failures](../aisdk/src/mcp.ts),
[mount expansion](../runtime/src/packaged/workspace.ts),
[doctor](../backend/daemon/src/daemon/daemon.ts),
[config example](../backend/daemon/config.example.toml),
[environment lifecycle](session-environments.md),
[packaged runtimes](packaged-runtimes.md).

## Proposed user model

Give each repo defaults for four explicit choices, visible when starting a session:

- **Checkout:** current checkout or new worktree.
- **Execution:** host or VM. Apply this across engines; resolve the appropriate
  runtime internally. Unsupported combinations fail before allocating resources.
- **Tools:** selected named integrations, with execution location and availability.
- **Environment:** host environment, or a named prepared VM development environment.

For Tilth, separate selection from placement. Enabling Tilth should mean its tools
are requested regardless of where the agent runs. Expose two explicit variants
initially: `tilth-host` and `tilth-vm`. The latter works with either agent execution
mode and remains a separate offline tool VM. Do not silently substitute host
execution if a requested VM cannot start. Do not automatically move a host MCP
into the agent VM: its binary, dependencies and authority may not be equivalent.

Keep tool definitions and credential references in trusted user configuration.
Repo overrides select definitions by name. Preserve exact canonical path matching
and the rule that repo files cannot expand trusted configuration.

Illustrative syntax, **not accepted by the current parser**:

```toml
[tools.tilth-host]
kind = "command"
execution = "host"
command = "tilth"
args = ["--mcp", "--edit"]

[tools.tilth-vm]
kind = "packaged"
runtime = "tilth"

[environments.project-dev]
nix = true
command_prefix = ["nix", "develop", "path:.", "--no-write-lock-file", "--command"]
network_presets = ["nix", "javascript"]

[[repo]]
path = "~/dev/project"

[repo.session]
checkout = "worktree"
execution = "vm"
environment = "project-dev"
tools = ["tilth-vm"]

[repo.tool_preferences]
read = "tilth-vm"
edit = "tilth-vm"
```

Host sessions could instead select `execution = "host"`, omit the VM environment,
and select either Tilth variant. A user who wants no VMs selects host execution
and host tools; a user who wants only Tilth confined selects host execution and
`tilth-vm`. Tool selection should be required by default; optional tools need an
explicit declaration and a visible degraded status on failure.

Avoid introducing general profile inheritance immediately. Named definitions
plus a complete selected-tool list provide reuse without permission unions that
are difficult to explain. Reject unknown names and incompatible selections.

## Proposed architectural seam and UX

Introduce one resolved session launch plan:

```text
Trusted defaults + repo selection + session choices
                        |
                 resolve and validate
                        |
  Launch plan: checkout, engine/runtime, tools, environment,
               mounts, network, credential references
                 /                     \
        CLI/TUI/doctor              lifecycle launcher
```

The resolver owns selection, provenance, compatibility checks and the description
of intended authority. Launchers own enforcement and lifecycle. Connectors adapt
agent protocols and consume the resolved configuration; they should not discover
the basic tool/execution incompatibility after external workers have started.
Runtime installation remains independent of selecting capabilities for a session.

Use the same plan for a proposed `loom config explain --provider ...`, the new
session summary, and startup. Show selected versus connected tools separately.
Example:

```text
Checkout    New worktree
Agent       Claude · VM
Tools       Tilth · separate VM · offline · required
Environment project-dev · prepared
Files       Repository read/write, including shared Git metadata
Network     Provider hosts + nix/javascript presets [expand exact hosts]
```

Store the session's resolved execution identity and references, never plaintext
credentials. Config edits change new-session defaults. For existing sessions,
detect incompatible policy changes and offer an explicit fork/migration path;
do not silently change execution mode or continue revoked access. Prepared-base
refresh remains its own supported idle-session transition.

## Suggested implementation order

1. Add a launch compatibility resolver and expose its result in doctor/startup.
   Catch VM + host MCP and the in-place/resume inconsistency before creation.
   Validate missing artifacts and required selections before creating a worktree
   or launching MCPs.
2. Fix shipped examples and documentation around three supported journeys: host
   agent with host tools, host agent with a Tilth VM, agent VM with a Tilth VM.
   Show the actual mount boundary and explain all three preparation/init stages.
3. Split tool definitions from selection; add explicit required/optional behavior.
   Migrate old arrays to named definitions and preserve their effective selection.
4. Promote host/VM execution to a session/repo policy, leaving engine artifact
   overrides as advanced settings. Add the shared launch summary to the TUI.
5. Align in-place VM creation/resume semantics, then decide whether to support
   that combination fully. Individual MCP grants or a standalone isolation product
   are separate expansions, not prerequisites for cleaning up Loom's UX.

Tests should focus on observable combinations and transitions: defaults into VM
mode, both Tilth placements with host agents, rejected host tools with VM agents,
missing required tools, repo selection replacement, engine switching, and resume
after policy changes. Run real VM checks for enforcement and mount claims;
resolver tests alone cannot establish those properties.
