# Loom TUI — keybindings

A small, consistent grammar. Learn the five rules and the keys fall out of them.
Press `?` in the TUI for the same thing on one screen; press `Space` for a
fuzzy, searchable list of every action valid right where you are.

## The grammar

| modifier | means |
|----------|-------|
| **bare key** | act on the selected session, or move the selection |
| **`Shift`+key** | the heavier / structural sibling of the lowercase — creates or destroys session / daemon state |
| **`Ctrl`+key** | text editing only, and only inside the prompt — the readline motions. `⌃c` quits (the one universal exception) |
| **`Alt`+key** | run an action *without leaving the prompt* — "step out to a bigger tool" |
| **`Space`** | the command palette: everything valid right now, fuzzy-filtered, each row showing its key |

Consequences:

- `Ctrl` never triggers an app action, so `⌃e` is line-end again (it used to be
  stolen for "$EDITOR").
- `Shift` is never a decorative "variant of" — it always means *bigger blast
  radius*: `q`→`Q` (also stops the daemon), `r`→`R` (restarts the daemon), `x`
  (mark done, reversible) →`X` (delete, permanent). `F` (hard fork) stands with
  them as a structural op.
- Rare actions don't need a memorised key — they're one `Space`, a few letters,
  `Enter` away, and the palette teaches you the key for next time.
- The footer only ever shows the few most pertinent verbs for the current state,
  plus `␣ more`.
- Two session-control keys work **both** in browse and inside a prompt, so you
  can change your mind mid-message: `⇧⇥` cycles the permission mode, `⌥m` swaps
  the model. (`⌥m` is the one `Alt` key that also acts from the fleet view.)

## Browse (the fleet view)

### Navigation

| key | action |
|-----|--------|
| `↑` / `↓`, `j` / `k` | move the selection |
| `PgUp` / `PgDn` | scroll the event log |
| `⇥` | fullscreen the event log (and back) |
| `Esc` | leave fullscreen / back out of an overlay — never quits |
| `Space` | open the command palette |
| `?` | keys & the grammar |

### Acting on the selected session (footer verbs)

| key | action |
|-----|--------|
| `⏎` | act on the selected session: compose a message (running / idle / stopped — a stopped one is revived first), or take up a pending question / plan. It's the one "talk to this session" verb — there's no separate resume. |
| `a` | approve a pending permission (Enter deliberately doesn't — this one's explicit); also answers / reviews, like `⏎` |
| `d` | deny the pending request (**deny-only** — never deletes) |
| `i` | interrupt the current turn |
| `c` | compact the context window (offered once the meter passes half) |
| `x` | mark the session done |

### Second tier (palette + `?` only)

| key | action |
|-----|--------|
| `⇧⇥` | cycle the permission mode (`manual` → `plan` → `acceptEdits` → `auto`) |
| `⌥m` | switch the session's model — applies next turn |
| `u` | undo — rewind an idle session to an earlier turn (shows the re-prime cost) |
| `e` | rename the session |
| `b` | set a cost budget (soft-warns, then hard-halts) |
| `y` | copy the session's branch name to the clipboard |
| `o` | open the pending request — or the transcript — in `$EDITOR`, read-only |
| `v` | event log: everything ↔ chat only |

### Structural (`Shift`)

| key | action |
|-----|--------|
| `F` | hard fork — a new session + worktree branched off this one (aisdk only) |
| `X` | delete the session — worktree + transcript go too (confirm; `b` there also drops the branch) |
| `R` | restart the daemon (confirm) |
| `Q` | quit the UI **and stop the daemon** (confirm) |

### Always

| key | action |
|-----|--------|
| `n` | new session — the prompt shows the provider / model; `⌥p` changes them |
| `f` | fuzzy-find a session by title or message text |
| `q` / `⌃c` | quit the UI — the daemon keeps running |

## In the prompt

`Ctrl` carries the readline motions and nothing else:

| key | motion |
|-----|--------|
| `⌃a` / `⌃e` | start / end of line |
| `⌃b` / `⌃f` | one char back / forward |
| `⌃←` / `⌃→` | one word back / forward |
| `⌃u` / `⌃k` | kill to start / end of line |
| `⌃w` | delete the word before the cursor |
| `↑` / `↓` | walk the prompt history (vertical caret move in multi-line text) |
| `Enter` | submit · `Esc` cancel — on a *send* prompt targeting a still-running session, sends now (lands after the current tool call) |
| `Esc` on a *new* / *send* prompt | keeps the typed text as a draft — reopening either prompt (whichever you meant) restores it, until it's actually sent |
| `⇧⏎` | insert a newline (only in terminals that send a distinct code for Shift+Enter) |
| `⌥⏎` | insert a newline — except on a *send* prompt targeting a still-running session, where it queues the message for turn end instead |

`Alt` runs an action without dropping what you've typed:

| key | action |
|-----|--------|
| `⌥e` | edit the text in `$EDITOR`, event log opened alongside (`:wq` to return); nothing is sent until `Enter` back in the UI |
| `⌥o` | open the event log in `$EDITOR`, read-only |
| `⇧⇥` | cycle the permission mode — the new session's *(new prompt)*, or the one you're messaging, live *(send prompt)* |
| `⌥m` | switch the model — a model step for the new session *(new prompt)*, or a live switch on the one you're messaging *(send prompt, draft kept)* |
| `⌥p` | pick the provider / model  *(new-session prompt only)* |
| `⌥x` | clear the session's queued messages  *(send prompt only)* |

`⇧⏎` / `⌥⏎` insert a newline inline; `⌥e` hands the whole thing to `$EDITOR`
for heavier multi-line editing.

## Overlays

Each overlay owns the screen and shows its own fixed key set on the footer:

- **Command palette / pickers** — type to filter, `↑↓` move, `Enter` pick, `Esc` cancel.
- **Confirm** — `Enter` confirm, `Esc` cancel (`b` toggles "also delete the branch" on a delete confirm).
- **Plan review** — `i` implement · `f` implement fresh (compact first) · `e` edit in `$EDITOR` then implement · `d` discuss (note back, stay in plan mode) · `⌥o`/`o` view. A plan review must be answered — `Esc` does nothing.

## Notes on terminals

`Alt`+key is delivered as an `Esc`-prefixed sequence (`ESC e` for `⌥e`), which
Ink parses as a meta keypress. If your terminal instead sends the high-bit form
(`Meta sends 8-bit`), the `⌥` prompt actions won't register — switch it to
"`Esc`+" / "meta sends escape".
