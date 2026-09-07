import { wrapText } from "./theme.ts";
const GRAMMAR_ROWS: Array<[string, string]> = [
  ["bare key", "act on the selected session, or move"],
  ["Shift + key", "the heavier / structural sibling — Q quit-all · R restart · X delete · F fork"],
  ["Ctrl + key", "text editing only, in the prompt (⌃a ⌃e ⌃b ⌃f ⌃u ⌃k ⌃w) — ⌃c quits"],
  [
    "Alt + key",
    "run an action without leaving the prompt — ⌥e ⌥o ⌥x; ⌥m / ⌥p switch the model / provider (also from the fleet view)",
  ],
  ["⇧⇥", "cycle the permission mode — on the selection, or inside a prompt (mid-message)"],
  ["Space", "the command palette — everything valid right now, fuzzy, with its key"],
];

const HELP_ROWS: Array<[string, string]> = [
  ["↑ / ↓  ·  j / k", "move the selection"],
  [
    "→ / ←  (fleet)",
    "drill into the session's sub-agents & background tasks — ↑/↓ picks one and EVENTS follows it · back out (esc too)",
  ],
  ["Space", "command palette — search and run any action available here"],
  [
    "a / ⏎  ·  d",
    "approve a request (`a` only) · answer / review it (`⏎` too)  ·  `d` deny (deny-only — never deletes)",
  ],
  [
    "⏎  ·  i",
    "send a message to the selected session (revives a stopped one)  ·  interrupt its turn",
  ],
  ["c  ·  x", "compact the context (any time)  ·  archive the session"],
  [
    "u  ·  ⇧⇥  ·  ⌥m / ⌥p",
    "undo to an earlier turn  ·  cycle the permission mode  ·  switch the model, or the provider + model (applies next turn)",
  ],
  ["e  ·  y", "rename  ·  copy the branch name to the clipboard"],
  ["o  ·  v", "view the log in $EDITOR  ·  event log full / chat"],
  [
    "⇥",
    "toggle the fleet list — hide it to give the session's detail + events the whole width (esc brings it back)",
  ],
  ["t", "cycle theme — dark / light / argonext"],
  [
    "n  ·  /",
    "new session (the prompt shows the provider / model; ⌥p to change)  ·  find a session",
  ],
  [
    "F  ·  X",
    "hard fork — new session + worktree off this one (aisdk)  ·  delete the session (confirm)",
  ],
  ["R  ·  Q", "restart the daemon  ·  quit the UI and stop the daemon  (both confirm)"],
  ["q  ·  ⌃c  ·  esc", "quit the UI, daemon keeps running  ·  quit  ·  back out of any overlay"],
  [
    "⟢ (fleet)",
    "prompt cache still warm — green → amber → red as it lapses; held green while a turn runs",
  ],
  ["␣ keep cache warm", "daemon re-primes the cache before its TTL lapses (Claude, pinned TTL)"],
  ["fleet id colour", "which provider the session runs on (default provider stays plain)"],
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
  ["⌥x  ·  ↑ / ↓", "clear the queued messages (send)  ·  walk the prompt history"],
];

export const helpLines = (width: number): string[] =>
  [
    "loom — keys",
    "",
    "the grammar",
    ...GRAMMAR_ROWS.map(([key, text]) => key + "  " + text),
    "",
    ...HELP_ROWS.map(([key, text]) => key + "  " + text),
    "",
    "in the prompt",
    ...EDIT_ROWS.map(([key, text]) => key + "  " + text),
    "",
    "loom drives worktrees only — it never pushes or touches your remotes.",
  ].flatMap((line) => wrapText(line || " ", Math.max(1, width)));
