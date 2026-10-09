/**
 * One provider's model catalogue: the stable model ids a session can be given,
 * with what every selector shows for them. The id is what a session stores and
 * what the provider is sent; the label, description, efforts and defaults are
 * presentation and validation that may change from one discovery to the next
 * without touching any session. Every picker reads these rows — none keeps
 * naming rules of its own.
 */
import { z } from "zod";
import type { DiscoveredModel } from "./types.ts";

/** Bounds a discovery result is held to before it reaches a cache or a client. */
export const MODEL_CATALOGUE_LIMIT = 256;

/** One row in the model picker — a canonical id plus display trimmings. */
export const modelChoiceSchema = z.object({
  id: z.string(),
  /** Friendly name; falls back to `id` when the provider gives none. */
  label: z.string(),
  /** The provider's one-line description of the model, when it gives one. */
  description: z.string().optional(),
  /** Context-window size in tokens, when the provider reports it. */
  context: z.number().optional(),
  /** Whether this model accepts a thinking-effort level. */
  supportsEffort: z.boolean().optional(),
  /** The effort levels it accepts, when the provider enumerates them.
   *  Endpoint-advertised lists pass through verbatim — they may name levels
   *  outside Loom's own effort-level union (OpenAI's `minimal`, …). */
  effortLevels: z.array(z.string()).optional(),
  /** The effort the provider defaults to for this model, when advertised —
   *  the picker marks it, and a session created without a choice sends it. */
  defaultEffort: z.string().optional(),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

export const modelCatalogueSchema = z.object({
  models: z
    .array(modelChoiceSchema)
    .max(MODEL_CATALOGUE_LIMIT)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, {
      message: "duplicate model id",
    }),
  /** The model the provider itself marks as its default, when it names one. */
  defaultModel: z.string().optional(),
});
export type ModelCatalogue = z.infer<typeof modelCatalogueSchema>;

/** The levels offered when a model supports effort but doesn't enumerate
 *  which ones — Claude's full set. */
export const DEFAULT_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The effort levels a catalogue row accepts; empty when it takes none. */
export const modelEfforts = (row: ModelChoice | undefined): readonly string[] => {
  if (row?.effortLevels?.length) return row.effortLevels;
  return row?.supportsEffort ? DEFAULT_EFFORT_LEVELS : [];
};

/** Control characters never belong in a label a terminal draws. */
const printable = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined;
  // oxlint-disable-next-line no-control-regex -- Labels are drawn on a terminal.
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean === "" ? undefined : clean.slice(0, max);
};

/**
 * Normalize what a provider's discovery returned into a catalogue: ids are
 * kept verbatim and deduplicated (first wins), a missing label falls back to
 * the id, and the list is held to {@link MODEL_CATALOGUE_LIMIT} rows.
 */
export const catalogueFromDiscovered = (rows: readonly DiscoveredModel[]): ModelCatalogue => {
  const seen = new Set<string>();
  const models: ModelChoice[] = [];
  let defaultModel: string | undefined;
  for (const row of rows) {
    if (!row.id || seen.has(row.id) || models.length >= MODEL_CATALOGUE_LIMIT) continue;
    seen.add(row.id);
    const description = printable(row.description, 2048);
    const efforts = row.effortLevels?.filter((e) => e !== "").slice(0, 32) ?? [];
    models.push({
      id: row.id,
      label: printable(row.label, 256) ?? row.id,
      ...(description ? { description } : {}),
      ...(row.context ? { context: row.context } : {}),
      ...(row.supportsEffort || efforts.length > 0 ? { supportsEffort: true } : {}),
      ...(efforts.length > 0 ? { effortLevels: efforts } : {}),
      ...(row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
    });
    if (row.isDefault && defaultModel === undefined) defaultModel = row.id;
  }
  return { models, ...(defaultModel !== undefined ? { defaultModel } : {}) };
};

/** The label every selector shows for `id`: the catalogue's, else the id itself. */
export const modelLabel = (models: readonly ModelChoice[] | undefined, id: string): string =>
  models?.find((m) => m.id === id)?.label ?? id;
