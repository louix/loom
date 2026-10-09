/**
 * The daemon's per-provider model catalogues: which ones can be discovered,
 * the last good catalogue of each, and the discovery running for it. Each
 * provider id (every Claude profile, every aisdk profile) has its own entry and
 * its own discovery identity, so one provider's list never stands in for
 * another's.
 *
 * Discovery runs at most once at a time per provider, bounded by a timeout and
 * cancellable. Every run takes a fresh generation; a run that settles after it
 * was cancelled or superseded is discarded, so a late response can never
 * replace a newer catalogue. A failed or cancelled run keeps the previous
 * catalogue — sessions and pickers go on showing what was last known, with the
 * failure beside it.
 */
import {
  catalogueFromDiscovered,
  type ModelCatalogue,
  modelCatalogueSchema,
} from "@loom/core/model-catalogue";
import type { DiscoveredModel } from "@loom/core/types";
import type { ModelCatalogueCache } from "./model-catalogue-cache.ts";

/** How one provider discovers its models. */
export interface CatalogueSource {
  /** Configuration plus credential identity. A different value is a different
   *  catalogue; it is only ever hashed, never stored. */
  identity(): unknown | Promise<unknown>;
  /** Metadata-only discovery; must stop its subprocess when `signal` aborts. */
  discover(signal: AbortSignal): Promise<readonly DiscoveredModel[]>;
}

export interface CatalogueState {
  /** The last catalogue discovery produced; kept through failures. */
  catalogue: ModelCatalogue | undefined;
  loading: boolean;
  /** The last run's failure, cleared by the next success. */
  error: string | undefined;
  /** Why discovery can't run for this provider; set at registration. */
  unavailable: string | undefined;
}

/** A run that was cancelled, superseded or shut down before it settled. */
export class CatalogueCancelled extends Error {
  constructor(message = "Model discovery was cancelled.") {
    super(message);
    this.name = "CatalogueCancelled";
  }
}

interface Entry {
  source: CatalogueSource | undefined;
  unavailable: string | undefined;
  catalogue: ModelCatalogue | undefined;
  error: string | undefined;
  generation: number;
  run:
    | {
        generation: number;
        controller: AbortController;
        promise: Promise<ModelCatalogue>;
      }
    | undefined;
}

export const DISCOVERY_TIMEOUT_MS = 30_000;

export class ModelCatalogues {
  readonly #entries = new Map<string, Entry>();
  readonly #cache: ModelCatalogueCache | null;
  readonly #onChange: (provider: string) => void;
  readonly #onCatalogue: ((provider: string, catalogue: ModelCatalogue) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #closing = new AbortController();
  /** Every run's settle-and-cleanup, so shutdown can wait for subprocesses. */
  readonly #settling = new Set<Promise<unknown>>();

