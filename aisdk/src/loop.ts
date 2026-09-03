/**
 * One turn against an OpenAI-compatible model: run `streamText`, translate the
 * stream, and capture the assistant/tool messages the turn produced so the
 * caller can persist them. Loop *policy* (how many steps, which tools, mode
 * gating) is the caller's.
 *
 * Mid-turn injection: `drainInjections` is polled before every step. Anything
 * it returns is spliced into that step's messages right after the current tool
 * result and persisted via `appendMessages`. The AI SDK discards a
 * `prepareStep` message override after the step runs, so the splice is
 * re-applied on each later step from `appliedInjections`.
 */
import { type LanguageModel, type ModelMessage, type ToolSet, stepCountIs, streamText } from "ai";
import type { HarnessEvent } from "@loom/core/events";
import type { AisdkEventMapper } from "./map.ts";
import { repairMalformedToolInputs } from "./transcript.ts";

/**
 * Vendor-options bag for a model request — structurally the SDK's
 * `ProviderOptions` (`ai` declares but doesn't re-export it): provider name →
 * options, e.g. `{ [name]: { reasoningEffort } }` on openai-compatible, which
 * becomes the `reasoning_effort` request-body field.
 */
export type VendorOptions = Record<string, Record<string, string>>;

export interface TurnHooks {
  emit(ev: HarnessEvent): void;
  /** Response messages (assistant text, tool calls/results) to append + persist. */
  appendMessages(msgs: ModelMessage[]): void;
}

export interface TurnArgs {
  sessionId: string;
  model: LanguageModel;
  system: string | undefined;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps: number;
  abortSignal: AbortSignal;
  mapper: AisdkEventMapper;
  /** Vendor options for the request — e.g. `{ [name]: { reasoningEffort } }`
   *  on openai-compatible, which becomes the `reasoning_effort` body field. */
  providerOptions?: VendorOptions;
  hooks: TurnHooks;
  /**
   * Polled before each step (after the previous step's tool results are in).
   * Return user messages to inject mid-turn, or `[]` for none. The messages are
   * persisted immediately, in order, via `hooks.appendMessages`.
   */
  drainInjections?: () => ModelMessage[];
  /**
   * Evaluated after each step as an extra stop condition. Return true when the
   * transcript has grown close to the model's context window so the segment
   * ends and the caller can compact before the next one — otherwise a long
   * segment of big tool reads 400s on context length mid-turn (A9).
   */
  shouldStopForContext?: () => boolean;
  /**
   * Evaluated after each step as a final stop condition. Return true to end
   * the segment at once — e.g. the session ends the exploration turn the
   * moment a plan review approves, so the follow-up turn can re-read the mode
   * and rebuild the tool set (a mid-flight swap is impossible).
   */
  shouldStop?: () => boolean;
}

export interface TurnResult {
  aborted: boolean;
  errored: boolean;
  /**
   * The stream ended with the last step still finishing on `tool-calls` — i.e.
   * the model wanted to keep going and only `stopWhen: stepCountIs(maxSteps)`
   * halted it. The caller decides whether to continue the turn with a fresh
   * step budget. Always `false` when `aborted` or `errored`.
   */
  hitStepLimit: boolean;
  /**
   * The segment was stopped early by `shouldStopForContext` — the caller should
   * compact, then continue the turn. Always `false` when `aborted` / `errored`.
   */
  hitContextLimit: boolean;
  /**
   * The segment was ended by the `shouldStop` hook rather than the model
   * finishing, the step ceiling, or the context guard. Always `false` when
   * `aborted` / `errored`.
   */
  stoppedEarly: boolean;
}

