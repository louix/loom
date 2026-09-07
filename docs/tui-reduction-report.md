# TUI reduction, separation and rendering — final report

Plan: `docs/tui-reduction-plan.md`. Measurements: `docs/tui-reduction-baseline.md`.
Base `6e2c2e4`, twenty-one commits, steps 0–9.

The original implementation grew and left important ownership work unfinished.
Its claim that the code could not shrink, and that overlapping ownership was
gone, was incorrect. The root still held feature values and recursively settled
them; the clock still published the root view. Treat sections 1–6 below as the
historical report for `46de3ef`, not a description of the remediated code.

The subsequent work is documented in [tui-remediation-plan.md](tui-remediation-plan.md).
It fixes send identity/retry and visible rendering defects, removes paginated and
truncated search, gives features canonical ownership, and removes root pane caches
and animation publication. Immediate mode feedback is preserved; the 300ms delay
applies only to dispatch. Performance measurements are regression checks.

### Remediation accounting

| Comparison                          | Production/config | Tests | Combined code |
| ----------------------------------- | ----------------: | ----: | ------------: |
| Remediation vs. `46de3ef`           |              −256 |  −173 |      **−429** |
| Whole branch vs. original `6e2c2e4` |            +1,200 |  +729 |    **+1,929** |

Documentation is excluded from these code totals. New feature test files are
included; relocating a suite does not count as deleting it.

These are net source/config and test deltas across the repository, not just the
TUI directory. Moves are not counted as substantive reduction. This is a modest
reduction, not the hoped-for 50%; most original growth remains. Large modules still
include the root handle (~2.4k lines), UI model (~1.5k), and transcript (~1.4k).
The root still contains substantial command routing; that has not been disguised
as a completed large-scale reduction.

Typecheck, the full checked test suite, lint, and format checks pass. Retained UI
flows also pass checked integration tests and the production-mode terminal-screen
exercise. Physical terminal/editor acceptance is partial; the user's Nix-build
keypress issue is deferred for their retest, not claimed resolved.

---

## 1. State fields and maps removed

Deleted from `TuiState`:

| gone                                                | what it was                                    | what replaced it                                                                                |
| --------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `mode` + `prompt` + `confirm` + `plan` + `picker`   | five slots, one active at a time by convention | one `overlay: Overlay` union                                                                    |
| `qaAll` / `qaIdx` / `qaAnswers`                     | a question list copied out of the request      | the request itself, plus `qnav` for the walk                                                    |
| `queue` / `heldSend` / `draining` / `lastDrainTurn` | four containers that had to agree              | one `Outbox` union per session                                                                  |
| `lastDraft` / `promptHistory`                       | two unsent-text stores                         | one `Drafts`                                                                                    |
| `modeDraft`                                         | an optimistic mode never rendered anywhere     | `ModeChoices` (`choosing` \| `applying{sent,next}`), which _is_ rendered                        |
| `transcripts: Record<string, Transcript>`           | a transcript cache per session                 | one `transcript: Transcript` for the selected session                                           |
| `transcriptGen`                                     | a generation counter beside the caches         | the transcript handle's own lifetime                                                            |
| `Transcript.head` / `.older`                        | two independent `Loadable`s                    | the resource's variant (`loading` / `failed` / `tailing` / `detached`) plus `older: OlderFetch` |
| `Transcript.following`                              | a boolean unrelated to load state              | the `detached` variant                                                                          |
| `Transcript.echoes`                                 | stored "queued: …" markers, never removed      | derived per render from the outbox (`waiting`)                                                  |
| `fleetView`                                         | a projection of the fleet recomputed per read  | `searchMatches` over the daemon's ranking                                                       |

Deleted from `LoomClient`: `#generation`, `#sock`, `#buf`, `#decoder`,
`#writeChain`, `#readLoop`, `#helloDone`, `#preHelloQueue` — all now fields of
one `Attempt`, gone when the attempt is.

Closure state deleted from `fleet-handle.ts`: `modeDebounce`, `modeInFlight`,
`requestActed`, `logScroll`, and the `tick` interval's bookkeeping.

## 2. Branches and effects deleted

- Ten overlay open/close actions → one `overlay` action. Five history actions
  (`historyStart` / `historyPage` / `historyFailed` / `transcriptReset` /
  `transcriptFollow`) plus `echo` → one `transcript` action carrying a value the
  pure transitions produced.
- `cycleSessionMode` (70 lines of debounce + in-flight bookkeeping in the root),
  `sessionMode()`, `forgetDeadSessions`, `pruneByLive` over transcripts,
  `anyCompacting`, `searchSessions` + `buildDocs` + two memo caches.
- Two connection-opening paths became one (`#open`), and the socket-close handler
  no longer starts a reconnect: `#run` is the only thing that decides what a
  closed socket means, so a drop during a handshake can no longer run two
  openings at once.
