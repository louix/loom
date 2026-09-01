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
  ["glm-5.3-flash", 1_048_576], // 2^20 — the flash tier ships the 1M window
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

/**
 * Exact-id context size from an override map (endpoint-reported `/models`
 * metadata, or a `model_context` config pin). Matched case-insensitively
 * against the full id and the part after the last slash — so a pin keyed
 * `glm-5.3-flash` covers an id like `zai-org/GLM-5.3-Flash`. `undefined` when
 * nothing is known: callers use this to distinguish "reported" from "guessed".
 */
export const knownContextLimit = (
  model: string | null | undefined,
  overrides: Readonly<Record<string, number>> | undefined,
): number | undefined => {
  if (!model || !overrides) return undefined;
  // Keys are matched case-insensitively — endpoint ids and hand-typed config
  // pins don't agree on case (e.g. `zai-org/GLM-5.3-Flash`).
  const byLower = new Map<string, number>();
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) byLower.set(k.toLowerCase(), v);
  }
  for (const n of candidates(model)) {
    const hit = byLower.get(n);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

export const contextLimitFor = (
  model: string | null | undefined,
  overrides?: Readonly<Record<string, number>>,
): number => {
  const known = knownContextLimit(model, overrides);
  if (known !== undefined) return known;
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  const names = candidates(model);
  // Separator-stripped pass first: `GLM5.3Flash` / `glm_5.3_flash` squash to
  // `glm53flash`, which the strict pass below would wrongly hand to the short
  // `glm` prefix. Same table order, so this stays at least as specific —
  // and it subsumes plain prefix matching.
  const squashed = names.map((n) => n.replace(/[^a-z0-9]/g, ""));
  for (const [prefix, limit] of MODEL_CONTEXT) {
    const p = prefix.replace(/[^a-z0-9]/g, "");
    if (p && squashed.some((n) => n.startsWith(p))) return limit;
  }
  // Strict pass — catches a mid-id `vendor/gpt-5/x` shape the after-slash
  // candidate and the squashed pass both miss.
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
