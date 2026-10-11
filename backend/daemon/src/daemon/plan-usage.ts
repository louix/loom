/**
 * On-demand refresh of subscription plan windows (`five_hour`, `seven_day`, …).
 *
 * Plan windows are stored per account and overlaid on every session snapshot.
 * A session polls them itself at start-up and after turns, so an account with
 * no active session lets them run out: a window's reset passes and it vanishes,
 * or it shows without a utilization. Nothing polls on a timer. Instead, when
 * the daemon serves a snapshot whose account windows are stale it asks for a
 * refresh here, in the background; the fresh readings reach clients through the
 * normal snapshot publish.
 *
 * Only windows a refresh can read again count (`SessionStore.planUsageState`),
 * and the daemon judges staleness once per account per client-facing snapshot
 * build (a state publish, `session.list`, `session.get`) — never for its own
 * reads.
 *
 * Per account scope: at most one refresh in flight, at most one every
 * {@link PLAN_USAGE_MIN_GAP_MS}, and a refresh that fails — or that came back
 * without making the windows fresh, or that read the same values again —
 * doubles the gap, up to {@link PLAN_USAGE_MAX_GAP_MS}.
 */
import type { PlanWindow } from "@loom/core/events";

/** Minimum gap between two refreshes of one account. */
export const PLAN_USAGE_MIN_GAP_MS = 2 * 60_000;
/** The longest a failing account backs off to; also where an account with no
 *  plan at all (an API key) settles at once. */
export const PLAN_USAGE_MAX_GAP_MS = 60 * 60_000;
/** Ceiling on one refresh, live or probe. */
export const PLAN_USAGE_TIMEOUT_MS = 30_000;

/** Where one account's windows can be read from. */
export interface PlanUsageRoute {
  /** Live sessions on the account, best candidate first. */
  live: readonly string[];
  /** Ask live session `id` to poll now; false when it can't. Its readings
   *  arrive as `rate_limit` events and are recorded with the stream. */
  refreshLive(id: string): Promise<boolean>;
  /** A bounded, metadata-only read with no session; absent when there is none. */
  probe?: (signal: AbortSignal) => Promise<readonly PlanWindow[]>;
  /** Store a probe's readings and publish the snapshots that show them. */
  record(windows: readonly PlanWindow[]): void;
}

/** What a refresh did: asked a live session, or probed and read `windows`. */
export type PlanUsageOutcome = { via: "live" } | { via: "probe"; windows: number };

/**
 * Refresh one account through the cheapest source: a live session already
 * talking to the provider, else a probe. Rejects when neither could.
 */
export const refreshPlanUsage = async (
  route: PlanUsageRoute,
  signal: AbortSignal,
): Promise<PlanUsageOutcome> => {
  for (const id of route.live) {
    signal.throwIfAborted();
    // A session that refuses (or has just ended) falls through to the next.
    if (await route.refreshLive(id).catch(() => false)) return { via: "live" };
  }
  if (!route.probe) throw new Error("No live session or probe can read this account's plan.");
  const windows = await route.probe(signal);
  signal.throwIfAborted();
  if (windows.length > 0) route.record(windows);
  return { via: "probe", windows: windows.length };
};

/** What a snapshot shows of an account's refreshable windows. */
export interface PlanUsageView {
  /** A refreshable window is missing, expired, aged out or without a utilization. */
  stale: boolean;
  /** Those windows' values (not when they were read), to tell a refresh that
   *  changed something from one that read the same again. */
  readings: string;
}

interface ScopeState {
  running: boolean;
  /** Epoch ms the last refresh started. */
  lastAt: number;
  /** Consecutive refreshes that failed, left the windows stale, or changed
   *  nothing. */
  failures: number;
  /** The readings as the last refresh started, while its outcome is still to
   *  be judged (on the first look once it is due again); null once judged. */
  before: string | null;
  /** The readings last judged; fresh ones that differ came some other way. */
  seen: string;
}

