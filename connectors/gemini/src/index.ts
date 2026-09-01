/**
 * `@loom/connector-gemini` — Google Gemini on the shared `@loom/aisdk` engine.
 * Separate from `@loom/connector-generic` because `@ai-sdk/google` carries the
 * heaviest dependency tree of the `@ai-sdk/*` backends.
 */
import type { LanguageModel } from "ai";
import type { AgentProvider } from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { makeAisdkProvider } from "@loom/aisdk/provider";

export const resolveModelFactory = async (opts: {
  baseUrl: string;
  apiKey: string;
}): Promise<(modelId: string) => LanguageModel> => {
  const key = opts.apiKey ? { apiKey: opts.apiKey } : {};
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const g = createGoogleGenerativeAI({
    ...key,
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  });
  return (id) => g(id);
};

export const createProvider = async (ctx: ConnectorContext): Promise<AgentProvider> => {
  if (!ctx.transcript)
    throw new Error(`connector "${ctx.id}": an aisdk connector needs a transcript store`);
  const { config } = ctx;
  const makeModel = await resolveModelFactory({
    baseUrl: config.baseUrl ?? "",
    apiKey: config.apiKey ?? "",
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
    },
    ctx.transcript,
  );
};
