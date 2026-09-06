# TUI reduction, separation, and rendering plan

Baseline: local `main` at `f67c653`. Status: planned; no implementation is
represented by the checkboxes below.

Goal: reduce the amount of state and behavior we maintain, separate pure domain
code from effect-owning handles, and keep the TUI responsive without repeatedly
redrawing unrelated content. This plan supersedes the earlier plans' scope where
they demand seamless synchronization or exact publication counts. Their fixes
for lost input, duplicate sends, and broken reconnects remain requirements.

## Product contract and boundaries

- Optimize for one active TUI. Other clients may connect and receive whole-fleet
  replacement snapshots. No locks on UI ownership, conflict revisions, perfect
  concurrent editing, or new synchronization framework.
- Keep existing commands, key bindings, child-session navigation, queued
  follow-ups, drafts, multi-question answers, and plan-review retargeting.
- Keep immediate mode-selection feedback. Do not replace it with an unresponsive
  control waiting for the daemon. The applied mode still comes from the snapshot.
- On reconnect, return the selected transcript to its latest page. Exact scroll
  restoration is unnecessary. Preserve unsent user text.
- No offline TUI. Without a connection, show connecting/reconnecting/error and
  allow quit; do not browse stale sessions, load history, search, or accept daemon
  commands. In-memory preservation of drafts and already queued text is enough.
- Preserve continuous scrollback and opening transcripts/requests in `$EDITOR`.
  Search across sessions belongs to the daemon and its database, not TUI caches.
- Do not automatically retry an uncertain mutation. A stale request may return
  “no longer available”; it must never resolve a different request.
- Keep serialized socket writes, bounded output, request identity checks,
  per-session command serialization, and approval/interrupt preemption.
- Keep raw replay for `loom tail`. Do not rebuild it to simplify the TUI.
- No framework migration, generic effect interpreter, custom React reconciler,
  or new dependency. Use existing stores, Loadable, unions, and exhaustive branches.
- Moving code is separation, not reduction. Report it separately. Do not meet a
  line target by compressing formatting, removing useful comments, or hiding casts.
- A 50% reduction is an investigation target for affected subsystems and tests,
  not a requirement to delete half the project's behavior or safety checks.

These scope choices are settled. Do not substitute explicit history pages, remove
editor access, or introduce offline browsing during implementation.

## Execution rules

Work in numbered order, with a reviewable change per step. A step may require
several commits, but do not leave two implementations connected indefinitely.
For each step record only: changed behavior, deleted representations, validation,
and source/test line delta. Keep completion notes short; do not grow a journal.

Use existing tests while refactoring. Add a regression only for an uncovered
behavior or a reproduced defect. Do not add a test for every checkbox, union
variant, private helper, or field assignment. Delete obsolete tests in the same
change that removes their responsibility. A correct type prevents malformed
construction; it does not prove the correct transition or asynchronous effect.

## 0. Record a usable baseline

Files: existing scripts, tests, `frontend/tui/src/run.tsx`.

- [x] Record HEAD and run `deno task typecheck`, `deno task test:silent`,
      `deno task lint`, and `deno task format:check` in the repository environment.
      Record environmental failures honestly; do not use `--no-check` as a pass.
- [x] Measure four scenarios at fixed terminal dimensions: idle, one streaming
      session, scrolling a long transcript, and typing/changing mode while streaming.
      Use the same transcript and scripted input for before/after comparisons.
- [x] Capture render count/time with Ink's `onRender`, stdout bytes/write count,
      and key-to-visible-feedback latency. Write diagnostics to a file, never the
      live TUI's stdout. Keep instrumentation temporary or in one opt-in script.
- [x] Separately measure mode keypress → local feedback → RPC dispatch → RPC
      settlement/applied snapshot. The existing 300ms debounce is not socket latency.
- [x] Record production and test line counts for affected files. Do not include
      docs as production reduction or use total test count as a quality metric.

Done: a reproducible comparison exists. If no interactive terminal is available,
record what a simulated TTY establishes and leave visible flicker/latency unverified.

## 1. Reduce terminal output with Ink's existing option