- The central 120ms `setInterval` and its "is anything in the fleet busy" check;
  the poll for notice expiry; `Date.now()` at render time.
- `logRowCount` used to run twice per `push` dispatch whenever the viewport was
  scrolled. There is now one measurement site, and it returns before measuring
  while the pane is at the live tail — which is where it sits almost always.

## 3. Module boundaries

`frontend/tui/src/` went from 4 meaningful modules to 12. Each new one owns its
own state, its own pure transitions, and — where it has effects — a handle with
`settle()` / `dispose()` swept by the root:

| module            | owns                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `overlay.ts`      | what is open over the fleet, and where a picker returns to                                    |
| `interactions.ts` | outstanding requests, one guard per request                                                   |
| `composer.ts`     | text on its way to a session, and unsent drafts                                               |
| `mode-control.ts` | mode selection, its debounce, and its optimistic chip                                         |
| `fleet-search.ts` | the `/` filter's query lifetime (matching is the daemon's)                                    |
| `transcript.ts`   | what an event becomes, what the filter keeps, how it wraps, and the selected session's window |
| `views.ts`        | what each pane draws, narrowed to that pane's inputs                                          |
| `clock.ts`        | one animation beat, and one deadline timer                                                    |

Two boundaries moved _out_ of the TUI entirely:

- **Search** is now `session.search` in the daemon, answered from
  `session_events`. `backend/daemon/src/store/session-search.ts` (254 lines) holds
  the matcher that used to live in the TUI.
- **Line geometry** left the React module: `fleet-handle.ts` no longer imports
  `components.tsx` to measure scrollback.

`components.tsx` is the only module that renders, and (except for the footer and
the prompt pane, which are the input surface) every component is now a pure
projection of a narrow view.

## 4. Source and test deltas

| area                                | before | after  | Δ          |
| ----------------------------------- | ------ | ------ | ---------- |
| TUI production (`frontend/tui/src`) | 9,044  | 10,043 | **+999**   |
| TUI tests (model + render + editor) | 6,104  | 6,700  | +596       |
| `client/src/client.ts`              | 767    | 855    | +88        |
| `core/src/wire.ts`                  | 525    | 582    | +57        |
| `daemon/daemon.ts`                  | 3,218  | 3,268  | +50        |
| `store/session-search.ts`           | —      | 254    | +254 (new) |
| `test/client-state.test.ts`         | 834    | 886    | +52        |
| `test/daemon.test.ts`               | 2,355  | 2,430  | +75        |
| `test/session-search.test.ts`       | —      | 179    | +179 (new) |

Per step, TUI production / TUI tests:

| step                       | Δ prod | Δ tests | character                                                                 |
| -------------------------- | ------ | ------- | ------------------------------------------------------------------------- |
| §2 overlay + prompt unions | −52    | +82     | **reduction**                                                             |
| §3 interactions + composer | +185   | +46     | separation (512 lines moved out of the root, which shrank ~330)           |
| §4 mode control            | +188   | +146    | separation, plus feedback that did not exist before                       |
| §5 search → daemon         | +108   | +157    | move (the ~180 deleted lines reappear in the daemon) + an async lifecycle |
| §6 transcript ownership    | +165   | +107    | separation (three files lost 1,218 lines; the new module is larger)       |
| §7 feature views + clock   | +398   | +119    | separation                                                                |
| §8 connection lifecycle    | +88    | +52     | separation                                                                |

**§2 is the only step that reduced anything, and it reduced 52 lines.** The plan
named a 50% reduction as an investigation target for affected subsystems, not a
requirement. The conclusion that size was not a problem was unsupported, and
overlapping ownership still existed at this historical baseline. The remediation
above corrects that conclusion without rewriting these historical measurements.

## 5. Performance, before and after

Four scripted scenarios at 120×40, `incrementalRendering` on after §1. Two
numbers are worth reading; the rest moved inside noise.

**Terminal bytes** (§1, the one change that was purely output):

| scenario                          | before    | after   | Δ        |
| --------------------------------- | --------- | ------- | -------- |
| one streaming session (60 events) | 494,344   | 139,343 | **−72%** |
| scrolling a long transcript       | 195,285   | 33,448  | **−83%** |
| typing + mode while streaming     | 1,112,974 | 251,541 | **−77%** |

**Idle CPU** (§7, the clock):

|                  | before | after      |
| ---------------- | ------ | ---------- |
| 3s idle, renders | 0      | 0          |
| 3s idle, CPU     | 5.11ms | **0.38ms** |

The old 120ms interval ran for the life of the process and declined to draw
~24 times per idle 3s; there is now no timer at all when nothing on screen
animates. Renders and bytes are both zero either way, which is why `cpuMs` had
to be added to the bench to see it.

