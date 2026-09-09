import type { PriceTable } from "../config/pricing.ts";
import { probeOpenAiModels, type ProbedModel } from "./model-catalog.ts";

/** Rates are scoped to an endpoint/profile and expire after an hour. */
export class EndpointPricing {
  readonly #rows = new Map<string, { table: PriceTable; fetchedAt: number }>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #attempts = new Map<string, number>();
  readonly probe: typeof probeOpenAiModels;
  constructor(probe = probeOpenAiModels) {
    this.probe = probe;
  }

  record(scope: string, models: ProbedModel[], now = Date.now()): void {
    this.#rows.set(scope, {
      table: new Map(models.flatMap((m) => (m.pricing ? [[m.id, m.pricing] as const] : []))),
      fetchedAt: now,
    });
  }

  table(scope: string, now = Date.now()): PriceTable {
    const row = this.#rows.get(scope);
    return row && now - row.fetchedAt < 3_600_000 ? row.table : new Map();
  }

  async refresh(scope: string, baseUrl: string, apiKey: string, force = false): Promise<void> {
    const pending = this.#pending.get(scope);
    if (pending) return pending;
    const now = Date.now();
    if (
      !force &&
      (now - (this.#attempts.get(scope) ?? 0) < 60_000 ||
        now - (this.#rows.get(scope)?.fetchedAt ?? 0) < 3_600_000)
    )
      return;
    this.#attempts.set(scope, now);
    const job = this.probe(baseUrl, apiKey)
      .then((models) => {
        this.record(scope, models);
      })
      .finally(() => this.#pending.delete(scope));
    this.#pending.set(scope, job);
    return job;
  }
}
