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
import type { SessionMode } from "../types.ts";

const READONLY_EXACT = new Set([
  "ask_user", // surfaces its own question prompt
  "exit_plan", // surfaces its own plan-review prompt
  "list_allowed_directories",
  "directory_tree",
  "list_directory_with_sizes",
]);
const READONLY_RE =
  /(^|__)(read|list|get|search|stat|tree|find|grep|glob|fetch|inspect|show|describe|view|cat|head|tail|count|exists)(_|$)/i;
const EDIT_RE =
  /(^|__)(write|edit|create|append|patch|apply|insert|mkdir|move|rename|copy|delete|remove|rm|touch|format|save)(_|$)/i;

export function isReadonly(name: string): boolean {
  return READONLY_EXACT.has(name) || READONLY_RE.test(name);
}

export function isEdit(name: string): boolean {
  return EDIT_RE.test(name);
}

/** What to do with a tool call *before* any user prompt. */
export function policy(mode: SessionMode, name: string): "allow" | "ask" {
  if (mode === "auto") return "allow";
  if (isReadonly(name)) return "allow";
  if (mode === "acceptEdits" && isEdit(name)) return "allow";
  // `plan` mode's withhold-the-mutators behaviour is M10d; until then it gates
  // like `default`.
  return "ask";
}

export class PermissionDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDenied";
  }
}

export interface PermissionAsk {
  (toolName: string, input: unknown, toolCallId: string): Promise<{ allow: boolean; message?: string }>;
}

export interface GateOptions {
  /** Read dynamically so a mid-session `setMode` takes effect on the next call. */
  mode: () => SessionMode;
  ask: PermissionAsk;
}

/** Wrap every executable tool in a set with the gate. */
export function wrapToolSet(tools: ToolSet, opts: GateOptions): ToolSet {
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
}
