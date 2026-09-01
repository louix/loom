/**
 * `@loom/connector-generic` — any OpenAI-compatible endpoint (OpenAI, GLM,
 * DeepSeek, OpenRouter, vLLM, Ollama) and native Anthropic, on the shared
 * `@loom/aisdk` engine. Pulls only `@ai-sdk/openai-compatible` + `@ai-sdk/anthropic`;
 * Gemini lives in `@loom/connector-gemini`.
 */
import type { LanguageModel } from "ai";
import type { AgentProvider } from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { makeAisdkProvider } from "@loom/aisdk/provider";

/**
 * Build a `(modelId) => LanguageModel`, importing only the one `@ai-sdk/*` the
 * `sdk` needs — a daemon that never runs this connector never evaluates them.
 */
export const resolveModelFactory = async (
  sdk: "openai" | "anthropic",
  opts: { id: string; baseUrl: string; apiKey: string; includeUsage?: boolean },
): Promise<(modelId: string) => LanguageModel> => {
  const key = opts.apiKey ? { apiKey: opts.apiKey } : {};
  if (sdk === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const a = createAnthropic({ ...key, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
    return (id) => a(id);
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  // `includeUsage` asks the endpoint for `stream_options.include_usage` —
  // without it many endpoints (sference among them) stream no token usage and
  // Loom's context meter / cost stay at zero. Opt out per provider with
  // `include_usage = false` for an endpoint that rejects the field.
  const p = createOpenAICompatible({
    name: opts.id,
    baseURL: opts.baseUrl,
    includeUsage: opts.includeUsage !== false,
    ...key,
  });
  return (id) => p(id);
};

export const createProvider = async (ctx: ConnectorContext): Promise<AgentProvider> => {
  if (!ctx.transcript)
    throw new Error(`connector "${ctx.id}": an aisdk connector needs a transcript store`);
  const { config } = ctx;
  const sdk = config.sdk === "anthropic" ? "anthropic" : "openai";
  const makeModel = await resolveModelFactory(sdk, {
    id: ctx.id,
    baseUrl: config.baseUrl ?? "",
    apiKey: config.apiKey ?? "",
    ...(config.includeUsage !== undefined ? { includeUsage: config.includeUsage } : {}),
  });
  return makeAisdkProvider(
    {
      id: ctx.id,
      model: config.model ?? "",
      models: config.models ?? [],
      ...(config.modelContext ? { modelContext: config.modelContext } : {}),
      ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
      makeModel,
      ...(ctx.search ? { search: ctx.search } : {}),
      ...(ctx.baseBranch ? { base: ctx.baseBranch } : {}),
    },
    ctx.transcript,
  );
};