Files: `frontend/tui/src/run.tsx`. Installed baseline: Ink 7.1.1.

- [x] Enable `incrementalRendering: true` in the existing render options.
      Keep alternate-screen support and the current frame limit initially.
- [x] Compare emitted bytes for a spinner-only change and an appended event.
      React rendering and terminal writing are different measurements.
- [x] Exercise resize, narrow/wide layouts, long wrapped rows, overlays, scroll,
      `$EDITOR` return, and exit. Check that output stays within terminal height;
      overflowing the viewport can force a full clear despite incremental mode.
- [x] If this reveals an Ink defect, record the reproducer and defer the option;
      do not build an ANSI diff engine or silently accept rendering corruption.

Done: changed-line output works with existing interactions, or a concrete blocker
is documented. No new permanent suite solely asserting the option is `true`.

## 2. Make overlay and prompt state structurally correct

Files: `frontend/tui/src/model.ts`, `fleet-handle.ts`, `app.tsx`, `components.tsx`.
Introduce `frontend/tui/src/overlay.ts` for pure overlay types/transitions.

- [ ] Replace independent UI mode plus nullable overlay payloads with one union:
      browse, help, doctor, prompt, confirmation, plan review, or picker. Each
      payload lives in its owning variant. Render with an exhaustive switch/fold.
- [ ] Replace `PromptKind` plus optional fields with purpose-specific variants.
      New-session prompts have creation settings; session prompts require a session;
      request answers require the exact request identity; multi-question answers
      require their questions and answer progress. Factor only genuinely shared
      editor fields. Do not use `Partial<Prompt>` constructors or broad casts.
- [ ] Model picker destinations explicitly: new session, existing session, or
      plan implementation. Replace `planStage`, `reopenSend`, and navigation flags
      with the actual return destination and required continuation data.
- [ ] Preserve temporarily suspended input: opening the provider/model picker
      from a send prompt or plan review must carry the return payload inside that
      flow. A single active overlay does not mean discarding the underlying draft.
- [ ] Reconcile request-bound UI by session + request ID in one pure function.
      Close stale request UI without retargeting typed answers; leave unrelated
      send/title drafts alone. Unknown fleet state is not proof of removal.
- [ ] Gate the connected layout and daemon-dependent input once at the root using
      ClientState's discriminant. On disconnect, dispose connected feature effects
      and show the connection view. Preserve draft/queue values separately from
      those effects; do not add a second `connected` flag or offline session copy.
      Existing editor handoffs may finish; retain returned text without submitting
      it until connected. Reconnect revalidates targets before enabling actions.
- [ ] Delete old fields, constructors, null guards, and patch helpers whose sole
      purpose was making the independent values agree. No compatibility getters
      recreating the old mutable representation.

Validation: retain representative answer, plan→picker→plan, send→picker→send,
Escape/back, and removed-request flows. Delete fixtures testing malformed overlay
combinations. Typecheck must enforce required payloads without `!` or casts added
to silence the migration. This step must reduce production code, not just move it.

## 3. Give interactions and the composer ownership of their effects

Files: `fleet-handle.ts`, `model.ts`, components consuming their state.
Introduce `interactions.ts` and `composer.ts` under `frontend/tui/src/`.

- [ ] Put pure request selection, answer progression, and decision construction
      beside a small interaction handle. Read outstanding requests directly from
      daemon snapshots; do not recreate a local pending/resolved request database.
- [ ] Keep one submission guard scoped to the relevant session/request operation.
      Batched duplicate keys issue one command. Failure and request replacement
      must not leave another request blocked or reuse the old answer.
- [ ] Put drafts, queued messages, and send progression in the composer. Replace
      correlated `draining`, `lastDrainTurn`, and held-text bookkeeping with a
      per-session union whose active variant owns its message and turn barrier.
      Keep the unsent tail explicit; do not call it an uncertain send.
- [ ] Commit the sending/held/removed state before invoking effects or publishing
      notices. Reducers never call dispatch. Sending completion produces a new
      input to the owning handle, not recursive inspection of the entire app.
