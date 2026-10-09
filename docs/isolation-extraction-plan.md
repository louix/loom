# Preserve Loom while extracting isolation

Status: proposal, not an implementation cutover. Reviewed 2026-10-09.
Updated with the user's required main-new improvements; preserve the old application
architecture while deliberately upgrading these behaviors.

Compared `main` / `main-old` at `13a7cd6f4389179d50826e51041407db552ea431`
with `main-new` at `e454c836`. The old tip is the merge base; the new
branch adds 224 commits. The endpoint diff changes 789 files, with 72,285
insertions and 70,196 deletions. These counts describe scope, not quality.

## Concrete delivery plan

Start from main-old and rebuild the extraction there. This branch already has
that code baseline plus review documents. Keep main-new as a pinned source of
implementation and acceptance fixtures. Do not merge main-new and then restore
two directories: its replacement application extends into client, core,
connectors, runtime, storage, packaging and tests.

The target is the old Loom application, improved deliberately, over the reusable
isolation layer. The old daemon embeds the library; no replacement daemon or
per-conversation host process is required for Loom.

| Keep as the application foundation                                                                                                                                          | Port or adapt from main-new                                                                                                                                                                                              | Exclude from this extraction                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI layout/model and session interactions; LoomClient snapshot protocol; Daemon, SessionManager, queue/status/event ownership; old provider contracts and resumable storage | Isolation coordinator and leases; VM execution, cleanup and recovery; workspace mechanics; environment configuration/grants; standalone CLI; native Codex settings semantics; specified UX improvements and Git identity | Replacement environment-based fleet; conversation owner/control/journal/catalogue stack; wholesale provider/worker replacement; retirement of old session storage and product tests |

Deliver in these seven stages, each split into reviewable commits and leaving
the old app usable. The later technical workstreams give details, not a second
conflicting order.

1. **Freeze the baseline and acceptance contract.** Keep old sessions and tests;
   make copied-state fixtures for resume/fork/restart and record existing
   failures. Turn the requested improvements into explicit acceptance cases.
   Investigate cost inflation early so its eventual fix has a reproduced cause.
   Do not require an old behavioral assertion where the user explicitly chose
   improved behavior, such as turn-boundary fleet ordering.

2. **Bring over the isolation foundation as a library.** Port the generic
   coordinator, leases and necessary runtime/workspace dependencies from the
   latest reviewed new code, including cleanup fixes. Keep old entrypoints and
   connectors working. First prove an independent plain-command consumer;
   dependency checks must exclude conversation and TUI packages. Do not copy
   whole client/core/runtime directories merely because they are outside TUI.

3. **Port configuration resolution and Git identity.** Adopt project intent,
   trusted user grants and profile/environment resolution, with an explicit
   old-config conversion path. Keep Loom-only options under Loom ownership.
   Resolve this policy into launch options consumed by the new library and old
   provider adapters. Preserve provider coverage and saved session identity;
   report unrepresentable settings rather than dropping them. Include user
   author/committer defaults and global/per-repository overrides here.

4. **Connect the old daemon to isolation through one complete vertical slice.**
   Boot a VM, launch the existing guest worker as an execution, and return its
   old WorkerProcess interface. Prove create/send/suspend/resume/cancel/crash
   cleanup with one provider before extending to all existing providers. Retain
   the worker runtime artifact and protocol. Route shells, hooks and inspection
   through the same leases, then retire superseded VM ownership. The daemon
   remains the sole owner of conversation state and workspace lifecycle policy.

5. **Expose and package the separate isolation CLI.** Reuse the proven library
   and config path for prepare/exec/inspect/lifecycle operations. Keep Loom's
   existing commands. A persistent standalone owner is optional and belongs to
   the standalone product, not underneath the Loom daemon. Avoid two owners for
   the same VM/workspace; keep standalone state separate unless access is routed
   explicitly through the owning service.

