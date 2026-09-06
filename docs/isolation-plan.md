# Isolation plan

Implement this after [provider parity](chatgpt-provider-plan.md). That change set
supplies local, session-bound tool dispatch, injectable process launch, explicit
provider/workspace paths and separate session/thread/process lifetimes. This
workstream supplies worker RPC, production VMs and security enforcement. Optional
VM smoke tests during parity development validate interfaces, not isolation.

The end state: one trusted host daemon; one smolvm per session worktree; isolated connector and Kagi workers; all host Git operations exposed through session-scoped tools.

| Component        | Execution environment                                                                       | Authority                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| TUI              | Existing host process                                                                       | Daemon IPC; no credentials supplied                                                      |
| Daemon           | Existing trusted host process                                                               | Config, credentials, session database, host Git, worker and VM lifecycle                 |
| JS/TS connector  | Separate Deno process per session                                                           | Its provider endpoints, its credential, private state; no workspace, subprocesses or FFI |
| Native connector | One smolvm per provider account/profile; separate process and broker connection per session | That profile's endpoints, credentials and provider state; no worktree mounts             |
| Workspace tools  | One smolvm per session                                                                      | Worktree RW, private scratch/cache; no credentials; network disabled by default          |
| Kagi client      | Separate Deno process                                                                       | Kagi endpoint and credential only; receives search/extract arguments                     |

The daemon requires no direct internet calls, but remains trusted with ordinary host-process permissions. Deno restrictions apply to workers, not the daemon.

Three Codex sessions sharing a profile use four VMs: one provider VM and three
workspace VMs. Sharing a provider VM accepts a common failure and provider-state
trust boundary; different accounts/profiles stay separate. Processes sharing
credentials require coordinated refresh and durable writeback.

Strict isolation requires proving that native execution is either brokered or
independently confined away from credentials. Bring this feasibility test forward
before implementing the native-provider rollout, using the actual app-server/SDK
path rather than relying on model preference or missing sandbox executables.
Read-only sandboxing does not prevent credential reads. Neither model preference
for MCP nor a missing executable establishes credential separation. Network
restrictions are defense-in-depth: search/extract arguments and other brokered
outbound channels can also carry secrets.

If Codex cannot meet that boundary, it is unavailable in strict mode. A separately
labelled, explicit opt-in may instead use one combined Codex/workspace VM per
session, with no promise that project code cannot read provider credentials.
Never mount multiple worktrees into the shared provider VM as a workaround. Git
remains daemon-owned in either topology; there is no silent isolation downgrade.

## Spike evidence and remaining gates

Reported spike results (not a complete security proof), using smolvm 1.8.1 and
the standalone Codex 0.153.2 build. The spike files may need bringing over from
their development branch: `spikes/microvm-providers/run.sh` and
`app-server-driver.mjs`. Targets: `claude`, `codex`, `codex-adversarial`,
`appserver`, `appserver-credential-read`, `appserver-resume`, or `all`.
The driver expects a throwaway Git fixture with `notes.txt` at
`/tmp/loom-fixture-repo` and dummy credentials at
`/tmp/loom-fixture-repo-secrets/credentials`; never use real secrets in probes.

- Bare smolvm guests boot with KVM, round-trip volume writes, and run both real
  CLIs. Registry pulls failed in this environment because bundled crane used
  blocked DNS to `1.1.1.1`; omitting `--image` uses the bundled Alpine rootfs.
  Guest networking worked; that is not evidence of destination enforcement.
- Claude's tool stripping and strict injected MCP configuration completed a
  read/write workflow with no worktree at provider cwd. This is functional
  evidence; Claude resume and subagent restriction inheritance remain untested.
  In the root guest, `bypassPermissions` was refused; `dontAsk` with explicit
  allowed MCP tools worked. Model descriptions of their tool lists are not proof.
- Codex app-server on a host with working bubblewrap read an absolute-path dummy
  credential outside cwd with **zero approval requests** under read-only
  sandboxing. A write requested escalation; declining it prevented the write.
  Read-only protects against writes, not disclosure of readable credentials.
- Without bubblewrap in the guest, sampled native commands failed to sandbox,
  then requested approval to retry outside it. Explicit declines prevented
  execution. This explains the earlier under-instrumented `exec` discrepancy;
  the runs also differed in approval policy. Deliberately omitting bubblewrap
  is a candidate configuration to investigate, not an accepted security boundary.
- A fresh VM/process resumed persisted Codex state with caller-supplied settings;
  a native write was again declined. Explicit subagents generated approvals on
  the same connection, with their own thread IDs; the tested write was blocked.
  These are sampled results, not evidence that all reads or tool paths are gated.
  The daemon must reapply restrictions on every start/resume and associate child
  threads with the correct session rather than filtering only the primary ID.
- `codex_apps` started despite not appearing in injected `mcp_servers` config.
  Enumerate its tools, authority and disablement options before claiming the
  native tool surface is controlled. Do not assume replacing that config table
  removes every built-in or inherited MCP surface.

Before choosing a strict Codex launch strategy, test the actual app-server path
with pinned binary/model, sandbox/approval policy, cwd and tool implementation.
Record native launcher behavior, every approval decision, tool results and
independently observed file effects. Cover native shell/code-mode/apply-patch,
credential reads, brokered MCP usability, built-in apps, mode changes, resume and
subagents. Unknown paths fail closed. Package changes (especially adding a
working sandbox) must not silently enable previously gated credential reads.
If fully brokered operation cannot pass, investigate an independently enforced
lower-privilege execution compartment before considering the weaker opt-in.

## Packaging and state requirements

- Pin the native executable and required helpers, not just `command -v`: a
  PATH-shadowing Codex 0.149.0 caused misleading model/version errors. Pass guest
  environment explicitly (`smolvm -e`); absent `CODEX_HOME` caused fallback to an
  empty guest home and misleading 401s. Include launch/home diagnostics without
  exposing credential contents.