export class PlanUsageRefresher {
  readonly #scopes = new Map<string, ScopeState>();
  readonly #refresh: (
    scope: string,
    provider: string,
    signal: AbortSignal,
  ) => Promise<PlanUsageOutcome>;
  readonly #now: () => number;
  readonly #minGapMs: number;
  readonly #maxGapMs: number;
  readonly #timeoutMs: number;
  readonly #onError: (scope: string, error: unknown) => void;
  readonly #closing = new AbortController();
  readonly #running = new Set<Promise<void>>();

  constructor(opts: {
    /** Refresh `scope`'s windows, through `provider` when it has to probe. */
    refresh: (scope: string, provider: string, signal: AbortSignal) => Promise<PlanUsageOutcome>;
    now?: () => number;
    minGapMs?: number;
    maxGapMs?: number;
    timeoutMs?: number;
    onError?: (scope: string, error: unknown) => void;
  }) {
    this.#refresh = opts.refresh;
    this.#now = opts.now ?? Date.now;
    this.#minGapMs = opts.minGapMs ?? PLAN_USAGE_MIN_GAP_MS;
    this.#maxGapMs = Math.max(opts.maxGapMs ?? PLAN_USAGE_MAX_GAP_MS, this.#minGapMs);
    this.#timeoutMs = opts.timeoutMs ?? PLAN_USAGE_TIMEOUT_MS;
    this.#onError = opts.onError ?? (() => {});
  }

  /**
   * A client is being shown `scope`'s windows. Stale ones start a background
   * refresh when the throttle allows. A refresh helped once the windows are
   * fresh and read differently from before it, which clears the backoff; if
   * they do not by the time it is due again — still stale, or the same values
   * read again — the gap doubles. Fresh readings that changed some other way
   * (a session's own poll) clear it too. Never blocks and never throws.
   */
  observe(scope: string, provider: string, view: PlanUsageView): void {
    const known = this.#scopes.get(scope);
    if (!known && !view.stale) return;
    const st: ScopeState = known ?? {
      running: false,
      lastAt: -Infinity,
      failures: 0,
      before: null,
      seen: view.readings,
    };
    this.#scopes.set(scope, st);
    if (st.running || this.#closing.signal.aborted) return;
    const now = this.#now();
    const due = () => now >= st.lastAt + this.#gap(st.failures);
    if (st.before !== null) {
      if (!view.stale && view.readings !== st.before) st.failures = 0;
      // Its readings have had until it is due again to land.
      else if (due()) st.failures++;
      else return;
      st.before = null;
      st.seen = view.readings;
    } else if (!view.stale && view.readings !== st.seen) {
      st.failures = 0;
      st.seen = view.readings;
    }
    if (!view.stale || !due()) return;
    this.#start(scope, provider, st, now, view.readings);
  }

  /** Whether a refresh of `scope` is running. */
  running(scope: string): boolean {
    return this.#scopes.get(scope)?.running ?? false;
  }

  /** Cancel every refresh and wait for them to settle. */
  async close(): Promise<void> {
    this.#closing.abort(new Error("The daemon is stopping."));
    await Promise.allSettled(this.#running);
  }

  #gap(failures: number): number {
    return Math.min(this.#minGapMs * 2 ** Math.min(failures, 30), this.#maxGapMs);
  }

  #start(scope: string, provider: string, st: ScopeState, now: number, readings: string): void {
    st.running = true;
    st.lastAt = now;
    st.before = null;
    const signal = AbortSignal.any([this.#closing.signal, AbortSignal.timeout(this.#timeoutMs)]);
    // Shutdown waits for the source itself (a probe's subprocess) to settle.
    const work = (async () => await this.#refresh(scope, provider, signal))();
    this.#track(work);
    // Settles at the ceiling even if the source is slow to notice it.
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
    this.#track(
      (async () => {
        try {
          const outcome = await Promise.race([work, stopped]);
          // A probe that read no windows found an account without a plan:
          // check back rarely rather than climbing there one failure at a time.
          if (outcome.via === "probe" && outcome.windows === 0) {
            st.failures = Math.max(
              st.failures,
              Math.ceil(Math.log2(this.#maxGapMs / this.#minGapMs)),
            );
          } else st.before = readings;
        } catch (error) {
          st.failures++;
          if (!this.#closing.signal.aborted) this.#onError(scope, error);
        } finally {
          st.running = false;
        }
      })(),
    );
  }

  #track(p: Promise<unknown>): void {
    const settled = p.then(
      () => {},
      () => {},
    );
    this.#running.add(settled);
    void settled.finally(() => this.#running.delete(settled));
  }
}
