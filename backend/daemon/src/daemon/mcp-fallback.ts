/**
 * Resolve a `[[mcp]]` command string to what actually gets spawned. Two
 * special cases, both about the default `tilth` file-tools server:
 *
 *   - the legacy / misspelled `tilth mcp …` invocation is rewritten to
 *     `tilth --mcp …` — tilth's MCP server is a *flag*, and a bare `mcp`
 *     parses as a search query, so the "server" prints results and exits
 *     (the MCP client sees `Connection closed` and the tools silently
 *     vanish from every session);
 *   - `tilth` missing from `$PATH` → the command is left as-is with a note
 *     and the session runs with just the built-in tools.
 */
import { onPath } from "@loom/core/paths";

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** A human-readable reason, set only when the command was rewritten or a
   *  needed binary is missing. */
  note?: string;
}

/** Split a command line on whitespace, but keep a `'…'` / `"…"` quoted run
 *  (e.g. a path with spaces) as one token. No escape handling — `[[mcp]]`
 *  commands are simple. */
const tokenize = (s: string): string[] => {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
};

export const resolveMcpCommand = (
  raw: string,
  has: (cmd: string) => boolean = onPath,
): ResolvedCommand => {
  const parts = tokenize(raw);
  const command = parts[0] ?? raw;
  let args = parts.slice(1);
  const notes: string[] = [];

  // Heal the legacy `tilth mcp …` spelling (shipped in early defaults and the
  // example config before this was caught). No released tilth has an `mcp`
  // subcommand, and a `[[mcp]]` command must launch a server, never run a
  // one-shot search — so the rewrite is unambiguous.
  if (command === "tilth" && args[0] === "mcp") {
    args = ["--mcp", ...args.slice(1)];
    notes.push("tilth's serve flag is `--mcp` — rewrote legacy `tilth mcp`");
  }

  if (command !== "tilth" || has("tilth")) {
    return notes.length === 0 ? { command, args } : { command, args, note: notes.join("; ") };
  }

  return {
    command,
    args,
    note: ["tilth is not installed — its tools won't be available this session", ...notes].join(
      "; ",
    ),
  };
};