- [ ] On timeout/disconnect, preserve the ambiguous message for explicit review,
      prevent its automatic resend, and preserve remaining unsent entries. Keep
      the existing next-turn rule; do not drain several entries on one idle snapshot.
- [ ] Root composition forwards fleet updates and user intentions. Components
      receive views/actions; they do not perform RPCs or reconcile daemon state.
      Feature modules must not import the root fleet handle or each other cyclically.

Validation: keep the existing duplicate-key, queue-on-idle, disconnect-with-queue,
session-removed notice, and uncertain-send cases at their owning boundary. Move
tests rather than copy them. Delete root reducer actions and cross-map cleanup
made unnecessary by the new ownership. No general-purpose effect/action bus.

## 4. Keep responsive mode selection with one small controller

Files: `fleet-handle.ts`, `model.ts`; introduce `mode-control.ts`.

- [ ] Keep applied mode exclusively in the daemon snapshot. Model local control
      as idle, choosing(target), or applying(sent target, optional next target).
      Include the target session in the controller's scope. This explicitly permits
      rapid cycling while a previous application is awaiting a response.
- [ ] Update selection feedback on the keypress, before network work. Label a
      pending target honestly; do not overwrite the applied snapshot field.
- [ ] Retain the existing debounce initially: passing through plan mode has real
      provider effects. One timer belongs to the choosing state. One application
      can be outstanding per session; further input replaces the next target.
- [ ] When an application settles, consume only the next chosen target according
      to the same debounce policy. On ambiguous failure, stop automatic application
      and require fresh user intent. On session removal/disposal, cancel timers.
- [ ] Preserve `plan_pending` feedback and the route into the real plan review.
- [ ] Delete `modeDraft`, `modeDebounce`, `modeInFlight`, their reducer actions,
      and cleanup loops once the controller owns those responsibilities.

Validation: a rapid cycle applies the settled choice, not every intermediate mode;
input during an outstanding call is retained; rejection shows the authoritative
mode; removal cancels scheduled work. Reuse existing mode tests. Compare latency
with step 0. Do not remove the debounce merely because local `ping` is fast.

## 5. Move cross-session search to the daemon

Files: `frontend/tui/src/fleet-search.ts`, search consumers in `model.ts` and
`fleet-handle.ts`, `backend/daemon/src/daemon/daemon.ts`, the stores under
`backend/daemon/src/store/`, and `core/src/wire.ts`.

- [ ] Add one read-only search RPC accepting query, bounded limit, and an optional
      continuation cursor. Return ordered session IDs and only the match metadata
      needed by the existing UI, plus continuation information. Empty query uses
      the ordinary fleet snapshot; it does not query every transcript.
      Use a deterministic tie-breaker and bind continuation to the query. Results
      may change as the database changes; no snapshot-isolated search is required.
- [ ] Search durable user/assistant text and session metadata in the daemon.
      Preserve case-insensitive AND terms, the leading-apostrophe literal match,
      fuzzy matching, and title-before-message ranking from the current matcher.
      Include persisted answers and agent questions as the existing matcher does.
      Unsent drafts/queue echoes need not be searchable; they are not durable text.
      Move the pure matcher without importing TUI theme/model code into the daemon.
      Do not silently substitute SQL LIKE or FTS semantics for the current grammar.
- [ ] Query the database directly and keep matching/ranking server-side. Inspect
      the existing schema/query facilities first. Do not construct a second
      permanent in-memory copy of every transcript or add a new search engine.
      If fuzzy scoring requires scanning text, stream/batch candidates and keep a
      bounded result set; measure a large history before inventing an index. Query
      pagination bounds the response, not necessarily the cost of finding matches.
- [ ] Add a small search handle owning query, Loadable results, debounce, and one
      query lifetime. Typing updates immediately; stale results cannot replace a
      newer query. Disable result activation while showing stale/loading results.
      Clearing the query restores the full fleet immediately.
- [ ] Intersect returned IDs with the current fleet for display and selection.
      Do not clamp selection to unrelated results while a new search is pending.
      Load more results on demand; a capped response must not imply no more matches.
