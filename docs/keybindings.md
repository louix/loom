# Loom TUI — keybindings

A small, consistent grammar. Learn the five rules and the keys fall out of them.
Press `?` in the TUI for the same thing on one screen; press `Space` for a
fuzzy, searchable list of every action valid right where you are.

**Prepare repo environment** in that palette runs `loom environment prepare`
with live output in the terminal. It refreshes the base for future sessions and
does not require a selected session. Press Enter after completion to return;
Ctrl-C cancels preparation and returns after cleanup.

## The grammar

| modifier        | means                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **bare key**    | act on the selected session, or move the selection                                                                                 |
| **`Shift`+key** | the heavier / structural sibling of the lowercase — creates or destroys session / daemon state                                     |
| **`Ctrl`+key**  | text editing only, inside the prompt and the pickers' filter line — the readline motions. `⌃c` quits (the one universal exception) |
| **`Alt`+key**   | run an action _without leaving the prompt_ — "step out to a bigger tool"                                                           |
| **`Space`**     | the command palette: everything valid right now, fuzzy-filtered, each row showing its key                                          |

Consequences:

- `Ctrl` never triggers an app action, so `⌃e` is line-end again (it used to be
  stolen for "$EDITOR").
- `Shift` is never a decorative "variant of" — it always means _bigger blast
  radius_: `q`→`Q` (also stops the daemon), `r`→`R` (restarts the daemon), `x`
  (archive, reversible) →`X` (delete, permanent). `F` (hard fork) stands with
  them as a structural op.
- Rare actions don't need a memorised key — they're one `Space`, a few letters,
  `Enter` away, and the palette teaches you the key for next time.
- The footer only ever shows the few most pertinent verbs for the current state,
  plus `␣ more`.
- Three session-control keys work **both** in browse and inside a prompt, so
  you can change your mind mid-message: `⇧⇥` cycles the permission mode, `⌥m`
  swaps the model, `⌥t` its thinking-effort level. (`⌥m` / `⌥t` are the `Alt`
  keys that also act from the fleet view.)

## Browse (the fleet view)

### Navigation

