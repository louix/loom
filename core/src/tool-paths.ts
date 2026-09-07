/**
 * Which files did a tool call write? Every connector names its editors
 * differently — Claude's `Write` / `Edit` / `MultiEdit` / `NotebookEdit`, the
 * aisdk engine's lowercase `write` / `edit`, and MCP servers whose tools arrive
 * namespaced (`mcp__tilth__tilth_write`) — so the mapping lives here rather
 * than being re-guessed by each consumer.
 *
 * Read-only tools deliberately return nothing: a `file_write` hook that fired
 * on `Read` would run the linter on every file the agent so much as opened.
 */

/** Trailing segment of a possibly namespaced tool name: `mcp__tilth__tilth_write` → `tilth_write`. */
const bareName = (name: string): string => {
  const i = name.lastIndexOf("__");
  return i === -1 ? name : name.slice(i + 2);
};

/** Tools that write one file, named by `file_path` / `path`. */
const SINGLE_WRITERS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "write",
  "edit",
  "tilth_edit",
]);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const pathOf = (o: Record<string, unknown>): string | null => {
  return str(o["file_path"]) ?? str(o["path"]);
};

/**
 * The files a successful `tool_call` wrote, in call order and de-duplicated.
 * Empty for a tool that writes nothing (or whose input doesn't name a path) —
 * the caller should treat that as "not a write" rather than "wrote nothing".
 *
 * Paths are returned exactly as the tool received them; resolving a relative
 * one is the caller's job, since only it knows the session's cwd.
 */
export const writtenPaths = (name: string, input: unknown): string[] => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const o = input as Record<string, unknown>;
  const bare = bareName(name);

  // tilth's batch write takes `files: [{ path, … }]` — one call, many files.
  if (bare === "tilth_write" && Array.isArray(o["files"])) {
    const out: string[] = [];
    for (const f of o["files"]) {
      if (!f || typeof f !== "object") continue;
      const p = pathOf(f as Record<string, unknown>);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  if (!SINGLE_WRITERS.has(bare)) return [];
  const p = pathOf(o);
  return p ? [p] : [];
};