export const runTurn = async (args: TurnArgs): Promise<TurnResult> => {
  const { sessionId, model, system, messages, mapper, hooks } = args;
  let aborted = false;
  let errored = false;
  // The mapper already emits a fatal `error` event for a stream `error` part;
  // track that so the outer catch doesn't emit a second one if the iterator
  // then also throws.
  let sawErrorPart = false;
  // Finish reason of the last completed step. `tool-calls` when the stream ends
  // means the loop was cut by `stopWhen`, not by the model deciding it was done.
  let lastStepReason: string | undefined;

  // Generated messages already handed to the store. `onStepFinish` reports the
  // running total, so we persist the fresh tail each step — which also keeps
  // injected user messages (appended between steps) in the right order.
  let persistedGen = 0;
  // Messages this turn started from, before any generation. Captured on the
  // first `prepareStep` so injections can be spliced at a stable offset.
  let baseCount = -1;
  const applied: Array<{ afterGen: number; msg: ModelMessage }> = [];

  const genCount = (steps: ReadonlyArray<{ response: { messages: unknown[] } }>): number =>
    steps.length > 0 ? (steps[steps.length - 1]?.response.messages.length ?? 0) : 0;

  // Set by the `shouldStopForContext` stop condition so the caller can tell a
  // context-driven segment end from the model finishing / the step ceiling.
  let stoppedForContext = false;
  const stopForContext = args.shouldStopForContext;
  // Set by the `shouldStop` stop condition — a caller-requested early end
  // (plan approval) that is neither a step-ceiling nor a context stop.
  let stoppedEarly = false;
  const stopEarly = args.shouldStop;

  try {
    const res = streamText({
      model,
      ...(args.providerOptions ? { providerOptions: args.providerOptions } : {}),
      ...(system ? { system } : {}),
      // A model can poison its own transcript with unparseable tool-call
      // arguments (sference/GLM-5.3 400s the prompt from then on); every
      // request rebuilds from the transcript, so scrub it here.
      messages: repairMalformedToolInputs([...messages]),
      ...(args.tools ? { tools: args.tools } : {}),
      stopWhen: [
        stepCountIs(args.maxSteps),
        () => {
          if (stopForContext?.()) stoppedForContext = true;
          if (stopEarly?.()) stoppedEarly = true;
          return stoppedForContext || stoppedEarly;
        },
      ],
      abortSignal: args.abortSignal,
      ...(args.drainInjections
        ? {
            prepareStep: ({ steps, messages: stepMessages }) => {
              const gen = genCount(steps);
              if (baseCount < 0) baseCount = stepMessages.length - gen;

              if (steps.length > 0) {
                const fresh = args.drainInjections?.() ?? [];
                for (const msg of fresh) applied.push({ afterGen: gen, msg });
                if (fresh.length > 0) hooks.appendMessages(fresh);
              }

              if (applied.length === 0) return undefined;
              const rebuilt = [...stepMessages];
              let offset = 0;
              for (const { afterGen, msg } of applied) {
                rebuilt.splice(baseCount + afterGen + offset, 0, msg);
                offset += 1;
              }
              return { messages: rebuilt };
            },
          }
        : {}),
      onStepFinish: ({ response }) => {
        const all = response.messages as ModelMessage[];
        if (all.length > persistedGen) {
          hooks.appendMessages(all.slice(persistedGen));
          persistedGen = all.length;
        }
      },
    });

    for await (const part of res.fullStream) {
      if (part.type === "finish-step") {
        const r = (part as { finishReason?: string }).finishReason;
        if (r) lastStepReason = r;
      }
      // Let the mapper see `abort` / `error` too — it flushes any half-streamed
      // assistant text into the feed (and, for `error`, emits the fatal event)
      // before we stop.
      for (const ev of mapper.map(part)) hooks.emit(ev);
      if (part.type === "abort") {
        aborted = true;
        break;
      }
      // A4: stop reading on a stream error, mirroring `abort`. Consuming the
      // rest of the stream would leave a tool parked in the permission gate
      // (its `execute` still awaiting) with nothing to release it → wedged turn.
      if (part.type === "error") {
        errored = true;
        sawErrorPart = true;
        break;
      }
    }

    if (aborted || errored) {
      return {
        aborted,
        errored,
        hitStepLimit: false,
        hitContextLimit: false,
        stoppedEarly: false,
      };
    }

    try {
      // Surface a late failure the stream didn't already report; messages were
      // persisted incrementally in `onStepFinish`.
      await res.response;
    } catch {
      errored = true;
    }
  } catch (err) {
    errored = true;
    if (!sawErrorPart) {
      hooks.emit({
        type: "error",
        sessionId,
        ts: Date.now(),
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      });
    }
  }

  const hitContextLimit = !aborted && !errored && stoppedForContext;
  const hitStepLimit =
    !aborted && !errored && !hitContextLimit && !stoppedEarly && lastStepReason === "tool-calls";
  return { aborted, errored, hitStepLimit, hitContextLimit, stoppedEarly };
};
