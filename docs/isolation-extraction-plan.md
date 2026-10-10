# Preserve Loom while extracting isolation

Status: proposal, not an implementation cutover. Reviewed 2026-10-09;
restructured the same day into two delivery tracks, improvements first.

Compared `main` / `main-old` at `13a7cd6f4389179d50826e51041407db552ea431` with
`main-new` at `e454c836`. The old tip is the merge base; the new branch adds 224
commits. The endpoint diff changes 789 files, with 72,285 insertions and 70,196
deletions. These counts describe scope, not quality.

## Decision

Build forward from main-old. Keep its TUI, LoomClient snapshot protocol, daemon,
SessionManager, queue/status/event ownership, provider interfaces, event store,
session state machine and resumable storage. Port selected behavior from
main-new into those owners. Do not merge main-new and then restore two
directories: its replacement application extends into client, core, connectors,
runtime, storage, packaging and tests. Keep main-new as a pinned source of
implementation and acceptance fixtures.

This is two projects, delivered as two tracks:

- **Track A — improve the old application.** Port the required main-new
  improvements into the old app. None of them needs the isolation library, the
  new daemon or the conversation service. This track goes first.
- **Track B — extract isolation.** Move VM execution and workspace mechanics
  into a reusable library that the old daemon embeds, then package a separate
  isolation CLI over the same library.

**Loom does not need the new daemon to consume an isolation API.** Module
boundaries do not require process boundaries. Keep one application daemon per
repository and its existing snapshot protocol. A standalone isolation CLI can
own foreground-only environments directly; environments that outlive the CLI
need a small optional standalone host, which must not sit underneath the Loom
daemon.

