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
 * returned — with the query they were returned *for*, so an answer that arrives
 * after you have typed on can be recognised as stale rather than shown as an
 * answer. The fleet snapshot stays the only source of the sessions themselves:
 * a response carries ids, and {@link searchMatches} intersects them with the fleet
 * that is on screen.
 */
import { mkStore } from "./store.ts";
import type { SearchResult, SessionSnapshot } from "@loom/core/wire";
import {
  loadableFailed,
  loadableIdle,
  loadableLoaded,
  loadablePending,
  type Loadable,
} from "@loom/core/loadable";
import { buffer, type Buffer } from "./editor.ts";

/** One query's complete answer. */
export type SearchResults = SearchResult;

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

/** No row can be accepted until this query has an answer. */
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
  return `${n}/${sessions.length} match${n === 1 ? "" : "es"}`;
};

// ---- the handle ------------------------------------------------------------

export interface SearchControlDeps {
  search: (query: string) => Promise<SearchResult>;
  connected: () => boolean;
  debounceMs?: number;
}

export const mkSearchControl = ({ search, connected, debounceMs = 180 }: SearchControlDeps) => {
  const store = mkStore<Find | null>(null);
  const find = store.get;
  const loaded = (q: string, results: Loadable<string, SearchResults>) => {
    const f = find();
    if (f && queryOf(f) === q) store.set({ ...f, results });
  };
  let disposed = false;
  let generation = 0;
  let query: string | null = null;
  let live = connected();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
  };
  const request = (q: string) => {
    if (disposed || !connected()) return;
    const mine = generation;
    void search(q).then(
      (result) => {
        if (mine === generation && result.query === q) loaded(q, loadableLoaded(result));
      },
      (e) => {
        if (mine === generation)
          loaded(q, loadableFailed(e instanceof Error ? e.message : String(e)));
      },
    );
  };
  const start = (delay: number) => {
    if (disposed) return;
    const f = find();
    const q = f ? queryOf(f) : null;
    invalidate();
    query = q;
    if (q === null) return;
    loaded(q, q === "" ? loadableIdle : loadablePending);
    if (q !== "" && connected()) timer = setTimeout(() => request(q), delay);
  };
  return {
    get: store.get,
    subscribe: store.subscribe,
    open: () => {
      if (!disposed) {
        store.set(openFind());
        start(0);
      }
    },
    close: () => {
      invalidate();
      query = null;
      store.set(null);
    },
    setBuffer: (buffer: Buffer) => {
      const f = find();
      if (disposed || !f) return;
      // Install the new query and its loading state together; never expose old rows.
      const changed = buffer.text.trim() !== query;
      store.set({ buffer, results: changed ? loadablePending : f.results });
      if (changed) start(debounceMs);
    },
    refresh: () => start(0),
    settle: () => {
      const next = connected();
      if (next === live) return;
      live = next;
      if (next) start(0);
      else {
        invalidate();
        const f = find();
        if (f) loaded(queryOf(f), loadableIdle);
      }
    },
    dispose: () => {
      disposed = true;
      invalidate();
    },
  };
};
