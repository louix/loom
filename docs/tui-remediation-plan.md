# TUI remediation: correct transitions, fewer owners, less code

Baseline: `46de3ef` on `loom/execute-tui-reduction-plan-incrementally`.
Status: implemented; final validation is recorded below. This replaces the unfinished reduction and
ownership portions of `tui-reduction-plan.md`; keep that document as history.

The branch added 1,456 production/config lines, 902 test lines, and 550 doc lines
over `6e2c2e4`. Useful changes exist, but the reduction acceptance criterion was
not met. Do not describe relocation plus dependency interfaces as completed
ownership, or infer that reduction was impossible from these results.

Performance was not a pre-existing problem to solve. Measurements below are
regression checks. Mode selection must show the target immediately; the retained
300ms debounce delays the daemon call, not local feedback.

## Settled scope

Keep continuous scrollback, selected-session history, editor viewing/editing,
queued follow-ups, unsent drafts, multi-question answers, plan retargeting,
immediate mode-selection feedback, replacement fleet snapshots, incremental Ink
output, and the single connection supervisor. Keep daemon command serialization,
safe socket writes, and raw replay for `loom tail`.

Change search to one response containing all matching session IDs. No search
pagination, prefetch, live ranking synchronization, or TUI transcript search.
On disconnection show connection status and quit only; retain unsent text in
memory but offer no offline browsing, editing, or daemon actions.

No framework migration, generic event/effect bus, typed-RPC overhaul, schema
migration, provider rewrite, or speculative transport rewrite. Do not remove
scrollback or debounce to meet a line target. Do not auto-retry uncertain writes.

## Working rules and gates

1. Work in this branch's worktree; verify HEAD and local changes first. Do not
   modify main or another agent's changes. Record a new baseline if HEAD moved.
2. Make one reviewable change per numbered step. Steps 1–2 are correctness fixes
   and may grow slightly. Each later simplification must delete its predecessor
   and achieve net production reduction within its affected scope before moving on.
   Redesign a growing extraction; do not mark it done as “separation.”
3. Record source/config and tests separately against both `46de3ef` and
   `6e2c2e4`. Moved lines, compressed formatting, and removed comments are not
   substantive reduction. Final production and affected tests must be net smaller
   than `46de3ef`; report honestly how much of the original growth remains.
4. Add a regression for a reproduced defect if none exists. Otherwise adapt/move
   existing tests; never duplicate a suite for the new module. No exhaustive
   permutations of multiple clients, private fields, or React render schedules.
5. Run relevant checked tests during each step. Finish with `deno task typecheck`,
   `deno task test:silent`, `deno task lint`, and `deno task format:check`.
6. Completion notes: one short paragraph per step with deletions, behavior,
   evidence, and deltas. No new implementation diary. Correct misleading existing
   completion claims in step 8 rather than rationalizing unmet requirements.

## 0. Establish evidence once

- [x] Run the four standard checks and record environment failures separately.
- [x] Retain the review's reproducible scenarios in step 1–2, not necessarily its
      temporary fixtures. The review passed 144 checked model/search tests; its
      separate fixture probes used `--no-check`. Neither is a full-suite baseline.
- [x] Recover the useful benchmark from Git history into one opt-in script if
      needed. Compare the same dimensions, transcript, and input for idle, streaming,
      typing/mode selection, and scrolling. Record stdout bytes, render time/count,
      and key-to-visible feedback. Do not build a general benchmark framework.

Done: a baseline and a reproducible comparison, with real-terminal gaps named.

## 1. Fix the composer without adding another coordination layer

Files: `frontend/tui/src/composer.ts`, its wiring in `fleet-handle.ts`, affected
cases in `test/tui-model.test.ts` and `test/tui-render.test.ts`.

- [x] Preserve a sending head when clearing the queue: `sending(text, rest)`
      becomes `sending(text, [])`, never idle. Clearing held text's waiting tail
      retains the held head too. Clearing an ordinary queued box may make it idle.
