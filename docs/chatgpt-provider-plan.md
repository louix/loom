# ChatGPT provider parity plan

## Goal and agreed direction

Make ChatGPT a first-class Loom provider: changing models must not change
authentication, Loom tools, question and plan workflows, or persistence strategy.

Use Codex app-server for every ChatGPT model. An installed Codex binary is an
acceptable requirement. Codex owns subscription authentication, model protocols
and native execution; Loom owns tool configuration, interactions, session state
and git workflows.

Authenticate through `~/<codex-dir>/auth.json`, with Codex managing token refresh.
Do not require or silently fall back to an API key. Preserve custom Codex
directories and provide migration guidance for existing `auth_path` settings.

The target is consistent Loom workflows, not an identical native tool surface.
Retain native execution where it fits Loom's policy, and use supported masking
controls for tools replaced by configured Loom tools.

Remove the direct OAuth/Responses implementation rather than retaining a second
backend. Old direct-backend sessions remain readable but cannot resume; preserve
their worktrees and stored history. No history migration or compatibility engine
is required.

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

## Phase 4: Unify all ChatGPT models on app-server

- Route creation, resume and model changes through Codex.
- Mount shared Loom tools through dynamic tools and preserve configured external
  MCP mounts, including read-only annotations and normalized Loom event names.
- Apply configured search and supported native-tool masking. Disable native web
  search by default; retain `codex_builtin_web_search = true` as an explicit opt-in.
- Persist an explicit history/backend discriminator; resume native threads
  independently of model choice.
- Remove direct OAuth/Responses code, `codex-shell` branches and the standalone
  commit-only server. Reject obsolete direct-backend settings with migration
  guidance instead of silently ignoring them.
- Leave legacy direct sessions readable but non-resumable without retaining the
  old execution path.

**Acceptance:** Selecting a different ChatGPT model no longer selects a different
harness.

## Phase 5: Complete questions, plans and mode switching

- Support Loom questions and native Codex user-input requests through the same
  pending-interaction machinery.
- Implement discuss, revise, implement and handoff plan decisions. Phase 6 adds
  the context-reset behavior required for implement fresh.
- Coordinate planning instructions, native permissions and host-tool policy.
  Plan mode uses read-only execution; default uses human review; accept-edits
  permits workspace edits while retaining escalation approval; auto uses Codex's
  automatic reviewer. Host-executed tools also require Loom's policy because
  Codex's filesystem sandbox does not protect them.
- Serialize settings changes with active turns. Model and effort changes apply at
  the next generation boundary. Host-tool mode policy updates immediately;
  native policy updates at an acknowledged boundary, interrupting first when
  needed to enforce a restriction.
- Ensure interrupt and close settle every parked interaction, cancel work and
  stop further events before returning.

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
- Add opt-in live smoke tests for ordinary and Code Mode models, including
  switching between them within one session.
- Document configuration migration, Codex requirements and explicit capability
  limits. Keep unsupported history transfers unavailable with accurate errors.
- Run typecheck, relevant tests and the full suite in the repository's Deno
  development environment.

**Acceptance:** Parity is enforced by tests, and setup no longer depends on
knowing which ChatGPT model uses which protocol.

## Sequencing

Keep the existing ChatGPT path active through phases 1–3. Phase 4 is the single
backend cutover; phases 5–7 complete and verify parity without maintaining two
implementations. Each phase should be independently reviewable. The overall
parity work is complete only after phase 7.

## References

- [Codex authentication and credential storage](https://learn.chatgpt.com/docs/auth)
- [Codex app-server, including experimental dynamic tools](https://learn.chatgpt.com/docs/app-server)
- [Loom connector architecture](connectors.md)
