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
import type { PlanDecision, SessionMode } from "@loom/core/types";

export interface ToolDispatchContext {
  mode: SessionMode;
  cwd: string;
  base?: string;
  /** Round-trip a question to the user; resolves with their answer text.
   *  Supplied by `CodexAppServerSession` for the `ask_user` tool — omitted
   *  (e.g. in a test-only dispatcher) means `ask_user` isn't available. */
  askUser?: (question: string, context: string | undefined) => Promise<string>;
  /** Present a plan for human review; resolves with their decision.
   *  Supplied by `CodexAppServerSession` for the `exit_plan` tool. */
  requestPlan?: (plan: string) => Promise<PlanDecision>;
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
 * own native approvals — Loom's own tool requests are a separate side
 * channel `respondToPermission` never touches, so Codex's own approvals
 * reviewer, even `auto_review`, can never approve one of these on its
 * behalf). Until a human actually approves it, "needs asking" means "deny",
 * not "silently run" — a temporary but safe stand-in outside `auto` mode,
 * not a silent gap. `ask_user`/`exit_plan` are exempt from this gate
 * entirely: both are read-only by name (`@loom/runtime/policy`'s
 * `READONLY_EXACT`), so `policy()` would always return "allow" for them
 * anyway — they just ask/present, they don't mutate anything.
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
  if (tool === "ask_user") {
    if (!ctx.askUser) return { ok: false, text: "ask_user is not available in this session" };
    const question = typeof args["question"] === "string" ? args["question"] : "";
    const context = typeof args["context"] === "string" ? args["context"] : undefined;
    const answer = await ctx.askUser(question, context);
    return { ok: true, text: answer };
  }
  if (tool === "exit_plan") {
    if (!ctx.requestPlan) return { ok: false, text: "exit_plan is not available in this session" };
    // Dynamic tools can't be unregistered mid-thread (no `dynamicTools` field
    // on `thread/resume`), so `exit_plan` stays mounted even after the
    // session leaves plan mode — gate its actual use here instead of at
    // mount time, matching how `commit`/`status` gate on `policy()` instead
    // of on whether they were ever mounted.
    if (ctx.mode !== "plan") {
      return {
        ok: false,
        text: "exit_plan is only usable in plan mode; the session is not currently in plan mode.",
      };
    }
    const plan = typeof args["plan"] === "string" ? args["plan"] : "";
    const decision = await ctx.requestPlan(plan);
    if (decision.action === "discuss") {
      return {
        ok: true,
        text:
          `The user is not ready to implement. Their note:\n\n${decision.message}\n\n` +
          "Stay in planning, address this, and call exit_plan again when ready.",
      };
    }
    if (decision.action === "handoff") {
      return { ok: true, text: "Plan approved. Implementation continues in a separate session." };
    }
    // implement / implement_fresh / revise — respondToPlan (app-server.ts)
    // re-drives the session (setMode + a follow-up send) after this returns.
    return { ok: true, text: "Plan approved. Implementing now." };
  }
  return { ok: false, text: `unsupported loom tool: ${tool}` };
};
