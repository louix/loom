/** ChatGPT subscription connector, authenticated by Codex's ~/.codex/auth.json. */
import type { AgentProvider, DiscoveredModel } from "@loom/core/types";
import type { ConnectorContext } from "@loom/core/connector";
import { makeAisdkProvider } from "@loom/aisdk/provider";
import { createChatGPTModels } from "./oauth.ts";

export const createProvider = async (ctx: ConnectorContext): Promise<AgentProvider> => {
  if (!ctx.transcript)
    throw new Error(`connector ${JSON.stringify(ctx.id)} needs a transcript store`);
  const { catalog, makeModel } = createChatGPTModels({
    ...(ctx.config.authPath ? { authPath: ctx.config.authPath } : {}),
    ...(ctx.config.baseUrl ? { baseUrl: ctx.config.baseUrl } : {}),
  });
  const listModels = async (): Promise<DiscoveredModel[]> =>
    // Match Codex's picker: it has the full account catalog available for an
    // explicit model id, but offers only `visibility: list` models, ordered by
    // backend priority, as automatic choices.
    (await catalog.list())
      .filter((model) => model.visibility === "list")
      .sort(
        (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
      )
      .map((model) => ({
        id: model.slug,
        ...(model.display_name ? { label: model.display_name } : {}),
        // The Codex catalog's `context_window` is its conservative operating
        // default (272k today); `max_context_window` is the account/model cap.
        // Loom needs the latter for its context meter and compaction guard.
        ...((model.max_context_window ?? model.context_window)
          ? { context: model.max_context_window ?? model.context_window }
          : {}),
        ...(model.supported_reasoning_levels?.length
          ? {
              supportsEffort: true,
              effortLevels: model.supported_reasoning_levels
                .map((level) => level.effort)
                .filter((level): level is string => typeof level === "string"),
              ...(model.default_reasoning_level
                ? { defaultEffort: model.default_reasoning_level }
                : {}),
            }
          : {}),
      }));
  return makeAisdkProvider(
    {
      id: ctx.id,
      model: ctx.config.model ?? "",
      models: ctx.config.models ?? [],
      ...(ctx.config.modelContext ? { modelContext: ctx.config.modelContext } : {}),
      ...(ctx.config.maxSteps !== undefined ? { maxSteps: ctx.config.maxSteps } : {}),
      providerOptionsName: "chatgpt",
      makeModel,
      toolMode: async (model) =>
        (await catalog.get(model)).tool_mode === "code_mode_only" ? "codex-shell" : "full",
      subagents: true,
      listModels,
    },
    ctx.transcript,
  );
};
