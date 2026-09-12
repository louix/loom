import { z } from "zod";
import { opaqueSchema } from "./schema.ts";
/**
 * What a blocked turn is waiting on, as one closed union (design spec §4's
 * companion to {@link SessionState}). Each variant carries its request id *and*
 * everything a client needs to render the prompt and answer it — so a client
 * that has downloaded no transcript at all can still act on an outstanding
 * request straight off a session snapshot.
 *
 * The `kind` strings are exactly the {@link AwaitReason} values, so
 * `awaiting_input`'s payload is *derived* from the request set rather than
 * tracked beside it.
 */
import { absurd } from "./absurd.ts";
import type { HarnessEvent } from "./events.ts";

/** A tool call gated on approve/deny. */
export const permissionInteractionSchema = z.object({
  kind: z.literal("permission"),
  id: z.string(),
  tool: z.string(),
  input: opaqueSchema,
  /** Adapter-supplied alternatives (Claude's `suggestions`), passed through verbatim. */
  suggestions: opaqueSchema.optional(),
  /** When the request was raised (epoch ms). */
  at: z.number(),
});
export type PermissionInteraction = z.infer<typeof permissionInteractionSchema>;

/**
 * The SDK's own `AskUserQuestion` tool — a multiple-choice prompt rather than a
 * yes/no gate. It *is* a permission request underneath (it resolves through
 * `respondToPermission`), so it keeps the tool call's `input`; the questions are
 * parsed out of it for display.
 */
export const userQuestionInteractionSchema = z.object({
  kind: z.literal("user_question"),
  id: z.string(),
  tool: z.string(),
  input: opaqueSchema,
  at: z.number(),
});
export type UserQuestionInteraction = z.infer<typeof userQuestionInteractionSchema>;

/** Loom's own `ask_user` tool — a free-text answer. */
export const questionInteractionSchema = z.object({
  kind: z.literal("question"),
  id: z.string(),
  question: z.string(),
  /** Background the agent supplied with the question. */
  context: z.string().optional(),
  at: z.number(),
});
export type QuestionInteraction = z.infer<typeof questionInteractionSchema>;

/** An `ExitPlanMode` plan awaiting a human decision. */
export const planReviewInteractionSchema = z.object({
  kind: z.literal("plan_review"),
  id: z.string(),
  plan: z.string(),
  at: z.number(),
});
export type PlanReviewInteraction = z.infer<typeof planReviewInteractionSchema>;

export const sessionInteractionSchema = z.discriminatedUnion("kind", [
  permissionInteractionSchema,
  userQuestionInteractionSchema,
  questionInteractionSchema,
  planReviewInteractionSchema,
]);
export type SessionInteraction = z.infer<typeof sessionInteractionSchema>;

interface FoldInteraction<B> {
  readonly onPermission: (i: PermissionInteraction) => B;
  readonly onUserQuestion: (i: UserQuestionInteraction) => B;
  readonly onQuestion: (i: QuestionInteraction) => B;
  readonly onPlanReview: (i: PlanReviewInteraction) => B;
}

export const foldInteraction =
  <B>(fns: FoldInteraction<B>) =>
  (i: SessionInteraction): B => {
    switch (i.kind) {
      case "permission":
        return fns.onPermission(i);
      case "user_question":
        return fns.onUserQuestion(i);
      case "question":
        return fns.onQuestion(i);
      case "plan_review":
        return fns.onPlanReview(i);
      default:
        return absurd(i);
    }
  };

/**
 * The interaction an adapter event raises, or null when the event doesn't block
 * the turn. The single place the "`AskUserQuestion` is a multiple-choice prompt,
 * not a gate" rule is encoded — both the request set and `deriveStatus` read it
 * from here.
 */
export const interactionFor = (ev: HarnessEvent): SessionInteraction | null => {
  switch (ev.type) {
    case "permission_request":
      return ev.tool === "AskUserQuestion"
        ? { kind: "user_question", id: ev.id, tool: ev.tool, input: ev.input, at: ev.ts }
        : {
            kind: "permission",
            id: ev.id,
            tool: ev.tool,
            input: ev.input,
            ...(ev.suggestions !== undefined ? { suggestions: ev.suggestions } : {}),
            at: ev.ts,
          };
    case "question":
      return {
        kind: "question",
        id: ev.id,
        question: ev.question,
        ...(ev.context !== undefined ? { context: ev.context } : {}),
        at: ev.ts,
      };
    case "plan_review":
      return { kind: "plan_review", id: ev.id, plan: ev.plan, at: ev.ts };
    default:
      return null;
  }
};
