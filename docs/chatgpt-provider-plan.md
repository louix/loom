# ChatGPT provider parity plan

## Goal and agreed direction

Make ChatGPT a first-class Loom provider: changing models must not change
authentication, Loom tools, question and plan workflows, or persistence strategy.

Use Codex app-server for every ChatGPT model. An installed Codex binary is an
acceptable requirement. Codex owns subscription authentication and native model
protocols; Loom owns execution routing, tool configuration, interactions, session
state and git workflows.

Authenticate through `~/<codex-dir>/auth.json`, with Codex managing token refresh.
Do not require or silently fall back to an API key. Preserve custom Codex
directories and provide migration guidance for existing `auth_path` settings.

The target is consistent Loom workflows, not an identical native tool surface.
Retain native execution only within the selected execution boundary, and use
supported masking controls for tools replaced by configured Loom tools. Provider
parity does not by itself establish credential isolation.

Remove the direct OAuth/Responses implementation rather than retaining a second
backend. Old direct-backend sessions remain readable but cannot resume; preserve
their worktrees and stored history. No history migration or compatibility engine
is required.

## Architecture alternatives and trade-offs

Using Codex is a compatibility choice, not a requirement to write the connector
in Rust. Its open-source local agent engine is distinct from both its terminal
UI and OpenAI's remote inference backend. App-server exposes that engine for
embedding in other products; Loom does not need to run the TUI.

| Approach | Benefit | Cost / constraint |
| --- | --- | --- |
| Codex app-server (chosen) | Reuses upstream subscription authentication, token refresh, model protocols and native conversation handling. | Loom integrates another agent engine: native tools, approvals, cancellation and persistence must fit Loom's abstractions. Requires a compatible executable; does not itself establish isolation. |
| Direct TypeScript / AI SDK subscription adapter | Loom owns the agent loop, tool surface, history and execution placement; potentially simpler tool control and isolation. | Loom must maintain subscription-backend compatibility, token refresh coordination, model-specific tool protocols, streaming and conversation continuity. Not necessarily a small wrapper. |
| Standard public API adapter | Uses the documented model API without embedding Codex's agent engine. | API credentials and usage-based billing do not meet this plan's subscription-authentication requirement; not an implicit fallback. |

The previous direct OAuth/Responses adapter demonstrates the second approach's
shape, not complete model compatibility. In particular, its shell-only bridge
for `tool_mode: code_mode_only` was an adapter limitation. Code mode orchestrates
tools through model-generated JavaScript in a restricted runtime with brokered
tool access; it does not mean "shell only" or require a Rust implementation.
Reimplementing it entails tool descriptions, isolated execution, asynchronous
calls, yielding and result handling. The client honoring model metadata is not
proof that the backend rejects every alternative tool arrangement.

Finish parity on app-server; do not reopen the direct backend or implement two
engines in these phases. A future direct-adapter investigation should validate
subscription access and representative model/tool protocols end-to-end before
changing that decision. Requiring the executable is separate from installation
UX: shipping a pinned runtime with Loom could avoid a manual install, but would
add packaging and update responsibilities and is not part of this work.

