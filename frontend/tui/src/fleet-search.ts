/**
 * The fleet filter (`/`) — its state and the handle that keeps it fed.
 *
 * Matching and ranking are the daemon's (`session.search`); nothing here scores
 * anything. That is the point: the corpus is every session's durable
 * transcript, not the pages this one client happens to have downloaded, so a
 * session you have never selected is findable and two clients agree on what
 * exists.
 *
 * What is local is the query, one lifetime per query, and the results last
 * returned — with the query they were returned *for*, so a page that arrives
 * after you have typed on can be recognised as stale rather than shown as an
 * answer. The fleet snapshot stays the only source of the sessions themselves:
 * a page carries ids, and {@link searchMatches} intersects them with the fleet
 * that is on screen.
 */
import type { SearchCursor, SearchPage, SessionSnapshot } from "@loom/core/wire";
import {
  loadableFailed,
  loadableIdle,
  loadableLoaded,
  loadablePending,
  type Loadable,
} from "@loom/core/loadable";
import { buffer, type Buffer } from "./editor.ts";

/** One query's answer, as far as it has been paged in. */
export interface SearchResults {
  /** The query these are for — not necessarily the one in the buffer. */
  readonly query: string;
  /** Matching session ids, best first. May name sessions the fleet no longer
   *  has; {@link searchMatches} is where that is resolved. */
  readonly ids: readonly string[];
  /** Where the next page starts, or null when the ranking is exhausted. A
   *  full page means nothing on its own — the daemon says which it is. */
  readonly cursor: SearchCursor | null;
  /** A next-page fetch is out. Distinct from `pending`, which is the *first*
   *  page: these results are showable, there are just more coming. */
  readonly loadingMore: boolean;
}

/**
 * The filter as the UI holds it: the query being typed, and whatever the last
 * completed search produced.
 *
 * `results` is `idle` exactly when the query is empty — no filter is the whole
 * fleet, which needs no round trip and must not flash a spinner on `/`.
 */
export interface Find {
  readonly buffer: Buffer;
  readonly results: Loadable<string, SearchResults>;
}

export const openFind = (): Find => ({ buffer: buffer(), results: loadableIdle });

/** The query as the daemon will see it. Trailing whitespace is a keystroke on
 *  the way to a word, not a different search. */
export const queryOf = (find: Find): string => find.buffer.text.trim();

/**
 * Are the results on screen for a query other than the one in the buffer?
 *
 * True while a search is in flight or failed, and true for the beat between a
 * keystroke and its results. The rows shown are then the *previous* query's,
 * which is deliberate — blanking the list on every keystroke is worse — but
 * they are not an answer to what is typed, so nothing may be activated from
 * them and the selection must not ride onto them.
 */
export const searchStale = (find: Find): boolean => {
  const q = queryOf(find);
  if (q === "") return false;
  return find.results.tag !== "data" || find.results.value.query !== q;
};

/**
 * The sessions to show under the filter, in rank order: the returned ids
 * intersected with the fleet the client currently has. A session that has
 * ended between the search and now simply isn't there, and one the daemon
 * ranked but this client hasn't seen yet arrives on the next snapshot.
 *
 * An empty query is the fleet itself, untouched and in its own order.
 */
export const searchMatches = (
  find: Find | null,
  sessions: readonly SessionSnapshot[],
): SessionSnapshot[] => {
  if (!find || queryOf(find) === "") return [...sessions];
  if (find.results.tag !== "data") return [];
  const live = new Map(sessions.map((s) => [s.id, s]));
  const out: SessionSnapshot[] = [];
  for (const id of find.results.value.ids) {
    const s = live.get(id);
    if (s) out.push(s);
  }
  return out;
};

/**
 * What the FLEET pane's header says while the filter is up. The search is a
 * round trip now, so "how many match" has three more answers than it used to:
 * nothing typed yet, the daemon still counting, and a search that failed —
 * each of which has to read differently from an honest zero.
 */