- [x] Give each dispatched send one local operation identity, owned by its sending
      variant. Completion must match that identity before modifying anything.
      Do not use text equality; identical messages can be separate operations.
      This is local lifecycle identity, not a wire operation-ID protocol.
- [x] On definitive failure preserve the message in a blocked/held variant with
      an explicit failure reason. Require user review/resubmit. Do not convert it
      directly back to automatically eligible `queued`, even on a later snapshot.
      On ambiguous failure show “may already have been sent” and require the same
      explicit action. Do not falsely report a definitive failure as uncertain.
- [x] Preserve the unsent tail and existing one-release-per-turn barrier. Reviewing
      a failed head must not immediately release its tail ahead of the user's
      decision. Keep held text recoverable until submitted, edited/saved, or discarded.
- [x] Bind callbacks to the operation and controller lifetime. A late completion
      after removal/disposal cannot mutate a new box, emit a notice, or restart work.
- [x] Keep transitions pure. Commit before the network call. Notifications must
      never be the event that makes another send eligible.

Required evidence: reject a send while the fleet remains unchanged—exactly one
RPC, text retained. Clear while a send is pending, enqueue another message, and
resolve the first—the second neither starts early nor gets consumed by the first
completion. Repeat with identical text and with an obsolete completion after
disposal. Adapt existing uncertain-send and next-turn tests, retaining their meaning.

Done: these regressions pass without a `draining` set or a second shadow outbox.

## 2. Repair rendering dependencies, then measure

Files: `fleet-handle.ts`, `views.ts`, `components.tsx`, `app.tsx`, `theme.ts`.

- [x] Make theme an explicit input to all memoized panes. Prefer passing the
      selected immutable palette through props or one React context. Stop relying
      on mutating global `C` to invalidate `React.memo`. Existing non-memoized
      consumers can migrate with the same change; do not create two theme owners.
- [x] Account for outbox-derived echoes in transcript rendering. Queue changes
      must update the displayed rows even if the durable transcript is unchanged.
- [x] Remove the claim that missing memo dependencies cannot produce stale frames.
      First make correctness obvious, including temporarily removing a memo if
      necessary; step 6 removes the bespoke dependency-list machinery.
- [x] Fix Help's terminal overflow: give it the actual content-height budget and
      scrolling for overflow, preserving access to every binding. Check narrow and
      short terminals without forcing minimum dimensions beyond the viewport.

Required evidence: theme changes repaint an idle header and panes with unchanged
session data; queue echo removal is visible without another provider event;
Help fits a 120×40 and a short/narrow viewport, scrolls, and closes cleanly.
Check rendered content/colour or reconstructed screen, not internal memo counts.

Done: incremental rendering remains enabled and these visible regressions are gone.

## 3. One search query, one answer, complete searchable history

Files: `core/src/wire.ts`, search RPC in `backend/daemon/src/daemon/daemon.ts`,
`backend/daemon/src/store/session-search.ts`, `frontend/tui/src/fleet-search.ts`,
search consumers and tests.

- [x] Replace the paginated result with `{ query, ids: readonly string[] }`, in
      rank order. Return IDs only; the fleet snapshot supplies display metadata.
      The response has at most one ID per session already represented in the fleet.
- [x] Update producer and consumers together. Delete `SearchCursor`, limit/offset
      validation, query-bound cursors, `loadingMore`, `prefetchWithin`, selected-row
      prefetch triggers, page concatenation, and their tests. Remove score from the
      public response if no consumer needs it. Apply the repository's protocol-version
      policy for an incompatible result shape; do not retain a legacy paging adapter.
- [x] Remove both arbitrary text cutoffs. Preserve fuzzy AND terms, literal-prefixed
      terms, title/user/agent ranking, and persisted answers/questions. Unsent local
      drafts remain outside database search. Do not change matching semantics quietly.
- [x] Start with a simple scan over one session at a time, releasing its temporary
      searchable text after scoring. No permanent corpus copy, worker infrastructure,
      or FTS migration. This uses memory proportional to the largest session's text;
      do not claim a constant bound or hide truncation to improve measurements.
