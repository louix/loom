import type { KeyLike } from "./editor.ts";

// Key, label, and optional aliases. Menus and keyboard dispatch read this same table.
const globalCommands = {
  new: ["n", "new"],
  find: ["/", "find"],
  filter: ["v", "verbosity"],
  help: ["?", "help"],
  quit: ["q", "quit"],
  doctor: ["", "doctor — tools, connectors, daemon"],
  prepareEnvironment: ["", "Prepare repo environment — warm dependency cache for future sessions"],
  switchRepository: ["", "Switch repository"],
  viewlog: ["o", "view the active tab / pending request in $EDITOR"],
  logs: ["", "view the daemon + TUI logs in $EDITOR"],
  theme: ["t", "cycle theme"],
  restart: ["R", "restart the daemon"],
  quitall: ["Q", "quit the UI and stop the daemon"],
  gc: ["", "gc — remove worktrees of done sessions"],
} as const;
const sessionCommands = {
  approve: ["a", "approve"],
  deny: ["d", "deny"],
  answer: ["⏎", "answer", ["a"]],
  planreview: ["⏎", "review plan", ["a"]],
  send: ["⏎", "send"],
  interrupt: ["i", "interrupt"],
  done: ["x", "archive", [], "archive the session — branch + chat kept"],
  compact: ["c", "compact"],
  keepwarm: ["", "keep cache warm"],
  mode: ["⇧⇥", "mode"],
  model: ["⌥m", "model"],
  effort: ["⌥t", "effort"],
  provider: ["⌥p", "provider"],
  undo: ["u", "undo"],
  fork: ["F", "fork"],
  rebase: ["r", "rebase onto base"],
  title: ["e", "rename"],
  comment: ["", "add comment"],
  delete: ["X", "delete"],
  shell: ["s", "open shell"],
  copybranch: ["y", "copy branch"],
  clearqueue: ["⌥x", "clear the queued messages"],
} as const;

export type Command =
  | { tag: "global"; name: keyof typeof globalCommands }
  | { tag: "session"; name: keyof typeof sessionCommands; sessionId: string };
export type ActName = Command["name"];
const definitions = { ...globalCommands, ...sessionCommands };
const isGlobal = (name: ActName): name is keyof typeof globalCommands => name in globalCommands;
export const bindCommand = (name: ActName, sessionId: string | null): Command | null => {
  if (isGlobal(name)) return { tag: "global", name };
  return sessionId === null ? null : { tag: "session", name, sessionId };
};

export interface KeyHint {
  keys: string;
  label: string;
  act: ActName;
  footer?: boolean;
}
export const commandHint = (
  act: ActName,
  options: Partial<Omit<KeyHint, "act">> = {},
): KeyHint => ({
  act,
  keys: definitions[act][0],
  label: definitions[act][1],
  ...options,
});

export const keyCommand = (
  hints: readonly KeyHint[],
  input: string,
  key: KeyLike,
): ActName | null => {
  if (key.ctrl) return null;
  let pressed = input;
  if (key.return) pressed = "⏎";
  else if (key.tab && key.shift) pressed = "⇧⇥";
  else if (key.meta) pressed = `⌥${input}`;
  return (
    hints.find((h) => {
      const def: readonly [string, string, (readonly string[])?, string?] = definitions[h.act];
      return pressed !== "" && (def[0] === pressed || def[2]?.includes(pressed));
    })?.act ?? null
  );
};

export const commandHelp = (): Array<[string, string]> =>
  [...Object.values(sessionCommands), ...Object.values(globalCommands)]
    .filter((d) => d[0] !== "")
    .map((d) => [d[0], d.length > 3 ? d[3]! : d[1]]);
