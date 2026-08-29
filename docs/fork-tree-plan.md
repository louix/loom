# Undo + hard fork — design

Status: **agreed shape, ready to build.** Revised from an earlier "fork tree"
proposal after review (2026-08-29).

## What we're NOT building

An interactive **tree navigator** (`T`: up = previous turn, left/right = sibling
leaves, enter = continue). It's a good fit for a *chat* UI where only the
conversation changes, but not a *code harness* — the worktree changes underneath
you, so hopping between leaves in a shared tree is incoherent, and a
worktree-per-leaf is just hard-forking with extra steps. Parked.

## What we are building — two separate primitives

### 1. Undo — jump back N turns, in place

`u` on an idle session → a picker of recent turns (turn number + a snippet of
that turn's user message). Pick one → confirm (with the cache-burn line) → the
transcript is truncated to that turn, the session goes back to `idle`, and the
prompt reopens pre-filled with that turn's original user message ("redo this").

- **Conversation only.** The worktree/files are left as they are — the agent
  picks up from the older conversation against the current file state. If you
  want the files back too, that's `git` (or a follow-up: per-turn worktree
  snapshots).
- **aisdk** — `store.replaceFrom(id, checkpoint(turn).seq + 1, [])`.
- **claude** — restart the `query()` with `resume: <providerRef>`,
  `resumeSessionAt: <turn's last chain UUID>`, `resumeDropsTurn: <discarded
  turn's prompt UUID>`. On the deterministic refusal (`Resume rejected by
  --resume-drops-turn:`) fall back to a plain resume and surface a `notice` —
  never retry (SDK docs are explicit).

### 2. Hard fork — branch from the current tip

`f` / `⑂` on a session → a **new `sessions` row** (`parent_id` set, new
`fork_turn` column = the parent's current turn count), its **own worktree**
branched off the parent's branch HEAD, its transcript copied whole.

- It's just another session in the fleet — normal row, normal lifecycle — with a
  `⑂` glyph and the parent's short id in Detail so the lineage reads.
- Fully independent: edits on the fork never touch the original.
- **From the tip only.** To branch from an earlier point: `undo` first, then
  `fork`. (Fork-at-arbitrary-turn reopens "what file state does the fork start
  from"; skip it.)
- **aisdk** — copy `provider_messages` rows into the new session.
- **claude** — `query({ options: { resume: <parentRef>, forkSession: true } })`,
  or the standalone `forkSession(parentRef)`; the branch gets fresh UUIDs and
  shares the full history.

Both primitives show the **cache-burn estimate** before committing:
`estimateTokens(transcript) × price.cacheWrite` from the loaded table (both
helpers exist). Phrase as `~48k tokens, cache cold — next turn re-primes (~$0.18)`.

## Shared machinery: `checkpoints`

Append-only, one row per completed turn (written by the daemon on each
`result`):

```sql
CREATE TABLE checkpoints (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn         INTEGER NOT NULL,          -- 1-based, matches usage.turns
  provider_ref TEXT NOT NULL,             -- adapter transcript id at this turn
  fork_point   TEXT NOT NULL,             -- aisdk: provider_messages seq (as text)
                                          -- claude: the turn's last chain UUID
  user_text    TEXT,                      -- snippet for the undo picker
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);
```

`fork_point` is exactly what an adapter needs to rewind or fork at that turn.
The Claude mapper starts recording each turn's last chain-entry UUID (the SDK
messages carry `uuid`s; `resumeSessionAt`'s "kept turn's last chain entry" rule
picks which one). `sessions` gains a `fork_turn INTEGER` column (null = root).

## Seam / RPC surface

- `SessionRef` gains `forkFrom?: string` (the tip transcript ref) and
  `truncateAt?: { at: string; drops: string }` for the claude rewind pair.
- Or keep it daemon-orchestrated: `session.rewind { id, toTurn }` and
  `session.fork { id, prompt }`. The daemon reads the checkpoint, does the
  aisdk row copy / claude resume-option dance, and the adapter just needs the
  right `SessionRef` fields. Leaning this way — smaller seam change.
- `session.rewind` returns the truncated snapshot; `session.fork` returns the
  new session's snapshot.
- The undo picker needs the turn list: fold `turns` (already on the snapshot)
  + a `checkpoints` read into a `session.checkpoints { id }` RPC.

## TUI

- **`u`** (browse, idle session) → undo picker overlay (reuse the M10e `Picker`);
  rows are `turn N · "<user_text snippet>"`, newest at the bottom. Enter →
  confirm w/ cache line → `session.rewind` → prompt reopens.
- **`f`** stays "new session" via the existing flow; **`⑂`** (or `⌃f`) → hard
  fork the selected session → `session.fork` → selects the new row.
- Fleet: a forked session shows `⑂` before its id and, in Detail, `forked from
  <shortId> @ turn N`.
- Help + footer updated.

## Phasing

| # | scope |
|---|---|
| **F1** | `checkpoints` table + `fork_turn` column (one migration); daemon writes a checkpoint per `result`; `session.rewind` + `session.checkpoints` RPCs; aisdk rewind (`store.replaceFrom`); TUI `u` picker + cache-burn line. |
| **F2** | `session.fork` + the fleet `⑂` lineage; aisdk fork (row copy) + new worktree off the parent branch. |
| **F3** | Claude rewind (`resumeSessionAt` / `resumeDropsTurn` + refusal fallback) and fork (`forkSession`); mapper captures per-turn chain UUIDs. |

## Later / not now

- **Per-turn worktree snapshots** so undo can roll files back too (shadow-ref
  commit per turn). Follow-up.
- **F4 — switch a live session's provider = hard-fork onto the target
  provider.** aisdk→aisdk is trivial (copy `ModelMessage[]`). **claude←aisdk is
  now feasible** (user's note): the SDK takes a custom `SessionStore` and
  `SDKUserMessageReplay` (`shouldQuery: false`) transcript appends /
  `importSessionToStore`, so a synthesized Claude transcript can be seeded.
  Still fiddly (message-shape translation); park behind F1–F3.
- The same message-injection capability may unpark **mid-tool steering**
  (backlog) — inject a `shouldQuery: false` user note between tool results.
  Revisit separately.
