/**
 * On-disk model catalogues, shared across repositories and daemon processes so
 * a restart doesn't re-probe every provider. An entry is keyed by a digest of
 * the provider's discovery identity — provider id, the configuration that
 * steers discovery, the credential identity behind it, and the installed
 * Loom/host — so a changed config, a different account or an upgrade simply
 * misses. Only the digest is stored, never the identity (it may name keys).
 *
 * Invalidation follows main-new's catalogue cache: entries expire after
 * {@link MODEL_CATALOGUE_TTL}; an explicit refresh deletes the entry before
 * probing; an empty, oversized, expired, future-dated or corrupt entry is a
 * miss, never an empty catalogue; a failed probe leaves nothing behind.
 * Publication is atomic (temp file + rename), so reads need no lock.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { modelCatalogueSchema, type ModelCatalogue } from "@loom/core/model-catalogue";

export const MODEL_CATALOGUE_TTL = 10 * 60_000;
const RETENTION = 24 * 60 * 60_000;
const MAX_ENTRIES = 256;
const MAX_BYTES = 1024 * 1024;
/** Bumped when the stored shape or the identity's meaning changes. */
const VERSION = 1;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

/** The cache key for a discovery identity. */
export const catalogueKey = (identity: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical({ version: VERSION, identity })))
    .digest("hex");

export const defaultCatalogueDirectory = (): string => {
  const cache = Deno.env.get("XDG_CACHE_HOME");
  return join(
    cache && isAbsolute(cache) ? cache : join(homedir(), ".cache"),
    "loom",
    "model-catalogues",
  );
};

export class ModelCatalogueCache {
  readonly directory: string;
  readonly #now: () => number;

  constructor(directory = defaultCatalogueDirectory(), now: () => number = Date.now) {
    this.directory = directory;
    this.#now = now;
  }

  /**
   * The cached catalogue for `identity`, else `probe()`'s, published for the
   * next caller. `refresh` skips the read and drops the old entry first, so a
   * failed refresh can't leave a stale catalogue to be served later.
   */
  async get(
    identity: unknown,
    probe: () => Promise<ModelCatalogue>,
    signal: AbortSignal,
    refresh = false,
  ): Promise<ModelCatalogue> {
    signal.throwIfAborted();
    await Deno.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await Deno.lstat(this.directory)).isSymlink)
      throw new Error("The model catalogue cache must not be a symlink.");
    const path = join(this.directory, catalogueKey(identity) + ".json");
    if (!refresh) {
      const cached = await this.#read(path);
      if (cached) return cached;
    }
    await Deno.remove(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await this.#prune().catch(() => {});
    const catalogue = modelCatalogueSchema.parse(await probe());
    signal.throwIfAborted();
    if (!catalogue.models.length) throw new Error("The provider returned no models.");
    const serialized = JSON.stringify({ version: VERSION, at: this.#now(), catalogue });
    if (new TextEncoder().encode(serialized).length > MAX_BYTES) return catalogue;
    const temporary = await Deno.makeTempFile({ dir: this.directory, prefix: "write-" });
    try {
      await Deno.writeTextFile(temporary, serialized, { mode: 0o600 });
      await Deno.rename(temporary, path);
    } finally {
      await Deno.remove(temporary).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    return catalogue;
  }

  /** Drop the entry for `identity`, if any. */
  async forget(identity: unknown): Promise<void> {
    await Deno.remove(join(this.directory, catalogueKey(identity) + ".json")).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }

  async #read(path: string): Promise<ModelCatalogue | undefined> {
    try {
      const stat = await Deno.lstat(path);
      if (!stat.isFile || stat.size > MAX_BYTES) return;
      const saved = JSON.parse(await Deno.readTextFile(path));
      const now = this.#now();
      if (
        saved.version !== VERSION ||
        !Number.isFinite(saved.at) ||
        saved.at > now ||
        now - saved.at >= MODEL_CATALOGUE_TTL
      )
        return;
      const catalogue = modelCatalogueSchema.parse(saved.catalogue);
      if (catalogue.models.length) return catalogue;
    } catch {
      // Missing, expired or corrupt entries are misses, never an empty catalogue.
    }
  }

  /** Remove entries past retention and stray temp files; keep the newest few hundred. */
  async #prune(): Promise<void> {
    const entries: { path: string; at: number }[] = [];
    const now = this.#now();
    for await (const item of Deno.readDir(this.directory)) {
      if (!item.isFile || !/^(?:[a-f0-9]{64}\.json|write-)/.test(item.name)) continue;
      const path = join(this.directory, item.name);
      const at = (await Deno.stat(path)).mtime?.getTime() ?? 0;
      // A temp file younger than a minute may be another daemon's write in flight.
      if (item.name.startsWith("write-")) {
        if (now - at > 60_000) await Deno.remove(path).catch(() => {});
      } else if (now - at > RETENTION) await Deno.remove(path).catch(() => {});
      else entries.push({ path, at });
    }
    for (const entry of entries.sort((a, b) => b.at - a.at).slice(MAX_ENTRIES))
      await Deno.remove(entry.path).catch(() => {});
  }
}
