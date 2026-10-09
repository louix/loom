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
import type { PermissionDecision, SessionMode } from "@loom/core/types";

export interface ToolDispatchContext {
  mode: SessionMode;
  cwd: string;
  base?: string;
  /** The admitting turn's abort signal — set once its turn ends (via
   *  `interrupt()`/`close()`), which can happen at any point during this
   *  dispatch's own execution, not just before it starts. A dispatcher
   *  should check it before running a mutation, and after any `await` that
   *  could span an interrupt (an approval/question/plan wait). Omitted only
   *  in contexts with no turn to track (e.g. a bare unit test). */
  signal?: AbortSignal;
  /** Round-trip a question to the user; resolves with their answer text.
   *  Supplied by `CodexAppServerSession` for the `ask_user` tool — omitted
   *  (e.g. in a test-only dispatcher) means `ask_user` isn't available. */
  askUser?: (question: string, context: string | undefined) => Promise<string>;
  /** Raise a real permission request and block on a human decision, for a
   *  mutating loom tool `policy()` won't auto-allow in the current mode.
   *  Supplied by `CodexAppServerSession`; omitted means there's no wait
   *  machinery available, so `policy() === "ask"` falls back to an outright
   *  deny (see `localToolDispatcher`'s `commit` branch). */
  requestApproval?: (tool: string, args: Record<string, unknown>) => Promise<PermissionDecision>;
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
 * `auto` mode for a non-readonly name like `commit`; every other mode
 * (including `plan`) raises a real `permission_request` via
 * `ctx.requestApproval` and blocks on a human decision — the same
 * pending-interaction machinery `ask_user` uses, not a different
 * path. Loom's own tool requests are a separate side channel Codex's own
 * approvals reviewer never touches, so `auto_review` can never approve one
 * of these on its behalf regardless of mode. Denial (explicit, or a
 * synthesized one from `interrupt()`/`close()` draining a still-pending
 * approval) returns before `commitInWorktree` ever runs — cancellation
 * always prevents execution, never races it. `ctx.requestApproval` being
 * absent (a caller that hasn't wired the wait machinery) falls back to an
 * outright deny with guidance, rather than hanging forever. `ask_user` is
 * exempt from this gate entirely: it is read-only by name
 * (`@loom/runtime/policy`'s `READONLY_EXACT`), so `policy()` would always
 * return "allow" for it anyway — it just asks, it doesn't mutate anything.
 * The mode is Loom's, not Codex's reviewer: in Plan with an Auto exit, a
 * `commit` still asks.
 *
 * Cancellation: checked once up front (an already-ended turn's dispatch
 * should never even start its own tool's work) and again immediately before
 * `commitInWorktree` — specifically *after* the `requestApproval` wait,
 * since that's the one `await` in this function that can span an
 * `interrupt()`. `ctx.signal` itself is what actually protects `ask_user`/
 * `requestApproval`'s own pending-interaction parking (see
 * `CodexAppServerSession#askUser` et al.) — the checks here are this
 * dispatcher's *own* responsibility for the one thing it alone controls:
 * not running the mutation after cancellation, even if some other check
 * were ever missing or a future dispatcher forgot to wire one.
 */
export const localToolDispatcher: ToolDispatcher = async (tool, args, ctx) => {
  if (ctx.signal?.aborted) {
    return { ok: false, text: "cancelled: the turn was interrupted before this tool ran" };
  }
  if (tool === "commit" && policy(ctx.mode, tool) !== "allow") {
    if (!ctx.requestApproval) {
      return {
        ok: false,
        text:
          `${tool} needs approval in ${ctx.mode} mode, which this session can't ask for — ` +
          "switch to auto mode to allow it, or ask the user to do it manually.",
      };
    }
    const decision = await ctx.requestApproval(tool, args);
    if (decision.behavior !== "allow") {
      return { ok: false, text: decision.message ?? `${tool} was denied.` };
    }
  }
  if (tool === "commit") {
    if (ctx.signal?.aborted) {
      return { ok: false, text: "cancelled: the turn was interrupted before the commit ran" };
    }
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
    // Registered only on threads created before Plan became Codex's native
    // collaboration mode — dynamic tools can't be withdrawn (no `dynamicTools`
    // on `thread/resume`). A native plan is reviewed once its turn ends.
    return {
      ok: false,
      text:
        "exit_plan is retired. In Plan mode, present the complete plan in a <proposed_plan> " +
        "block and end your turn; the user reviews it then.",
    };
  }
  return { ok: false, text: `unsupported loom tool: ${tool}` };
};