**Mode-selection latency** (§4), keypress to visible local feedback:

| leg                                     | before | after                           |
| --------------------------------------- | ------ | ------------------------------- |
| keypress → mode hint in the send prompt | 317ms  | **3ms**                         |
| keypress → `session.setMode` dispatched | 301ms  | 301ms (the debounce, unchanged) |
| `session.setMode` → settled             | 16ms   | 16ms                            |

The 317ms was not latency: the optimistic draft was never rendered, so the hint
waited for the daemon. §4 supplied the feedback the plan assumed already existed.

**Cross-session search** (§5), measured in the daemon over synthetic corpora far
larger than a real one:

| corpus          | db     | rank one query |
| --------------- | ------ | -------------- |
| 50 × 200 events | 13 MB  | ~14ms          |
| 1000 × 50       | 64 MB  | ~85ms          |
| 200 × 500       | 128 MB | ~150ms         |

Behind a 180ms client debounce. No index was added, and not on "fast enough":
adding `(session_id, type, id)` leaves SQLite choosing `(session_id, id)`, which
already satisfies the ordering.

Render counts across the whole plan (`incrementalRendering` on throughout, so
§1 is excluded from the comparison): stream 76→77, scroll 39→30,
type+mode-while-streaming 197→168. The scroll and typing rows are the clock no
longer beating for content the layout is not drawing.

## 6. What is not verified

**No interactive terminal was available at any point.** Every rendering number
comes from a simulated TTY with `interactive: true` forced, so Ink emits its real
erase/cursor sequences into a fake stdout. What that cannot tell you:

- **Visible flicker.** §1's byte reduction is real; whether it _looks_ better on
  a real terminal is unverified.
- **Real `$EDITOR` handoff.** `suspendTerminal` → child process → resume →
  bracketed-paste re-assert is exercised with a stub editor. The stub is called
  and the frame comes back clean; a real `$EDITOR` on a real tty is untested.
- **Mouse reporting.** Click-to-select and the `[mode]` chip's hit region are
  driven by synthesised SGR sequences, not by a mouse.
- **Resize.** Driven by firing stdout's `resize` event at 60×20, 200×50 and back;
  a real terminal resize (SIGWINCH mid-frame) is untested.
- **Multiple real clients.** A second client is covered through the daemon's own
  tests; two live TUIs side by side were never run.

**One known failure, pre-existing and out of scope.** The incremental-render
correctness pass (which replays Ink's escape vocabulary into a reconstructed
screen, rather than checking "does the newest write contain X") reports:

```
help overlay: 56 rows rendered into a 40-row terminal (last write held 55 non-blank lines)
```

This was recorded at step 0 and is unchanged: the help overlay is taller than the
terminal, and Ink full-repaints an overflowing frame, so the help overlay is the
one screen §1 does not help. Fixing it is a layout change to `Help`, not a
lifecycle one, and the plan's scope did not include it.

Everything else in that pass is clean: initial render, help open/close, prompt
open/close, scroll back and return to the tail, three resizes, and the `$EDITOR`
round trip.

## 7. Standard checks

All four green at `HEAD`:

| task                     | result            |
| ------------------------ | ----------------- |
| `deno task typecheck`    | pass              |
| `deno task test:silent`  | pass              |
| `deno task lint`         | pass, no findings |
| `deno task format:check` | pass              |

## 8. Tests removed in §9

Two, both because a better test of the same behaviour already existed:

- _"PgUp climbs to the very top of a wrapped log"_ — subsumed by _"paging a
  wrapped log folds in older pages and reaches the first event"_, which asserts
  the same physical-row scroll ceiling through the handle (deterministic) rather
  than through Ink with a 40-iteration sleep loop.
- _"a wide terminal shows the full split"_ — a full daemon and an Ink mount to
  assert that `FLEET` and `EVENTS` both appear at 120 columns, which ~40 other
  tests already render.

Nothing else was found worth deleting. The plan's execution rules required each
step to delete obsolete tests in the same change that removed their
responsibility, and each did: §2 removed the overlay-combination tests with the
combinations, §4 the optimistic-mode counters, §5 the TUI matcher's tests (moved
to `test/session-search.test.ts` against the database), §6 converted the
retention / paging / viewport tests rather than duplicating them. There were no
snapshot-count or publication-order assertions to remove — the suite never had
any — and no exhaustive multi-client permutations: the several `c2` clients in
`test/daemon.test.ts` are each a distinct auto-resume behaviour after a restart,
not the same serialization invariant repeated.

The temporary instrumentation is gone: `scripts/tui-bench.ts` and
`scripts/search-bench.ts` were deleted in §9 along with the
`references/tui-bench-*.json` they wrote.
