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
