/**
 * Context-window bookkeeping for OpenAI-compatible sessions. There is no
 * per-model tokenizer here — a `chars / 4` estimate is enough to drive the
 * context meter and (in M10d) the compaction threshold. Exact billed token
 * counts still come from the provider's `usage` on every turn; this is only for
 * "how full is the window right now".
 */
/**
 * Just the shape {@link estimateTokens} reads. Kept local so `@loom/core` pulls
 * in no model-SDK — the aisdk connector passes its real `ModelMessage[]`, which
 * is structurally a superset of this.
 */
interface EstimableMessage {
  readonly role?: string;
  readonly content?: unknown;
}

/**
 * Known context limits, longest-prefix matched against the model id (so
 * `deepseek-chat`, `deepseek-chat-0824`, … all resolve). Extend freely.
 */
export const MODEL_CONTEXT: Array<[prefix: string, limit: number]> = [
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["gpt-oss", 128_000],
  ["o4", 200_000],
  ["o3", 200_000],
  ["claude", 200_000], // Sonnet / Opus / Haiku, default (non-beta) window
  ["deepseek", 128_000],
  ["glm-4.6", 200_000],
  ["glm-5", 200_000],
  ["glm", 128_000],
  ["qwen", 256_000],
  ["llama", 128_000],
  ["kimi", 256_000],
  ["moonshot", 256_000],
  ["minimax", 1_000_000],
  ["mistral", 128_000],
  ["gemini", 1_000_000], // 1.5 / 2.0 / 2.5 are all ≥ 1M
];

/**
 * Model ids often arrive as `vendor/model` (OpenRouter, llmbase). Match against
 * both the full id and the part after the last slash.
 */
const candidates = (model: string): string[] => {
  const lower = model.toLowerCase();
  const slash = lower.lastIndexOf("/");
  return slash === -1 ? [lower] : [lower, lower.slice(slash + 1)];
};

export const DEFAULT_CONTEXT_LIMIT = 128_000;

export const contextLimitFor = (model: string | null | undefined): number => {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  const names = candidates(model);
  for (const [prefix, limit] of MODEL_CONTEXT) {
    if (names.some((n) => n.startsWith(prefix) || n.includes(`/${prefix}`))) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
};

/** Rough token estimate for a message array (`chars / 4`, rounded up). */
export const estimateTokens = (messages: readonly EstimableMessage[]): number => {
  let chars = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === "string") {
      chars += c.length;
    } else if (c != null) {
      try {
        chars += JSON.stringify(c).length;
      } catch {
        chars += 0; // circular / unserializable — don't crash the turn over an estimate
      }
    }
  }
  return Math.ceil(chars / 4);
};