- [x] Measure full-history query time, peak memory, and event-loop blocking with
      long sessions as well as many short ones. If synchronous work blocks the daemon
      materially, yield between bounded scan batches before considering a larger
      design. Do not introduce silent content limits as the fix.
- [x] Keep one debounced query lifetime and Loadable result. Query replacement,
      disconnect, and disposal invalidate old callbacks immediately. While loading,
      show loading rather than maintain stale selectable results. Empty query uses
      the fleet locally. Refresh on query change/reopening/explicit refresh and once
      on reconnect, not on every provider event.

Validation: existing grammar/ranking tests; a match beyond character 2,048; an old
match beyond 256 KiB of newer text; an unvisited session; more than 50 matches in
one response; a stale query response cannot replace a new answer. Pagination tests
are deleted, not renamed to assert private replacement fields.

Done: fewer production lines across TUI + wire + daemon, one scan per query,
no client dependency on other sessions' pages, and no silent searchable-history cap.

## 4. Enforce the connection boundary once

Files: `app.tsx`, `fleet-handle.ts`, connected-feature wiring.

- [x] Branch the rendered/input surface on ClientState: data mounts the connected
      UI; pending/error/idle shows status and quit. Remove `OFFLINE_ACTS` and
      scattered offline notices/activation exceptions. No offline help/pickers/log UI.
- [x] Store unsent drafts, queues, selection intention, and an already-open editor's
      eventual returned text outside the disposable connected effects. Keeping these
      values is not permission to keep browsing or sending while disconnected.
- [x] On disconnect cancel scheduled mode/search work, invalidate history requests,
      and stop animation. Settle already-dispatched sends as uncertain when their
      RPC fails; preserve their text. No writes may be initiated while disconnected.
- [x] On reconnect revalidate selected session/request targets, reload latest
      history, refresh an active search once, and resume only genuinely unsent
      queued follow-ups under the existing turn rule. Never replay mode intent or
      an uncertain mutation merely because a connection returned.

Validation: disconnect with a draft, queued text, pending send, scheduled mode
change, and outstanding history/search. No daemon actions while down; text survives;
old callbacks cannot revive work. Existing editor handoff may return text while down.

Done: one visible/input connection gate, deleted offline branches, no lost input.

## 5. Finish feature ownership; stop recursive root reconciliation

Files: `composer.ts`, `mode-control.ts`, `fleet-search.ts`, `transcript.ts`,
`model.ts`, `fleet-handle.ts`, and their consumers.

- [x] Migrate one feature at a time in this order: composer, mode, search, transcript.
      Its handle owns the canonical local value in an existing `mkStore` or closure,
      exposes `get/subscribe`, and accepts concrete user/lifecycle inputs. Keep pure
      transitions beside it. No generic base controller or effect interpreter.
- [x] Delete that feature's field and replacement-value actions from TuiState in
      the same change. Delete `boxes/choices/transcript/find` getter-plus-commit
      round trips to the root. A temporary read-only adapter must not survive the step.
- [x] Feed a fleet notification to each interested feature once from composition.
      Feature publications notify consumers; they do not re-enter root dispatch or
      trigger a sweep of every other feature's `settle()` method. User inputs and
      operation completions go straight to their owner.
- [x] Keep authoritative fleet state in the client. Features may read it, but must
      not maintain independently mutable session/request replicas. Root owns only
      selection/layout/overlay coordination and routes concrete commands.
- [x] Make cross-feature dependencies explicit and one-way: transcript display
      reads composer waiting text, but transcript publication cannot drain queues.
      Mode errors may request a plan overlay; opening it cannot restart mode work.
- [x] For mode, retain immediate target feedback, debounce, and at most one active
      apply per session. Capture application identity. `dispose()` must prevent a
      late success from calling `resume()` and arming a new timer; callbacks from a
      removed operation must not clear a newer selection. Review the analogous
      interaction guard lifecycle without introducing a second request database.