6. **Complete the selected application improvements.** Upgrade our fork flow,
   question UI, turn-boundary ordering, unified Space/leader palette, contextual
   action bar, hover, deterministic colours and per-provider model catalogues
   with consistent selector names and explicit refresh. Replace Codex's mode translation
   with the native mapping reviewed below. Fix the demonstrated accounting
   defects. These changes should use existing session/interaction ownership.
   Small independent UI, ordering and Codex commits can land earlier; this stage
   is the completion gate, not a reason to postpone them behind isolation work.

7. **Verify migration and cut over.** Exercise retained old-session continuity,
   all supported providers, restart/reconnect and real VM execution. Account
   separately for sessions created by main-new: preserve their state and provide
   a tested import/fork or explicit read-only path. Validate the installed CLI
   and runtime artifacts, then remove only superseded code whose callers have
   moved. Keep rollback state until the new old-app-based build is accepted.

The first implementation deliverable is stage 1 plus the smallest stage-2
library/plain-command slice. Do not start by merging main-new or rewriting the
daemon. No implementation is performed by this planning document.

### Git identity is required, not optional polish

Default to the user's configured Git author and committer. Support configured
overrides globally and per repository, including a custom committer without
changing the author. Main-new's `environment-config/src/git-identity.ts` is the
source candidate: it resolves role-specific values, ordinary Git identity and
environment overrides, with explicit Loom settings taking precedence. Reuse its
literal template support where applicable.

Apply the resolved identity to local sessions, VM sessions, private clones and
Loom's retained commit-tool path. Audit each path for old hard-coded identity or
`git -c`/environment overrides which would defeat the new defaults. Verify actual
commit objects for author and committer, not merely config parsing. Propagate
identity values without copying host signing keys/settings or rewriting the
user's in-place repository configuration. This can land with configuration
migration; it does not require the replacement daemon or conversation service.

## Recommendation

Build forward from main-old. Keep its TUI, LoomClient, daemon, SessionManager,
provider interfaces, event store and session state machine. Extract environment
execution underneath them. Reuse selected implementation from main-new without
merging its replacement application architecture.

**Loom does not need the new daemon to consume an isolation API.** The old daemon
can embed the library. Module boundaries do not require process boundaries.
Keep one application daemon per repository and its existing snapshot protocol.

A separately installable isolation CLI can use the same library. For commands
whose environments live only for the command, its process can own execution.
For environments that survive CLI exit, a persistent owner is still necessary
with the current VM supervision, credential renewal and lease design. Supply a
small optional standalone host for that use case; do not require it underneath
the Loom daemon. The new environment host is useful source material, not a
mandatory replacement for Loom's daemon.

Do not restore only the old TUI over the new conversation service: that would
require recreating the removed session API and would retain most of the changed
behavior beneath the familiar presentation.

## What changed beyond isolation

| Concern               | main-old                                                             | main-new                                                              | Proposed destination                                    |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Application owner     | Repository Daemon and SessionManager                                 | Environment daemon plus independent conversation owners               | Old daemon                                              |
| Fleet authority       | Replacement SessionSnapshots with derived turn status                | Environment records combined with activity and delivery observations  | Old session snapshots                                   |
| Agent execution       | AgentProvider / RemoteWorkerSession and existing connectors          | Profiles, native headless integrations and conversation control       | Preserve connectors initially                           |
| History               | Loom events, provider messages/checkpoints and provider-native state | Per-conversation journal, catalogue and native history                | Preserve old history; explicit import for new histories |
| Environment ownership | VM launcher, shell leases, daemon lifecycle coordination             | Generic coordinator, execution leases, persistent environment service | Extract reusable library                                |
| Configuration         | Trusted user JSONC and repository overrides                          | Versioned project intent plus trusted user profiles/grants            | Adopt separately with explicit mapping                  |
| Public tools          | Existing Loom CLI/TUI                                                | Isolation CLI becomes the main entrypoint; TUI is optional            | Keep Loom commands; separately package isolation CLI    |

Evidence of deliberate product replacement, rather than an unavoidable extraction:

- `18267c12` cuts the public CLI over to environment lifecycle/daemon.
- `15bf8e57`, `da51bb03`, `25377594` introduce independent conversation
  ownership/service and reconnect a new TUI to it.
