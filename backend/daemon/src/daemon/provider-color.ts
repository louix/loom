/**
 * Default Fleet-row id colours for providers and named profiles.
 *
 * A provider without an explicit `color` gets one hashed from its id — the
 * aisdk profile key, or `claude:<slug>` for a named Claude profile — so the
 * colour is the same in every listing, whatever order the config declares
 * providers in, and across daemon restarts. The palette is small, so two
 * providers may share a colour; stable is the promise, not unique.
 */

/** Ink colour names, readable on the dark and light themes alike. */
export const PROVIDER_PALETTE = ["cyan", "magenta", "yellow", "green", "blue", "red"] as const;

/** 32-bit FNV-1a over the id's UTF-16 code units: cheap, unseeded and stable. */
const fnv1a = (text: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
};

/** The colour provider `id` shows in, `explicit` (the configured `color`)
 *  winning whenever it is set. */
export const providerColor = (id: string, explicit = ""): string =>
  explicit || PROVIDER_PALETTE[fnv1a(id) % PROVIDER_PALETTE.length]!;