Validation: carry the existing feature behavior tests forward. Add only uncovered
late-operation/disposal regressions. Test feature inputs/outputs directly; keep a
small integration set proving routing, not full daemon fixtures for pure transitions.

Done: root `dispatch` no longer runs composer/search/transcript settlement, feature
state is absent from TuiState, and the combined changed files shrink. Do not count
a new 1,000-line controller plus a smaller root as a reduction.

## 6. Simplify rendering around those owners

Files: `app.tsx`, `components.tsx`, `views.ts`, `clock.ts`, `fleet-handle.ts`.

- [x] Panes subscribe to their feature's stable snapshots. Root subscribes only to
      layout/selection/overlay inputs. Remove root `FleetView.state` and feature
      copies once callers consume their owners directly.
- [x] Delete `memoOne`, `ViewMemos`, and manual `unknown[]` dependency lists. Pure
      view builders take the actual narrow inputs they read, not all of TuiState.
      Use ordinary React memoization only at expensive boundaries with explicit
      inputs; do not replace the deleted helper with a renamed memo framework.
- [x] A shared animation clock publishes to animated subscribers, not root
      `publish()`. Static transcript rows do not receive a changing spinner tick.
      Keep a slower clock for visible age/countdown displays and a notice deadline.
      No timer while disconnected or while nothing visible requires one.
- [x] Preserve line wrapping cache and visible-row construction. Avoid additional
      cache/index layers unless the same benchmark demonstrates a remaining cost.
- [x] Collapse view wrappers and pass-through interfaces that no longer serve an
      ownership or performance boundary. `views.ts` need not survive as a separate
      layer if its small remaining builders belong with their features.

Validation: repeat the step 0 scenarios, including another session streaming while
the selected transcript is idle. Theme changes remain correct. Compare bytes and
CPU separately; verify immediate mode/input feedback and real terminal behavior
where available. Prefer one diagnostic trace over permanent scheduler-count tests.

Done: fewer rendering/coordination lines, no clock-driven whole-app publication,
and no measured material regression from the baseline's responsiveness.

## 7. Consolidate tests after deleting responsibilities

- [x] Delete search-pagination, offline UI, root feature-commit, private memo, and
      retired bookkeeping tests as their implementation disappears.
- [x] Keep pure transition tests for actual behavior. No runtime tests merely
      proving that a union variant contains its required payload. Typecheck enforces
      construction, while runtime tests prove the chosen transition/effect is right.
- [x] Keep boundary coverage for sends, stale requests, page overlap/retention,
      late callbacks, transport framing, reconnect, and protocol mismatch. Retain
      one ordinary second-client smoke case; no combinatorial synchronization suite.
- [x] Put feature tests with their feature suite; stop accumulating every new
      controller test in `tui-model.test.ts`. Move tests once, do not duplicate them.
- [x] Keep a representative real handle/Ink integration path for composition,
      input, scroll, and editor handoff. Do not delete a unique behavior test solely
      to achieve a numerical target.

Done: net fewer affected test lines, meaningful regressions retained, no coverage
claim based solely on test count or exhaustive construction of valid variants.

## 8. Close with evidence, not a revised success criterion

- [ ] Finish real-terminal acceptance. Standard checks and automated flows pass;
      physical-terminal coverage remains partial. Manually exercise typing, mode cycling, queued
      sends, questions/plans, scrollback, search, editor handoff, theme, Help,
      reconnect, resize, and quit. Name unavailable real-terminal checks honestly.
- [x] Correct the old report's ownership/reduction conclusions and completed
      checkboxes contradicted by the review. Preserve measured historical numbers
      as historical numbers; do not rewrite them to describe the new implementation.
- [x] Report source/test deltas against both baselines, remaining large modules,
      deleted state/actions/interfaces, and before/after performance. If a size gate
      remains unmet, the reduction work is incomplete, not “done as separation.”
- [x] Keep the connection supervisor and transport unchanged unless validation
      reproduces a defect. Provider request claiming and the broader typed-RPC/wire
      validation work remain separate follow-ups; they do not belong in this pass.

