# TUI reduction — step 0 baseline

HEAD `6e2c2e4`, Deno 2.9.5, Ink 7.1.1, `incrementalRendering` off.
Reproduce with `deno run -A scripts/tui-bench.ts --label before` (opt-in
instrumentation; writes `references/tui-bench-<label>.json`, never the TUI's
own stdout). No interactive terminal was available: every number below comes
from a simulated TTY (`interactive: true` forced, so Ink emits the real
erase/cursor sequences). Visible flicker is therefore **unverified**.

## Standard checks

| task                     | result            |
| ------------------------ | ----------------- |
| `deno task typecheck`    | pass (2.2s)       |
| `deno task test:silent`  | pass (55s)        |
| `deno task lint`         | pass, no findings |
| `deno task format:check` | pass, 192 files   |

## Scenarios — 120×40, same scripted input each run

| scenario                                                | React renders | render ms | stdout writes | stdout bytes | wall ms |
| ------------------------------------------------------- | ------------- | --------- | ------------- | ------------ | ------- |
| idle (3 idle sessions, 3s, no input)                    | 0             | 0         | 0             | 0            | 3000    |
| one streaming session (60 events @20/s)                 | 77            | 144       | 228           | 494,344      | 3267    |
| scrolling a long transcript (200 events, 12×PgUp + End) | 30            | 52        | 90            | 195,285      | 1968    |
| typing + mode while streaming                           | 184           | 311       | 534           | 1,112,974    | 11,909  |

Renders and bytes are separate measurements: at 30fps with no incremental
rendering, Ink writes a full ~2.1KB frame per render plus its erase preamble,
so bytes track frames, not changed content.

Key-to-visible-feedback (first stdout write containing the change):
scroll p50 3.0ms / p95 36.6ms; typing p50 2.4ms idle-ish, 36.5ms under a
streaming load. The p95s sit on the 30fps frame cap (33ms), not on work.

The idle row is genuinely zero: the 120ms interval in `fleet-handle.ts` already
returns early when nothing animates.

## Mode selection, leg by leg

One `⇧⇥` press on a live session, measured separately from the 300ms debounce:

| leg                                                    | ms  |
| ------------------------------------------------------ | --- |
| keypress → local hint in the send prompt (`⇧⇥ mode:…`) | 317 |
| keypress → `session.setMode` dispatched                | 301 |
| `session.setMode` dispatch → settled                   | 16  |
| keypress → applied `[mode]` chip in Detail             | 317 |
| keypress → `mode → …` notice in browse                 | 37  |

Socket latency is 16ms. Everything else is the debounce.

**The optimistic draft is not rendered anywhere.** `sessionMode()` in `model.ts`
folds `modeDraft` over the snapshot, but its only caller is `cycleSessionMode`
computing the next target: `components.tsx` renders `sendSess?.mode` in the
prompt hint and `s.mode` in the Detail chip, both straight off the snapshot.
So the send prompt's mode hint lags a press by debounce + round trip, and the
only genuinely immediate feedback that exists today is the browse-mode notice
(37ms — one frame). Step 4 must supply the feedback the plan says to keep, not
merely preserve it.

A rapid three-press cycle reached the daemon as 1–2 `session.setMode` calls
depending on scheduling jitter, never 3.

## Line counts (affected files)

Production: `fleet-handle.ts` 2881, `model.ts` 2952, `components.tsx` 2005,
`app.tsx` 241, `fleet-search.ts` 217, `theme.ts` 288, `editor.ts` 277,
`run.tsx` 55, `store.ts` 33, `theme-store.ts` 34, `editor-handoff.ts` 61 —
TUI total **9044**. Plus `client/src/client.ts` 767, `core/src/wire.ts` 525,
`daemon/daemon.ts` 3218, `store/sessions.ts` 826.

Tests: `tui-model.test.ts` 3279, `tui-render.test.ts` 2608, `tui-editor.test.ts`
217, `client-state.test.ts` 834, `connection.test.ts` 364, `daemon.test.ts` 2355,
`session-queue.test.ts` 124 — total **9781**.