- `6f89574c` removes the old TUI and its implementation-specific tests.
- `b68d8dd0` removes Daemon, SessionManager, registry, snapshot LoomClient
  and harness.
- Later commits retire the old provider/worker contracts and configuration.

The new branch's `docs/consolidation-review.md`, especially lines 184–219 and
548–585, records these decisions. It explicitly allowed breaking configuration
and required old history to remain readable/exportable, not resumable.
That was a materially weaker compatibility goal than preserving the old app.

The old daemon is large and owns several concerns. Keeping it does not mean
freezing its internals: extracting VM execution and workspace mechanics will
reduce its responsibilities without simultaneously changing its product model.

## Concrete differences relevant to the reported glitches

These are source-confirmed behavior differences and risk mechanisms. They are
not a claim to have reproduced every reported glitch in a live TUI.

1. **Old sessions are not active sessions in the new system.**
   At main-new, `backend/daemon/src/store/repository-environment-db.ts:31`
   projects old conversation rows into retained environments. It sets their
   phase to stopped and maps done to archived. The environment host explicitly
   rejects lifecycle writes to retained records
   (`environment-host/src/daemon.ts:104`). Export preserves rows; it does not
   convert them into native resume input. A saved session failing to resume
   through this path is therefore a design consequence.

2. **Environment health and conversation status are being combined in the UI.**
   `frontend/tui/src/workspace-chrome.tsx:75` derives the fleet group from both.
   A stopped environment is IDLE; a ready environment observed as offline is
   also IDLE. A ready environment without a usable activity observation falls
   through to IDLE. Thus IDLE does not establish that a conversation completed
   successfully or that its owner is healthy.

3. **The grouping no longer expresses the same distinctions.**
   The new groups omit INTERRUPTED and WORKING_BACKGROUND. Activity carries
   subagent information, but grouping does not use it as a background-work
   category. The old reducer explicitly preserves interrupted/error state
   against trailing output and represents outstanding background work separately
   (`backend/daemon/src/daemon/status-machine.ts`).

4. **Observation reconciliation adds timing-dependent behavior.**
   `frontend/tui/src/fleet-activity.ts:42` polls with a one-second delay after
   each read. `client/src/repository-conversations.ts:143` combines socket
   observations with journal delivery state, then selects an environment-level
   observation across its conversations. `mergeFleetActivity` can replace a
   previously observed nonfailed owner with offline after an unavailable read.
   This is more reconciliation than the old authoritative session snapshot,
   and creates temporary classification ambiguity even without a protocol bug.

5. **Turn-boundary ordering is an improvement to retain.**
   Old `core/src/session-order.ts` orders within groups by creation time and ID.
   New `workspace-chrome.tsx:101` uses recency from
   `ConversationJournal.lastTurnCompletedAt()` (`client/src/conversation-journal.ts:964`).
   That query explicitly selects root outcome timestamps, excluding streaming and
   subagent updates. The initial review overstated the risk of arbitrary activity
   reordering: this source implements deliberate turn-boundary recency.
   Keep the old fleet and apply this strategy; do not import the new journal or
   polling architecture to obtain it. Keep a deterministic ID tie-breaker.

6. **Passing the new suite does not prove old behavior survived.**
   The consolidation record explicitly retires old owner/TUI tests, including
   deferred behavior. New tests and native acceptance are useful evidence for
   the new architecture, but cannot substitute for the removed product contracts.

## Required improvements from main-new

These are part of the intended result, not speculative polish to discard when
restoring the old architecture. Port behavior into existing owners; source files
below are main-new references unless stated otherwise.

