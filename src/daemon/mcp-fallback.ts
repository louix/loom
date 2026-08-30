/**
 * Resolve a `[[mcp]]` command string to what actually gets spawned. The only
 * special case: the default `tilth` file-tools server missing from `$PATH` →
 * fall back to a pinned `npx` download so a fresh checkout still gets the good
 * tools. If `npx` is missing too, the command is left as-is and the session
 * runs with just the built-in tools.
 */
import { onPath } from "../util/paths.ts";

/** Pinned tilth version for the no-install fallback. */
export const TILTH_FALLBACK = "tilth@0.9.0";

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** A human-readable reason, set only when the command was rewritten or a
   *  needed binary is missing. */
  note?: string;
}

export function resolveMcpCommand(
  raw: string,
  has: (cmd: string) => boolean = onPath,
): ResolvedCommand {
  const parts = raw.split(/\s+/).filter((s) => s.length > 0);
  const command = parts[0] ?? raw;
  const args = parts.slice(1);

  if (command !== "tilth" || has("tilth")) return { command, args };

  if (has("npx")) {
    return {
      command: "npx",
      args: ["-y", TILTH_FALLBACK, ...args],
      note: `tilth not on PATH — falling back to \`npx -y ${TILTH_FALLBACK}\``,
    };
  }
  return {
    command,
    args,
    note: "tilth and npx both missing — its tools won't be available this session",
  };
}