- [ ] Search refreshes on query change or explicit refresh/reopening. It need not
      rerun on every streamed event or maintain live ranked results across clients.
      Disconnect invalidates results; reconnect reruns an active query once.
- [ ] Delete TUI search-document caches, scoring, and transcript-based `fleetView`
      projections. Search must work for sessions never selected in this TUI.

Validation: move existing pure grammar/ranking tests to the server matcher, rather
than duplicate them. Keep one database-backed case finding text in an unvisited
session, result pagination, and a handle case where old-query results arrive late.
Verify that persisted content becomes searchable on a new query/refresh without
downloading other sessions' pages. This new RPC can have a concrete typed wrapper;
it does not authorize the all-method RPC migration listed under follow-ups.

## 6. Consolidate transcript ownership and preserve scrollback

Files: transcript sections of `model.ts`, `fleet-handle.ts`, `components.tsx`.
Introduce `transcript.ts` containing pure resource transitions and its handle.

- [ ] Own one selected-session transcript resource, including existing child
      filtering. Drop per-session transcript caches; selecting another session
      reloads it. Drafts and queues remain independent and survive selection.
- [ ] Represent unloaded/loading/failure/ready explicitly. Only ready contains
      a retained window and the operations possible on that window. Avoid two
      independent Loadables plus unrelated flags that permit impossible mixtures.
- [ ] One resource lifetime owns live subscription, requests, and scroll. On
      selection change/reconnect/disposal invalidate that lifetime. Late callbacks
      must affect neither rows nor scroll. Cancellation alone is not a proof that
      an already queued callback cannot run.
- [ ] Listen for live events before the initial fetch and retain the minimal
      durable-ID deduplication needed for overlap. Fetch only while connected.
      Reconnect loads latest; failed initial loads retry on explicit action.
- [ ] Move pure line formatting/wrapping out of the React component module so
      the transcript handle does not import components to compute geometry.
      Preserve existing per-line layout caching and visible-row construction.

- [ ] Keep cursor pagination, bounded retention, and existing Home/End behavior.
      Encode live-tail versus historical-window behavior in variants, rather than
      a `following` boolean unrelated to load state.
- [ ] Give window retention and scroll adjustment one owner. Do not duplicate
      viewport corrections between promise callbacks and root dispatch.
- [ ] Keep the cap in all growth paths. When old browsing evicts the live tail,
      do not append new events across the missing interval; End reloads latest.
- [ ] Preserve `o`/`Alt+o` request/transcript viewing and `Ctrl+e` prompt editing
      with transcript context, using the existing editor-handoff module. Preserve
      the current retained-transcript export scope; a full-history export is not
      required for this refactor. Never retain other sessions' pages for the editor.

Validation: initial/live overlap produces no duplicate
rows; late old-resource response has no effect; reconnect shows latest; old history
does not alter outstanding requests; wrapped rows scroll correctly; editor opening
and return preserve content. Keep meaningful eviction/pagination/viewport tests:
their behavior remains. Reduce ownership and invalid combinations, not scrollback.

## 7. Subscribe and render at feature boundaries

Files: `app.tsx`, `fleet-handle.ts`, `store.ts`, `components.tsx`, feature handles.

- [ ] Root view contains layout/selection/active-overlay information, not a fresh
      copy of every pane's inputs for every event. Panes consume narrow feature
      views with stable references when their actual inputs have not changed.
- [ ] Replace the central 120ms whole-app publish with an animation subscription
      scoped to visible animated content. One shared clock is sufficient; disable
      it when nothing visible animates. Use a deadline for notice expiration.
- [ ] Keep cache-age/elapsed-time displays updating at their visible precision.
      Removing the global clock must not freeze those displays indefinitely.
- [ ] Use memoization only after narrowing inputs. Do not deep-compare entire
      snapshots, introduce a second replicated fleet, or add custom equality
      functions to every component. In-place mutation is not reference stability.
- [ ] Keep events/state updates immediate. If measurements still show redundant
      work during bursts, coalesce view publication only, with a bounded delay;
      never drop provider events or delay the state used to interpret keypresses.