Sessions created by main-new are discarded. There is no import, fork or
read-only path for them (see [main-new state](#main-new-state)).

Excluded from both tracks: the replacement environment-based fleet; the
conversation owner/control/journal/catalogue stack; wholesale provider/worker
replacement; and retirement of old session storage or product tests.

## Progress

Status on 2026-10-10. Every stage below landed with typecheck, lint and the
full suite green; the suite now runs in a throwaway HOME and XDG root
(`f21ed739`).

| Stage | State   | Commits (first … last)                | Notes                                                                                              |
| ----- | ------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A0    | Done    | `4f0cf4cc`                            | Baseline green; cost inflation reproduced (resume re-charges restored CLI totals)                  |
| A1    | Done    | `be48f7c5` … `f6c81d67`               | Answer sheet; provider colours hashed from provider id                                             |
| A2    | Done    | `5ca63395` … `41cabf98`               | `frontend/tui/src/commands.ts`; Space palette replaces `?`; hover hit testing                      |
| A3    | Done    | `51dfa2ec`                            | `sessions.turn_completed_at` (migration 28)                                                        |
| A4    | Done    | `86fabdc0`, `7758689e`                | Native collaboration modes; `turn/completed` race fixed                                            |
| A5    | Done    | `8a355699`                            | Sessions commit as the user by default; `git.author` / `git.committer` overrides                   |
| A6    | Done    | `6134038d` … `ff4fb47a`               | Per-provider catalogues; `providers.refreshModels`                                                 |
| A7    | Done    | `a7b88528` … `021c8fff`, `d99e5ace`   | Seeded from `get_usage`; `usage.provider_total` (migration 29); provider ref follows undo/`/clear` |
| A8    | Done    | `fd334122`                            | Fork wizard; native vs handoff; lineage (migration 30)                                             |
| B1    | Done    | `f9da0b8f` … `cdc76fd0`               | `isolation/`, runtime slice, `plain-exec.ts`, boundary test                                        |
| B2    | Done    | `ce8b14d9` … `25acc182`               | `session.isolation.launcher` (default `legacy`)                                                    |
| B3    | Partial | `d2705da6` … `74b4fc01`, `491b4000` … | Shells/hooks/inspection on leases; scripts run on either launcher; default not yet flipped         |
| B4    | Done    | `e78ceafc` … `9f05b461`               | `loom-isolate` (foreground ownership); `.#loom-isolate`                                            |
| B5    | Done    | `701a8a0b` … `c96a922c`               | `environment-config/`; `loom.json`, `environment.jsonc`; `loom config convert`                     |
| B6    | Pending |                                       | After the default flips                                                                            |

Live verification (`scripts/test-live-daemon-acceptance.ts`, `claude:personal`
and default `codex`, Linux): isolation launcher sessions with idle suspension
and fresh-VM resume, Codex native Plan end to end, model discovery and refresh,
cost across a daemon restart, native Claude and Codex forks and a Claude→Codex
handoff all passed. Real-VM scripts pass on both launchers on Linux.

Outstanding:

- Apple Silicon evidence and refreshed `packaging/macos/runtime-hashes.json`.
- Flip `session.isolation.launcher` to `isolation`, then B6: remove the legacy
  launcher and the switch in a separate, revertible commit.
- A real credential renewal on the isolation path; forced renewal is avoided
  against logins in active use.
- Follow-ups: `loom shell` and daemon-run hooks ignore Git identity overrides;
  `loom-isolate` has no persistent host, private clones or process-group
  interrupt without `-t`; the Loom dev shell needs `static.crates.io` for the
  patched smolvm on x86_64-linux; an isolation-launcher preparation records
  `stdout_closed` where legacy records `guest_exit`.

## Delivery order

Every stage is split into reviewable commits and leaves the old app usable. Use
main-new commits as provenance and review units, not a cherry-pick queue: many
were written after the product cutover and depend on it. Inspect dependencies
before moving any slice.

A0 comes first. After it, Track A and Track B may proceed in parallel, but Track
A has priority: it delivers the user-visible value and does not wait on any
Track B stage.

### Track A: improve the old application

| Stage | Work                                     | Depends on   |
| ----- | ---------------------------------------- | ------------ |
| A0    | Baseline and acceptance contract         | —            |
| A1    | Question prompt, provider colours, hover | A0           |
| A2    | Unified command model: palette + key bar | A0           |
| A3    | Turn-boundary fleet ordering             | A0           |
| A4    | Codex native agent modes                 | A0           |
| A5    | Git identity                             | A0           |
| A6    | Model catalogues and Refresh models      | A2           |
| A7    | Cost accounting fix                      | A0 diagnosis |
| A8    | Cross-provider fork workflow             | A6           |

A1–A5 are independent of each other and can land in any order. A6 publishes
Refresh availability and disabled reasons through A2's command model. A8 uses
A6's labels and valid model/effort choices in its destination selector.

1. **A0 — Freeze the baseline.** Keep the old sessions and test suite as the
   preservation contract. Rerun the session-manager suite where Unix sockets can
   bind (see [evidence](#evidence-and-limits-of-this-review)) so the contract
   starts green or with characterized failures. Record current CLI commands and
   the [acceptance matrix](#acceptance-matrix). Make copied-state fixtures for
   resume/fork/restart. Turn each Track A improvement into an explicit
   acceptance case, revising old assertions only where an improvement
   deliberately changes behavior (e.g. ordering). Reproduce the cost inflation
   here so A7 starts from a known cause.
2. **A1 — Small UI ports.** Question prompt, deterministic provider colours and
   hover feedback. See [details](#questions-hover-and-colours).
3. **A2 — Unified command model.** One action description drives the
   Space/leader palette, the bottom key bar, keyboard dispatch and clicks.
   Removes the `?` help view. See [details](#unified-command-model).
4. **A3 — Ordering.** Promote by completed root-turn recency within existing
   groups. See [ordering contract](#ordering-contract).
5. **A4 — Codex modes.** Replace the old Codex mode translation with native
   collaboration settings. See [Codex agent modes](#codex-agent-modes).
6. **A5 — Git identity.** User author/committer defaults with global and
   per-repository overrides, expressed in the old configuration. See
   [details](#git-identity).
7. **A6 — Model catalogues.** Per-provider/profile discovery, consistent labels
   across selectors and an explicit Refresh models action. See
   [details](#model-catalogues-and-selectors).
8. **A7 — Cost accounting.** Fix the cause demonstrated in A0. See
   [details](#cost-accounting).
9. **A8 — Forks.** Improve the old continuation-fork path for cross-provider
   handoff and native forks. See [details](#fork-workflow).

Track A exit: the [release gate](#acceptance-matrix) improvements pass on the
old application, with the old session/TUI suite green.

### Track B: extract isolation

1. **B1 — Library and runtime slice.** Port `isolation/src` and the runtime
   slice it needs, including cleanup fixes. Prove a plain-command consumer with
   no conversation or TUI imports. Keep old entrypoints and connectors
   unchanged. See [library port](#b1-library-and-runtime-port).
2. **B2 — One Loom vertical slice behind a switch.** Boot a VM through the
   coordinator, launch the existing guest worker as an execution and return the
   old `WorkerProcess`. Select the library path or the current
   `session-vm-worker` path with a launcher switch, defaulting to the current
   path. Prove create/send/suspend/resume/cancel/crash cleanup with one
   provider. See [integration seam](#integration-seam).
3. **B3 — Parity, then retire the old path.** Extend to all retained providers.
   Route shells, hooks and inspection through the same leases. Flip the switch
   default once real-VM acceptance passes, then remove the superseded VM
   ownership and the switch in a separate, revertible commit.
4. **B4 — Standalone isolation CLI.** Package a separate command over the proven
   library. See [standalone CLI](#b4-standalone-cli).
5. **B5 — Configuration adoption.** Adopt project intent, trusted user grants
   and profile/environment resolution with an explicit old-config converter. The
   standalone CLI is the first consumer; Loom keeps resolving its old
   configuration into launch options until conversion is proven. See
   [configuration](#b5-configuration-adoption).
6. **B6 — Verify and cut over.** Exercise old-session continuity, all supported
   providers, restart/reconnect and real VM execution. Validate the installed
   CLI and runtime artifacts. Remove only superseded code whose callers have
   moved, and keep rollback state until the build is accepted.

The daemon remains the sole owner of conversation state and workspace lifecycle
policy throughout Track B.

### Main-new state

Sessions, environment records, catalogue/journal databases, profile bindings and
native homes created by main-new are discarded and need no migration.

Before running the rebuilt app against live state, check for main-new writes to
files the old app also reads: the user configuration (the new schema uses the
same default filename and rejects old fields) and the repository database.
Restore those from backup or remove the main-new-only state; never let the old
app silently reinterpret a main-new schema.

## Track A details

These are required parts of the result, not speculative polish. Port behavior
into existing owners; source files are main-new references unless stated
otherwise.

| Improvement                    | Integration and acceptance                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question prompt                | Port the improved presentation over existing pending-request/answer contracts. Preserve multi-question navigation, choice descriptions, single/multiple selection, custom text, review, validation and small-terminal behavior.                |
| Deterministic provider colours | Derive default theme colours from stable provider/profile identity, independent of list order and process restart. Preserve explicit overrides if configured; custom colours must not be required.                                             |
| Hover feedback                 | Shared hover/click hit testing and visible feedback for enabled clickable elements, including after resize, scrolling, modal changes and a stationary pointer over changed layout. Mouse motion must not activate actions.                     |
| Unified command palette        | Space/leader opens the complete command reference, including disabled commands with reasons. Remove the separate `?` help view.                                                                                                                |
| Bottom action/key bar          | One contextual action model for hints, keyboard dispatch and clickable actions. Available session actions stay consistent with the composer open or closed; editing-specific controls may differ intentionally.                                |
| Turn-boundary fleet ordering   | Keep our fleet implementation; promote by completed root-turn recency, without reordering peers on token/tool/subagent updates. Retain session grouping and selection by ID.                                                                   |
| Codex native agent modes       | Replace sandbox/approval mode translation with native collaboration modes, reviewer preservation and effective-settings observation.                                                                                                           |
| Git identity                   | Default to the user's Git author and committer, with global and per-repository overrides, on every commit path.                                                                                                                                |
| Model catalogues               | Per-provider/profile discovery, stable IDs with consistent labels in every selector, and an explicit Refresh models action.                                                                                                                    |
| Cost accuracy                  | Investigate and correct old accounting with recorded usage sequences. Preserve truthful cost scope and unknown values; a smaller displayed number alone is not evidence of accuracy.                                                           |
| Forking, incl. cross-provider  | Preserve the improved workflow and destination choices. Support portable context handoff across providers and native history forks where supported. Keep source history intact, record lineage, and make workspace reuse versus copy explicit. |

### Questions, hover and colours

`ConversationInteractionPane` is explicitly presentation-only; its parent owns
request identity and submission. Adapt the UI and validation at the old
interaction boundary, retaining stale-request rejection and concurrent request
handling rather than replacing the daemon's interaction ownership.

`mouse-target.ts` shares hit testing and rechecks changed layout; `theme.ts:50`
hashes profile identity into theme roles. These are small independent port
candidates. The finite palette can have collisions; stable colours do not imply
every provider receives a unique hue.

### Unified command model

Reuse `ui.tsx`'s `KeyHints`, action-palette patterns and the
`environment-app.tsx` / `conversation-pane.tsx` action-availability decisions as
references. One action description determines visibility, enabled state,
disabled reason, shortcut and activation in the old app. The Space/leader
palette replaces the separate `?` help view and lists all relevant commands,
including unavailable ones with an explanation. The bottom bar is a concise
contextual projection of that same command model, not a separate command list.
Revalidate the captured target when an action executes; changing focus or
session selection must not redirect an outstanding action.

### Ordering contract

Old `core/src/session-order.ts` orders within groups by creation time and ID.
New `workspace-chrome.tsx:101` uses recency from
`ConversationJournal.lastTurnCompletedAt()`
(`client/src/conversation-journal.ts:964`), which selects root outcome
timestamps and excludes streaming and subagent updates. Apply that strategy to
the old fleet; do not import the new journal or polling architecture to obtain
it.

Keep our existing grouping semantics; change ordering within each group to the
most recent completed root turn, with creation time for sessions without one and
an ID tie-breaker. Persist the boundary timestamp in Loom-owned session state so
reconnect/restart does not reshuffle rows.

Acceptance pins the user-send/agent-completion boundary behavior to the main-new
interaction: streaming and child activity do not promote a row. Status changes
can still move a session between groups. Define treatment of failed/interrupted
root outcomes explicitly and apply it consistently. Update the old
creation-order tests intentionally, retaining their no-mid-process-reordering
and selection-stability protections.

### Codex agent modes

Confirmed by tracing both implementations. Preserve the old application
architecture, but replace its Codex mode translation with these native settings
semantics.

| Loom mode        | Old Codex mapping                                             | Required main-new semantics                                                   |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Auto             | on-request; auto_review; workspace-write                      | Same approval policy/reviewer; explicitly select default collaboration        |
| Manual (default) | untrusted; user; workspace-write                              | on-request; user; default collaboration                                       |
| Plan             | untrusted; user; read-only; no native collaboration selection | on-request; native plan collaboration; preserve previous reviewer and sandbox |

Old Auto already uses Codex's automatic reviewer explicitly. It is not merely
unattended operation obtained by disabling approvals. The mismatch is Manual
policy and, most substantially, the use of sandbox/approval changes as a
substitute for native Plan collaboration.

Old `connectors/chatgpt/src/app-server.ts:210` defines policyFor, sandboxFor and
approvalsReviewerFor. Start/resume and each new turn apply them. setMode (:753)
sends approvalPolicy, approvalsReviewer and sandboxPolicy through
thread/settings/update; it sends no collaborationMode. Its local snapshot tracks
requested/applied mode and may defer application until a new turn. The adapter
does not observe thread/settings/updated to establish effective mode.

At main-new, `connectors/chatgpt/src/agent-modes.ts` exposes Auto, Manual and
Plan using discovered native collaboration modes. `native-settings.ts:169` sends
on-request for all mode choices; Auto/Manual explicitly set auto_review/user and
default collaboration. Plan selects plan collaboration and omits
approvalsReviewer, preserving the previous choice. These updates do not change
sandbox policy.

`headless-session.ts:134` starts/resumes with workspace-write and on-request;
fresh threads select auto_review, while resume preserves the saved reviewer.
Missing resumed collaboration state triggers a settings refresh rather than
inventing a mode. NativeSettings derives UI state from effective native
settings. Its update waits for both the RPC receipt and an observed settings
notification; headless-session forwards thread/settings/updated into that
observer. Plan exposes the remembered execution choice for the exit flow.

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
  because the planning turn was read-only; that assumption no longer defines the
  desired mode transition.
- Verify fresh launch, resume, mid-turn changes, effective-settings notification
  ordering, rejected updates, disconnect and plan exit. An acknowledgement alone
  must not cause the UI to claim an unobserved native mode.
- Check retained dynamic-tool approval policy separately from Codex's native
  approval reviewer; configuring one does not automatically configure the other.

This finding is based on source and existing test inspection, not a live Codex
acceptance run.

### Git identity

Default to the user's configured Git author and committer. Support configured
overrides globally and per repository, including a custom committer without
changing the author. Main-new's `environment-config/src/git-identity.ts` is the
source candidate: it resolves role-specific values, ordinary Git identity and
environment overrides, with explicit Loom settings taking precedence. Reuse its
literal template support where applicable.

Express the overrides in the old trusted user JSONC and repository overrides,
with settings shaped so B5's converter can map them directly. This does not wait
for configuration adoption.

Apply the resolved identity to local sessions, VM sessions, private clones and
Loom's retained commit-tool path. Audit each path for old hard-coded identity or
`git -c`/environment overrides which would defeat the new defaults. Verify
actual commit objects for author and committer, not merely config parsing.
Propagate identity values without copying host signing keys/settings or
rewriting the user's in-place repository configuration.

### Model catalogues and selectors

Retain main-new's per-provider/profile model discovery, consistent model naming
throughout selectors, and explicit Refresh models action. Integrate these into
the old daemon's provider discovery and TUI; they do not require replacing
conversation ownership or starting a conversation/VM.

Source candidates: `core/src/model-catalogue.ts`, provider `model-discovery.ts`
implementations, `frontend/tui/src/provider-model-picker.tsx` and the
profile.models discovery/cache path. The catalogue separates stable model IDs
from display labels, descriptions, supported efforts and defaults. Codex
discovery reads native displayName and supportedReasoningEfforts, filters hidden
models and handles bounded pagination. Reuse these semantics rather than
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
and disabled reasons with the unified command model.

Native discovery can use a bounded host metadata subprocess with a disposable
credential snapshot; it does not create a conversation or consume a session VM.
Keep the daemon's network restrictions and do not import personal hooks, history
or MCP configuration into metadata probes. Reuse the new cache invalidation and
process cleanup where applicable. Acceptance covers multiple profiles, stable
labels/IDs across selectors, supported effort/default handling, refresh success,
failure/retry and stale-response cancellation.

### Cost accounting

The new fleet's `ConversationJournal.estimatedCost()` (:978) reads the latest
root `result.total_cost_usd`, excluding child results. It does not sum result
frames. That is a scoped estimate, not proof of complete session-lifetime
billing across provider process restarts.

The old Claude mapper already differences cumulative query cost
(`connectors/claude/src/map.ts:559`), preserves a high-water baseline and
carries cost across query replacement. Old Codex handling also differences
cumulative usage and seeds a resume baseline
(`connectors/chatgpt/src/app-server.ts:1089`). The daemon preserves
provider-reported costs before attempting table pricing (:2081). Therefore
neither “old code simply sums cumulative costs” nor “compaction is the cause”
has been established.

In A0, trace provider input -> mapper delta -> persisted session total -> UI
display. Compare identical sequences around automatic/manual compaction, resume,
rewind/fork, duplicate/replayed results, child usage included in parent totals,
model changes and cache pricing. Separate current context occupancy, usage for a
query/turn, cumulative billed usage and subscription quota. Compaction can
reduce context while still incurring cost; it should not erase previously
incurred cost. Validate query-reset detection rather than assuming every
decrease in a cumulative counter starts a new billing epoch.

Use captured or representative provider fixtures to demonstrate the inflation
and, in A7, the corrected accounting. Show whether a value is reported,
estimated or unavailable, and state its scope. Cross-provider forks must not
charge the source's historical usage again to the destination.

### Fork workflow

Source candidates: `frontend/tui/src/conversation-fork.tsx`,
`client/src/conversation-fork.ts`, `conversation-handoff.ts` and
`conversation-native-fork.ts`. The new workflow is tied to catalogue/journal
identity, so do not transplant its service wholesale.

The old app already has continuation-fork machinery (see its `docs/tui-state.md`
and `backend/daemon/src/daemon/fork-context.ts`). Improve that path to provide
the desired cross-provider experience, using the existing worktree/private-clone
fork mechanics. Distinguish native history copying from a portable context
handoff; the latter starts a fresh provider session and does not preserve hidden
native state. Test both directions between available providers, unavailable
source providers, destination failure, cancellation, preserved source state and
workspace-copy fidelity.

## Track B details

### Target ownership

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

### B1: library and runtime port

`main-new:isolation/src/{coordinator,environment,execution-leases,storage,errors}.ts`
imports only its own modules and `node:crypto`; it ports as-is. The work is in
the runtime slice beneath it. Main-new `runtime/src/session-vm` differs from
main-old across 30 files (+1,884/−545) and imports these `core/src` modules:

- New on main-new, all small leaf modules depending only on `zod`:
  `execution.ts`, `init-hook.ts`, `network-policy.ts`, `public-diagnostic.ts`,
  `sandbox-setup.ts`.
- Present on main-old with small changes: `worker-failure.ts`,
  `nix-activation.ts`, `workspace-prepare.ts`.
- Present and unchanged: `host-path.ts`, `relay-diagnostic.ts`,
  `session-environment.ts`, `shell-hook.ts`, `text-stream.ts`,
  `vm-termination.ts`.

It also reaches `runtime/src/packaged/*`, `process.ts`, `framing.ts` and
`diagnostics.ts`; audit those before moving them. Do not copy whole
client/core/runtime directories merely because they are outside the TUI.

Port in bounded commits from the latest reviewed code, preserving cleanup fixes,
recovery and generation checks absent from early extraction snapshots. Keep
credentials and application launch configuration supplied by trusted
composition. Preserve network denial, scoped relays, private-clone boundaries,
FD/relay diagnostics and durable state ownership. Keep workspace allocation
under the old daemon; the library receives its resolved workspace.

Exit: a plain-command consumer launches through the library; a dependency check
proves it imports no conversation, session protocol or TUI package; the existing
VM lifecycle tests still pass.

### Integration seam

The old code already provides a narrow seam:

- `backend/daemon/src/daemon/vm-provider.ts:39` (`withVmSessions`) decorates
  AgentProvider.
- Its start path launches a VM and connects RemoteWorkerSession, then returns
  the existing session interface.
- `worker-launch.ts:23` defines WorkerProcess: streams, exit, terminate, cleanup
  and optional failure diagnostics.
- `session-vm-worker.ts` currently combines VM provisioning and worker launch.

Split that last responsibility. Boot an environment through the extracted
coordinator, then launch the **existing guest worker** as an execution inside
it. Adapt that execution back to WorkerProcess. RemoteWorkerSession and the old
provider protocol continue to run unchanged above it. The B2 launcher switch
sits at this point, choosing between the new adapter and the current
`session-vm-worker` launcher.

This is a concrete seam, not a drop-in import: main-new retired the old guest
worker (`core/src/worker.ts`, `provider-worker.ts`, `session-vm-worker.ts`) and
its packaged graph. Preserve/build the Loom worker runtime artifact alongside
the generic environment runtime. Retain transcript attachment for AISDK,
provider references, MCP endpoint mapping and credential renewal. Do not switch
to native headless adapters merely to obtain generic execution.

Separate VM exit from guest-worker exit. Execution cleanup must await the child
and release its lease; environment cleanup is owned by the coordinator. The
adapter must propagate cancellation, startup progress and structured failure
diagnostics, and must never stop a replacement VM through a stale callback.

Preserve old idle suspension and keep-warm policy. A lease held for an idle
worker's entire life must be released through orderly worker suspension before
stopping the environment. Two unrelated idle timers must not compete.

In B3, move shell, hook and inspection execution onto shared leases while
preserving their RPC surface. Keep session creation/failure persistence, status
reducer, queue, auto-resume, interruption, compaction, forks, hooks and
private-clone publication policy in the daemon. Do not make an environment
service independently create or delete the same worktree. Transfer cleanup
authority once.

B3 exit: old session/TUI tests pass with the switch on the library path, and
real VM fixtures prove create, suspend, resume, stop, crash recovery and shell
coexistence with the old connectors.

### B4: standalone CLI

Package a separate command (proposed: `loom-isolate`) over the library. Preserve
existing `loom` / `loomd` entrypoints. Start with prepare, exec, inspect and
cleanup; add profile launch independently. Standalone workspace allocation can
use the extracted workspace module.

If persistent environments are included, adapt the small environment host. Give
it its own state/socket namespace. Enforce one owner for each environment and
backing VM directory. The CLI must not silently attach to or mutate a Loom-owned
environment; shared access would require an explicit owner-routed protocol.

Exit: install/run succeeds without TUI or conversation packages; literal argv,
stdio, PTY resize, exit status, Ctrl-C, disconnect and lease cleanup are tested.
No standalone daemon is launched merely to run the Loom TUI.

### B5: configuration adoption

Port project intent plus host grants, with an explicit converter/inspection path
for old configuration. Do not replace the existing user file implicitly: the new
schema uses the same default filename and rejects old fields.

Map old providers to launch profiles only where semantics agree; report
unrepresentable settings rather than dropping them. Retain Loom settings for UI,
models, mode, auto-resume, hooks, usage, Git identity and session policy in
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

### Reuse from main-new

| Source                                                                                        | Treatment                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `isolation/src/{coordinator,environment,execution-leases,storage,errors}.ts`                  | Strong reuse candidate: generic ownership and cancellation with injected backend/storage                           |
| `runtime/src/session-vm/{coordinator,environment-launch,configured-environment,execution}.ts` | Port reviewed runtime slices; preserve cleanup fixes, recovery and generation checks                               |
| `environment-service`, `workspaces`                                                           | Reuse generic lifecycle operations/workspace mechanics as needed; avoid two writers for session/workspace metadata |
| `environment-config`                                                                          | Reuse intent/grant resolution and schemas in B5; Git identity resolution in A5                                     |
| Typed environment RPC, operation IDs/discovery, transport lease handling                      | Reuse for standalone CLI and any added environment methods                                                         |
| `packaging/copy-isolation-cli.ts` and package tests                                           | Reuse dependency-boundary approach; choose distinct executable/socket names                                        |
| Shared UI primitives, usage formatting, diagnostics                                           | Port individually when an old-app comparison demonstrates a benefit                                                |
| Native profile integrations                                                                   | Optional later capability for standalone CLI; do not make them a prerequisite for old Loom sessions                |
| Conversation owner/control/journal/catalogue and replacement TUI                              | Do not port                                                                                                        |

## Acceptance matrix

Retain and exercise the old tests for:

- Session groups and turn-boundary ordering, background completion, late output
  after interruption, concurrent questions/permissions and snapshot consistency.
- Startup cancellation, failed startup rows, suspended and ended-worker resume,
  provider unavailability and daemon restart.
- Queued/uncertain sends, reconnect, draft preservation, paginated transcript
  stitching and scrolled-back stability.
- Model/mode changes, compaction, undo, context/usage accounting, titles and
  hooks.
- Worktree/private-clone forks, staged/unstaged/untracked state, publication,
  archive/delete guards and open-shell protection.

Track A release gate: cross-provider fork behavior, the upgraded question
prompt, a unified Space/leader palette with disabled reasons, coherent action
availability across composer states, hover targets, deterministic colours,
turn-boundary ordering, native Codex modes, Git identity on actual commit
objects, consistent per-provider model catalogues and refresh, and demonstrated
cost-accounting correctness. Preserving main-old is the architectural baseline,
not a request to preserve every old UX decision.

Track B adds coverage for lease/worker/VM lifetime separation, cleanup failure
retry, generation races, shared workspace exclusion and library dependency
boundaries. Run real VM acceptance for the retained Claude, Codex and AISDK
paths and standalone plain execution. Distinguish Linux evidence from Apple
Silicon evidence.

## Background: why not build on main-new

| Concern               | main-old                                                             | main-new                                                              | Destination                                          |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Application owner     | Repository Daemon and SessionManager                                 | Environment daemon plus independent conversation owners               | Old daemon                                           |
| Fleet authority       | Replacement SessionSnapshots with derived turn status                | Environment records combined with activity and delivery observations  | Old session snapshots                                |
| Agent execution       | AgentProvider / RemoteWorkerSession and existing connectors          | Profiles, native headless integrations and conversation control       | Preserve connectors initially                        |
| History               | Loom events, provider messages/checkpoints and provider-native state | Per-conversation journal, catalogue and native history                | Preserve old history; discard main-new histories     |
| Environment ownership | VM launcher, shell leases, daemon lifecycle coordination             | Generic coordinator, execution leases, persistent environment service | Extract reusable library (Track B)                   |
| Configuration         | Trusted user JSONC and repository overrides                          | Versioned project intent plus trusted user profiles/grants            | Adopt separately with explicit mapping (B5)          |
| Public tools          | Existing Loom CLI/TUI                                                | Isolation CLI becomes the main entrypoint; TUI is optional            | Keep Loom commands; separately package isolation CLI |

Evidence of deliberate product replacement, rather than an unavoidable
extraction:

- `18267c12` cuts the public CLI over to environment lifecycle/daemon.
- `15bf8e57`, `da51bb03`, `25377594` introduce independent conversation
  ownership/service and reconnect a new TUI to it.
- `6f89574c` removes the old TUI and its implementation-specific tests.
- `b68d8dd0` removes Daemon, SessionManager, registry, snapshot LoomClient and
  harness.
- Later commits retire the old provider/worker contracts and configuration.

The new branch's `docs/consolidation-review.md`, especially lines 184–219 and
548–585, records these decisions. It explicitly allowed breaking configuration
and required old history to remain readable/exportable, not resumable. That was
a materially weaker compatibility goal than preserving the old app.

Restoring only the old TUI over the new conversation service would require
recreating the removed session API and would retain most of the changed behavior
beneath the familiar presentation.

The old daemon is large and owns several concerns. Keeping it does not mean
freezing its internals: extracting VM execution and workspace mechanics will
reduce its responsibilities without simultaneously changing its product model.

### Differences relevant to the reported glitches

These are source-confirmed behavior differences and risk mechanisms, not a claim
to have reproduced every reported glitch in a live TUI.

1. **Old sessions are not active sessions in the new system.**
   `backend/daemon/src/store/repository-environment-db.ts:31` projects old
   conversation rows into retained environments, sets their phase to stopped and
   maps done to archived. The environment host rejects lifecycle writes to
   retained records (`environment-host/src/daemon.ts:104`). Export preserves
   rows but does not convert them into native resume input, so a saved session
   failing to resume through this path is a design consequence.

2. **Environment health and conversation status are combined in the UI.**
   `frontend/tui/src/workspace-chrome.tsx:75` derives the fleet group from both.
   A stopped environment is IDLE; a ready environment observed as offline is
   also IDLE; a ready environment without a usable activity observation falls
   through to IDLE. IDLE therefore does not establish that a conversation
   completed successfully or that its owner is healthy.

3. **The grouping no longer expresses the same distinctions.** The new groups
   omit INTERRUPTED and WORKING_BACKGROUND. Activity carries subagent
   information, but grouping does not use it as a background-work category. The
   old reducer preserves interrupted/error state against trailing output and
   represents outstanding background work separately
   (`backend/daemon/src/daemon/status-machine.ts`).

4. **Observation reconciliation adds timing-dependent behavior.**
   `frontend/tui/src/fleet-activity.ts:42` polls with a one-second delay after
   each read. `client/src/repository-conversations.ts:143` combines socket
   observations with journal delivery state, then selects an environment-level
   observation across its conversations. `mergeFleetActivity` can replace a
   previously observed nonfailed owner with offline after an unavailable read.
   This creates temporary classification ambiguity even without a protocol bug.

5. **Turn-boundary ordering is the exception worth keeping.** See the
   [ordering contract](#ordering-contract).

6. **Passing the new suite does not prove old behavior survived.** The
   consolidation record retires old owner/TUI tests, including deferred
   behavior. New tests cannot substitute for the removed product contracts.

## Evidence and limits of this review

This review traced both branch endpoints, history, launch interfaces, ownership,
fleet projections, configuration documentation and retained-history handling. It
did not run a live main-new TUI or access personal session databases.

On main-old, all 18 status-machine tests and both session-order tests passed.
The broader session-manager invocation reported 21 passed and 19 failed (58
failed steps); a focused rerun confirmed a Unix-socket bind was denied by the
review sandbox at Deno.listen. This is not evidence that the old daemon's
session behavior is broken, nor a complete runtime validation; A0 reruns it
where sockets can bind.

No application code or live configuration was changed by this review.
