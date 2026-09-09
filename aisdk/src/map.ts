/**
 * Translate the Vercel AI SDK's `fullStream` parts into Loom's `HarnessEvent`
 * union. Streaming text / reasoning deltas are buffered per block id and
 * flushed as one event when the block ends, matching the block granularity the
 * Claude adapter emits (rather than one event per token).
 */
import type { LanguageModelUsage, ProviderMetadata, TextStreamPart, ToolSet } from "ai";
import type { HarnessEvent } from "@loom/core/events";
import { contextLimitFor } from "@loom/core/tokens";
import { ephemeralTtlMinutes, type CacheCreation } from "@loom/core/cache";

type Part = TextStreamPart<ToolSet>;

export class AisdkEventMapper {
  readonly #sessionId: string;
  #model: string | null;
  readonly #limitFor: (model: string | null) => number;
  readonly #text = new Map<string, string>();
  readonly #reasoning = new Map<string, string>();
  /** Last prompt-token count a provider actually reported, so a step with no
   *  usage data doesn't flap the context meter to zero. */
  #lastContextUsed = 0;

  constructor(
    sessionId: string,
    model: string | null,
    /** Context-limit resolver — sessions pass one that consults endpoint-reported
     *  / pinned sizes; the default is the built-in prefix table. */
    limitFor: (model: string | null) => number = (m) => contextLimitFor(m),
  ) {
    this.#sessionId = sessionId;
    this.#model = model;
    this.#limitFor = limitFor;
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
        return text.trim() === ""
          ? []
          : [{ type: "assistant_text", sessionId: this.#sessionId, ts, text }];
      }
      case "reasoning-delta":
        this.#reasoning.set(part.id, (this.#reasoning.get(part.id) ?? "") + part.text);
        return [];
      case "reasoning-end": {
        const text = this.#reasoning.get(part.id) ?? "";
        this.#reasoning.delete(part.id);
        return text.trim() === ""
          ? []
          : [{ type: "thinking", sessionId: this.#sessionId, ts, text }];
      }
      case "tool-call":
        // Flush any text / reasoning still buffered so it lands *before* the
        // tool call (and before the permission_request the call may raise) —
        // some providers don't send a clean text-end / reasoning-end first.
        return [
          ...this.#flushOpenBlocks(ts),
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
        // A step boundary closes any block the provider left open.
        return [
          ...this.#flushOpenBlocks(ts),
          ...chatgptRateLimits(part.providerMetadata, this.#sessionId, ts),
          this.#usage(part.usage, part.providerMetadata),
        ];
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
        // file, raw — nothing Loom needs. (abort / finish are handled above.)
        return [];
    }
  }

  /** Public shim so callers outside the main turn (e.g. the summariser) can
   *  meter a step's usage the same way. */
  mapUsage(u: LanguageModelUsage, meta?: ProviderMetadata): HarnessEvent[] {
    return [this.#usage(u, meta)];
  }

  #flushOpenBlocks(ts: number): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    // Reasoning first: within a step a model reasons, then answers. When the
    // provider omits the `*-end` parts (flush at `tool-call` / `finish`), this
    // is the only place that order can be restored — flushing text first made
    // the answer render above the thinking that produced it.
    for (const [, text] of this.#reasoning) {
      if (text.trim() !== "") out.push({ type: "thinking", sessionId: this.#sessionId, ts, text });
    }
    for (const [, text] of this.#text) {
      if (text.trim() !== "")
        out.push({ type: "assistant_text", sessionId: this.#sessionId, ts, text });
    }
    this.#text.clear();
    this.#reasoning.clear();
    return out;
  }

  #usage(u: LanguageModelUsage, meta?: ProviderMetadata): HarnessEvent {
    const details = u.inputTokenDetails;
    const cacheRead = details.cacheReadTokens ?? 0;
    const output = u.outputTokens ?? 0;
    // The two conventions are the SDK's problem now. Through v5 this had to
    // guess: OpenAI's `prompt_tokens` counts cached reads inside the prompt
    // total, Anthropic's `input_tokens` is the *uncached remainder*, and the
    // provider passed its own straight through. v7 normalizes both —
    // `inputTokens` is always the whole prompt and `inputTokenDetails` splits
    // it — so we read the split, and only fall back to arithmetic when a
    // provider reports the total without saying how much of it was cached.
    const cacheWrite = details.cacheWriteTokens ?? 0;
    const input =
      details.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
    const prompt = input + cacheRead + cacheWrite;
    // Several OpenAI-compatible endpoints omit usage on streamed responses.
    // Report the last real prompt-token count for `contextUsed` rather than 0,
    // so the meter holds steady instead of flapping after each such step.
    const hasData = prompt > 0;
    if (hasData) this.#lastContextUsed = prompt;
    const cacheCreation = anthropicCacheCreation(meta);
    const ttlMinutes = ephemeralTtlMinutes(cacheCreation);
    return {
      type: "usage",
      sessionId: this.#sessionId,
      ts: Date.now(),
      // Loom keeps cached reads and writes out of `input`; they are billed at
      // their own rates and `costOf` prices the three separately.
      tokens: { input, output, cacheRead, cacheWrite },
      contextUsed: hasData ? prompt : this.#lastContextUsed,
      contextLimit: this.#limitFor(this.#model),
      ...(ttlMinutes > 0 && cacheCreation ? { cacheTtlMinutes: ttlMinutes, cacheCreation } : {}),
    };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null && !Array.isArray(v);
};

const numOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * How long a step's cache write lives, in minutes, dug out of its provider
 * metadata. `LanguageModelUsage` reports the write itself under
 * `inputTokenDetails.cacheWriteTokens`, but says nothing about which ephemeral
 * bucket it landed in — a 1h write is billed at twice a 5m one, so the meter
 * cannot price a turn without it. Only Anthropic reports the split, in the raw
 * `usage` block it passes through untouched. `0` for every other vendor, and
 * for an Anthropic turn that wrote nothing.
 */
const anthropicCacheCreation = (meta: ProviderMetadata | undefined): CacheCreation | undefined => {
  const a = meta?.["anthropic"];
  // Structural, not by name: the key is the provider id, and an
  // OpenAI-compatible profile can legitimately be called "anthropic"
  // (`[providers.anthropic] adapter = "aisdk"` with no `sdk`) — reading its
  // metadata as Anthropic's would attach a TTL to a step that has none. The
  // `cache_creation` split inside the raw usage is what nobody else emits.
  const cc = isObj(a) && isObj(a["usage"]) ? a["usage"]["cache_creation"] : undefined;
  if (!isObj(cc)) return undefined;
  return {
    ephemeral_5m_input_tokens: Math.max(0, numOf(cc["ephemeral_5m_input_tokens"])),
    ephemeral_1h_input_tokens: Math.max(0, numOf(cc["ephemeral_1h_input_tokens"])),
  };
};

/** Subscription-window readings sent by the vendored ChatGPT provider. */
const chatgptRateLimits = (
  meta: ProviderMetadata | undefined,
  sessionId: string,
  ts: number,
): HarnessEvent[] => {
  const chatgpt = meta?.["chatgpt"];
  if (!isObj(chatgpt) || !isObj(chatgpt["rateLimits"])) return [];
  const out: HarnessEvent[] = [];
  for (const [window, value] of Object.entries(chatgpt["rateLimits"])) {
    if (!isObj(value)) continue;
    const utilization = numOf(value["utilization"]);
    const status = value["status"];
    if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") continue;
    const resetsAt = numOf(value["resetsAt"]);
    out.push({
      type: "rate_limit",
      sessionId,
      ts,
      window,
      status,
      utilization,
      ...(resetsAt > 0 ? { resetsAt } : {}),
    });
  }
  return out;
};
const errorText = (err: unknown): string => {
  if (err instanceof Error) {
    // An `APICallError`'s message is often just the HTTP status text ("Bad
    // Request"); the status code and the raw response body ride alongside it.
    // Append both so a provider 400 isn't reported with no further details.
    const api = err as Error & { statusCode?: unknown; responseBody?: unknown };
    const parts: string[] = [];
    if (typeof api.statusCode === "number") parts.push(`HTTP ${api.statusCode}`);
    const body = typeof api.responseBody === "string" ? api.responseBody.trim() : "";
    if (body !== "") parts.push(body.length > 512 ? `${body.slice(0, 512)}…` : body);
    return parts.length > 0 ? `${err.message} (${parts.join(": ")})` : err.message;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};