| Improvement                             | Integration and acceptance                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forking, including cross-provider forks | Preserve the improved workflow and destination choices. Support portable context handoff across providers and native history forks where supported. Keep source history intact, record lineage, and make workspace reuse versus copy explicit. |
| Question prompt                         | Port the improved presentation over existing pending-request/answer contracts. Preserve multi-question navigation, choice descriptions, single/multiple selection, custom text, review, validation and small-terminal behavior.                |
| Cost accuracy                           | Investigate and correct old accounting with recorded usage sequences. Preserve truthful cost scope and unknown values; a smaller displayed number alone is not evidence of accuracy.                                                           |
| Turn-boundary fleet ordering            | Keep our fleet implementation; promote by completed root-turn recency, without reordering peers on token/tool/subagent updates. Retain session grouping and selection by ID.                                                                   |
| Unified command palette                 | Space/leader opens the complete command reference, including disabled commands with reasons. Remove the separate `?` help view.                                                                                                                |
| Bottom action/key bar                   | Use one contextual action model for hints, keyboard dispatch and clickable actions. Available session actions remain consistent with the composer open or closed; editing-specific controls may differ intentionally.                          |
| Hover feedback                          | Port shared hover/click hit testing and visible feedback for enabled clickable elements, including after resize, scrolling, modal changes and a stationary pointer over changed layout. Mouse motion must not activate actions.                |
| Deterministic provider colours          | Derive default theme colours from stable provider/profile identity, independent of list order and process restart. Preserve explicit overrides if configured; custom colours must not be required.                                             |

### Fork workflow

Source candidates: `frontend/tui/src/conversation-fork.tsx`,
`client/src/conversation-fork.ts`, `conversation-handoff.ts` and
`conversation-native-fork.ts`. The new workflow is tied to catalogue/journal
identity, so do not transplant its service wholesale.

The old app already has continuation-fork machinery (see its
`docs/tui-state.md` and `backend/daemon/src/daemon/fork-context.ts`).
Improve that path to provide the desired cross-provider experience. Distinguish
native history copying from a portable context handoff; the latter starts a
fresh provider session and does not preserve hidden native state. Test both
directions between available providers, unavailable source providers, destination
failure, cancellation, preserved source state and workspace-copy fidelity.

### Model catalogues and selectors are required improvements

Retain main-new's per-provider/profile model discovery, consistent model naming
throughout selectors, and explicit Refresh models action. Integrate these into
the old daemon's provider discovery and TUI; they do not require replacing
conversation ownership or starting a conversation/VM.

Source candidates on main-new: `core/src/model-catalogue.ts`, provider
`model-discovery.ts` implementations, `frontend/tui/src/provider-model-picker.tsx`
and the profile.models discovery/cache path. The catalogue separates stable
model IDs from display labels, descriptions, supported efforts and defaults.
Codex discovery reads native displayName and supportedReasoningEfforts, filters
hidden models and handles bounded pagination. Reuse these semantics rather than
maintaining unrelated naming rules in each picker.

Apply the same labels and valid model/effort choices in new-session, live model
switching and fork-destination selectors. Preserve the underlying model ID when
labels change. Discovery must be scoped to the selected provider/profile and
credential/configuration identity, not a global list that leaks choices between
providers. Generic catalogue data belongs to provider discovery; isolation only
supplies any necessary execution/credential facilities.

Refresh models must actually refresh the selected catalogue, expose progress,
failure and retry, and respect cancellation. A stale response after switching
providers must not replace the new provider's choices. Keep current session
settings intact when refresh fails or the current model disappears; explain
availability instead of silently substituting another model. Share availability
and disabled reasons with the unified command palette.

Native discovery can use a bounded host metadata subprocess with a disposable
credential snapshot; it does not create a conversation or consume a session VM.
Keep the daemon's network restrictions and do not import personal hooks, history
or MCP configuration into metadata probes. Reuse the new cache invalidation and
process cleanup where applicable. Acceptance covers multiple profiles, stable
labels/IDs across selectors, supported effort/default handling, refresh success,
failure/retry and stale-response cancellation.

### Questions, actions, hover and colours

`ConversationInteractionPane` is explicitly presentation-only; its parent owns
request identity and submission. Adapt the UI and validation at the old
interaction boundary, retaining stale-request rejection and concurrent request
handling rather than replacing the daemon's interaction ownership.

Reuse `ui.tsx`'s `KeyHints`, action-palette patterns and the
`environment-app.tsx` / `conversation-pane.tsx` action-availability decisions
as references. One action description should determine visibility, enabled
state, disabled reason, shortcut and activation in the old app. The Space/leader
palette replaces the separate `?` help view and lists all relevant commands,
including unavailable ones with an explanation. The bottom bar is a concise
contextual projection of that same command model, not a separate command list. Revalidate the captured target
when an action executes; changing focus or session selection must not redirect
an outstanding action.