## Step 1 — `incrementalRendering: true`

Enabled in `run.tsx`; `alternateScreen` and Ink's default 30fps cap unchanged.
React render counts are identical either way — this is terminal traffic only.

| scenario                      | bytes before | bytes after | writes           |
| ----------------------------- | ------------ | ----------- | ---------------- |
| stream (60 events)            | 494,344      | 138,793     | 225 (unchanged)  |
| scroll (12×PgUp + End)        | 195,285      | 33,448      | 90 (unchanged)   |
| typing + mode while streaming | 1,112,974    | 255,820     | ~530 (unchanged) |

`deno run -A scripts/tui-bench.ts --micro` isolates the two shapes of change:

| change                        | bytes/write before | bytes/write after |
| ----------------------------- | ------------------ | ----------------- |
| spinner-only tick             | 2,160              | 139               |
| one appended transcript event | 2,164              | 138               |

Key-to-visible-feedback improved as a side effect — typing p50 under a
streaming load fell from 36.5ms to 2.8ms, and the browse-mode mode notice from
37ms to 2.3ms — because a smaller write clears the stream sooner.

### Interaction pass

`deno run -A scripts/tui-bench.ts --exercise` replays Ink's incremental
escape vocabulary into a reconstructed screen (a stale row Ink forgot to erase
is invisible to a "newest write contains X" check, but not to this) and asserts
across: initial fleet, help open/close, new-session prompt open/close, 5×PgUp,
End, resize to 60×20 / 200×50 / back to 120×40, `$EDITOR` handoff and return,
and unmount. No stale content and no content regressions.

Two height findings, both **identical with the option off** (`--exercise --full`),
so neither is caused by incremental rendering:

- the help overlay renders ~55 rows into a 40-row terminal;
- at 60×20 the layout renders 20–21 non-blank rows, one over the viewport.

Ink can fall back to a full repaint when a frame overflows the viewport, so the
help overlay does not benefit from the option at 40 rows. That is a pre-existing
layout bug, recorded here rather than fixed in this step. No blocker found: the
option is kept.

## Step 4 — mode control

`deno run -A scripts/tui-bench.ts --label step4 --incremental`, same scenario,
same machine. The bench's local-hint regex changed with the label it measures:
the send prompt now reads `⇧⇥ mode:manual → plan` while a change is pending, and
`⇧⇥ mode:plan` once the daemon has taken it.

| leg                                      | step 0 | step 4 |
| ---------------------------------------- | ------ | ------ |
| keypress → local hint in the send prompt | 317    | **3**  |
| keypress → `session.setMode` dispatched  | 301    | 302    |
| `session.setMode` dispatch → settled     | 16     | 21     |
| keypress → applied `[mode]` chip         | 317    | 368    |
| keypress → `mode → …` notice in browse   | 37     | 3      |
| rapid cycle: first press → its target    | never  | **3**  |
| rapid cycle: 3 presses → `setMode` calls | 2      | 2      |

The debounce is deliberately unchanged: passing through `plan` has real provider
effects, and 302ms of it is the timer, not the socket (21ms round trip).

What moved is the feedback. Step 0 had none in the send prompt — the hint read
the snapshot, so a press showed nothing for 317ms, and during a rapid cycle the
intermediate targets were never rendered at all (`rapidCycleHintMs: null` in
both step-0 runs). The applied chip is ~50ms slower than step 0 within run-to-run
jitter; it is still the daemon's answer, one frame after it lands.

## Step 5 — cross-session search

Search is no longer a local computation, so the step-0 render bench has nothing
to compare against here. What it costs now is one `session.search` scan in the
daemon, measured over synthetic histories far larger than a real one
(`deno run -A scripts/search-bench.ts <sessions> <eventsPerSession>`, warm page
cache; the temporary bench script goes with `tui-bench.ts` at §9):

