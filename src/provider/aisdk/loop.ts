/**
 * One turn against an OpenAI-compatible model: run `streamText`, translate the
 * stream, and capture the assistant/tool messages the turn produced so the
 * caller can persist them. Loop *policy* (how many steps, which tools, mode
 * gating) is the caller's; M10a runs a single tool-free step.
 */
import { type LanguageModel, type ModelMessage, type ToolSet, stepCountIs, streamText } from "ai";
import type { HarnessEvent } from "../../protocol/events.ts";
import type { AisdkEventMapper } from "./map.ts";

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
  hooks: TurnHooks;
}

export interface TurnResult {
  aborted: boolean;
  errored: boolean;
}

export async function runTurn(args: TurnArgs): Promise<TurnResult> {
  const { sessionId, model, system, messages, mapper, hooks } = args;
  let aborted = false;
  let errored = false;

  try {
    const res = streamText({
      model,
      ...(system ? { system } : {}),
      messages,
      ...(args.tools ? { tools: args.tools } : {}),
      stopWhen: stepCountIs(args.maxSteps),
      abortSignal: args.abortSignal,
    });

    for await (const part of res.fullStream) {
      if (part.type === "abort") {
        aborted = true;
        break;
      }
      if (part.type === "error") errored = true;
      for (const ev of mapper.map(part)) hooks.emit(ev);
    }

    if (aborted) return { aborted, errored };

    try {
      const response = await res.response;
      if (response.messages.length > 0) hooks.appendMessages(response.messages);
    } catch {
      // The stream already surfaced the failure as an `error` event.
      errored = true;
    }
  } catch (err) {
    errored = true;
    hooks.emit({
      type: "error",
      sessionId,
      ts: Date.now(),
      message: err instanceof Error ? err.message : String(err),
      fatal: true,
    });
  }

  return { aborted, errored };
}
