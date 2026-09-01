# Codebase review — 2026-09

Nine read-only subagent reviews, one per subsystem. Detailed findings with `file:line`
and suggested fixes are in `01-daemon-lifecycle.md` … `09-tui-cli.md`. This file is the
master checklist and the execution plan.

Counts: ~11 high, ~45 medium, ~40 low.

---

## Systemic patterns

Two root causes account for most of the high-severity findings.

### 1. No concurrency discipline around turn control / compaction / rewind

`session-manager`'s header comment claims "serialized per session" but nothing enforces it.
`aisdk/session.ts` uses `#turnRunning` / `#compacting` / `#abort` as separate ad-hoc flags
that don't compose; the Claude adapter uses `#rewinding` / `#rewindInFlight` / `#interrupted`
with scope bugs. Compaction runs for up to 15 min with the session marked "idle", inviting a
concurrent `send()`. → **S1 S2 S3 S12 S13, A1 A2 A4 A5 A8, C4 C5 C6.**

Fix: one per-session command queue in the session-manager that every mutating op passes
through; `interrupt`/`close` preempt via an `AbortSignal` that every long-running op (turn,
compaction, summariser) is contractually required to observe. Adapters then drop their
bespoke flags. — **Phase 1**, own design note.

### 2. Unbounded buffers / no backpressure

Daemon push write queue, `AsyncChannel`, bash tool output, client read buffer, TUI
`state.log`, `session_events` table. → **W1 (=L4) W5 W6 W12, T1, D2/D8, U13.**

Fix: one bounded-queue primitive with an explicit overflow policy (block / drop-oldest /
disconnect-and-resync), applied at ~5 sites. — **Phase 2**.

### Other cross-cutting clusters

- **Rewind/undo model** — checkpoints capture transcript position but not worktree `HEAD`
  or live control settings. **G2 C1 C2 C5 C13**, related **A9**. — **Phase 3**.
- **Git worktree safety** — no in-progress-operation check, 120 s sync freeze, silent
  config failure. **G1 G3–G13**. — **Phase 4**.
- **Client / TUI replay discipline** — seq de-dup not an invariant, replayed frames trigger
  side effects, optimistic select clobbered. **W2 W3 W4 W7 W8, S6 S11, U1 U2 U4 U11 U15**. — **Phase 5**.
- **Write atomicity** — no `withTransaction`, non-atomic `edit` / pidfile writes. **D2 D5, T6, L11**. — folded into Phase 2.
- **Subprocess hygiene** — process groups, mandatory timeouts, stream error handlers.
  **T2 T5 T7**, related **C9**. — mostly Phase 0.
- **Spec/impl drift** — comments assert invariants the code doesn't enforce (**S12**,
  "cumulative cost never regresses" **C2**, `partialTokens` **C7**, keep-warm give-up **S10**).
  Sweep: make code match doc or fix doc.

---

## Execution plan

| Phase    | What                                                                                                                                               | Approach                                                              | Gate                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| **0 ✅** | mechanical, independent fixes — **done** (52 fixed, 3 wontfix, 2 backlog, S1→P1) across 7 commits `a00abaa`..`7a1bf75`; 376 tests green throughout | solo, batched by area                                                 | typecheck + `pnpm test` per commit |
| **1**    | Per-session serialization + cooperative cancellation                                                                                               | design note → your sign-off → implement on a branch → subagent review | full test run + new tests          |
| **2**    | Bounded-queue primitive + `withTransaction`, applied at all sites                                                                                  | solo → subagent review                                                | "                                  |
| **3**    | Rewind/undo record: `{ turn, transcriptRef, headSha, model, effort, mode }`                                                                        | solo → subagent review                                                | "                                  |
| **4**    | `GitWorktree` safety helper + async execution off the event loop                                                                                   | solo → subagent review                                                | "                                  |
| **5**    | Client/TUI replay discipline + selection/notice fixes                                                                                              | solo → subagent review                                                | "                                  |

Working rules: commit as work lands, never push, update the Status column here per commit.

---

## Checklist