`mouse-target.ts` shares hit testing and rechecks changed layout;
`theme.ts:50` hashes profile identity into theme roles. These are small
independent port candidates. The finite palette can have collisions; stable
colours do not imply every provider receives a unique hue.

### Ordering contract

Keep our existing grouping semantics; change ordering within each group to the
most recent completed root turn, with creation time for sessions without one
and an ID tie-breaker. Persist the boundary timestamp in Loom-owned session
state so reconnect/restart does not reshuffle rows.

Source evidence is root-outcome recency, not generic activity or draft edits.
Acceptance must pin the user-send/agent-completion boundary behavior to the
desired main-new interaction: streaming and child activity do not promote a
row. Status changes can still move a session between groups. Define treatment
of failed/interrupted root outcomes explicitly and apply it consistently.
Update the old creation-order tests intentionally, retaining their
no-mid-process-reordering and selection-stability protections.

### Cost investigation before choosing an implementation

The new fleet's `ConversationJournal.estimatedCost()` (:978) reads the latest
root `result.total_cost_usd`, excluding child results. It does not sum result
frames. That is a scoped estimate, not proof of complete session-lifetime
billing across provider process restarts.

The old Claude mapper already differences cumulative query cost
(`connectors/claude/src/map.ts:559`), preserves a high-water baseline and carries
cost across query replacement. Old Codex handling also differences cumulative
usage and seeds a resume baseline
(`connectors/chatgpt/src/app-server.ts:1089`). The daemon preserves
provider-reported costs before attempting table pricing (:2081).
Therefore neither “old code simply sums cumulative costs” nor “compaction is
the cause” has been established.

Trace provider input -> mapper delta -> persisted session total -> UI display.
Compare identical sequences around automatic/manual compaction, resume,
rewind/fork, duplicate/replayed results, child usage included in parent totals,
model changes and cache pricing. Separate current context occupancy, usage for
a query/turn, cumulative billed usage and subscription quota. Compaction can
reduce context while still incurring cost; it should not erase previously
incurred cost. Validate query-reset detection rather than assuming every
decrease in a cumulative counter starts a new billing epoch.

Use captured or representative provider fixtures to demonstrate the inflation
and the corrected accounting. Show whether a value is reported, estimated or
unavailable, and state its scope. Cross-provider forks must not charge the
source's historical usage again to the destination.

## Target ownership

```text
existing TUI / Loom CLI
          |
existing LoomClient and session RPC
          |
existing Loom daemon
  - SessionManager / provider adapters / event history
  - session status, queue, hooks, title, fork and resume policy
          |
  Loom execution adapter
          |
shared isolation library ---- runtime / smolvm backend
          ^
          |
standalone isolation CLI
  - direct owner for foreground-only operation, or
  - optional small host for persistent environments
```

The shared library owns VM startup/readiness, execution leases, process/resource
cleanup, generation fencing and recovery. It accepts resolved launch policy and
injected storage/workspace adapters. It must not import TUI, SessionSnapshot,
HarnessEvent, conversation journals or agent turn policy.

The Loom daemon decides whether a session is running, waiting for a question,
interrupted, working in the background, idle or done. A VM being ready/stopped
must never overwrite those meanings. Environment progress and failure feed
existing startup/diagnostic events.

Initially retain one environment per isolated Loom session and preserve its ID
and state locations. Sharing an environment across conversations is a separate
feature with separate identity, lease and presentation decisions.

Local execution remains a Loom execution choice outside the VM backend.

## The useful integration seam

The old code already provides a narrow seam:

- `backend/daemon/src/daemon/vm-provider.ts:39` decorates AgentProvider.
- Its start path launches a VM and connects RemoteWorkerSession, then returns
  the existing session interface.
- `worker-launch.ts:23` defines WorkerProcess: streams, exit, terminate,
  cleanup and optional failure diagnostics.
- `session-vm-worker.ts` currently combines VM provisioning and worker launch.

