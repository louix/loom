import { z } from "zod";
import { harnessEventSchema } from "./events.ts";
import { historyCursorSchema, helloParamsSchema } from "./wire.ts";
import { sessionModeSchema, planDecisionSchema, permissionDecisionSchema } from "./types.ts";
import { sessionStateSchema } from "./session-state.ts";

const text = z.string().min(1);
const optionalText = z.string().optional();
const by = optionalText;
const session = z.object({ id: text, by });
const empty = z.object({});
const mode = z
  .union([sessionModeSchema, z.literal("manual")])
  .transform((v) => (v === "manual" ? ("default" as const) : v));
const implementMode = mode.refine((v): boolean => v !== "plan");
const status = z.enum(sessionStateSchema.options.map((s) => s.shape.kind.value));
const planFields = z.object({
  id: text,
  requestId: text,
  by,
  mode: implementMode.optional(),
  provider: optionalText,
  model: optionalText,
  effort: optionalText,
  plan: optionalText,
});
// Normalize the public mode alias before applying the shared action union.
const plan = planFields
  .passthrough()
  .pipe(planDecisionSchema.and(planFields.extend({ mode: sessionModeSchema.optional() })))
  .superRefine((p, ctx) => {
    if (p.action === "handoff")
      ctx.addIssue({ code: "custom", path: ["action"], message: "invalid action" });
    if (p.action === "revise" && !p.plan.trim())
      ctx.addIssue({ code: "custom", path: ["plan"], message: "empty plan" });
    if (p.action === "discuss" && !p.message.trim())
      ctx.addIssue({ code: "custom", path: ["message"], message: "empty message" });
  });

/** Public RPC input contracts. Domain checks (busy, capabilities, ownership) stay in handlers. */
export const rpcParamsSchemas = {
  hello: helloParamsSchema.partial(),
  "tui.focus": z.object({ focused: z.boolean().nullable() }),
  ping: z.object({ nonce: z.unknown().optional() }),
  "daemon.status": empty,
  "daemon.shutdown": empty,
  "pricing.reload": empty,
  "providers.list": empty,
  "providers.probeModels": session,
  "config.check": empty,
  "daemon.relinkProvider": z.object({ from: text, to: text }),
  "daemon.doctor": empty,
  "session.list": empty,
  "session.get": session,
  "session.openShell": session,
  "session.closeShell": z.object({ token: text }),
  "session.history": session,
  "stats.models": z.object({ id: optionalText }),
  "session.messages": session,
  "session.events": session.extend({
    limit: z
      .number()
      .catch(500)
      .transform((n) => Math.min(5000, Math.max(1, Math.trunc(n)))),
    cursor: historyCursorSchema.nullish(),
  }),
  "session.search": z.object({ query: text }),
  "session.create": z.object({
    prompt: z.string().trim().min(1),
    provider: optionalText,
    model: optionalText,
    effort: optionalText,
    parentId: optionalText,
    mode: mode.optional().catch(undefined),
    worktree: z.boolean().optional(),
    isolation: z.enum(["vm", "local"]).optional(),
    by,
  }),
  "session.resume": session,
  "session.send": session.extend({ text }),
  "session.checkpoints": session,
  "session.rewind": session.extend({
    toTurn: z.coerce.number().int().nonnegative(),
    restoreWorktree: z.boolean().optional(),
  }),
  "session.fork": session.extend({
    provider: optionalText,
    prompt: optionalText,
    isolation: z.enum(["vm", "local"]).optional(),
  }),
  "session.interrupt": session,
  "session.compact": session.extend({ instructions: optionalText }),
  "session.rebase": session,
  "session.setKeepWarm": session.extend({ on: z.boolean().optional() }),
  "session.respondPermission": session.extend({
    requestId: text,
    decision: z.enum(permissionDecisionSchema.options.map((s) => s.shape.behavior.value)),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    message: optionalText,
  }),
  "session.respondPlan": plan,
  "session.answer": session.extend({ requestId: text, text }),
  "session.setMode": session.extend({ mode }),
  "session.setModel": session.extend({ model: text }),
  "session.setEffort": session.extend({ effort: text }),
  "session.setProvider": session.extend({
    provider: text,
    model: optionalText,
    effort: optionalText,
  }),
  "session.setTitle": session.extend({
    title: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.slice(0, 200)),
  }),
  "session.setComment": session.extend({ comment: optionalText.nullable() }),
  "session.markDone": session.extend({ force: z.boolean().optional() }),
  "session.remove": session.extend({
    force: z.boolean().optional(),
    deleteBranch: z.boolean().optional(),
  }),
  "session.gc": z.object({ id: optionalText, force: z.boolean().optional() }),
  "session.createStub": z.object({
    prompt: optionalText,
    provider: optionalText,
    model: optionalText,
    mode: optionalText,
    parentId: optionalText,
    status: status.optional().catch(undefined),
    reason: optionalText,
  }),
  "session.setStatus": session.extend({ status, reason: optionalText }),
  "dev.emit": z.object({
    event: z.preprocess(
      (v) => ({ ...(v && typeof v === "object" ? v : {}), ts: 0 }),
      harnessEventSchema,
    ),
  }),
};
export type RpcMethod = keyof typeof rpcParamsSchemas;
export type RpcParams<M extends string> = M extends RpcMethod
  ? z.output<(typeof rpcParamsSchemas)[M]>
  : unknown;

/** Curated diagnostics contain no caller values or raw Zod issues. */
export const rpcParamsError = (method: string, error: z.ZodError): string => {
  const field = error.issues[0]?.path[0];
  if (method === "session.create" && field === "prompt") return "prompt is required";
  if (method === "session.events" && field === "cursor")
    return "cursor must be the { olderThan } object from an earlier page's olderCursor";
  if (field === "mode")
    return "mode must be one of manual|default|plan|acceptEdits|auto (implementation cannot use plan)";
  if (method === "session.rewind" && field === "toTurn")
    return "toTurn must be 0..the last completed turn";
  if (method === "session.respondPlan") {
    if (field === "plan") return "revise needs a non-empty plan";
    if (field === "message") return "discuss needs a message";
    return "action must be implement | implement_fresh | revise | discuss";
  }
  return `invalid parameters for ${method}`;
};