- [ ] Delete central tick plumbing and root-dispatch effect checks as their last
      consumers move. The root handle should compose features and route input.

Validation: spinner-only updates do not execute transcript derivation; typing does
not derive the fleet unnecessarily; streaming another session does not rebuild the
selected transcript unless its relevant inputs change. Use a short diagnostic trace,
not permanent render-count assertions coupled to React scheduling. Repeat step 0;
report terminal bytes and CPU/render work separately. Do not claim measured speedups
from code inspection alone.

## 8. Simplify connection lifecycle without changing the protocol

Files: `client/src/client.ts`; connection tests.

- [ ] Make one supervisor own dial → handshake/first snapshot → connected →
      teardown → optional retry. A read-loop close reports to that supervisor;
      it never recursively starts another reconnect loop.
- [ ] Scope socket, decoder/buffer, write chain, and pending RPC cleanup to one
      connection attempt. Dispose the attempt before starting another. Keep one
      cancellation/identity check for late asynchronous work; delete guards only
      where exclusive ownership makes their case unreachable.
- [ ] Reuse the same opening path for initial connect and reconnect. Bound startup,
      clean up every failure path, and keep mismatch terminal. Closing during a dial
      must close a late socket rather than reopening the client.
- [ ] Preserve partial-write ordering, backlog limits, pending RPC rejection,
      no mutation replay, epoch handling, and existing `loom tail` replay behavior.
- [ ] No new transport interface hierarchy. If an extraction grows the lifecycle
      implementation without deleting overlapping ownership, revise it before merge.

Validation: keep transport-boundary tests for partial/failed writes, malformed
frames, reconnect, startup failure, mismatch, and close during pending work.
Consolidate overlapping race scenarios only after the old overlapping loops are
gone. Multiple clients are not required to trigger these failures.

## 9. Remove redundant tests and close the work

- [ ] Review affected tests by responsibility: pure transition, effect boundary,
      transport boundary, or integrated user flow. Keep a representative integrated
      flow; do not repeat its full daemon setup for every pure branch.
- [ ] Delete tests for removed overlay combinations, old projection/cleanup helpers,
      optimistic-mode counters, and any offline browsing behavior. Preserve tests
      that protect drafts, queued text, and uncertain sends across disconnects.
- [ ] Remove exact snapshot-count/order assertions where they express no user
      requirement. Keep proof that resulting state is coherent, request changes
      arrive, and rate-limit-only changes eventually publish. Do not deliberately
      reintroduce partial internal updates to save a few lines.
- [ ] Retain ordinary second-client smoke coverage. Drop exhaustive multi-client
      permutations that duplicate the same session serialization invariant. Retain
      adapter/event versus command races that one TUI can produce.
- [ ] Run affected checks during each step; finish with all four standard tasks
      from step 0. Exercise actual TUI selection, typing, mode switching, queueing,
      questions, plans, history, reconnect, resize, and editor handoff.
- [ ] Report removed state fields/maps, deleted branches/effects, module boundaries,
      source/test deltas, and before/after performance. List unverified manual checks.
      Do not invent extra features or tests to hit a reduction percentage.

Done: the important user flows still work, feature effects have one owner, the
root no longer handles every feature transition, and production plus affected test
code is smaller. A smaller root file alone does not meet the reduction requirement.

## Separate follow-ups, outside this implementation

- Typed RPC method→params/result association is valuable, but spans the dispatcher,
  client, CLI, and many handlers. Plan it separately; do not turn the TUI pass into
  an all-method protocol migration or keep caller-chosen `request<T>` as a claimed
  type-safety solution.
- `wire-decode.ts` currently claims complete domain types after partial checks.
  Decide separately between schema-derived validation and an explicit trusted,
  version-matched local protocol boundary. Do not expand handwritten checks field
  by field while calling them a proof, or remove malformed-frame handling casually.
- Provider request claiming, adapter-response failures, duplicate pending IDs, and
  lossy control channels remain the separate follow-ups in the state-sync fix plan.
  This plan does not claim to solve them.