| key                  | action                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑` / `↓`, `j` / `k` | move the selection                                                                                                                                 |
| `→` / `←`, `l` / `h` | drill into the selected session's sub-agents & background tasks / back out — `↑`/`↓` then picks a child, and EVENTS shows just that child's stream |
| `PgUp` / `PgDn`      | scroll the event log — a scrolled-back log stays pinned as new events land (accent border) instead of following the tail                           |
| `Home` / `End`       | jump the event log to the first line held / back to the live tail                                                                                  |
| `⇥`                  | toggle the fleet list: **overview** (fleet + detail + events) ↔ **session** (detail + events, full width)                                          |
| `Esc`                | one step back: the session view → overview, then out of a drill-down, then out of an overlay — never quits                                         |
| `Space`              | open the command palette                                                                                                                           |
| `?`                  | keys & the grammar                                                                                                                                 |

On a narrow terminal (under 80 columns — a small window or an SSH session from a
phone) there's no room for the three-column split, so `overview` is the fleet
list alone — detail + events are hidden — and `⇥` swaps to the full-width
session pane; `Esc` snaps back. `→` / `←` are unchanged — they still only drill
into a session's children. Replying to a session jumps to the session pane so
you can see what you type.

### Acting on the selected session (footer verbs)

| key | action                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `⏎` | act on the selected session: compose a message (running / idle / stopped — a stopped one is revived first), or take up a pending question / plan. It's the one "talk to this session" verb — there's no separate resume. |
| `a` | approve a pending permission (Enter deliberately doesn't — this one's explicit); also answers / reviews, like `⏎`                                                                                                        |
| `d` | deny the pending request (**deny-only** — never deletes)                                                                                                                                                                 |
| `i` | interrupt the current turn                                                                                                                                                                                               |
| `c` | compact the context window (offered once the meter passes half)                                                                                                                                                          |
| `x` | archive the session — stop it and drop its worktree, keeping the branch + chat; message it again to resume on a fresh tree (a dirty tree prompts to confirm)                                                             |

Press `s` in browse mode to open a shell in the selected session's repository or
worktree, inside its VM when applicable. Exit or Ctrl-D returns to the same Loom
view. Ctrl-C belongs to the shell while it is open. You can also run
`loom shell <session>` from another terminal.

### Second tier (palette + `?` only)

| key  | action                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| `⇧⇥` | cycle the permission mode (`manual` → `plan` → `acceptEdits` → `auto`)                                       |
| `⌥m` | switch the session's model — applies next turn                                                               |
| `⌥t` | switch the session's thinking-effort level (models that support one)                                         |
| `u`  | undo — rewind an idle session to an earlier turn (shows the re-prime cost)                                   |
| —    | keep cache warm — daemon re-primes the prompt cache before its TTL lapses (Claude, pinned TTL; palette only) |
| —    | gc — repair sweep for a done session whose worktree removal failed at archive time; branches and rows kept   |
| `e`  | rename the session                                                                                           |
| —    | add / edit a comment — a user-authored note on the session, meta, not part of the event log (palette only)   |
| `s`  | open an interactive shell in the session's environment; exit to return                                       |
| `y`  | copy the session's branch name to the clipboard                                                              |
| `o`  | open the pending request — or the transcript — in `$EDITOR`, read-only                                       |
| `v`  | event log: cycle chat only → chat + tool calls → everything                                                  |
| `t`  | cycle theme: dark → light → argonext (remembered across restarts)                                            |

### Structural (`Shift`)

| key | action                                                                                       |
| --- | -------------------------------------------------------------------------------------------- |
| `F` | hard fork — a new session + worktree branched off this one (aisdk only)                      |
| `X` | delete the session — worktree + transcript go too (confirm; `b` there also drops the branch) |
| `R` | restart the daemon (confirm)                                                                 |
| `Q` | quit the UI **and stop the daemon** (confirm)                                                |

### Always

| key        | action                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `n`        | new session — the prompt shows the provider / model; `⌥p` changes them                                                                                                                                                               |
| `/`        | filter the fleet in place — type to narrow the list (fuzzy, over titles and message text; matched in the daemon, so sessions this TUI has never opened are found too); `↑↓` keep moving the selection, `enter` accepts, `esc` clears |
| `q` / `⌃c` | quit the UI — the daemon keeps running                                                                                                                                                                                               |

`v` cycles EVENTS verbosity: `full` → `chat` → `chat+tools` → `full`.
The same action is available as **verbosity** in the Space command palette.

## In the prompt

Reply prompts — send, answer, deny, rename, discuss, compact — draw on the
selected session's EVENTS pane (label, then the input under its transcript), so
you can see the agent you're typing at; the footer keeps their hints row. The
sessionless `new` prompt stays in the footer.

For lettered questions, enter a letter (`b` or `b)`) or a list (`a, c`,
`a and c`, or `a/c`). The TUI sends the corresponding option labels to the
agent. Free-form replies are also accepted and sent as typed.

`Ctrl` carries the readline motions and nothing else:

| key                              | motion                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `⌃a` / `⌃e`                      | start / end of line                                                                                                              |
| `⌃b` / `⌃f`                      | one char back / forward                                                                                                          |
| `⌃←` / `⌃→`                      | one word back / forward                                                                                                          |
| `⌃u` / `⌃k`                      | kill to start / end of line — a second `⌃u` (nothing left on the line) clears the whole input, pasted wall of text and all       |
| `⌃w`                             | delete the word before the cursor                                                                                                |
| `↑` / `↓`                        | walk the prompt history (vertical caret move in multi-line text)                                                                 |
| `Enter`                          | submit · `Esc` cancel — on a _send_ prompt targeting a still-running session, sends now (lands after the current tool call)      |
| `Esc` on a _new_ / _send_ prompt | keeps the typed text as a draft — reopening either prompt (whichever you meant) restores it, until it's actually sent            |
| `⇧⏎`                             | insert a newline (only in terminals that send a distinct code for Shift+Enter)                                                   |
| `⌥⏎`                             | insert a newline — except on a _send_ prompt targeting a still-running session, where it queues the message for turn end instead |

`Alt` runs an action without dropping what you've typed:

| key  | action                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `⌥e` | edit the text in `$EDITOR` (`:wq` to return); `tui.include_event_log_in_editor: true` includes the log (default `false`, may require `:wq!`); nothing is sent until `Enter` back in the UI |
| `⌥o` | open the event log in `$EDITOR`, read-only                                                                                                                                                 |
| `⇧⇥` | cycle the permission mode — the new session's _(new prompt)_, or the one you're messaging, live _(send prompt)_                                                                            |
| `⌥m` | switch the model — a model step for the new session _(new prompt)_, or a live switch on the one you're messaging _(send prompt, draft kept)_                                               |
| `⌥t` | switch the thinking-effort level, same shape as `⌥m` — only offered when the current (or chosen) model takes one                                                                           |
| `⌥p` | pick the provider / model _(new-session prompt only)_ — a model that takes a thinking-effort level asks for one as a third step                                                            |
| `⌥x` | clear the session's queued messages _(send prompt only)_                                                                                                                                   |

`⇧⏎` / `⌥⏎` insert a newline inline; `⌥e` hands the whole thing to `$EDITOR`
for heavier multi-line editing.

Holding a motion key (`⌃k`, `⌃w`, `⌃u`, `Backspace`, the arrows) repeats it —
the app replays the run even when the terminal delivers the auto-repeat as one
batched chunk.

## Overlays

Each overlay owns the screen and shows its own fixed key set on the footer:

- **Command palette / pickers** — type to filter (the prompt's readline motions work on the filter: `⌃a`/`⌃e`/`⌃w`…), `↑↓` move, `Enter` pick, `Esc` cancel. Session search is not a picker anymore — `/` filters the FLEET list in place and ranks it: title hits first, then your messages, then the agent's; space-separated terms are AND'd and a leading `'` pins a term to a literal substring (`'hello` won't match a spelled-out "h-e-l-l-o"). While a query is up the list is one flat, relevance-ordered set (same readline motions; `↑↓` keep moving the selection, `enter` accepts, `esc` clears).
- **Confirm** — `Enter` confirm, `Esc` cancel (`b` toggles "also delete the branch" on a delete confirm).
- **Plan review** — `i` implement · `f` implement fresh (compact first) · `e` edit in `$EDITOR` then implement · `d` discuss (note back, stay in plan mode) · `⇧⇥` cycle the mode the implementation runs in (manual → acceptEdits → auto) · `⌥p` retarget `f` for model / thinking-effort / provider (pre-selected to the session's current; a different provider forks a fresh session) · `⌥o`/`o` view · `PgUp`/`PgDn` / mouse wheel scroll a long plan. The overlay also shows the session's context meter. `Esc` backs out to the fleet without answering — the review stays pending and `a` re-opens it.

## Notes on terminals

`Alt`+key is delivered as an `Esc`-prefixed sequence (`ESC e` for `⌥e`), which
Ink parses as a meta keypress. If your terminal instead sends the high-bit form
(`Meta sends 8-bit`), the `⌥` prompt actions won't register — switch it to
"`Esc`+" / "meta sends escape".

The permission-mode chip also accepts mouse clicks in DETAIL and in the new-session
and reply composers, using the same cycle as `⇧⇥`. It is disabled while a send is
pending or its outcome needs review. Starting or resuming a session displays
the session's STARTING state after closing the composer. Accepted startup/send
errors appear in session events beside the attempted message. In an open composer,
↑ recalls that session's latest user messages (at the first line of a multiline
buffer), independent of transcript loading. New-session prompts use local history.
