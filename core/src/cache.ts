/**
 * Prompt-cache arithmetic shared by every provider path. Anthropic reports the
 * per-TTL breakdown of a cache write the same way whether it arrives through
 * the Claude Agent SDK or through `@ai-sdk/anthropic`'s provider metadata, so
 * the reading of it lives here rather than in either adapter.
 */

/**
 * The `usage.cache_creation` object: how many tokens this request wrote into
 * each ephemeral bucket. Fields are optional and nullable — older providers
 * omit the object entirely.
 */
export interface CacheCreation {
  ephemeral_5m_input_tokens?: number | null;
  ephemeral_1h_input_tokens?: number | null;
}

/**
 * Which prompt-cache TTL a request wrote at, in minutes — 60, 5, or 0 when it
 * wrote no cache (or the provider doesn't report the split).
 *
 * A request may write both buckets at once (a long-lived breakpoint on the
 * stable prefix and a short one on the tail). A liveness countdown wants the
 * TTL governing most of what is cached, so the larger bucket wins; a tie goes
 * to the longer TTL, which is the half that outlives it.
 */
export const ephemeralTtlMinutes = (cc: CacheCreation | null | undefined): number => {
  if (!cc) return 0;
  const short = cc.ephemeral_5m_input_tokens ?? 0;
  const long = cc.ephemeral_1h_input_tokens ?? 0;
  if (long <= 0 && short <= 0) return 0;
  return long >= short ? 60 : 5;
};

/**
 * The share of prompt tokens served from cache, 0..1 — cache reads over every
 * prompt token billed. `null` when nothing has been spent yet, which is not
 * the same answer as a 0% hit rate.
 */
export const cacheHitRate = (u: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null => {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return prompt > 0 ? u.cacheRead / prompt : null;
};
