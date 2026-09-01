# TUI (Ink) + loom / loomd CLI — code review

Scope: `frontend/tui/src/*` and `cli/src/*`. Read-only review.

Findings ranked most severe first.

---

### Selecting a session re-dispatches its entire history every time
- **File:** frontend/tui/src/fleet-handle.ts:301-314 (`backfillHistory`), consumed in model.ts:664-689 (`applyPush` `"event"`)
- **Severity:** high
- **Issue:** `backfillHistory()` fires on *every* `selectedId` change (`dispatch`, line 365) and unconditionally re-requests `session.events` for the whole session, then does `for (const frame of frames) dispatch({ t: "push", frame })`. De-dup is per-frame via `s.log.some((l) => l.seq === frame.seq)` — an O(n) scan of the uncapped, cross-session `state.log` for each of N replayed frames, so O(N·log). Worse, every de-duped frame still returns a fresh object (`return { ...s, pending, compacting, notice }`), so `dispatch` sees `state !== prev` and runs `publish()` → `deriveView` (`selectedSession`, `allowedActs`, array builds) N times synchronously in one microtask. On a busy daemon, pressing `j`/`k` to move through the fleet visibly stalls the UI, and it re-does the full cost on each revisit (the comment even says "Re-fetched on every select, not just the first").
- **Fix:** Skip backfill for sessions already represented in `state.log` (track a `backfilledIds` set, or compare max seq); filter frames against existing seqs *before* dispatching and apply them as one batched action; or have the daemon return only frames newer than the client's highest seq for that session.

---

### History backfill re-raises stale notices and re-adds resolved permissions
- **File:** frontend/tui/src/model.ts:664-688 (`applyPush` `"event"`), 761-817 (`trackPending`), 1834-1851 (`noticeForEvent`)
- **Severity:** medium-high
- **Issue:** In the `"event"` case, `trackPending`, `trackCompacting` and `noticeForEvent` all run *before* the seq de-dup `return`. So when `backfillHistory` (or `client.bufferedEvents` at startup) replays a session's history, every historical `permission_request` / `question` / fatal `error` / step-limit `result` produces a fresh `Notice { at: Date.now() }`, and the last one wins — selecting an old, long-settled session flashes "Bash needs approval [req…]" or "error: …" on the notice line for 4s. `trackPending` also re-adds historical `permission_request`s to `pending[sessionId]` (its de-dup only checks the *current* pending map, which was cleared when the session settled); they only get cleaned up again if the matching `tool_result` also happens to be in the replayed history.
- **Fix:** Mark backfill/buffered frames (e.g. `{ t: "push", frame, replay: true }`) and skip `noticeForEvent` for them; run the seq de-dup check first and bail before any `trackPending`/notice work for frames already in the log.

---

### `logScroll` grows without bound past the top of the log
- **File:** frontend/tui/src/fleet-handle.ts:1372 (`wheel` up), 1568-1570 (`pageUp`)
- **Severity:** medium
- **Issue:** Wheel-up does `logScroll = logScroll + 3` and PageUp does `logScroll = logScroll + Math.max(1, logPage - 1)` with no clamp. `EventLog` clamps only at render (`off = Math.min(scroll, maxScroll)`), so the backing variable keeps climbing. Scroll up hard at the top of a short log and you then have to scroll *down* the same number of notches before the viewport moves at all — the log appears frozen.
- **Fix:** Clamp on write: `logScroll = Math.min(maxScroll, logScroll + 3)`. `maxScroll` needs the wrapped-row count; either compute it in the handle or expose it on the view and clamp against `view.` values already available (`logPage`, row count).

---