Split that last responsibility. Boot an environment through the extracted
coordinator, then launch the **existing guest worker** as an execution inside it.
Adapt that execution back to WorkerProcess. RemoteWorkerSession and the old
provider protocol can continue to run unchanged above it.

This is a concrete seam, not a drop-in import: main-new retired the old guest
worker and its packaged graph. Preserve/build a Loom worker runtime artifact
alongside the generic environment runtime. Retain transcript attachment for
AISDK, provider references, MCP endpoint mapping and credential renewal.
Do not switch to native headless adapters merely to obtain generic execution.

Separate VM exit from guest-worker exit. Execution cleanup must await the child
and release its lease; environment cleanup is owned by the coordinator. The
adapter must propagate cancellation, startup progress and structured failure
diagnostics, and must never stop a replacement VM through a stale callback.

Preserve old idle suspension and keep-warm policy. A lease held for an idle
worker's entire life must be released through orderly worker suspension before
stopping the environment. Two unrelated idle timers must not compete.

## Reuse from main-new

| Source                                                                                        | Treatment                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `isolation/src/{coordinator,environment,execution-leases,storage,errors}.ts`                  | Strong reuse candidate: generic ownership and cancellation with injected backend/storage                           |
| `runtime/src/session-vm/{coordinator,environment-launch,configured-environment,execution}.ts` | Port reviewed runtime slices; preserve cleanup fixes, recovery and generation checks                               |
| `environment-service`, `workspaces`                                                           | Reuse generic lifecycle operations/workspace mechanics as needed; avoid two writers for session/workspace metadata |
| `environment-config`                                                                          | Reuse intent/grant resolution and schemas in a separate configuration phase                                        |
| Typed environment RPC, operation IDs/discovery, transport lease handling                      | Reuse for standalone CLI and any added environment methods                                                         |
| `packaging/copy-isolation-cli.ts` and package tests                                           | Reuse dependency-boundary approach; choose distinct executable/socket names                                        |
| Git identity support (`e454c836`)                                                             | Independent improvement candidate; port with its tests and explicit compatibility policy                           |
| Shared UI primitives, usage formatting, diagnostics                                           | Port individually when an old-app comparison demonstrates a benefit                                                |
| Native profile integrations                                                                   | Optional later capability for standalone CLI; do not make them a prerequisite for old Loom sessions                |
| Conversation owner/control/journal/catalogue and replacement TUI                              | Do not port as part of extraction                                                                                  |

Use commits as provenance and review units, not a blind cherry-pick queue.
Many extraction commits were written after the product cutover and depend on
it. The latest low-level code also contains cleanup fixes absent from early
extraction snapshots. Inspect dependencies before moving any slice.

## Technical workstreams and acceptance details

### 1. Establish the preservation baseline

Keep main-new intact as reference. Work from the pinned main-old baseline.
Record current CLI commands and the session behavior matrix below. Restore the
old test suite as the preservation contract, with deliberate revisions for the
required improvements above. Do not weaken unrelated assertions to match regressions.

Use copied databases/provider state for compatibility fixtures. Do not run the
old executable indiscriminately over state already modified by main-new.

Exit: baseline failures are characterized; fixture state and restart/resume
paths are understood before moving ownership.

### 2. Extract the library without changing Loom entrypoints

Introduce the generic coordinator/leases and runtime adapter in bounded commits.
Keep credentials and application launch configuration supplied by trusted
composition. Preserve network denial, scoped relays, private-clone boundaries,
FD/relay diagnostics and durable state ownership.

Prove an independent consumer can launch a plain command without importing
conversation code. Keep workspace allocation under the old daemon initially;
the library receives its resolved workspace. Standalone workspace allocation
can use the extracted workspace module.

Exit: plain-command library acceptance plus existing VM lifecycle tests pass;
no TUI, session protocol or session storage replacement.

### 3. Route existing Loom workers through the library

Implement the WorkerProcess adapter above. Move shell, hook and inspection
execution onto shared leases. Preserve the existing RPC surface for those
features. Transfer cleanup authority once; remove superseded direct VM control
only after its callers use the coordinator.