- Codex needs writable private state and the sibling `codex-code-mode-host`
  helper for the tested Code Mode path. A home under the temporary directory was
  rejected for helper creation. Package helpers ahead of time and choose an
  explicit private writable home. `exec` needed `--skip-git-repo-check`; do not
  generalize its CLI or headless-approval limitations to app-server.
- Claude ran via a read-only `/nix/store` mount; static-musl Codex needed its
  binary directory. The tested smolvm build failed with roughly five extra
  volume mounts, preventing per-store-path mounts. Use a packaged rootfs or
  staged, self-contained runtime filesystem, not production-wide `/nix/store`
  visibility. Symlinks to unmounted store paths do not provide a closure.
- Keep the user's resolved `auth.json` as the login source, with provider-managed
  refresh. Define provisioning, coordinated refresh/writeback across session
  processes, durable native thread state and crash recovery before rollout.
  Disposable per-run credential copies are not a production persistence design.
  Discovery and titling use the same restricted launch/auth path.
- Distinguish provider process, profile VM and workspace VM lifetimes. Closing
  one session must not terminate its peers; thread replacement must not destroy
  workspace state. Preserve recoverable state across daemon/VM restarts and use
  explicit host-to-guest workspace path mappings.

## Implementation phases

1. **Introduce explicit worker protocols.**

   Replace in-process connector imports with requests and streamed events. Define messages for session start/resume, prompt, cancellation, model output, tool requests and tool results.

   Bind each connection to its session and permitted methods. Keep TUI administrative methods inaccessible to workers. The daemon owns Loom's event log and session metadata and passes only relevant session data. Native conversation formats remain provider-owned in durable private state; they are not interchangeable with Loom-owned transcripts.

2. **Implement the complete Git tool suite on the daemon.**

   Provide `status`, `diff`, `history`, `show`, `commit`, `stage`, `rebase`, `rebase_continue` and `rebase_abort`.

   Resolve repository, worktree and branch from the session. Accept structured arguments and explicit staging paths. Run Git with controlled configuration and environment, disabled hooks, and no unintended external filters/helpers. Use trusted Git metadata paths.

   Serialize Git mutations per session and coordinate them with workspace mutations. Rebase results return structured conflict information for the agent to resolve.

3. **Build the workspace VM image and tool runner.**

   Include Loom's runner, tilth, bash, Git-independent file tools and baseline development utilities. Pin tool versions; make tilth a required image dependency.

   Mount only the session worktree RW. Keep VM storage, caches and installed project dependencies private to the session. Store Loom's executable artifacts outside the writable worktree.

   Hide and protect the linked worktree's `.git` pointer; a plain writable mount
   must not allow guest code to replace the host's pointer. Do not mount shared
   Git metadata. Native Git-dependent scripts are not guaranteed to work; any
   requirement for local Git needs a separate clone/synchronization design.

   Start and stop the VM with the session; preserve it across pauses and resumes.

4. **Route every workspace operation into that VM.**

   Replace host execution of read/write/edit/bash and local MCP tools with guest RPC. Run tilth inside the guest. Route background jobs, tests and package installation through the same boundary.

   Keep Git tools on the daemon. Remove host-execution fallbacks.

   Default workspace networking to disabled. Store any permitted development endpoints in daemon-controlled policy; agent requests cannot modify that policy.

   Enforce tool policy in the daemon at execution time. Native automatic reviewers
   cannot authorize brokered operations independently; auto mode never expands
   mounts, network destinations, credential access or administrative authority.

5. **Move JS/TS connectors and Kagi into Deno workers.**

   Supply each worker only its own credential and configuration. Restrict network destinations, filesystem access and environment access; deny subprocesses and FFI. Disable permission prompts and runtime dependency downloads.

   Remove search credentials from connector contexts. Route search/extract requests through the daemon to the Kagi worker.

6. **Move native connectors into dedicated VMs.**

   Package each connector and its native binary together, sharing a VM only
   within one provider account/profile. Keep separate session processes and
   broker connections. Restrict networking and supply only that profile's
   auth/state, including a defined refresh/writeback path. Discovery and titling
   must use this boundary too.

   Disable built-in workspace execution and bridge tool requests through the daemon, or prove an equivalent independently enforced credential-separating execution compartment. A native connector must pass this routing check before being enabled under strict isolation; no fallback to host tools or worktree mounts in the shared provider VM. The weaker combined-VM opt-in described above is not strict isolation.

7. **Verify boundaries and switch the default.**

   Require these acceptance checks:

   - A conflicted rebase completes through daemon Git tools and guest file edits, including continuation and abort.
   - Workspace code cannot read host credentials, other worktrees or shared Git metadata.
   - Connector workers cannot access workspace files or other providers' credentials.
   - Workers cannot invoke administrative methods, impersonate another session or approve their own requests.
   - Native execution cannot read dummy credentials or bypass routing through built-in tools/apps, mode changes, resumed threads or subagents; approved brokered workflows still work.
   - Guest code cannot replace the host worktree's `.git` pointer; Git operations stay scoped despite malicious paths, config, hooks or concurrent workspace writes.
   - Forbidden network destinations fail.
   - Cancellation stops guest/background work; worker crashes and daemon restarts preserve recoverable session and refreshed-auth state without misrouting peer sessions.

Run native-boundary feasibility checks early, then implement in that order after
provider parity. Steps 1–4 establish the workspace and Git boundary; steps 5–6
isolate third-party connector dependencies and credentials. Enable strict mode
per connector only after its acceptance checks pass. If implemented, test and
document the combined-VM opt-in separately without asserting credential isolation.