References: [app-server integration](https://learn.chatgpt.com/docs/app-server),
[subscription versus API authentication](https://learn.chatgpt.com/docs/auth).
Source inspection on 2026-09-06 used upstream Codex commit
`ac192cd7937b0d73edc6dffe009940ae53782dd4`: `codex-rs/tui/src/lib.rs`,
`codex-rs/core/src/tools/mod.rs`, `codex-rs/core/src/tools/spec_plan.rs` and
`codex-rs/code-mode-protocol/src/description.rs`. These implementation details
are version-specific, not a stable backend contract.

## Phase 1: Make capabilities and history ownership explicit

- Distinguish Loom-owned transcripts from provider-managed threads.
- Replace daemon assumptions based on provider IDs with capability checks.
- Fix checkpoint, undo, fork and provider-switch eligibility. Never pass Codex
  thread IDs into AI SDK transcript operations.
- Distinguish mode-switch timing, model-switch timing and compaction features.
- Allow model-advertised effort values through shared interfaces and RPC
  validation; keep vendor-specific restrictions inside connectors.

**Acceptance:** Codex sessions cannot accidentally enter AI SDK transcript
operations, and valid effort picker choices survive validation.

## Phase 2: Build a reliable Codex client and authentication path

- Extract typed RPC transport with startup/request deadlines, bounded
  diagnostics, explicit unsupported-request errors and reliable cleanup.
- Resolve the Codex directory consistently: explicit `config_dir`, legacy
  `auth_path`'s parent, `CODEX_HOME`, then `~/.codex`. Reject conflicting explicit
  paths; legacy `auth_path` must identify an `auth.json`.
- Use Codex-managed file authentication for every process and return actionable
  login errors without substituting API-key authentication.
- Discover models and reasoning efforts through app-server. Preserve configured
  picker restrictions and context overrides; use runtime-reported context limits
  when available.
- Add a fake app-server process and versioned protocol fixtures for deterministic
  tests without real credentials.

**Acceptance:** Discovery and session startup use the same credentials, and
startup failures leave no processes or pending requests behind.

## Phase 3: Extract shared Loom tools and interaction handling

- Introduce a vendor-neutral runtime package for shared tool definitions,
  execution callbacks, pending interactions and tool policy.
- Share questions, commit, status and configured search implementations, including
  the session's actual base branch and worktree.
- Share pending-question, permission and plan bookkeeping.
- Adapt Claude's MCP wrapper and AI SDK tools to these components without changing
  their behavior. Keep vendor transports and model loops inside connectors.
- Introduce connector-neutral session instructions and tool policy, applied on
  both creation and resume. Generate guidance from the tools actually mounted.

**Acceptance:** Existing providers pass regression tests through the shared layer.

## Interfaces for later isolation

Finish provider parity first; implement [isolation](isolation-plan.md) afterward.
Build these concrete seams now, with local implementations:

- Session-bound, structured tool dispatch for workspace, Git and search
  operations. The dispatcher determines session/worktree authority; connector
  code does not hardwire host execution or require search credentials.
- Injectable process launch with explicit executable, environment, cwd and
  writable provider-state configuration. Discovery and titling use the same
  launch/authentication path as sessions.
- Distinct provider cwd and tool-visible workspace root; do not assume identical
  paths or require provider code to inspect the workspace to generate instructions.
- Separate Loom session, native thread, provider process and workspace lifetimes.
  Replacing one must not implicitly discard the others.

Do not implement worker RPC, VM orchestration, images, mount/network enforcement
or the full hardened Git suite in this change set. Existing Git tools should use
the dispatch interface. An optional VM smoke test can catch launch/path assumptions
without making production isolation a prerequisite for parity.

## Phase 4: Unify all ChatGPT models on app-server and brokered tools

- Route creation, resume and model changes through Codex.
- Mount shared Loom tools through dynamic tools backed by a session-bound
  execution interface, initially local and suitable for later serialization.
  Preserve configured external MCP tool semantics, read-only annotations and
  normalized Loom event names. Keep execution placement behind the interface.
- Apply configured search and supported native-tool masking. Disable native web
  search by default; retain `codex_builtin_web_search = true` as an explicit opt-in
  only where configured policy permits it.
- Persist an explicit history/backend discriminator; resume native threads
  independently of model choice.
- Remove direct OAuth/Responses code, `codex-shell` branches and the standalone
  commit-only server. Reject obsolete direct-backend settings with migration
  guidance instead of silently ignoring them.
- Leave legacy direct sessions readable but non-resumable without retaining the
  old execution path.

**Acceptance:** Selecting a different ChatGPT model no longer selects a different
harness. Tool dispatch and process launch are replaceable without changing the
model loop; no production VM implementation is required.

## Phase 5: Complete questions, plans and mode switching

- Support Loom questions and native Codex user-input requests through the same
  pending-interaction machinery.
- Implement discuss, revise, implement and handoff plan decisions. Phase 6 adds
  the context-reset behavior required for implement fresh.
- Coordinate planning instructions, native permissions and host-tool policy.
  Plan mode uses read-only execution; default uses human review; accept-edits
  permits workspace edits while retaining escalation approval. Loom remains the
  final authority for brokered tools; Codex's automatic reviewer cannot approve
  its own Loom tool requests. Auto mode does not override execution policy or
  grant administrative authority. Enforce policy at execution time in the
  dispatcher, not only when tools are advertised to the model.
- Serialize settings changes with active turns. Model and effort changes apply at
  the next generation boundary. Host-tool mode policy updates immediately;
  native policy updates at an acknowledged boundary, interrupting first when
  needed to enforce a restriction.
- Ensure interrupt and close settle every parked interaction, cancel work and
  stop further events before returning.
- Handle native approvals through app-server explicitly; never depend on an
  interactive CLI prompt. Denied native execution must not trigger a host or
  unsandboxed fallback, and permitted brokered tools must remain usable.
- Associate parent and subagent thread IDs with the owning session; route their
  approvals through the same handler and reject unknown requests. Reapply policy,
  tool configuration and instructions on every start/resume. Approval handling
  does not imply native reads are confined; isolation is a separate workstream.

**Acceptance:** Users can plan, answer questions, approve work and change modes
without stuck sessions or stale policy.

## Phase 6: Complete lifecycle events, context handling and titling

- Normalize text, reasoning, tool start/result pairs, permission resolution,
  usage, rate limits and background/subagent activity.
- Correlate events by thread, turn and item IDs; prevent duplicate text and
  cumulative-usage double counting.
- Await compaction completion and distinguish manual from automatic compaction.
- Implement custom-summary restart and implement fresh through a shared
  summarize-and-restart operation. Preserve the Loom session and branch, and
  replace the native thread only after success.
- Preserve workspace lifetime and recoverable native state across provider
  process/thread replacement. Generate tool instructions using the explicit
  workspace root, independently of provider cwd.
- Add ephemeral titling with execution tools, MCP, skills and subagents disabled,
  with startup included in the timeout.
- Verify manual title locking, branch renaming and base-branch-aware git helpers.

**Acceptance:** Loom's status, context meter and git workflows reflect actual
Codex behavior, and all plan decisions are supported.

## Phase 7: Lock in conformance and document the cutover

- Run common workflow tests against Claude, AI SDK and Codex adapters for tools,
  questions, plans, modes, git helpers, resume, model changes and cleanup.
- Cover crashes, cancellation, duplicate events, settings failures, compaction,
  unsupported history transfers and legacy-session handling.
- Test custom Codex homes, environment precedence, missing or invalid
  authentication, and absence of API-key fallback.
- Test private state recovery, session-bound routing, cross-session rejection,
  parent/subagent approvals and settings reapplication on resume. Exercise
  injectable launch/dispatch and differing provider/workspace paths with fakes.
- Add opt-in live smoke tests for ordinary and Code Mode models, including
  switching between them within one session.
- Document configuration migration, Codex requirements and explicit capability
  limits. Keep unsupported history transfers unavailable with accurate errors.
- Clearly label this rollout as provider parity, not a credential-isolation
  guarantee; link to the subsequent isolation workstream.
- Run typecheck, relevant tests and the full suite in the repository's Deno
  development environment.

**Acceptance:** Parity is enforced by tests, and setup no longer depends on
knowing which ChatGPT model uses which protocol.

## Sequencing

Keep the existing ChatGPT path active through phases 1–3. Phase 4 is the single
backend cutover; phases 5–7 complete and verify parity without maintaining two
implementations. Each phase should be independently reviewable. The overall
parity work is complete only after phase 7.

Agree dispatch, launch and lifecycle contracts before phase 4. Use the spike
findings to avoid hardwired local assumptions, but do not gate explicitly
non-isolated parity on strict-isolation feasibility. Production VMs and security
acceptance follow this change set under the isolation plan.

## References

- [Codex authentication and credential storage](https://learn.chatgpt.com/docs/auth)
- [Codex app-server, including experimental dynamic tools](https://learn.chatgpt.com/docs/app-server)
- [Loom connector architecture](connectors.md)