Keep old session creation/failure persistence, status reducer, queue,
auto-resume, interruption, compaction, forks, hooks and private-clone publication
policy in the daemon. Do not make the environment service independently create
or delete the same worktree.

Exit: old session/TUI tests pass, and real VM fixtures prove create, suspend,
resume, stop, crash recovery and shell coexistence with the old connectors.

### 4. Ship the independent isolation CLI

Package a separate command (proposed: `loom-isolate`) over the library.
Preserve existing `loom` / `loomd` entrypoints. Start with prepare, exec,
inspect and cleanup; add profile launch independently.

If persistent environments are included, adapt the small environment host.
Give it its own state/socket namespace. Enforce one owner for each environment
and backing VM directory. The CLI must not silently attach to or mutate a
Loom-owned environment; shared access would require an explicit owner-routed
protocol.

Exit: install/run succeeds without TUI or conversation packages; literal argv,
stdio, PTY resize, exit status, Ctrl-C, disconnect and lease cleanup are tested.
No standalone daemon is launched merely to run the Loom TUI.

### 5. Adopt configuration independently

Port project intent plus host grants, with an explicit converter/inspection
path for old configuration. Do not replace the existing user file implicitly:
the new schema uses the same default filename and rejects old fields.

Map old providers to launch profiles only where semantics agree. Retain Loom
settings for UI, models, mode, auto-resume, hooks, usage and session policy in
product-owned configuration. Keep prepare/start hooks distinct from session and
write-feedback hooks. Specify replacement versus append rules: new environment
hook arrays replace prior arrays, whereas old hook inheritance has established
behavior.

Preserve the old local/VM default until a separately reviewed choice changes it;
main-new defaults to worktree + VM while main-old defaults to local execution.
Project configuration may request capabilities but must not grant itself host
authority.

Exit: conversion reports unsupported fields, precedence is tested, existing
sessions keep their saved execution/profile identity, and rollback is possible.

### 6. Complete required improvements and handle main-new sessions

The improvements above are required acceptance work. Small UI ports
(questions, shared action hints, hover and default colours) can land on the old
app independently of isolation extraction. Ordering can also land independently
with its intentional test-contract change. Investigate costs early; integrate
fork improvements with workspace/launch changes where they depend on them.
This is not a requirement to wait until configuration migration is finished.

Independent conversation processes and shared-environment conversation identity
remain optional product proposals, not prerequisites for these improvements.

Treat sessions created on main-new separately from old sessions. Inventory
environment records, catalogue/journal databases, profile bindings and native
homes. Preserve them before any adoption. Prefer explicit import/fork into a
new old-app session with provenance; offer read-only history where exact resume
cannot be demonstrated. Never claim that provider-native history alone restores
Loom queue, checkpoint, hook or interaction state.

Exit: both populations have a documented readable/recoverable path; neither
schema generation is silently reinterpreted.

## Acceptance matrix

Retain and exercise the old tests for:

- Session groups and turn-boundary ordering, background completion, late output after interruption,
  concurrent questions/permissions and snapshot consistency.
- Startup cancellation, failed startup rows, suspended and ended-worker resume,
  provider unavailability and daemon restart.
- Queued/uncertain sends, reconnect, draft preservation, paginated transcript
  stitching and scrolled-back stability.
- Model/mode changes, compaction, undo, context/usage accounting, titles and hooks.
- Worktree/private-clone forks, staged/unstaged/untracked state, publication,
  archive/delete guards and open-shell protection.

Add extraction-specific coverage for lease/worker/VM lifetime separation,
cleanup failure retry, generation races, shared workspace exclusion and library
dependency boundaries. Run real VM acceptance for the retained Claude, Codex
and AISDK paths and standalone plain execution. Distinguish Linux evidence from
Apple Silicon evidence.

The release gate also includes cross-provider fork behavior, the upgraded
question prompt, a unified Space/leader palette with disabled reasons, coherent action availability
across composer states, hover
targets, deterministic colours, consistent per-provider model catalogues and
refresh, and demonstrated cost-accounting correctness.
Preserving main-old is the architectural baseline, not a request to preserve
every old UX decision.