| corpus                    | db size | rank one query |
| ------------------------- | ------- | -------------- |
| 50 sessions × 200 events  | 13 MB   | ~14ms          |
| 200 sessions × 100 events | 25 MB   | ~33ms          |
| 1000 sessions × 50 events | 64 MB   | ~85ms          |
| 200 sessions × 500 events | 128 MB  | ~150ms         |

Behind the handle's 180ms debounce, the realistic corpora are invisible. The
extremes are not fast, but the plan's instruction was to measure before
inventing an index — and an index is not the answer: adding
`(session_id, type, id)` leaves SQLite still choosing `(session_id, id)`, which
already satisfies the ordering, so the plan doesn't change. Cost is dominated
by reading and `JSON.parse`-ing rows, not by scoring; halving the per-session
text cap moved the 128MB number by under 10%. None was added.

Two caps bound the scan: 2 KB per message (as the TUI matcher had) and 256 KB
per field per session, reading newest-first and stopping there. The second is
new, and it is strictly more text than step 0 searched — which was only the
transcript pages this one client had downloaded, and nothing at all for a
session never selected.

What the user sees that they could not before: a match in a session this TUI has
never opened. What they see that is new and slower: `FLEET · searching…` for the
duration of one round trip, where step 0 recomputed the filter synchronously on
every keystroke over a much smaller (and incomplete) corpus.

## Step 6 — transcript ownership

Same four scenarios, `--label step6`, `incrementalRendering` on throughout, so
the step-4 row is the honest comparison:

| scenario                  | renders (4 → 6) | render ms | writes  | bytes           |
| ------------------------- | --------------- | --------- | ------- | --------------- |
| idle                      | 0 → 0           | 0 → 0     | 0 → 0   | 0 → 0           |
| stream (60 events)        | 74 → 77         | 160 → 144 | 219→228 | 138,517→138,931 |
| scroll (12×PgUp + End)    | 29 → 30         | 53 → 49   | 87→90   | 33,030→33,448   |
| type+mode while streaming | 167 → 167       | 315 → 272 | 492→492 | 251,405→254,518 |

Nothing here moved outside run-to-run noise, which is the expected result: this
step changed who owns the transcript, not what is drawn. Scroll key latency is
p50 2.6ms / p95 37.5ms (step 4: 3.4 / 39.3) — the p95 is still the 30fps frame
cap, not work.

The one measurable change is what the *un*scrolled case costs. The viewport
correction used to run `logRowCount` twice on every `push` dispatch where the
offset was non-zero; it now runs in one place and returns before measuring
anything while the pane is at the live tail, which is where it sits almost
always. And an event for a session that is not selected is no longer turned
into a `LogLine` at all — with the per-session caches gone there is nothing to
put it in, so `formatEvent` runs for the selected session's stream only, not the
whole fleet's.

Representations deleted: `TuiState.transcripts` (a `Record` of per-session
caches), `transcriptGen`, `Transcript.head` / `Transcript.older` (two
independent `Loadable`s), `Transcript.following`, `Transcript.echoes`, the
`echo` action, and the `historyStart` / `historyPage` / `historyFailed` /
`transcriptReset` / `transcriptFollow` actions — five actions and a generation
counter replaced by one `transcript` action carrying a value the pure
transitions produced.

Line counts, against the end of step 5 (`205c4e1`): TUI production 9480 →
**9645**. `transcript.ts` is 1356 new lines, of which ~830 are the move in §6a;
`model.ts` 2491 → 1571, `fleet-handle.ts` 2546 → 2380, `components.tsx`
2038 → 1906. TUI tests 6535 → **6642**. This is separation again, not
reduction: the three files lost 1218 lines between them, `theme.ts` and
`composer.ts` gained 27 (`inside`, `waiting`), and the new module is larger
than the three files lost by the handle and the resource it owns.

## Step 7 — feature views and a scoped clock

Two "after" runs, both with `incrementalRendering` on: `--label step7` is the
step, and `step7-oldclock` is the same tree with the 120ms interval put back
(publish while anything in the fleet is busy, early-return otherwise), so the
comparison isolates the clock rather than seven steps of drift.