export const fleetFilterStatus = (find: Find, sessions: readonly SessionSnapshot[]): string => {
  if (queryOf(find) === "") return `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  if (find.results.tag === "error") return `search failed: ${find.results.error}`;
  if (searchStale(find)) return "searching…";
  const n = searchMatches(find, sessions).length;
  const more = find.results.tag === "data" && find.results.value.cursor !== null ? "+" : "";
  return `${n}${more}/${sessions.length} match${n === 1 && more === "" ? "" : "es"}`;
};

// ---- the handle ------------------------------------------------------------

export interface SearchControlDeps {
  /** `session.search`. One page; `cursor` continues an earlier one. */
  search: (query: string, cursor: SearchCursor | null) => Promise<SearchPage>;
  find: () => Find | null;
  /** The fleet on screen — how far a page has to be paged in is decided
   *  against what the user can actually select. */
  sessions: () => readonly SessionSnapshot[];
  /** The selected session, so an exhausted-looking list can be topped up
   *  before the selection walks off the end of it. */
  selectedId: () => string | null;
  /** Only fetch while the daemon is there. */
  connected: () => boolean;
  /** Install results for `query`; the reducer drops them if the buffer has
   *  moved on. */
  loaded: (query: string, results: Loadable<string, SearchResults>) => void;
  /** How long a query sits before it is sent. Search is a scan over every
   *  session's durable text, so a keystroke must not start one. */
  debounceMs?: number;
  /** How close to the end of the loaded results the selection has to get
   *  before the next page is fetched. */
  prefetchWithin?: number;
}

export interface SearchControl {
  /** The query changed (or the filter opened): schedule the search it needs. */
  typed: () => void;
  /** Re-run the current query now — an explicit refresh, or a reconnect. */
  refresh: () => void;
  /** Called on every state change: page in more results when the selection is
   *  running out of them, and invalidate everything on disconnect. */
  settle: () => void;
  /** Cancel the timer and orphan any outstanding response. */
  dispose: () => void;
}

export const mkSearchControl = ({
  search,
  find,
  sessions,
  selectedId,
  connected,
  loaded,
  debounceMs = 180,
  prefetchWithin = 10,
}: SearchControlDeps): SearchControl => {
  // One lifetime per query. Bumped by every keystroke, refresh, disconnect and
  // dispose, so a response can be matched against the search that asked for it
  // — cancelling a fetch cannot un-queue a callback that is already scheduled.
  let gen = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The query `gen` belongs to, so `settle` can tell an in-flight page for
   *  the current query from one left over from an abandoned search. */
  let inFlight: string | null = null;
  let wasConnected = true;

  const disarm = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /** Abandon whatever is scheduled or outstanding. */
  const invalidate = (): void => {
    gen += 1;
    inFlight = null;
    disarm();
  };

  const run = (query: string, cursor: SearchCursor | null, previous: readonly string[]): void => {
    if (!connected()) return;
    const mine = gen;
    inFlight = query;
    search(query, cursor).then(
      (page) => {
        if (mine !== gen) return; // a newer query owns the filter now
        inFlight = null;
        // The daemon echoes the query; a page for anything else is a page for
        // a search this handle has already replaced.
        if (page.query !== query) return;
        loaded(
          query,
          loadableLoaded({
            query,
            ids: [...previous, ...page.hits.map((h) => h.id)],
            cursor: page.cursor,
            loadingMore: false,
          }),
        );
      },
      (e: unknown) => {
        if (mine !== gen) return;
        inFlight = null;
        loaded(query, loadableFailed(e instanceof Error ? e.message : String(e)));
      },
    );
  };

  const start = (query: string): void => {
    invalidate();
    if (query === "") return void loaded(query, loadableIdle);
    loaded(query, loadablePending);
    run(query, null, []);
  };

  return {
    typed: () => {
      const f = find();
      if (!f) return void invalidate();
      const q = queryOf(f);
      // Already answered, or already on its way: `findSet` fires on every
      // keystroke, including the ones that don't change the query (cursor
      // motion, a space at the end).
      if (q === "") {
        invalidate();
        if (f.results.tag !== "idle") loaded(q, loadableIdle);
        return;
      }
      if (inFlight === q) return;
      if (f.results.tag === "data" && f.results.value.query === q) return;
      disarm();
      timer = setTimeout(() => {
        timer = null;
        start(q);
      }, debounceMs);
    },

    refresh: () => {
      const f = find();
      if (!f) return void invalidate();
      start(queryOf(f));
    },

    settle: () => {
      const live = connected();
      if (!live) {
        // The results describe a fleet this client is no longer being told
        // about. Holding them would let a selection land on a session that
        // may not exist by the time the socket is back.
        if (wasConnected) {
          invalidate();
          const f = find();
          if (f && f.results.tag !== "idle") loaded(queryOf(f), loadableIdle);
        }
        wasConnected = false;
        return;
      }
      if (!wasConnected) {
        // Reconnected: re-run the active query once, rather than leaving the
        // filter showing an answer from before the gap.
        wasConnected = true;
        const f = find();
        if (f && queryOf(f) !== "") start(queryOf(f));
        return;
      }
      const f = find();
      if (!f || f.results.tag !== "data") return;
      const r = f.results.value;
      if (r.cursor === null || r.loadingMore || r.query !== queryOf(f)) return;
      // Page in more only as the selection approaches the end of what is
      // loaded: a capped page is not "no more matches", and the user walking
      // down the list must not stop at an arbitrary boundary.
      const shown = searchMatches(f, sessions());
      const at = shown.findIndex((s) => s.id === selectedId());
      if (shown.length - (at < 0 ? 0 : at) > prefetchWithin) return;
      loaded(r.query, loadableLoaded({ ...r, loadingMore: true }));
      run(r.query, r.cursor, r.ids);
    },

    dispose: () => invalidate(),
  };
};
