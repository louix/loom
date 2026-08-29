/**
 * Context-window bookkeeping for OpenAI-compatible sessions. There is no
 * per-model tokenizer here — a `chars / 4` estimate is enough to drive the
 * context meter and (in M10d) the compaction threshold. Exact billed token
 * counts still come from the provider's `usage` on every turn; this is only for
 * "how full is the window right now".
 */
import type { ModelMessage } from "ai";

/**
 * Known context limits, longest-prefix matched against the model id (so
 * `deepseek-chat`, `deepseek-chat-0824`, … all resolve). Extend freely.
 */
export const MODEL_CONTEXT: Array<[prefix: string, limit: number]> = [
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["o4", 200_000],
  ["o3", 200_000],
  ["deepseek-reasoner", 128_000],
  ["deepseek-chat", 128_000],
  ["glm-4.6", 200_000],
  ["glm-4.5", 128_000],
  ["glm-4", 128_000],
  ["qwen", 128_000],
  ["llama", 128_000],
  ["kimi", 128_000],
  ["moonshot", 128_000],
  ["mistral", 128_000],
  ["gemini-2", 1_000_000],
];

export const DEFAULT_CONTEXT_LIMIT = 128_000;

export function contextLimitFor(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  const m = model.toLowerCase();
  for (const [prefix, limit] of MODEL_CONTEXT) {
    if (m.startsWith(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/** Rough token estimate for a message array (`chars / 4`, rounded up). */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}