| scenario                  | renders   | CPU ms        | writes    | bytes             |
| ------------------------- | --------- | ------------- | --------- | ----------------- |
| idle (3s, no input)       | 0 → 0     | **5.1 → 0.4** | 0 → 0     | 0 → 0             |
| stream (60 events)        | 80 → 77   | 438 → 402     | 237 → 231 | 140,034 → 139,343 |
| scroll (12×PgUp + End)    | 39 → 30   | 159 → 142     | 87 → 90   | 33,030 → 33,448   |
| type+mode while streaming | 197 → 168 | 903 → 834     | 492 → 495 | 251,405 → 251,541 |

`cpuMs` (process user+system inside the measured window) is new in the bench,
because the idle row is where the clock change lands and renders and bytes are
both zero either way. What the old interval cost an idle TUI was ~8 wakeups a
second forever, for a frame it then declined to draw: 5.1ms of CPU per 3s, or
about 0.17% of a core, permanently. There is now no timer at all while nothing
on screen animates.

The other rows always have something running, so the clock is armed either way;
what falls is the beats that no longer fire for content the layout isn't
drawing, and the derivation each surviving beat no longer repeats. Terminal
bytes are unchanged either way, as they should be — this step changed how often
the panes are asked to draw, not what they draw.

**What the bench does not show.** The narrowing lands as pane rebuilds avoided,
not as renders. `test/tui-render.test.ts` asserts identity on the handle's own
memo output — `view.log` and `view.fleetPane` survive an event for another
session, and the fleet view survives typing — which is a claim about this code
rather than about React's scheduling. Adding one dep back to a memo makes it
fail, which is how it was checked.

Representations deleted: the central 120ms `setInterval`, the tick-bump
heuristic beside it (`transcript.lines.length > 3`), the poll for notice expiry,
`anyCompacting` (its only caller was that interval), and `Date.now()` at render
time in `app.tsx` — the frame's `now` is coarsened to the second every
time-derived thing is drawn at, so it no longer invalidates a memo per keystroke.

`FooterArea` and `PromptPane` still take the whole `TuiState`. They are the
input surface and repaint on every keystroke regardless; narrowing them would
buy nothing and cost the plumbing.

Line counts, against the end of step 6 (`cee980e`): TUI production 9645 →
**10,043**; `views.ts` 245 and `clock.ts` 99 are new, `fleet-handle.ts`
2380 → 2519 (the memo slots and the per-pane derivation), `components.tsx`
1906 → 1840, `app.tsx` 246 → 222, `model.ts` 1571 → 1576. TUI tests
6642 → **6761**.

## Step 8 — connection lifecycle

No bench: this is the transport, and none of the four scenarios exercises a
reconnect. What it is measured against is `test/client-state.test.ts` and
`test/connection.test.ts`, both unchanged in substance and both still passing —
partial/failed writes, malformed frames, reconnect with `sinceSeq` replay,
startup failure, mismatch in both directions, and close during pending work.

Representations deleted: `#generation`, `#sock`, `#buf`, `#decoder`,
`#writeChain`, `#readLoop`, `#helloDone`, `#preHelloQueue`, `#invalidate`,
`#attach`, `#dial`, `#reconnectLoop`. What replaces them is one `Attempt` (the
socket and everything whose lifetime is that socket's) and one supervisor loop.
There were two opening paths — `connect()`'s and the reconnect loop's — and the
loop was started from the socket-close handler, so a drop during a handshake ran
a second opening while the first was still awaiting; the generation counter was
the guard around that shape rather than a reason for it.

One behavioural change worth naming: `close()` now cuts a backoff sleep short,
where before a client the caller had finished with could stay asleep for up to
four seconds before noticing.

`client/src/client.ts` 777 → 855 (+78): the `Attempt` class and the supervisor
are more lines than the fields and the loop they replace, and the guards that
are gone were one-liners. Reported as separation, like §3, §5, §6 and §7.
`test/client-state.test.ts` +52: `peak()` on the stub daemon (the most sockets
it ever had open at once) and one regression that drives a drop mid-handshake.