  constructor(opts: {
    /** Disk cache; null keeps catalogues in memory only (tests, embedded). */
    cache: ModelCatalogueCache | null;
    /** A provider's catalogue, loading flag or error changed. */
    onChange: (provider: string) => void;
    /** A run produced a catalogue — called before `onChange`, so whatever it
     *  derives (config fields, pricing) is in the snapshot that announces it. */
    onCatalogue?: (provider: string, catalogue: ModelCatalogue) => void;
    timeoutMs?: number;
  }) {
    this.#cache = opts.cache;
    this.#onChange = opts.onChange;
    this.#onCatalogue = opts.onCatalogue;
    this.#timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  }

  /** Declare a provider: a source to discover from, or why it has none. */
  register(provider: string, source: CatalogueSource | { unavailable: string }): void {
    const old = this.#entries.get(provider);
    if (old?.run) this.#abort(old, new CatalogueCancelled("The provider was reconfigured."));
    this.#entries.set(provider, {
      source: "discover" in source ? source : undefined,
      unavailable: "unavailable" in source ? source.unavailable : undefined,
      catalogue: undefined,
      error: undefined,
      generation: (old?.generation ?? 0) + 1,
      run: undefined,
    });
  }

  has(provider: string): boolean {
    return this.#entries.has(provider);
  }

  state(provider: string): CatalogueState {
    const e = this.#entries.get(provider);
    return {
      catalogue: e?.catalogue,
      loading: e?.run !== undefined,
      error: e?.error,
      unavailable: e ? e.unavailable : "This provider has no model catalogue.",
    };
  }

  /**
   * Discover `provider`'s catalogue — from the disk cache unless `refresh` —
   * and resolve with it. A run already in flight is joined, not restarted.
   * Rejects with the failure (the previous catalogue stays) or with
   * {@link CatalogueCancelled}.
   */
  load(provider: string, { refresh = false }: { refresh?: boolean } = {}): Promise<ModelCatalogue> {
    const e = this.#entries.get(provider);
    if (!e) return Promise.reject(new Error(`No model catalogue for ${provider}.`));
    if (!e.source)
      return Promise.reject(new Error(e.unavailable ?? "Model discovery unavailable."));
    if (this.#closing.signal.aborted) return Promise.reject(new CatalogueCancelled());
    if (e.run) return e.run.promise;
    const source = e.source;
    const generation = ++e.generation;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.#closing.signal,
      AbortSignal.timeout(this.#timeoutMs),
    ]);
    const probe = async (): Promise<ModelCatalogue> => {
      const rows = await source.discover(signal);
      signal.throwIfAborted();
      return catalogueFromDiscovered(rows);
    };
    const work = (async () => {
      const identity = await source.identity();
      const catalogue = this.#cache
        ? await this.#cache.get({ provider, identity }, probe, signal, refresh)
        : await probe();
      return modelCatalogueSchema.parse(catalogue);
    })();
    // Settles the moment the run is cancelled, shut down or times out, so a
    // probe slow to notice its signal can't hold the caller.
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
    const cancelled = () => controller.signal.aborted || this.#closing.signal.aborted;
    const current = () => e.generation === generation && this.#entries.get(provider) === e;
    const finish = () => {
      if (e.run?.generation !== generation) return;
      e.run = undefined;
      this.#onChange(provider);
    };
    const promise = Promise.race([work, stopped]).then(
      (catalogue) => {
        if (!current()) throw new CatalogueCancelled("A newer model discovery replaced this one.");
        if (catalogue.models.length) {
          e.catalogue = catalogue;
          e.error = undefined;
          this.#onCatalogue?.(provider, catalogue);
        } else e.error = `${provider} returned no models.`;
        finish();
        if (e.error) throw new Error(e.error);
        return catalogue;
      },
      (error: unknown) => {
        if (cancelled()) throw new CatalogueCancelled();
        if (!current()) throw new CatalogueCancelled("A newer model discovery replaced this one.");
        if (signal.aborted)
          e.error = `Model discovery for ${provider} timed out after ${Math.round(this.#timeoutMs / 1000)}s.`;
        else if (error instanceof Error && error.message) e.error = error.message;
        else e.error = `Model discovery for ${provider} failed.`;
        finish();
        throw new Error(e.error);
      },
    );
    void promise.catch(() => {});
    // Shutdown waits for the probe itself (its subprocess), not just the reply.
    const tracked = work.then(
      () => {},
      () => {},
    );
    this.#settling.add(tracked);
    void tracked.finally(() => this.#settling.delete(tracked));
    e.run = { generation, controller, promise };
    this.#onChange(provider);
    return promise;
  }

  /** Abort `provider`'s running discovery. Its previous catalogue stays; when
   *  there is none the cancellation is what the provider reports. */
  cancel(provider: string): boolean {
    const e = this.#entries.get(provider);
    if (!e?.run) return false;
    this.#abort(e, new CatalogueCancelled());
    if (!e.catalogue) e.error = "Model discovery was cancelled. Refresh models to try again.";
    this.#onChange(provider);
    return true;
  }

  #abort(e: Entry, reason: Error): void {
    const run = e.run;
    if (!run) return;
    e.generation++;
    e.run = undefined;
    run.controller.abort(reason);
  }

  /** Cancel every run and wait until their subprocesses are cleaned up. */
  async close(): Promise<void> {
    this.#closing.abort(new CatalogueCancelled("The daemon is stopping."));
    for (const e of this.#entries.values()) {
      if (e.run) {
        e.generation++;
        e.run = undefined;
      }
    }
    await Promise.allSettled(this.#settling);
  }
}