## Evidence and limits of this review

This review traced both branch endpoints, history, launch interfaces, ownership,
fleet projections, configuration documentation and retained-history handling.
It did not run a live main-new TUI or access personal session databases.

On main-old, all 18 status-machine tests and both session-order tests passed.
The broader session-manager invocation reported 21 passed and 19 failed
(58 failed steps); a focused rerun confirmed a Unix-socket bind was denied by
this execution sandbox at Deno.listen. This is not evidence that the old
daemon's session behavior is broken, nor a complete runtime validation.

No application code or live configuration was changed by this review.

## Codex agent-mode correction

This is an additional required improvement from main-new, confirmed by tracing
both implementations. Preserve the old application architecture, but replace its
Codex mode translation with the native settings semantics below.

| Loom mode        | Old Codex mapping                                             | Required main-new semantics                                                   |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Auto             | on-request; auto_review; workspace-write                      | Same approval policy/reviewer; explicitly select default collaboration        |
| Manual (default) | untrusted; user; workspace-write                              | on-request; user; default collaboration                                       |
| Plan             | untrusted; user; read-only; no native collaboration selection | on-request; native plan collaboration; preserve previous reviewer and sandbox |

Old Auto already uses Codex's automatic reviewer explicitly. It is not merely
unattended operation obtained by disabling approvals. The mismatch is Manual
policy and, most substantially, the use of sandbox/approval changes as a
substitute for native Plan collaboration.

Old `connectors/chatgpt/src/app-server.ts:210` defines policyFor, sandboxFor
and approvalsReviewerFor. Start/resume and each new turn apply them.
setMode (:753) sends approvalPolicy, approvalsReviewer and sandboxPolicy through
thread/settings/update; it sends no collaborationMode. Its local snapshot
tracks requested/applied mode and may defer application until a new turn.
The adapter does not observe thread/settings/updated to establish effective mode.

At main-new, `connectors/chatgpt/src/agent-modes.ts` exposes Auto, Manual
and Plan using discovered native collaboration modes.
`native-settings.ts:169` sends on-request for all mode choices;
Auto/Manual explicitly set auto_review/user and default collaboration.
Plan selects plan collaboration and omits approvalsReviewer, preserving the
previous choice. These updates do not change sandbox policy.

`headless-session.ts:134` starts/resumes with workspace-write and on-request;
fresh threads select auto_review, while resume preserves the saved reviewer.
Missing resumed collaboration state triggers a settings refresh rather than
inventing a mode. NativeSettings derives UI state from effective native settings.
Its update waits for both the RPC receipt and an observed settings notification;
headless-session forwards thread/settings/updated into that observer.
Plan exposes the remembered execution choice for the exit flow.

Implementation requirements:

- Port native mode discovery, explicit collaboration selection, reviewer
  preservation and effective-settings observation into the existing Codex
  adapter. Do not import the replacement conversation service to obtain them.
- Keep sandbox/isolation configuration independent of agent mode. Preserve its
  workspace, network and runtime constraints while switching collaboration mode.
- Reconcile Loom's acceptEdits mode explicitly: its old Codex policy/reviewer
  pair is on-request/user, matching the desired Manual pair. Do not retain
  misleading duplicate Codex choices or silently reinterpret saved settings.
- Preserve Auto -> Plan -> Auto and Manual -> Plan -> Manual; explicitly
  selecting Auto/Manual while in Plan chooses the new reviewer.
- Rework the existing Loom exit_plan/approval flow against native Plan behavior.
  Its current logic assumes that implementing a plan needs a new writable turn
  because the planning turn was read-only; that assumption no longer defines
  the desired mode transition.
- Verify fresh launch, resume, mid-turn changes, effective-settings notification
  ordering, rejected updates, disconnect and plan exit. An acknowledgement
  alone must not cause the UI to claim an unobserved native mode.
- Check retained dynamic-tool approval policy separately from Codex's native
  approval reviewer; configuring one does not automatically configure the other.

This finding is based on source and existing test inspection, not a new live
Codex acceptance run. No mode implementation was changed during this review.
