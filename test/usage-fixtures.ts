import type { LanguageModelV3Usage } from "@ai-sdk/provider";
import type { LanguageModelUsage } from "ai";

/**
 * Token counts as a *provider* reports them on a v3 `finish` chunk. Through
 * AI SDK v5 this was four flat numbers; v3 of the provider spec splits the
 * prompt into its cached and uncached parts at the provider boundary, which is
 * what retired the vendor-convention guessing in `AisdkEventMapper`.
 *
 * `noCache` is the uncached remainder — pass the reads and writes separately
 * and `total` is summed for you, matching what every shipped provider does.
 */
export const streamUsage = (u: {
  noCache: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}): LanguageModelV3Usage => ({
  inputTokens: {
    total: u.noCache + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    noCache: u.noCache,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
  },
  outputTokens: {
    total: u.output,
    text: u.output - (u.reasoning ?? 0),
    reasoning: u.reasoning,
  },
});

/**
 * The same counts one layer up, as `streamText` hands them to the mapper on a
 * `finish-step` part: `inputTokens` is the whole prompt and the split lives
 * under `inputTokenDetails`.
 */
export const stepUsage = (u: {
  noCache: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}): LanguageModelUsage => {
  const input = u.noCache + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: u.noCache,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
    },
    outputTokens: u.output,
    outputTokenDetails: {
      textTokens: u.output - (u.reasoning ?? 0),
      reasoningTokens: u.reasoning,
    },
    totalTokens: input + u.output,
  };
};
