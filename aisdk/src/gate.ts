/**
 * Permission gate + mode filter for aisdk tool calls. The Claude adapter gets
 * this from the SDK's `canUseTool`; here Loom owns it. Every tool's `execute` is
 * wrapped so that, depending on the session mode and the tool's nature, the call
 * is allowed outright, routed through a `permission_request` the user answers,
 * or (in `plan` mode) withheld. A denied call throws — the model sees a
 * tool error and can adjust.
 *
 * Tool-nature classification (`isReadonly`/`isEdit`/`policy`) is vendor-neutral
 * and lives in `@loom/runtime/policy`, re-exported here; only the `ToolSet`
 * wrapping below is aisdk-specific.
 */
import type { ToolExecutionOptions, ToolSet } from "ai";
import type { SessionMode } from "@loom/core/types";
import { isEdit, isReadonly, policy } from "@loom/runtime/policy";

export { isEdit, isReadonly, policy };

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
  /** Mounted tool name → the MCP server's `annotations.readOnlyHint` for it.
   *  Present entries override the name heuristics (see `isReadonly`). */
  readonlyHints?: ReadonlyMap<string, boolean>;
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
    const call = run as (input: unknown, ctx: ToolExecutionOptions<unknown>) => unknown;
    out[name] = {
      ...t,
      execute: async (input: unknown, ctx: ToolExecutionOptions<unknown>): Promise<unknown> => {
        if (policy(opts.mode(), name, opts.readonlyHints?.get(name)) === "ask") {
          const decision = await opts.ask(name, input, ctx.toolCallId);
          if (!decision.allow) throw new PermissionDenied(decision.message ?? "denied by the user");
        }
        return call(input, ctx);
      },
    };
  }
  return out as ToolSet;
};
