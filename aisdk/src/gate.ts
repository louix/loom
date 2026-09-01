/**
 * Permission gate + mode filter for aisdk tool calls. The Claude adapter gets
 * this from the SDK's `canUseTool`; here Loom owns it. Every tool's `execute` is
 * wrapped so that, depending on the session mode and the tool's nature, the call
 * is allowed outright, routed through a `permission_request` the user answers,
 * or (M10d, `plan` mode) withheld. A denied call throws — the model sees a
 * tool error and can adjust.
 *
 * Tool nature is inferred from the name: official MCP servers and our own tools
 * use consistent `read_`/`write_`/`list_`/… verbs.
 */
import type { ToolCallOptions, ToolSet } from "ai";
import type { SessionMode } from "@loom/core/types";

const READONLY_EXACT = new Set([
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
const READONLY_RE =
  /(^|_)(read|list|get|search|stat|tree|find|grep|glob|fetch|inspect|show|describe|view|cat|head|tail|count|exists)(_|$)/i;
// `set` / `sync` are omitted deliberately: they collide with trailing nouns
// (`get_result_set`, `get_sync_status`) and dropping them only downgrades an
// oddly-named tool from "auto-accept in acceptEdits" to "prompt" — still safe,
// still withheld in plan mode.
const EDIT_RE =
  /(^|_)(write|edit|create|append|patch|apply|insert|mkdir|move|rename|copy|delete|remove|rm|touch|format|save|replace|swap|update|upsert|prune|purge|drop|truncate|clear|overwrite)(_|$)/i;

export const isEdit = (name: string): boolean => {
  return EDIT_RE.test(name);
};

export const isReadonly = (name: string): boolean => {
  if (READONLY_EXACT.has(name)) return true;
  // A name that carries *both* a read verb and a mutation verb
  // (`search_and_replace`, `get_or_create_file`, `read_and_write`) is a
  // mutator — the edit verb wins the tie, so it goes through the gate and is
  // withheld in plan mode.
  return READONLY_RE.test(name) && !EDIT_RE.test(name);
};

/** What to do with a tool call *before* any user prompt. */
export const policy = (mode: SessionMode, name: string): "allow" | "ask" => {
  if (mode === "auto") return "allow";
  if (isReadonly(name)) return "allow";
  if (mode === "acceptEdits" && isEdit(name)) return "allow";
  // `plan` mode's withhold-the-mutators behaviour is M10d; until then it gates
  // like `default`.
  return "ask";
};

export class PermissionDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDenied";
  }
}

export interface PermissionAsk {
  (
    toolName: string,
    input: unknown,
    toolCallId: string,
  ): Promise<{ allow: boolean; message?: string }>;
}

export interface GateOptions {
  /** Read dynamically so a mid-session `setMode` takes effect on the next call. */
  mode: () => SessionMode;
  ask: PermissionAsk;
}

/** Wrap every executable tool in a set with the gate. */
export const wrapToolSet = (tools: ToolSet, opts: GateOptions): ToolSet => {
  const src = tools as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(src)) {
    const t = src[name] as Record<string, unknown>;
    const run = t["execute"];
    if (typeof run !== "function") {
      out[name] = t; // provider-executed / declaration-only — nothing to gate
      continue;
    }
    const call = run as (input: unknown, ctx: ToolCallOptions) => unknown;
    out[name] = {
      ...t,
      execute: async (input: unknown, ctx: ToolCallOptions): Promise<unknown> => {
        if (policy(opts.mode(), name) === "ask") {
          const decision = await opts.ask(name, input, ctx.toolCallId);
          if (!decision.allow) throw new PermissionDenied(decision.message ?? "denied by the user");
        }
        return call(input, ctx);
      },
    };
  }
  return out as ToolSet;
};
