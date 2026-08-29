# Fork / undo tree — design

Status: **proposal, under review.** The last unbuilt item from the post-M5
roadmap era. Nothing here is committed as code yet.

## Goal

An "undo" and "fork" for a session, presented as a **tree of turns**, not a
linear history. From any past turn the user can:

- **rewind** — go back to that point, discarding what came after (the 80% case:
  "that last turn went sideways, redo it");
- **fork** — start a new branch from that point, leaving the original intact;
- navigate between leaves, seeing the tree structure.

When checking out a cold branch, warn about the **prompt-cache / context-burn
cost** of re-priming it — the tree UI needs a cheap estimate.

## Core decision: a fork is a new session row

Not an in-session sub-structure. A fork = `session.create`-shaped: a new
`sessions` row with `parent_id` set and a new `fork_turn` column (which turn of
the parent it branched at), its own worktree, its own transcript. This reuses
**everything** — the snapshot, the fleet view, status derivation, budgets,
titles, the adapter lifecycle. The "tree" is a view over `sessions` linked by
`parent_id` + `fork_turn`.

Rewind is the degenerate case: rewind-in-place truncates the current session;
rewind-as-fork forks at turn N and leaves the original as a dead branch.
Start with truncate-in-place for rewind (simpler, matches "undo"), add
rewind-as-fork later if wanted.

## Checkpoints

A new append-only table, one row per completed turn (`result` event):

```sql
CREATE TABLE checkpoints (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn        INTEGER NOT NULL,           -- 1-based, matches usage.turns
  provider_ref TEXT NOT NULL,             -- adapter transcript id at this turn
  fork_point  TEXT NOT NULL,              -- aisdk: provider_messages max seq;
                                          -- claude: the turn's last chain UUID
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);
```

The daemon writes one on each `result` (it already increments `usage.turns`
there). `fork_point` is what an adapter needs to branch at exactly that turn.

- **aisdk** — `fork_point` = the `provider_messages` seq of the last message
  in the turn. Forking = copy rows `[0..seq]` into the new session; the new
  session `resumeSession`s from its own copy. Trivial and exact at any turn.
- **claude** — `fork_point` = the turn's last chain-entry UUID. The mapper must
  start recording it (the SDK messages carry `uuid`s; the "last chain entry of
  the kept turn" rule from `resumeSessionAt`'s docs decides *which* uuid).

## Provider support

Both can do **full rewind + fork at any turn**:

- **aisdk** — Loom owns `ModelMessage[]`; slicing is exact.
- **claude** — the Agent SDK exposes it: `query({ options: { resume: <parentRef>,
  forkSession: true, resumeSessionAt: <turn UUID>, resumeDropsTurn: <next-turn
  prompt UUID> } })`. `forkSession` gives the branch fresh UUIDs;
  `resumeSessionAt` truncates to the turn; `resumeDropsTurn` arms a validator
  that refuses if the discarded range holds anything unexpected (a queued
  message the session absorbed mid-turn). **The SDK docs mandate**: on refusal
  (message starts `Resume rejected by --resume-drops-turn:`) the caller must
  fall back to a plain resume keeping the evidence — never retry. The adapter
  handles that fallback and surfaces it as a `notice`.

`capabilities.forking` becomes `"none" | "tip" | "any"` (both current adapters
report `"any"`) so a future provider that can only branch from the latest turn
degrades gracefully in the UI.

## Worktree

A fork gets its **own** worktree, branched off the parent session's branch at
its current HEAD: `git worktree add -b loom/<slug>-f1 <parent-branch>`. The
worktree manager already branches off a base ref — pass the parent branch. No
copy-on-write, no shared-tree bookkeeping.

## Cache-burn estimate

On checkout / fork, before it runs: `estimateTokens(branch transcript) ×
price.cacheWrite` from the loaded price table (both helpers exist —
`estimateTokens`, `costOf`). Phrase it as e.g. `this branch is ~48k tokens and
cold — the next turn re-primes it (~$0.18)`. For Claude, `cacheWrite` price
comes from the same table keyed by model.

## TUI

- **`T`** on a selected session → a tree overlay for its fork family (root +
  every `parent_id` descendant). Nodes are turns; branches where a fork
  happened. `↑/↓` move, `enter` = check out that node's branch (confirm with the
  cache-burn line), `f` = fork at the highlighted node (opens a prompt for the
  new branch's first message), `esc` backs out. Reuses the `Picker`/overlay
  patterns from M10e.
- **`u`** in browse on an idle session → rewind-and-redo the last turn: truncate
  to turn N-1, reopen the prompt pre-filled with the last user message. The
  quick path, no tree needed.
- Fleet list **stays flat** — every leaf is its own session row and shows
  normally. A forked session gets a `⑂` glyph + its `parent`'s short id in the
  Detail pane so the lineage is visible without opening the tree.

## Seam / RPC surface

- `AgentProvider.forkSession(ref: SessionRef, forkPoint: string): Promise<AgentSession>`
  — or keep forking daemon-orchestrated (copy + `resumeSession` for aisdk;
  `resumeSession` with the fork options for claude). Leaning daemon-orchestrated
  with a `forkPoint` field on `SessionRef` — smaller seam change.
- RPCs: `session.fork { id, atTurn, prompt }` → new session snapshot;
  `session.rewind { id, toTurn }` → truncates in place, returns the snapshot.
- `session.tree { rootId }` → the `{ id, parentId, forkTurn, turn, title,
  status }[]` for the family, for the `T` overlay. Or fold it into
  `SessionSnapshot` (`parentId` is already there; add `forkTurn`, `turns` is
  there) and let the client assemble the tree.

## Phasing

| # | scope |
|---|---|
| **F1** | `checkpoints` table + daemon writes one per `result`; `session.rewind` (aisdk: `store.replaceFrom`); TUI `u` = rewind-and-redo-last-turn on an idle session. No tree UI. |
| **F2** | `session.fork` (aisdk) + `parent_id`/`fork_turn` wiring + own worktree; the `T` tree overlay + component + cache-burn estimate. |
| **F3** | Claude rewind + fork via `resumeSessionAt` / `forkSession` / `resumeDropsTurn` (+ the mandated refusal fallback); mapper captures per-turn chain UUIDs; `capabilities.forking` tri-state. |
| **F4** | "switch a live session's provider" = fork into a new session on the target provider, seeding the transcript. aisdk→aisdk trivial; claude→aisdk needs transcript extraction from SDK messages; →claude is out of scope (can't inject a synthetic transcript into the CLI). |

## Open questions

1. **Rewind semantics** — truncate-in-place (my proposal, matches "undo") vs
   always fork so nothing is ever lost? Truncate is simpler and the worktree
   still has the git history; fork-always doubles session rows fast.
2. **Fleet vs tree** — flat fleet + a `T` overlay (my proposal), or restructure
   the fleet list to show forks indented under their root?
3. **F1 `u` scope** — just "redo the last turn", or a small inline turn-picker
   (`u` then a number)? I'd ship the former first.
4. **Checkpoint retention** — keep every turn's checkpoint forever, or cap
   (e.g. last 50) / prune on session `done`?
5. **F4 priority** — is "switch provider mid-session" wanted enough to pull it
   forward, or is it fine as the last phase?
