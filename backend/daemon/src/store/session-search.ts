/**
 * Cross-session search: the `/` query's grammar, scoring, and the scan that
 * answers it from the database.
 *
 * This used to live in the TUI, over whatever transcript pages that one client
 * happened to have downloaded — so a session you had never selected could not
 * be found, and two clients disagreed about what existed. Here the corpus is
 * the durable `session_events` table, so a match is a fact about the fleet
 * rather than about one client's cache.
 *
 * The file is two halves. Above the divider is the pure matcher — the query
 * grammar and the scorers, no database and no session types, which is what the
 * grammar tests drive. Below it is {@link SessionSearchStore}, which streams
 * candidates out of SQLite and ranks them.
 */
import type { SessionSnapshot } from "@loom/core/wire";
import type { Db } from "./db.ts";

// ---- the matcher (pure) ----------------------------------------------------

/**
 * One parsed query term. `exact` terms (fzf's `'` prefix) match as a literal
 * substring; the rest match fuzzily (subsequence). Text is lowercased here —
 * haystacks are folded lowercase at build time.
 */
export interface SearchTerm {
  text: string;
  exact: boolean;
}

/**
 * fzf-style query: space-separated terms, AND'd. A leading `'` pins a term to
 * a literal (case-insensitive) substring — `'hello` won't match a spelled-out
 * "h-e-l-l-o". A bare `'` is dropped.
 */
export const parseQuery = (q: string): SearchTerm[] =>
  q
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => {
      const exact = t.startsWith("'");
      return { text: (exact ? t.slice(1) : t).toLowerCase(), exact };
    })
    .filter((t) => t.text !== "");

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9]/.test(ch);

/**
 * Fuzzy subsequence score of `q` in `hay` (both lowercase): 0 when the
 * characters aren't there in order; otherwise 1, +1 when the match starts at
 * a word boundary, +1 per extra consecutive character (capped) — "mobile"
 * inside "mobile access" outranks an m…o…b…i…l…e scattered across a
 * paragraph.
 */
const fuzzyScore = (hay: string, q: string): number => {
  let prev = -1;
  let run = 0;
  let bestRun = 1;
  let boundary = false;
  for (let k = 0; k < q.length; k++) {
    const at = hay.indexOf(q[k]!, prev + 1);
    if (at === -1) return 0;
    if (at === prev + 1) {
      run += 1;
      if (run > bestRun) bestRun = run;
    } else {
      run = 1;
    }
    if (k === 0) boundary = at === 0 || !isWordChar(hay[at - 1]);
    prev = at;
  }
  return 1 + (boundary ? 1 : 0) + Math.min(bestRun - 1, 2);
};

/**
 * Literal-substring score of `q` in `hay` (both lowercase): 0 when absent; a
 * word-boundary hit (either end) outranks one buried inside a word.
 */
const exactScore = (hay: string, q: string): number => {
  const at = hay.indexOf(q);
  if (at === -1) return 0;
  const startOk = at === 0 || !isWordChar(hay[at - 1]);
  const endOk = at + q.length >= hay.length || !isWordChar(hay[at + q.length]);
  return startOk || endOk ? 4 : 3;
};

/** A session's searchable fields, folded lowercase. */
export interface SearchDoc {
  title: string;
  /** Everything the human wrote: sent messages and answers to agent questions. */
  user: string;
  /** Everything the agent said: prose and the questions it asked. */
  agent: string;
}

/**
 * Field weights. They dwarf the per-field scores (1–4), so a title hit always
 * outranks a message-only hit and your words outrank the agent's; within a
 * field, match quality decides.
 */
const FIELD_WEIGHTS: ReadonlyArray<readonly [keyof SearchDoc, number]> = [
  ["title", 100],
  ["user", 10],
  ["agent", 1],
];

/** Sum over AND'd terms of each term's best weighted field score; 0 = no match.
 *  Terms are AND'd across the *whole* field, not per message — "mobile access"
 *  finds a session where you said one word in one message and the other in the
 *  next, which is how people remember conversations. */