Status: `todo` / `wip` / `done` / `backlog` (deferred, tracked) / `wontfix`.

### Phase 0 — mechanical

| ID  | Sev      | Status        | Finding                                                                                                                                                                                                                                                                                                            | Where                                              |
| --- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| L1  | med      | done          | `net.Server` has no lifetime `error` listener after `listen()` → accept-time `EMFILE` crashes the daemon                                                                                                                                                                                                           | `daemon/server.ts:59-71`                           |
| L2  | med      | done          | Signal handlers installed only at end of `#bringUp`; a throw after `acquirePidfile` leaks pidfile + DB handle (no `try/catch`)                                                                                                                                                                                     | `daemon/daemon.ts:357-398`                         |
| L3  | med      | done          | Shutdown unbounded + 2nd signal no-ops → daemon unkillable, pidfile blocks restart                                                                                                                                                                                                                                 | `daemon/daemon.ts:400-444`                         |
| L5  | low-med  | backlog       | `reapChildren` forgets the child row before confirming death. A correct fix needs an async hygiene path; `test/hygiene.test.ts` currently locks the synchronous "one restart clears the row" contract.                                                                                                             | `daemon/hygiene.ts:59-97`                          |
| L6  | low-med  | done          | `#reloadConfig` aliases `this.config` as `before` then mutates it in place                                                                                                                                                                                                                                         | `daemon/daemon.ts:1045-1091`                       |
| L7  | low-med  | done          | Model probes block the socket ~10 s before `listen()` — now listen first                                                                                                                                                                                                                                           | `daemon/daemon.ts:374-380`                         |
| L8  | low      | done          | `tidyWorktrees` deletes `index.lock` unconditionally (no age/pid check)                                                                                                                                                                                                                                            | `daemon/hygiene.ts:99-133`                         |
| L9  | low      | done          | `stop()` has no `try/finally` guaranteeing `#resolveClosed()` + `releasePidfile()`                                                                                                                                                                                                                                 | `daemon/daemon.ts:400-434`                         |
| L10 | low      | done          | Claude model-discovery timeout timer never cleared                                                                                                                                                                                                                                                                 | `daemon/daemon.ts:585-590`                         |
| L11 | low      | wontfix       | `acquirePidfile` — the `wx` exclusive create is the single-instance guard and matters more than the theoretical torn write of a ~60-byte JSON payload (one `write(2)`). tmp+rename would lose the exclusivity.                                                                                                     | `daemon/lifecycle.ts:24-54`                        |
| W9a | low      | done          | Reconnect backoff has no jitter                                                                                                                                                                                                                                                                                    | `client/client.ts:332-356`                         |
| W10 | low      | done          | Client never validates `result.protocolVersion`                                                                                                                                                                                                                                                                    | `client/client.ts:291-318`                         |
| W11 | low      | wontfix       | The per-request 30s timeout already bounds this and produces a clear error; a corrupted frame id isn't worth special-casing (client has no logger).                                                                                                                                                                | `client/client.ts:243-254`                         |
| W13 | low      | done          | `client.close()` is `async` but awaits nothing                                                                                                                                                                                                                                                                     | `client/client.ts:164-168`                         |
| S1  | **high** | done (via C6) | `deriveStatus` resurrecting a killed turn on a trailing gate. The status-machine guard conflicts with a deliberate, tested design choice ("a new turn's blocking request re-engages an interrupted / errored session", `status-machine.test.ts:67`). The correct layer is the adapter muzzle — folded into **C6**. | `daemon/status-machine.ts:49-62`                   |
| S4  | med      | done          | Stream-ended path never clears `run.pending` (interrupt does)                                                                                                                                                                                                                                                      | `daemon/session-manager.ts:160-168`                |
| S5  | med      | done          | Cost `NaN` — sanitized at the `#trackUsage` boundary (the store's `accFloat`/`abs` already guarded the columns; this keeps the in-memory delta finite for `#priceUsage`)                                                                                                                                           | `daemon/session-manager.ts:266-283`                |
| S7  | med      | done          | Titler returns a truncated partial title on timeout instead of `null`                                                                                                                                                                                                                                              | `daemon/titler.ts:114-128`                         |
| S9  | low      | done          | `result` error branch now `truncate()`s `ev.error` (it's typed `string`, so no null-guard needed)                                                                                                                                                                                                                  | `daemon/status-machine.ts:109-119`                 |
| S10 | low      | done          | `setKeepWarm` clears the give-up counter on idempotent re-asserts                                                                                                                                                                                                                                                  | `daemon/session-manager.ts:308-313`                |
| S14 | low-med  | done          | A throwing per-event hook kills the `#drain` loop; `run.pump` rejection can go unhandled                                                                                                                                                                                                                           | `daemon/session-manager.ts:142-176`                |
| G3  | med      | done          | `gc` removes a worktree without `close()`ing the still-registered session                                                                                                                                                                                                                                          | `daemon/daemon.ts:1788-1820`                       |
| G4  | med      | done          | Hard fork silently branches off base when the parent ref doesn't resolve — throw instead                                                                                                                                                                                                                           | `daemon/worktrees.ts:109-119`                      |
| C3  | med      | done          | Zeroed `modelUsage` on a crash/startup-error `result` resets mapper counters → false spike next turn                                                                                                                                                                                                               | `connectors/claude/src/map.ts:375-401`             |
| C7  | med      | done          | `partialTokens` set `false` on the Claude caps (usage is only emitted from `result`). aisdk still declares `true` — unverified, left for its own pass.                                                                                                                                                             | `connectors/claude/src/adapter.ts:53`              |
| C8  | low-med  | done          | `setModel()` now wraps the control call and rethrows a readable reason (matches `setMode`/`setEffort`)                                                                                                                                                                                                             | `connectors/claude/src/adapter.ts:527-529`         |
| C9  | low-med  | done          | `listModels()` races a 15s handshake timeout and always closes the throwaway `query()`; stderr is logged                                                                                                                                                                                                           | `connectors/claude/src/adapter.ts:652-687`         |
| C10 | low      | done          | On a terminal `result` segment, `subagent_stopped` is emitted for any still-open foreground `Task`                                                                                                                                                                                                                 | `connectors/claude/src/map.ts:326-337`             |
| C11 | low      | wontfix       | `test/claude-map.test.ts:289` ("a failed interim result still surfaces even with turns queued") explicitly locks emitting `result kind:error` mid-engagement. Suppressing the marker needs a design decision on how the daemon should show a mid-engagement failure.                                               | `connectors/claude/src/map.ts:412-437`             |
| C14 | low      | backlog       | Transforming leading-slash user text safely needs knowledge of the Claude CLI's slash-command grammar; a wrong transform corrupts legitimate messages. Low severity.                                                                                                                                               | `connectors/claude/src/adapter.ts:334-350`         |
| A3  | med      | done          | `#summarize` swallows mid-stream `error` parts → whole transcript replaced by a truncated summary                                                                                                                                                                                                                  | `aisdk/src/session.ts:627-653`                     |
| A6  | med      | done          | Sub-agent failures and step-limit truncation are swallowed (no `error` event)                                                                                                                                                                                                                                      | `aisdk/src/session.ts:507-549`                     |
| A7  | low      | done          | Usage mapping zeroes `contextUsed` when a provider omits token fields → meter flaps                                                                                                                                                                                                                                | `aisdk/src/map.ts:133-150`                         |
| A10 | cosmetic | done          | Step-limit message reports `segments×maxSteps` (upper bound, not actual)                                                                                                                                                                                                                                           | `aisdk/src/session.ts:772-774`                     |
| A11 | low      | done          | Duplicate `fatal: true` error events for one stream failure                                                                                                                                                                                                                                                        | `aisdk/src/map.ts:96-105`                          |
| T2  | **high** | done          | bash spawned `detached` (own process group); `#kill` signals `-pid` so a timeout / reset takes descendants (dev servers, `foo &`) with it                                                                                                                                                                          | `aisdk/src/tools/bash.ts:35-39, 181-185`           |
| T3  | med      | done          | Trailing `\` / `\|` / `&&` wedges the persistent shell for the full 120 s timeout                                                                                                                                                                                                                                  | `aisdk/src/tools/bash.ts:125`                      |
| T4  | med      | done          | `set -x` makes the sentinel `printf` trace line satisfy the marker regex → early return, garbled tail                                                                                                                                                                                                              | `aisdk/src/tools/bash.ts:118-133`                  |
| T5  | med      | done          | No timeout on the ripgrep child                                                                                                                                                                                                                                                                                    | `aisdk/src/tools/grep.ts:24-72`                    |
| T7  | med      | done          | Failed bash spawn → synchronous `child.stdin.write()` → unhandled stream `error` → daemon exits                                                                                                                                                                                                                    | `aisdk/src/tools/bash.ts:50-58`                    |
| T10 | low      | done          | `edit` on a non-UTF8 file writes back a U+FFFD-mangled whole file                                                                                                                                                                                                                                                  | `aisdk/src/tools/edit.ts:41`                       |
| T13 | low      | done          | `web_search` `NaN` result count when `cfg.maxResults` is unset                                                                                                                                                                                                                                                     | `aisdk/src/tools/search.ts:27`                     |
| T14 | low      | done          | `web_search` empty API key not distinguished from a 401                                                                                                                                                                                                                                                            | `aisdk/src/tools/search.ts:22-48`                  |
| D1  | med      | done          | No "DB is newer than this build" fence → an old daemon silently runs a newer schema                                                                                                                                                                                                                                | `store/db.ts:38-40`                                |
| D3  | low-med  | done          | `pricing.reload` RPC has no error handling (config reload does)                                                                                                                                                                                                                                                    | `daemon/daemon.ts:1136-1139`                       |
| D4  | low      | done          | `deepMerge` doesn't skip `__proto__` / `constructor` — untrusted `.loom/config.toml` is an input                                                                                                                                                                                                                   | `config/config.ts:549-571`                         |
| D6  | low      | done          | `readClaudeAccount` ignores `CLAUDE_CONFIG_DIR` → stale provider-list account line                                                                                                                                                                                                                                 | `config/claude-profile.ts:76-105`                  |
| D7  | low      | done          | `scaffoldUserConfig` existsSync/copyFileSync TOCTOU, no `COPYFILE_EXCL`                                                                                                                                                                                                                                            | `daemon/scaffold.ts:28-40`                         |
| D9  | low      | done          | `addUsage` NaN guard bypassed for `lastTurnAt`                                                                                                                                                                                                                                                                     | `store/sessions.ts:216-263`                        |
| D10 | low      | done          | `resolveMcpCommand` splits on whitespace → mis-splits quoted args                                                                                                                                                                                                                                                  | `daemon/mcp-fallback.ts:25-27`                     |
| D11 | cosmetic | done          | `provider-registry` `mock` id documented as known but not in `#ids`                                                                                                                                                                                                                                                | `daemon/provider-registry.ts`                      |
| U3  | med      | done          | `logScroll` grows unbounded past the top of the log (clamp only at render)                                                                                                                                                                                                                                         | `frontend/tui/src/fleet-handle.ts:1372, 1568-1570` |
| U7  | med      | done          | `$EDITOR` quit-without-saving (`:q`, non-zero exit) treated as an edit → agent implements untouched plan                                                                                                                                                                                                           | `frontend/tui/src/editor-handoff.ts:48-57`         |
| U8  | med      | done          | `s.subagents` dereferenced without the `?? []` guard every other site uses → render crash                                                                                                                                                                                                                          | `frontend/tui/src/components.tsx:542-552`          |
| U10 | low-med  | done          | `loom tail` / `--json` not pipe-safe → uncaught `EPIPE` stack trace instead of exit 0                                                                                                                                                                                                                              | `cli/src/loom.ts:554-587`                          |
| U12 | low      | done          | Prompt targeting a session removed elsewhere is left open → error loop                                                                                                                                                                                                                                             | `frontend/tui/src/model.ts:708-737`                |
| U14 | low      | done          | 120 ms TUI ticker runs unconditionally (full render ~8×/s on an idle TUI)                                                                                                                                                                                                                                          | `frontend/tui/src/fleet-handle.ts:1689-1693`       |
| U16 | low      | done          | Unhandled rejection on quit-all `client.close()`                                                                                                                                                                                                                                                                   | `frontend/tui/src/fleet-handle.ts:1234-1244`       |

### Phase 1 — per-session serialization

_Done (`loom/audit-codebase-and-delegate-to`): SessionManager `#enqueue` gate over
`send`/`compact`/`rewind` + `restructuring`/`rewinding` flags + daemon `busy`
fast-fail; aisdk `#compactTracked` + `AbortSignal.any` cancellation + A4/A5/A8;
Claude `#rejectPending` on interrupt + `canUseTool` muzzle + `#rewindInFlight`
widening + module `forkLock` + `__setClaudeSdk` seam; TUI queues a send typed
during a compaction. +11 tests. Design note:
`~/.claude-personal/plans/eager-yawning-stearns.md`._
_Still open here, out of that design's scope: **S8** (usage double-count) →
Phase 2; **C12** (`snapshot()` always `stateRunning`) → cosmetic, unscheduled._

| ID  | Sev      | Status | Finding                                                                                                                                                                                                                                                                                                                                          | Where                                      |
| --- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| S2  | med      | done   | `send()` post-await unconditional `stateRunning` races the just-started turn, can mask a real block                                                                                                                                                                                                                                              | `daemon/session-manager.ts:341-360`        |
| S3  | med      | done   | 8 turn-control methods skip the `run.ended` check `send`/`compact` have → forward to a torn-down adapter                                                                                                                                                                                                                                         | `daemon/session-manager.ts:370-471`        |
| S8  | med      | todo   | Raw `ev.tokens.*` summed additively though only `costDeltaUsd` is a declared delta → double-count risk                                                                                                                                                                                                                                           | `daemon/session-manager.ts:266-283`        |
| S12 | low      | done   | Class doc claims per-session serialization the code doesn't implement (this phase)                                                                                                                                                                                                                                                               | `daemon/session-manager.ts:1-7`            |
| S13 | low      | done   | `interrupt()`/`rewind()` accept terminal states and overwrite a clean end                                                                                                                                                                                                                                                                        | `daemon/session-manager.ts:370-393`        |
| A1  | **high** | done   | Manual `compact()`/`rewind()` race a concurrently-started turn → transcript corruption                                                                                                                                                                                                                                                           | `aisdk/src/session.ts:252-256, 551-617`    |
| A2  | **high** | done   | `interrupt()`/`close()` can't cancel an in-flight compaction; `close()` emits to a closed channel post-teardown                                                                                                                                                                                                                                  | `aisdk/src/session.ts:284-291, 619-654`    |
| A4  | med      | done   | Provider/stream error with an unanswered permission prompt can wedge the turn (loop breaks only on `abort`)                                                                                                                                                                                                                                      | `aisdk/src/loop.ts:113-127`                |
| A5  | med      | done   | `#pendingPerms` keyed by provider `toolCallId` → duplicate ids under concurrent sub-agents orphan a promise                                                                                                                                                                                                                                      | `aisdk/src/session.ts:493`                 |
| A8  | low      | done   | Interrupt during first-turn MCP connect / auto-compact: no event, message left unprocessed                                                                                                                                                                                                                                                       | `aisdk/src/session.ts:656-671`             |
| C4  | med      | done   | Global `process.env.CLAUDE_CONFIG_DIR` mutated across an `await` in `#forkTruncated` (serialize forkSession)                                                                                                                                                                                                                                     | `connectors/claude/src/adapter.ts:498-514` |
| C6  | med      | done   | `interrupt()` doesn't cancel pending gates / `ask_user`; `canUseTool` bypasses the `#interrupted` muzzle. Also subsumes **S1**: gate the `permission_request`/`plan_review` emission on `#interrupted` so a killed turn's unwinding tool calls don't resurface a stopped session, without touching the (deliberately non-sticky) status machine. | `connectors/claude/src/adapter.ts:193-226` |
| C12 | low      | todo   | `snapshot()` always reports `stateRunning`, even after the CLI process exits                                                                                                                                                                                                                                                                     | `connectors/claude/src/adapter.ts:541-545` |

### Phase 2 — bounded buffers + write atomicity

_Done (`loom/audit-codebase-and-delegate-to`): `Connection.push` drops a client
whose write backlog passes 8 MB; `MAX_FRAME_BYTES` shared via `core/wire` and
enforced on the client's read buffer too; `AsyncChannel` gains a capacity (drop
-oldest + `dropped` count) and a synchronous single-consumer guard; bash collapses
its output buffer in flight; `edit` writes atomically (temp + rename); a
`withTransaction` helper wraps `SessionStore.create` / `ProviderMessageStore`
compound writes / `markMidRunInterrupted`, and `migrate()` re-checks the version
under `BEGIN IMMEDIATE`; the TUI caps `state.log` at 10k lines. +10 tests._
_Out of scope: **D8** (`backlog`)._

| ID      | Sev      | Status  | Finding                                                                                                          | Where                                                          |
| ------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| W1 / L4 | **high** | done    | No write-side backpressure on the daemon push fan-out → one stuck client OOMs the daemon                         | `daemon/connection.ts:73-89`, `daemon/server.ts:93-95`         |
| W5      | med      | done    | `AsyncChannel` has no queue bound / backpressure — hot path of every adapter                                     | `core/src/channel.ts:27-32`                                    |
| W6      | low-med  | done    | Client socket read buffer is unbounded (asymmetric with the daemon's `MAX_FRAME_BYTES`)                          | `client/src/client.ts:226-241`                                 |
| W12     | low      | done    | `AsyncChannel` `[Symbol.asyncIterator]` obtainable twice; early `break` leaks the queue                          | `core/src/channel.ts:41-52`                                    |
| T1      | **high** | done    | bash unbounded output buffer → `RangeError` in a data handler / OOM → daemon dies                                | `aisdk/src/tools/bash.ts:42-47`                                |
| T6      | med      | done    | `edit` writes non-atomic (`writeFileSync` O_TRUNC, no backup) → crash/ENOSPC corrupts source                     | `aisdk/src/tools/edit.ts:63, 85`                               |
| D2      | med      | done    | Compound store writes not wrapped in a transaction → interrupted `create()` leaves a session with no `usage` row | `store/sessions.ts:96-123`, `store/provider-messages.ts:59-71` |
| D5      | low      | done    | Migration loop reads `currentVersion()` outside the txn; `BEGIN` is not `IMMEDIATE`                              | `store/db.ts:38-55`                                            |
| U13     | low      | done    | `state.log` accumulates echo/notice cruft and is never truncated                                                 | `frontend/tui/src/model.ts:340-344`                            |
| D8      | low      | backlog | `session_events` / `status_history` grow unbounded, no `VACUUM` ever                                             | `store/session-events.ts`                                      |

### Phase 3 — rewind/undo record

_Done (`loom/audit-codebase-and-delegate-to`): migration 14 records the worktree HEAD + dirty state per checkpoint; `session.rewind` warns on drift and takes an opt-in `restoreWorktree` (`git reset --hard`, refuses a dirty tree). Claude `rewind()` resumes with the live model/mode/effort and, via `mapper.onQuerySwap()`, keeps cumulative usage/cost monotonic + drops stale chain/bg/subagent carry-over. aisdk ends a segment early when the transcript nears the window so the next segment compacts. +9 tests._

| ID  | Sev      | Status | Finding                                                                                                | Where                                      |
| --- | -------- | ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| G2  | **high** | done   | Undo/rewind never restores worktree files — checkpoint stores no git SHA                               | `daemon/daemon.ts:921-941, 1400-1477`      |
| C1  | **high** | done   | `rewind()` silently reverts live model/effort/mode changes                                             | `connectors/claude/src/adapter.ts:492`     |
| C2  | **high** | done   | `rewind()` regresses cumulative token/cost totals, contradicting its docstring                         | `connectors/claude/src/map.ts:399-401`     |
| C5  | med      | done   | Live query ending during the pre-teardown fork window → permanently silent session                     | `connectors/claude/src/adapter.ts:285-318` |
| C13 | low      | done   | Mapper carry-over state (`#lastChainUuid`, `#lastBgSig`, `#openSubagents`) not reset across `rewind()` | `connectors/claude/src/map.ts:176-183`     |
| A9  | low      | done   | No compaction between steps within a single 50-step segment                                            | `aisdk/src/session.ts:662-668`             |

### Phase 4 — git worktree safety

_Done (`loom/audit-codebase-and-delegate-to`): auto-rebase bails `busy` on an agent's own in-progress rebase/merge (G1); worktree-config failures are fatal + teardown, failed `worktree add` prunes (G5); `session.remove` keeps the row as `error` on a remove failure (G7) and refuses a dirty tree without `force` (G8); the nudge marker is persisted (migration 15, G9); `#git` gets `maxBuffer` + surfaces spawn errors, conflict-vs-error is index-driven, rebase timeout 120→90s, facts TTL 8→3s (G6/G10/G11); worktree hooks chain to the repo's own (G12); lifecycle ops serialise per id (G13); `listen()` binds before touching the socket file (W9b). +5 tests._

| ID  | Sev      | Status | Finding                                                                                                     | Where                                |
| --- | -------- | ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| G1  | **high** | done   | Auto-rebase destroys the agent's own in-progress rebase/merge (only checks `git status --porcelain`)        | `daemon/worktrees.ts:285-299`        |
| G5  | med      | done   | Worktree `user.email` / `core.hooksPath` config failures only warn-logged → push-block hook silently absent | `daemon/worktrees.ts:85-97, 124-131` |
| G6  | med      | done   | A large auto-rebase (`spawnSync`, 120 s) freezes the whole daemon event loop                                | `daemon/daemon.ts:795-801`           |
| G7  | med      | done   | `session.remove` / a failed `worktree add` can orphan a tree/branch with no row to reclaim it               | `daemon/daemon.ts:1764-1784`         |
| G8  | med      | done   | `session.remove` force-discards a dirty worktree with no confirmation                                       | `daemon/daemon.ts:1764-1773`         |
| G9  | low      | done   | Auto-rebase "once per base commit" dedupe is in-memory only → duplicate nudge turns after restart           | `daemon/daemon.ts:817-818`           |
| G10 | low      | done   | Fragile git-output parsing: locale-dependent conflict regex, unset `maxBuffer`, ignored `res.error`         | `daemon/worktrees.ts:300, 350-361`   |
| G11 | low      | done   | git-facts cache staleness (8 s TTL; `cachedFacts` ignores TTL; not invalidated on commit)                   | `daemon/worktrees.ts:17, 223-252`    |
| G12 | low      | done   | `core.hooksPath` override disables the repo's real `pre-commit` / `commit-msg` inside worktrees             | `daemon/worktrees.ts:127`            |
| G13 | low      | done   | Concurrent `markDone` / `remove` on the same id race (both only guard on an initial `get`)                  | `daemon/daemon.ts:1731-1784`         |
| W9b | low      | done   | `SocketServer.listen()` `isSocketLive` → `unlink` → `bind` TOCTOU; treat `EADDRINUSE` as "connect instead"  | `daemon/server.ts`                   |

### Phase 5 — client / TUI replay discipline

| ID  | Sev      | Status | Finding                                                                                                            | Where                                                  |
| --- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| U1  | **high** | todo   | Selecting a session re-dispatches its whole history every time → O(n) stalls + N synchronous re-renders            | `frontend/tui/src/fleet-handle.ts:301-314`             |
| U2  | med-high | todo   | History backfill re-raises stale notices and re-adds resolved permissions (side effects before seq de-dup)         | `frontend/tui/src/model.ts:664-688`                    |
| W2  | med      | todo   | `#resync` moves `#lastSeq` backwards → duplicate event replay on a later reconnect                                 | `client/src/client.ts:371`                             |
| W3  | med      | todo   | In-flight requests rejected on any socket blip and never retried, though the op may have completed                 | `client/src/client.ts:320-330`                         |
| W4  | med      | todo   | Failed handshake leaves `#helloDone=false` and never clears `#preHelloQueue`                                       | `client/src/client.ts:291-318`                         |
| U4  | med      | todo   | Optimistic `select` after create/fork clobbered by `clampSelection` if any unrelated `session_updated` lands first | `frontend/tui/src/model.ts:516-520`                    |
| U5  | med      | todo   | No double-submit / stale-mode latch on prompt submit                                                               | `frontend/tui/src/fleet-handle.ts:1484-1485`           |
| U11 | low-med  | todo   | Queue-drain gate set from a stale `turns` snapshot → next queued message injected mid-turn                         | `frontend/tui/src/fleet-handle.ts:332-352`             |
| W7  | low-med  | todo   | Silent frame drop on JSON parse failure → undetected seq divergence, no resync                                     | `client/src/client.ts:234-238`                         |
| W8  | low      | todo   | `replayHistory` (`sinceSeq: 0`) can never yield the documented `resync` fallback                                   | `client/src/client.ts:26-35`, `daemon/event-log.ts:82` |
| S6  | med      | todo   | Registry version counter resets to 1 on daemon restart → breaks `session_updated` de-dup for reconnecting clients  | `daemon/registry.ts:24-25`                             |
| S11 | low      | todo   | Event ordinal counter restarts at 0 on resume/restart, colliding with persisted ordinals                           | `daemon/session-manager.ts:124-145`                    |
| U15 | low      | todo   | `answerQuestion` step-back drops the in-progress (un-submitted) answer                                             | `frontend/tui/src/fleet-handle.ts:1464-1482`           |

### Backlog (deferred, tracked)

| ID  | Sev     | Status  | Finding                                                                                                       | Where                                      |
| --- | ------- | ------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| T8  | low-med | backlog | Concurrent `bash` tool calls throw an opaque "busy" error instead of serializing                              | `aisdk/src/tools/bash.ts:110`              |
| T9  | low-med | backlog | `edit` / `grep` accept unrestricted absolute / `../` paths and follow symlinks (needs a confinement decision) | `aisdk/src/tools/edit.ts:41`               |
| T11 | low     | backlog | `edit` fuzzy tiers rewrite CRLF→LF in the matched span                                                        | `aisdk/src/tools/edit.ts:78-79`            |
| T12 | low     | backlog | `edit` / `grep` error messages embed resolved absolute paths                                                  | `aisdk/src/tools/edit.ts:45`               |
| A12 | low     | backlog | An MCP server that disconnects mid-session is never reconnected                                               | `aisdk/src/mcp.ts:31-73`                   |
| U6  | med     | backlog | Detail pane / overlays can overflow the computed body height → frame corruption on the alt screen             | `frontend/tui/src/fleet-handle.ts:215-224` |
| U9  | med     | backlog | Word-wrap / truncate count UTF-16 code units, not columns (needs a display-width dep)                         | `frontend/tui/src/theme.ts:168-203`        |

---

## Confirmed sound

`EventLog.since()` seq/rolled math · hello snapshot-vs-subscribe ordering · no shell injection
in git ops · slug/branch uniqueness · fork-failure teardown · compaction refusing
undo-past-compaction · aisdk mid-turn injection splice (correct for pinned `ai@5.0.249`,
version-fragile) · aisdk step/segment counting · `task` recursion depth cap · MCP
connect-failure isolation · SQL parameterization + per-migration transactions ·
provider-registry lazy-import promise caching · claude-profile never writing credentials ·
TUI reconnect/resync non-destructiveness · id-based selection · version-mismatch
restart-loop guard.
