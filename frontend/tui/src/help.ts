import { commandHelp } from "./commands.ts";
import { wrapText } from "./theme.ts";
const GRAMMAR_ROWS: Array<[string, string]> = [
  ["bare key", "act on the selected session, or move"],
  ["Shift + key", "the heavier / structural sibling — Q quit-all · R restart · X delete · F fork"],
  ["Ctrl + key", "text editing only, in the prompt (⌃a ⌃e ⌃b ⌃f ⌃u ⌃k ⌃w) — ⌃c quits"],
  [
    "Alt + key",
    "run an action without leaving the prompt — ⌥e ⌥o ⌥q ⌥x; ⌥m / ⌥p switch the model / provider (also from the fleet view)",
  ],
  ["⇧⇥", "cycle the permission mode — on the selection, or inside a prompt (mid-message)"],
  ["Space", "the command palette — everything valid right now, fuzzy, with its key"],
];

const EDIT_ROWS: Array<[string, string]> = [
  ["enter  ·  esc", "submit  ·  cancel"],
  ["⇧⏎ / ⌥⏎", "insert a newline (⇧⏎ needs a terminal that sends a distinct code; ⌥⏎ always works)"],
  ["⌃a / ⌃e", "start / end of line     ⌃b / ⌃f  char back / forward"],
  ["⌃← / ⌃→", "word back / forward"],
  ["⌃u / ⌃k  ·  ⌃w", "kill to start / end     ·     delete the word before the cursor"],
  [
    "⌥e  ·  ⌥o",
    "edit in $EDITOR, event log alongside (`:wq` to return)  ·  view the log, read-only",
  ],
  [
    "⇧⇥  ·  ⌥m  ·  ⌥p",
    "cycle the permission mode  ·  switch the model  ·  switch the provider + model — the new session's, or the one you're messaging (aisdk↔aisdk carries the transcript; Claude isn't supported yet)",
  ],
  [
    "⌥q  ·  ⌥x",
    "queue for turn end while the session is working, send when idle  ·  clear the queued messages (send)",
  ],
  ["↑ / ↓", "walk the prompt history"],
];

export const helpLines = (width: number): string[] =>
  [
    "loom — keys",
    "",
    "the grammar",
    ...GRAMMAR_ROWS.map(([key, text]) => key + "  " + text),
    "",
    "1 / 2 / 3  Chat / Changes / Monitor (outside editing)",
    "PgUp / PgDn · Home / End  scroll the active tab",
    ...commandHelp().map(([key, text]) => key + "  " + text),
    "",
    "in the prompt",
    ...EDIT_ROWS.map(([key, text]) => key + "  " + text),
    "",
    "◇  VM session · unmarked sessions run locally",
    "",
    "loom drives worktrees only — it never pushes or touches your remotes.",
  ].flatMap((line) => wrapText(line || " ", Math.max(1, width)));