export const scoreDoc = (doc: SearchDoc, terms: readonly SearchTerm[]): number => {
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const raw = term.exact
        ? exactScore(doc[field], term.text)
        : fuzzyScore(doc[field], term.text);
      if (raw > 0 && raw * weight > best) best = raw * weight;
    }
    if (best === 0) return 0; // AND: one missed term kills the session
    total += best;
  }
  return total;
};

// ---- the scan (database) ---------------------------------------------------

/** Event types carrying durable *human* text. `echo` — the TUI's optimistic
 *  local copy of a send — has no row here; the `user_message` the daemon emits
 *  for the same send does. */
const USER_TYPES = ["user_message", "answer"] as const;

/** Event types carrying durable *agent* text, its questions included. Tool
 *  traffic and thinking are deliberately absent: searching them turns every
 *  `grep` the agent ran into a false hit. */
const AGENT_TYPES = ["assistant_text", "question"] as const;

const TEXT_TYPES = [...USER_TYPES, ...AGENT_TYPES];

const USER_TYPE_SET: ReadonlySet<string> = new Set(USER_TYPES);

interface SearchHit {
  id: string;
  score: number;
}

interface TextRow {
  type: string;
  payload: string;
}

/** The one field of an event payload each searchable type keeps its prose in. */
const textOf = (type: string, payload: string): string => {
  const ev = JSON.parse(payload) as Record<string, unknown>;
  const raw = type === "question" ? ev["question"] : ev["text"];
  return typeof raw === "string" ? raw : "";
};

export class SessionSearchStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Rank `sessions` (in the order given, which is the fleet's) against `query`
   * and return the whole ranked list of matches, best first. Ties keep the
   * fleet's own order, so the caller's paging over this list is deterministic
   * for a fixed snapshot even though `sortSnapshots` itself is not a total
   * order.
   *
   * An empty query matches everything without reading a single transcript row:
   * "no filter" is the fleet, not a search for the empty string.
   */
  async rank(sessions: readonly SessionSnapshot[], query: string): Promise<SearchHit[]> {
    const terms = parseQuery(query);
    if (terms.length === 0) return sessions.map((s) => ({ id: s.id, score: 0 }));

    const out: SearchHit[] = [];
    let deadline = performance.now() + 8;
    const yieldIfDue = async () => {
      if (performance.now() < deadline) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      deadline = performance.now() + 8;
    };
    for (const s of sessions) {
      const score = scoreDoc(await this.#doc(s, yieldIfDue), terms);
      if (score > 0) out.push({ id: s.id, score });
    }
    // Stable: equal scores keep the order the unfiltered fleet list uses.
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /**
   * One session's searchable text, streamed newest-first out of the
   * `(session_id, id)` index and dropped as soon as it has been scored — the
   * daemon keeps no second copy of any transcript.
   */
  async #doc(s: SessionSnapshot, yieldIfDue: () => Promise<void>): Promise<SearchDoc> {
    const user: string[] = [];
    const agent: string[] = [];
    const rows = this.#db
      .prepare(
        `SELECT type, payload FROM session_events
          WHERE session_id = ? AND type IN (${TEXT_TYPES.map(() => "?").join(", ")})
          ORDER BY id DESC`,
      )
      .iterate(s.id, ...TEXT_TYPES) as Iterable<TextRow>;
    for (const row of rows) {
      const field = USER_TYPE_SET.has(row.type) ? user : agent;
      field.push(textOf(row.type, row.payload));
      await yieldIfDue();
    }
    return {
      // The fleet shows an untitled session by its short id, so that is what
      // "search what you can see" has to mean.
      title: (s.title ?? s.id.slice(0, 8)).toLowerCase(),
      user: user.reverse().join(" ").toLowerCase(),
      agent: agent.reverse().join(" ").toLowerCase(),
    };
  }
}
