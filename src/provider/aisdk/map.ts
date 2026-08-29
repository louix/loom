/**
 * Translate the Vercel AI SDK's `fullStream` parts into Loom's `HarnessEvent`
 * union. Streaming text / reasoning deltas are buffered per block id and
 * flushed as one event when the block ends, matching the block granularity the
 * Claude adapter emits (rather than one event per token).
 */
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type { HarnessEvent } from "../../protocol/events.ts";
import { contextLimitFor } from "./tokens.ts";

type Part = TextStreamPart<ToolSet>;

export class AisdkEventMapper {
  readonly #sessionId: string;
  #model: string | null;
  readonly #text = new Map<string, string>();
  readonly #reasoning = new Map<string, string>();

  constructor(sessionId: string, model: string | null) {
    this.#sessionId = sessionId;
    this.#model = model;
  }

  setModel(model: string | null): void {
    this.#model = model;
  }

  map(part: Part): HarnessEvent[] {
    const ts = Date.now();
    switch (part.type) {
      case "text-delta":
        this.#text.set(part.id, (this.#text.get(part.id) ?? "") + part.text);
        return [];
      case "text-end": {
        const text = this.#text.get(part.id) ?? "";
        this.#text.delete(part.id);
        return text.trim() === "" ? [] : [{ type: "assistant_text", sessionId: this.#sessionId, ts, text }];
      }
      case "reasoning-delta":
        this.#reasoning.set(part.id, (this.#reasoning.get(part.id) ?? "") + part.text);
        return [];
      case "reasoning-end": {
        const text = this.#reasoning.get(part.id) ?? "";
        this.#reasoning.delete(part.id);
        return text.trim() === "" ? [] : [{ type: "thinking", sessionId: this.#sessionId, ts, text }];
      }
      case "tool-call":
        return [
          {
            type: "tool_call",
            sessionId: this.#sessionId,
            ts,
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          },
        ];
      case "tool-result":
        return [
          {
            type: "tool_result",
            sessionId: this.#sessionId,
            ts,
            id: part.toolCallId,
            ok: true,
            output: part.output,
          },
        ];
      case "tool-error":
        return [
          {
            type: "tool_result",
            sessionId: this.#sessionId,
            ts,
            id: part.toolCallId,
            ok: false,
            output: errorText(part.error),
          },
        ];
      case "finish-step":
        return [this.#usage(part.usage)];
      case "abort":
      case "finish":
        // Flush any block still open (an abort / a stream that ended without a
        // matching *-end) so partial assistant text isn't dropped from the feed.
        return this.#flushOpenBlocks(ts);
      case "error":
        return [
          {
            type: "error",
            sessionId: this.#sessionId,
            ts,
            message: errorText(part.error),
            fatal: true,
          },
        ];
      default:
        // start, start-step, text-start, reasoning-start, tool-input-*, source,
        // file, finish, abort, raw — nothing Loom needs.
        return [];
    }
  }

  /** Public shim so callers outside the main turn (e.g. the summariser) can
   *  meter a step's usage the same way. */
  mapUsage(u: LanguageModelUsage): HarnessEvent[] {
    return [this.#usage(u)];
  }

  #flushOpenBlocks(ts: number): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    for (const [, text] of this.#text) {
      if (text.trim() !== "") out.push({ type: "assistant_text", sessionId: this.#sessionId, ts, text });
    }
    for (const [, text] of this.#reasoning) {
      if (text.trim() !== "") out.push({ type: "thinking", sessionId: this.#sessionId, ts, text });
    }
    this.#text.clear();
    this.#reasoning.clear();
    return out;
  }

  #usage(u: LanguageModelUsage): HarnessEvent {
    const promptTokens = u.inputTokens ?? 0;
    const cached = u.cachedInputTokens ?? 0;
    return {
      type: "usage",
      sessionId: this.#sessionId,
      ts: Date.now(),
      tokens: {
        // Loom keeps cached reads out of `input`, like the Claude adapter.
        input: Math.max(0, promptTokens - cached),
        output: u.outputTokens ?? 0,
        cacheRead: cached,
        cacheWrite: 0,
      },
      contextUsed: promptTokens,
      contextLimit: contextLimitFor(this.#model),
    };
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
