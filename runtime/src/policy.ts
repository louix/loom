/**
 * Tool-nature classification: is a tool call read-only, an edit, or neither —
 * the vendor-neutral half of aisdk's permission gate (`aisdk/src/gate.ts`).
 * Relocated here (unchanged) because Phase 5 of the ChatGPT provider plan
 * needs the same classification for Codex's host-executed tools ("Codex's
 * filesystem sandbox does not protect them"); `aisdk/src/gate.ts` re-exports
 * these names so its existing `ToolSet`-wrapping stays where it is.
 *
 * Tool nature comes from the server's own MCP `annotations.readOnlyHint` when
 * it declares one, else from the name: official MCP servers and our own tools
 * use consistent `read_`/`write_`/`list_`/… verbs.
 */
import type { SessionMode } from "@loom/core/types";

export const READONLY_EXACT = new Set([
  "ask_user", // surfaces its own question prompt
  "exit_plan", // surfaces its own plan-review prompt
  "web_search",
  "list_allowed_directories",
  "directory_tree",
  "list_directory_with_sizes",
  "status", // git status/diff via @loom/core/status — read-only
  "background_output", // reads a background task's output buffer
]);
// Match a verb as any underscore-delimited segment of the name (`get_or_create`,
// `search_and_replace`, `mcp__fs__search_files`), not just the leading one.
export const READONLY_RE =
  /(^|_)(read|list|get|search|stat|tree|find|grep|glob|fetch|inspect|show|describe|view|cat|head|tail|count|exists)(_|$)/i;
// `set` / `sync` are omitted deliberately: they collide with trailing nouns
// (`get_result_set`, `get_sync_status`) and dropping them only downgrades an
// oddly-named tool from "auto-accept in acceptEdits" to "prompt" — still safe,
// still withheld in plan mode.
export const EDIT_RE =
  /(^|_)(write|edit|create|append|patch|apply|insert|mkdir|move|rename|copy|delete|remove|rm|touch|format|save|replace|swap|update|upsert|prune|purge|drop|truncate|clear|overwrite)(_|$)/i;

export const isEdit = (name: string): boolean => {
  return EDIT_RE.test(name);
};

export const isReadonly = (name: string, declaredReadonly?: boolean): boolean => {
  // The server's own MCP `annotations.readOnlyHint` beats the name guess, both
  // ways: `tilth_deps` / `tilth_diff` carry no read verb but declare themselves
  // read-only (so they stay available in plan mode), while a read-looking name
  // declared mutating still gates.
  if (declaredReadonly !== undefined) return declaredReadonly;
  if (READONLY_EXACT.has(name)) return true;
  // A name that carries *both* a read verb and a mutation verb
  // (`search_and_replace`, `get_or_create_file`, `read_and_write`) is a
  // mutator — the edit verb wins the tie, so it goes through the gate and is
  // withheld in plan mode.
  return READONLY_RE.test(name) && !EDIT_RE.test(name);
};

/** What to do with a tool call *before* any user prompt. */
export const policy = (
  mode: SessionMode,
  name: string,
  declaredReadonly?: boolean,
): "allow" | "ask" => {
  if (mode === "auto") return "allow";
  if (isReadonly(name, declaredReadonly)) return "allow";
  if (mode === "acceptEdits" && isEdit(name)) return "allow";
  // In `plan` mode mutators are additionally withheld at mount time
  // (aisdk's `#turnToolSet`); anything still reaching this gates like `default`.
  return "ask";
};
