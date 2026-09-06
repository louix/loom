/**
 * The fleet filter's engine — the `/` query's matcher and ranking. Pure and
 * model-free: it reads a structural slice of whatever the host hands it
 * ({@link FleetView}: sessions plus their log lines), never `TuiState`, so the
 * model can change shape without touching this file, and any other host (the
 * tests today; a CLI or web view tomorrow) can drive it as-is.
 *
 * The contract is the bottom of the file: `parseQuery` (the query grammar) and
 * `searchSessions` (ranked matches). Everything above it — the scorers, field
 * weights, doc build and memo caches — is implementation, free to swap.
 */
import type { SessionSnapshot } from "@loom/core/wire";

import { shortId } from "./theme.ts";

/** The slice of a log line the engine reads — the model's `LogLine` conforms. */
interface FleetLogLine {
  kind: string;
  text: string;
  full?: string;
}

/** The slice of a transcript cache the engine reads. */
interface FleetTranscript {
  lines: readonly FleetLogLine[];
  echoes: readonly FleetLogLine[];
}

/** What the engine sees of the fleet: every session and its transcript, keyed
 *  by session id — already grouped, so the doc build never has to bucket. */
export interface FleetView {
  sessions: readonly SessionSnapshot[];
  transcripts: Readonly<Record<string, FleetTranscript>>;
}

/**
 * One parsed query term. `exact` terms (fzf's `'` prefix) match as a literal
 * substring; the rest match fuzzily (subsequence). Text is lowercased here —
 * haystacks are folded lowercase at build time.
 */
interface SearchTerm {
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
interface SearchDoc {
  title: string;
  user: string;
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

/** Transcript kinds that count as *your* words — `echo` is the optimistic
 *  local copy of a send, `answer` your reply to an agent question. */
const USER_KINDS: ReadonlySet<string> = new Set(["user_message", "echo", "answer"]);

/** Transcript kinds that count as the agent's words (its questions included). */
const AGENT_KINDS: ReadonlySet<string> = new Set(["assistant_text", "question"]);

/** Cap on one message's searchable text — past a couple of KB of a single
 *  message the recall loss is negligible next to the scan it saves. */
const SEARCH_TEXT_CAP = 2_048;

const buildDocs = (fleet: FleetView): Map<string, SearchDoc> => {
  const docs = new Map<string, SearchDoc>();
  for (const sess of fleet.sessions) {
    const doc: SearchDoc = {
      title: (sess.title ?? shortId(sess.id)).toLowerCase(),
      user: "",
      agent: "",
    };
    const t = fleet.transcripts[sess.id];
    if (t) {
      for (const l of t.lines) addLine(doc, l);
      for (const l of t.echoes) addLine(doc, l);
    }
    docs.set(sess.id, doc);
  }
  return docs;
};

const addLine = (doc: SearchDoc, l: FleetLogLine): void => {
  const text = (l.full ?? l.text).slice(0, SEARCH_TEXT_CAP);
  if (USER_KINDS.has(l.kind)) doc.user += ` ${text}`;
  else if (AGENT_KINDS.has(l.kind)) doc.agent += ` ${text}`;
};

/** Sum over AND'd terms of each term's best weighted field score; 0 = no match. */
const scoreDoc = (doc: SearchDoc, terms: readonly SearchTerm[]): number => {
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

export interface SessionMatch {
  session: SessionSnapshot;
  /** Coarse relevance, higher is better — see the scoring above. */
  score: number;
}

let docsLog: FleetView["transcripts"] | null = null;
let docsSessions: readonly SessionSnapshot[] | null = null;
let docCache: Map<string, SearchDoc> = new Map();
const resultCache = new Map<string, SessionMatch[]>();

/**
 * The fleet filter's ranked view: every session matching `q`, best first —
 * title over your messages over the agent's, tight match over scattered, and
 * equal scores keep the fleet's own order (status groups, then recency). An
 * empty / all-whitespace query returns every session, unranked. Memoised on
 * the (log, sessions) refs — both are replaced immutably on change — so a
 * keystroke costs one pass over the parsed terms, and the reducer's calls and
 * the render share one computation.
 */
export const searchSessions = (fleet: FleetView, q: string): SessionMatch[] => {
  if (fleet.transcripts !== docsLog || fleet.sessions !== docsSessions) {
    docsLog = fleet.transcripts;
    docsSessions = fleet.sessions;
    docCache = buildDocs(fleet);
    resultCache.clear();
  }
  const hit = resultCache.get(q);
  if (hit) return hit;
  const terms = parseQuery(q);
  const out: SessionMatch[] = [];
  if (terms.length === 0) {
    for (const session of fleet.sessions) out.push({ session, score: 0 });
  } else {
    for (const session of fleet.sessions) {
      const doc = docCache.get(session.id);
      const score = doc === undefined ? 0 : scoreDoc(doc, terms);
      if (score > 0) out.push({ session, score });
    }
    // Stable sort: ties keep the order the unfiltered fleet list uses.
    out.sort((a, b) => b.score - a.score);
  }
  if (resultCache.size >= 32) resultCache.clear();
  resultCache.set(q, out);
  return out;
};