Final acceptance: reproduced failures fixed; no silent history-search omissions;
no offline coordination layer; local feature state has one owner; root dispatch
and animation no longer coordinate every feature; production and tests smaller
than `46de3ef`; retained user flows remain usable and responsive.

## Completion evidence

**0 — Baseline.** All four standard tasks passed before implementation. Rendering
comparisons use the recovered opt-in script outside the repository, at 120×40
with incremental output. The before measurement is `09845c0` (send safety already
fixed), not an untouched `46de3ef`. No permanent benchmark framework was added.

**1 — Sends.** Sending operations have identity; clearing preserves their head;
rejection and uncertainty require explicit retry. Snapshot publications cannot
resend rejected text. Submitted input is recorded before RPC dispatch. Removed
sessions recover all remaining outgoing text into an editable draft, preserving
an existing draft too. Checked regressions cover rejection, review, identical
replacement text, clear during send, turn barriers, and disposal.

**2 — Visible correctness.** Memoized panes receive an immutable palette through
context; queue echoes follow the composer. Help wraps and scrolls within the real
viewport. Request previews fit their reserved rows. Rendered regressions and the
production-mode screen reconstruction pass, including short/narrow resize.

**3 — Search.** Protocol v3 returns one ranked ID list. Search pagination, cursors,
prefetch, public scores, and both text cutoffs are deleted. Existing grammar tests
and long/old text regressions pass. One session is scanned at a time, yielding
between scan batches. For 200 sessions × 500 events (128.2 MB synthetic database),
queries took 194–219ms; the largest sampled timer gap was 20.2ms. Sampled process
RSS peaked at 554 MB, including fixture construction and SQLite; this is not a
search-only memory bound. A pathological single session can still be expensive.

**4 — Connection.** Non-data states show status and quit only. Drafts survive;
mode intent is cancelled; old search/history completions are ignored. Reconnect
refreshes reads without replaying uncertain mutations. The transport and its
connection supervisor were left alone. Boundary integration tests pass.

**5 — Ownership.** Composer, mode, search, and transcript own their values and
subscriptions. Their root fields and replacement actions, including tool-name
bookkeeping, are deleted. The root routes selection/viewport inputs and client
notifications; feature publications never re-enter its reducer. Mode's choosing
variant owns its timer, replacing the separate timer map. UI prompt history and
drafts remain with the input/overlay state.

**6 — Rendering.** `memoOne`, `ViewMemos`, `FleetView.state`, the combined feature
adapter, and clock-driven whole-app publication are gone. Panes subscribe to the
owners they read; static transcript rows do not subscribe to spinner ticks. The
pass-through detail view is deleted. The comparison found no material input-delay
regression: typing p95 55.6→48.0ms, scroll median 5.2→4.8ms, immediate mode hint
3.2→6.0ms, daemon dispatch still ~301ms. Streaming bytes stayed ~139KB and typing
bytes ~254KB. Total CPU fell slightly, but measured Ink render time rose; this is
not a claim that rendering was slow before or that every render became faster.

**7 — Tests.** Mode and search suites moved once to their feature files. One session
fixture replaces duplicated model/render construction. Pagination, root feature
replacement, memo-identity, and history-mutates-root-state checks were removed.
The latter had become tests of fixture copying once the types separated owners.
Real handle/Ink and transport coverage remains. The checked closing TUI run passed
135 tests plus 62 integration steps; subsequent mode/composer checks passed too.

**8 — Verification and limits.** Standard task results and final line accounting
are recorded in the report. The production-mode screen exercise had zero failures;
PTY probes emitted complete input without another key and quit cleanly. Other
retained flows passed automated integration tests, including an editor substitute.
A physical terminal/editor session and the user's Nix-built binary were not fully
exercised. The reported one-key delay was not reproduced and is not claimed fixed;
the user elected to retry after these changes. No daemon sync perfection, provider
request-claiming system, or generic reactive framework was added.
