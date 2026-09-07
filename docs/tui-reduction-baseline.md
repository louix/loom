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
