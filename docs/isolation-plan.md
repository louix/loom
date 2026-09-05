# Isolation plan

The end state: one trusted host daemon; one smolvm per session worktree; isolated connector and Kagi workers; all host Git operations exposed through session-scoped tools.

| Component | Execution environment | Authority |
|---|---|---|
| TUI | Existing host process | Daemon IPC; no credentials supplied |
| Daemon | Existing trusted host process | Config, credentials, session database, host Git, worker and VM lifecycle |
| JS/TS connector | Separate Deno process per session | Its provider endpoints, its credential, private state; no workspace, subprocesses or FFI |
| Native connector | Separate smolvm per session | Its provider endpoints, its credential and private state; no worktree mount |
| Workspace tools | One smolvm per session | Worktree RW, private scratch/cache; no credentials; network disabled by default |
| Kagi client | Separate Deno process | Kagi endpoint and credential only; receives search/extract arguments |

The daemon requires no direct internet calls, but remains trusted with ordinary host-process permissions. Deno restrictions apply to workers, not the daemon.

1. **Introduce explicit worker protocols.**

   Replace in-process connector imports with requests and streamed events. Define messages for session start/resume, prompt, cancellation, model output, tool requests and tool results.

   Bind each connection to its session and permitted methods. Keep TUI administrative methods inaccessible to workers. The daemon owns transcripts and passes only the relevant session data.

2. **Implement the complete Git tool suite on the daemon.**

   Provide `status`, `diff`, `history`, `show`, `commit`, `stage`, `rebase`, `rebase_continue` and `rebase_abort`.

   Resolve repository, worktree and branch from the session. Accept structured arguments and explicit staging paths. Run Git with controlled configuration and environment, disabled hooks, and no unintended external filters/helpers. Use trusted Git metadata paths.

   Serialize Git mutations per session and coordinate them with workspace mutations. Rebase results return structured conflict information for the agent to resolve.

3. **Build the workspace VM image and tool runner.**

   Include Loom's runner, tilth, bash, Git-independent file tools and baseline development utilities. Pin tool versions; make tilth a required image dependency.

   Mount only the session worktree RW. Keep VM storage, caches and installed project dependencies private to the session. Store Loom's executable artifacts outside the writable worktree.

   Start and stop the VM with the session; preserve it across pauses and resumes.

4. **Route every workspace operation into that VM.**

   Replace host execution of read/write/edit/bash and local MCP tools with guest RPC. Run tilth inside the guest. Route background jobs, tests and package installation through the same boundary.

   Keep Git tools on the daemon. Remove host-execution fallbacks.

   Default workspace networking to disabled. Store any permitted development endpoints in daemon-controlled policy; agent requests cannot modify that policy.

5. **Move JS/TS connectors and Kagi into Deno workers.**

   Supply each worker only its own credential and configuration. Restrict network destinations, filesystem access and environment access; deny subprocesses and FFI. Disable permission prompts and runtime dependency downloads.

   Remove search credentials from connector contexts. Route search/extract requests through the daemon to the Kagi worker.

6. **Move native connectors into dedicated VMs.**

   Package each connector and its native binary together. Restrict networking and supply only that provider's auth/state.

   Disable built-in workspace execution and bridge tool requests through the daemon. A native connector must pass this routing check before being enabled under the isolation model; no fallback to host tools or worktree mounts.

7. **Verify boundaries and switch the default.**

   Require these acceptance checks:

   - A conflicted rebase completes through daemon Git tools and guest file edits, including continuation and abort.
   - Workspace code cannot read host credentials, other worktrees or shared Git metadata.
   - Connector workers cannot access workspace files or other providers' credentials.
   - Workers cannot invoke administrative methods, impersonate another session or approve their own requests.
   - Forbidden network destinations fail.
   - Cancellation, worker crashes and daemon restarts preserve recoverable session state.

Implement in that order. Steps 1–4 establish the workspace and Git boundary; steps 5–6 isolate third-party connector dependencies and credentials.
