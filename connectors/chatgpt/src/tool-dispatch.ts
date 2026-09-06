/**
 * Executes Loom's own tools (`commit`/`status`) on behalf of a Codex dynamic
 * tool call (`item/tool/call`, see `app-server.ts#toolCall`). Pulled out as
 * an injectable, session-bound async interface — rather than a switch buried
 * inside the RPC handler — so Phase 5's approval-wait/cancellation machinery
 * (mirroring `aisdk/src/gate.ts#wrapToolSet`'s `ask()` seam for Claude/aisdk)
 * can wrap `localToolDispatcher` instead of growing inside it.
 */
import { commitInWorktree } from "@loom/core/commit";
import { statusInWorktree } from "@loom/core/status";
import { policy } from "@loom/runtime/policy";
import type { SessionMode } from "@loom/core/types";

export interface ToolDispatchContext {
  mode: SessionMode;
  cwd: string;
  base?: string;
}

export interface ToolDispatchResult {
  text: string;
  ok: boolean;
}

export type ToolDispatcher = (
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext,
) => Promise<ToolDispatchResult>;

/**
 * Runs `commit`/`status` locally and synchronously (both are `spawnSync`-
 * backed under the hood — `async` here only so the signature matches
 * {@link ToolDispatcher}), gated by `@loom/runtime/policy`'s `policy()`
 * exactly as before extraction.
 *
 * Codex's own approval/sandbox machinery has no visibility into this
 * side-channel call — it runs in Loom's own process, not the sandboxed turn
 * — so a mutating tool needs Loom's *own* gate here, same as Claude/aisdk's
 * `commit` goes through `policy()` before running (see
 * `aisdk/src/gate.ts#wrapToolSet`). `policy()` returns "allow" only in
 * `auto` mode for a non-readonly name like `commit` — every other mode
 * (including `plan`) needs a human's answer to a `permission_request`, which
 * Codex sessions can't raise yet (`respondToPermission` only answers Codex's
 * own native approvals; Phase 5 is where Loom's own pending-interaction
 * machinery reaches Codex tool calls). Until then, "needs asking" means
 * "deny", not "silently run" — a temporary but safe stand-in, not a silent
 * gap.
 */
export const localToolDispatcher: ToolDispatcher = async (tool, args, ctx) => {
  if (tool === "commit" || tool === "status") {
    if (policy(ctx.mode, tool) !== "allow") {
      return {
        ok: false,
        text:
          `${tool} needs approval in ${ctx.mode} mode, which Codex sessions can't yet ask for — ` +
          "switch to auto mode to allow it, or ask the user to do it manually.",
      };
    }
  }
  if (tool === "commit") {
    const message = typeof args["message"] === "string" ? args["message"] : "";
    const res = commitInWorktree(ctx.cwd, message, { stageAll: args["stage_all"] !== false });
    return { text: res.text, ok: res.ok };
  }
  if (tool === "status") {
    const res = statusInWorktree(ctx.cwd, {
      ...(ctx.base ? { base: ctx.base } : {}),
      ...(args["patch"] === true ? { patch: true } : {}),
    });
    return { text: res.text, ok: res.ok };
  }
  return { ok: false, text: `unsupported loom tool: ${tool}` };
};