### Optimistic `select` is clobbered by `clampSelection`
- **File:** frontend/tui/src/model.ts:516-520 (`select`), 690-707 (`session_updated`), 886-892 (`clampSelection`); callers fleet-handle.ts:994 (`new`), 1319 (`fork`), 867 (`find`)
- **Severity:** medium
- **Issue:** After `session.create` / `session.fork` the handle does `dispatch({ t: "select", id: r.id })` before the new session's `session_updated` push has necessarily arrived. `select` stores the id optimistically, but *any* `session_updated` / `sessions` / `session_removed` for an unrelated session that lands in that window runs `clampSelection(sessions, r.id)`, doesn't find `r.id`, and snaps `selectedId` back to `sortSessions(...)[0]`. On a daemon with other running sessions ticking out `session_updated` frames, the user creates a session and is silently bounced to the fleet head.
- **Fix:** Keep a short-lived "pending selection" id that `clampSelection` preserves even when absent from the list until its first `session_updated`, or gate the new-session `select` on receipt of that session's push.

---

### No double-submit / stale-mode guard on prompt submit
- **File:** frontend/tui/src/fleet-handle.ts:1484-1485 (`applyKey` → `submitPrompt`), 967-1114 (`submitPrompt`), vs. `overlayActed` latch used for confirm/plan/picker (284, 793, 1137, 1208, 1547)
- **Severity:** medium
- **Issue:** Ink invokes `handleKey` once per stdin byte before React re-renders. `submitPrompt` closes the prompt synchronously (`dispatch({ t: "closePrompt" })`) then fires the RPC async, but there is no latch. A second `\r` in the same chunk is then processed in `browse` mode: `key.return` → `runAct("send"|"answer"|"planreview")` on the current selection. Result: send a message and immediately get an empty send prompt popped open; or, while the session is still `awaiting_input` (daemon hasn't replied to the answer/deny yet), re-open the answer/deny prompt. `deny`/`compact` accept an empty submit, so a third Enter can push an empty deny.
- **Fix:** Add the same `overlayActed`-style identity latch for the open `PromptState`, cleared on `closePrompt`; or ignore `key.return` in `browse` for a few ms after a prompt close.

---

### Detail pane / overlays can overflow the computed body height
- **File:** frontend/tui/src/fleet-handle.ts:215-224 (`deriveView` height math); components.tsx:373-563 (`Detail`)
- **Severity:** medium
- **Issue:** `splitLogH = Math.max(4, bodyH - 13)` hard-codes Detail at ≤13 rows, but `Detail` renders a large number of conditional rows: fork line, `compacting` field, `cache` field, tokens row, per-window `rateLimits` field, git line, last-commit subject, queued line, subagents line, background-tasks line. A feature-rich session easily exceeds 13 rows, so `Detail` + `EventLog(bodyH-13)` > `bodyH` and the layout overflows — on the alternate screen that scrolls/corrupts the frame (the same class of breakage the `body()` tab-expansion comment describes). Separately, during the `answerQuestion` flow the prompt (`footerH` up to 10) and the `RequestPanel` (`REQUEST_PANEL_ROWS = 8`) plus header are both shown, needing ~19 rows before `bodyH`'s min of 6 — overflows an 80×24 terminal.
- **Fix:** Give `Detail` a fixed height and clip/scroll inside it, or measure it and derive `splitLogH` from the remainder; cap `footerH + requestH + headerH` against `rows` and shrink the prompt window when the request panel is up.

---

### `$EDITOR` "quit without saving" is treated as an edit
- **File:** frontend/tui/src/editor-handoff.ts:48-57 (`spawnEditor`); fleet-handle.ts:1162-1169 (`editPlan`), 416-425 (`editPrompt`)
- **Severity:** medium
- **Issue:** `spawnEditor` only checks `r.error` (spawn failure). It ignores `spawnSync`'s `status` / `signal`, then always `readFileSync`s the temp file. Quitting vim with `:q` / `:cq`, or an editor that exits non-zero, returns the *original* text as if it were saved. `editPlan` treats only an empty result as "unchanged" (`if (!plan) return`), so `:q` on a plan submits `respondPlan({ action: "revise", plan })` with the untouched plan and the agent starts implementing.
- **Fix:** Return `null` when `r.status !== 0` or `r.signal != null`; in `editPlan`, also bail when `edited.trim() === pl.text.trim()`.

---

### `session.subagents` dereferenced without a guard in Detail
- **File:** frontend/tui/src/components.tsx:542-552
- **Severity:** medium
- **Issue:** `{s.subagents.length > 0 ? (() => { const active = s.subagents.filter(...); const names = s.subagents.map(...) ... })() : null}` accesses `s.subagents` directly, while every other site guards it (`components.tsx:321` `(s.subagents ?? [])`, `components.tsx:587` `sel?.subagents ?? []`). A `SessionSnapshot` without `subagents` (older daemon build, or a `loom stub` session) throws in render → Ink error boundary / crash.
- **Fix:** `const subs = s.subagents ?? []` and use that; same defensive treatment as `backgroundTasks`.

---

### Word-wrap and truncation count UTF-16 code units, not columns
- **File:** frontend/tui/src/theme.ts:168-203 (`truncate`, `wrapText`); components.tsx:704-713 (`wrapLine`)
- **Severity:** medium
- **Issue:** `wrapText` uses `word.length` / `line.length` and `truncate` uses `s.length` and `s.slice`. CJK and emoji are 1–2 UTF-16 units but 2 terminal columns, so wide-character transcript text wraps too late; the rendered segment then exceeds `room`, and `<Text wrap="truncate-end">` (physicalRows rows) silently clips the tail. The hard-break path `out.push(rest.slice(0, width))` can also cut a surrogate pair, yielding a replacement glyph. This is the "every redraw lands one row off" hazard for non-ASCII output.
- **Fix:** Measure with a display-width function (e.g. `string-width` / an East-Asian-width table) in `wrapText`/`truncate`, and break on grapheme/codepoint boundaries.

---

### `loom tail` and `--json` commands are not pipe-safe
- **File:** cli/src/loom.ts:554-587 (`runTail`), 468-471, 609-617 (top-level `catch`)
- **Severity:** low-medium
- **Issue:** `loom tail | head` (or any early-closing consumer) causes an async `EPIPE` on `process.stdout`; there is no `'error'` handler on the stream and the top-level `main().catch` cannot catch a stream error, so the process dies with an uncaught-exception stack trace instead of exiting 0. Also every `--json` path prints machine-readable output only on success — on failure `main().catch` writes `loom: <message>` plain text to stderr and exits 1, so `--json` consumers must special-case non-JSON error output.
- **Fix:** `process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); })` early in `main`; when `values.json`, emit `{ "error": "..." }` to stdout on failure.

---

### Queue-drain gate is set from a stale `turns` snapshot
- **File:** frontend/tui/src/fleet-handle.ts:332-352 (`drainQueues`)
- **Severity:** low-medium
- **Issue:** `lastDrainTurn.set(s.id, s.turns)` runs in the `session.send` `.then`, but `s` is the object captured from `for (const s of state.sessions)` at call time, so `s.turns` is the value from *before* the send. If the user issues a manual `send` that interleaves with a queued drain (turns bumps under a different code path), the gate `s.turns > (lastDrainTurn.get(s.id) ?? -1)` can pass early and the next queued message is injected mid-turn instead of waiting for turn end — partly defeating the "queue for turn end" contract.
- **Fix:** Gate on a monotonic marker the daemon reports for "turn that consumed the drained message", or re-read `state.sessions.find(x => x.id === s.id)?.turns` inside the `.then`.

---

### Prompt targeting a session removed elsewhere is left open
- **File:** frontend/tui/src/model.ts:708-737 (`session_removed`), 690-707 (`session_updated`)
- **Severity:** low
- **Issue:** `session_removed` (and settled `session_updated`) closes the `plan` overlay and clears `picker` when it referenced the gone session, but never touches `state.prompt`. A `send` / `answer` / `title` / `compact` prompt open for a session another client `loom rm`s stays open; submitting hits an RPC error and `submitPrompt`'s `reopen()` puts the same dead-target prompt back — an error loop until the user hits Esc.
- **Fix:** In `session_removed` / settled `session_updated`, if `s.prompt?.sessionId === gone`, `closePrompt` (saving the draft for `send`/`new`).

---

### `state.log` accumulates echo / notice cruft and is never truncated
- **File:** frontend/tui/src/model.ts:340-344 (comment: "never truncated"), 575-576 (`echo`); fleet-handle.ts:1118-1132 (`queueSend`)
- **Severity:** low
- **Issue:** `state.log` is deliberately uncapped. `queueSend` appends a `"queued: …"` echo line that is never removed even after the real message sends (the daemon's `user_message` is a separate line), and `clearQueue` leaves those echo lines behind. Over a long-lived TUI against a chatty daemon the array only grows; `physicalRows` rebuilds an array over the whole visible slice on every new event, and `sessionLog`/`findPickItems` scan the full log.
- **Fix:** Either cap `state.log` with a generous ring buffer (the daemon has the durable copy and `session.events` can refill on select), or at least drop/replace the transient `"queued:"` echo when the matching `user_message` arrives.

---

### 120 ms ticker runs unconditionally
- **File:** frontend/tui/src/fleet-handle.ts:1689-1693
- **Severity:** low
- **Issue:** `setInterval(… , 120)` always calls `publish()` ("the tick bump alone needs a frame (spinner)"), forcing a full `deriveView` + React render ~8×/s even when there are zero sessions or every session is idle and no spinner is animating. Steady CPU / wakeups on an idle TUI.
- **Fix:** Only run the interval while at least one session is `running` / `starting` / has a live compaction; otherwise fall back to event-driven publishes.

---

### `answerQuestion` step-back drops the in-progress answer
- **File:** frontend/tui/src/fleet-handle.ts:1464-1482 (Esc in `answerQuestion`)
- **Severity:** low
- **Issue:** The doc comment (model.ts:131-134) promises answers are "kept across stepping back and forth so nothing typed is lost", but only *submitted* (Enter'd) answers are written to `qaAnswers` (in `submitPrompt`). Pressing Esc on question 2 to go back to question 1 discards whatever is currently in the buffer for question 2; walking forward again shows it empty.
- **Fix:** Before dispatching the step-back `openPrompt`, fold the current buffer into `qaAnswers[p.qaAll[p.qaIdx].question]`.

---

### Unhandled rejection on quit-all close
- **File:** frontend/tui/src/fleet-handle.ts:1234-1244 (`runConfirm`, `quitAll` branch)
- **Severity:** low
- **Issue:** `void (async () => { try { await client.request("daemon.shutdown") } catch {} await client.close(); term.exit() })()` — `client.close()` is not guarded; if it rejects, that's an unhandled promise rejection during shutdown (contrast `quitTui`, which does `client.close().catch(() => {})`).
- **Fix:** `await client.close().catch(() => {})`.

---

## Areas that look sound

- **`editor.ts` (`applyKey` / `layout`)** — pure, well-clamped, readline motions and vertical-motion→history handoff are coherent; paste-bracket stripping is defensive. Only concern is display-width (covered above).
- **`store.ts` / `loadable.ts`** — minimal and correct; the synchronous-`get` store also neatly sidesteps "setState after unmount" (post-unmount `store.set` just updates a variable and notifies zero listeners).
- **Reconnect / resync non-destructiveness** — `applyPush "resync"` only clears `compacting`; `prompt` / `plan` / `pending` / `selectedId` survive a resync, and `reduce "sessions"` rebases per-row by `updatedAt` rather than blind-replacing. Good.
- **Version reconcile** — `versionMismatchAction` + `versionRestartTried` + the `restarting` latch correctly prevent a restart loop when the freshly respawned daemon is still mismatched (falls through to `nag`).
- **`loomd.ts` / `connectors.ts`** — `DaemonAlreadyRunning` → exit 3 with a message is the right shape for the connect-or-spawn race; lazy connector thunks are clean.
- **`sortSessions` / Fleet keying** — selection is id-based throughout (`clampSelection`, `move` via `findIndex`), and components key by `s.id`, so a status change that reorders rows doesn't cause an index-based selection jump.
