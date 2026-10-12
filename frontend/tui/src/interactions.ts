/**
 * The requests a session is parked on — a permission, a plan review, a
 * question, an `AskUserQuestion` — and everything the TUI does about them:
 * which one the panel shows, what the answer sheet asks, what
 * a decision becomes on the wire, and the guard that stops one being answered
 * twice.
 *
 * Outstanding requests are read straight off the daemon's snapshots. There is
 * no local pending/resolved mirror to keep in step: a request is outstanding
 * exactly while the snapshot lists it, so a replayed history page cannot
 * resurrect a settled one and another client answering one makes it disappear
 * here with no bookkeeping at all.
 */
import type { SessionInteraction } from "@loom/core/interaction";
import type { SessionSnapshot } from "@loom/core/wire";
import { isAmbiguousFailure } from "@loom/client";
import type { QNav } from "./question-sheet.ts";

export type { QNav } from "./question-sheet.ts";

/** The daemon's newest session snapshots — the only source of request truth. */
export type Fleet = readonly SessionSnapshot[];

const NO_REQUESTS: readonly SessionInteraction[] = [];

/** Everything the session is parked on, in the daemon's order — oldest first,
 *  which is the order parallel permissions must be answered in. */
export const requestsFor = (fleet: Fleet, id: string | null): readonly SessionInteraction[] =>
  (id ? fleet.find((x) => x.id === id)?.requests : undefined) ?? NO_REQUESTS;

/**
 * The one request the panel shows and the keys act on.
 *
 * `awaiting_input`'s reason is the daemon's own answer to "what is this turn
 * blocked on", so prefer the first request of that kind; a session that reports
 * no reason, or one nothing matches, falls back to the first request it has.
 * Selecting never discards the rest — {@link requestsFor} still has them, in
 * order, and the panel says how many are queued behind this one.
 */
export const activeRequest = (fleet: Fleet, id: string | null): SessionInteraction | null => {
  const requests = requestsFor(fleet, id);
  if (requests.length === 0) return null;
  const status = fleet.find((x) => x.id === id)?.status;
  const on = status?.kind === "awaiting_input" ? status.on : null;
  return (on ? requests.find((r) => r.kind === on) : undefined) ?? requests[0] ?? null;
};

// ---- AskUserQuestion -------------------------------------------------------

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  /** Any number of options may be chosen, rather than exactly one answer. */
  multiSelect?: boolean;
  /** Loom's own `ask_user`: no options, and the answer is the text typed. */
  freeText?: true;
}

/** Parse an `AskUserQuestion` tool call's `input.questions` defensively — the
 *  shape comes from the model, not from Loom, so nothing here is guaranteed. */
export const parseAskUserQuestions = (input: unknown): AskUserQuestionItem[] => {
  if (!input || typeof input !== "object") return [];
  const qs = (input as Record<string, unknown>)["questions"];
  if (!Array.isArray(qs)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") continue;
    const o = q as Record<string, unknown>;
    if (typeof o["question"] !== "string" || o["question"] === "") continue;
    const options: AskUserQuestionItem["options"] = [];
    if (Array.isArray(o["options"])) {
      for (const opt of o["options"]) {
        if (!opt || typeof opt !== "object") continue;
        const oo = opt as Record<string, unknown>;
        if (typeof oo["label"] !== "string" || oo["label"] === "") continue;
        options.push({
          label: oo["label"],
          ...(typeof oo["description"] === "string" ? { description: oo["description"] } : {}),
        });
      }
    }
    out.push({
      question: o["question"],
      header: typeof o["header"] === "string" ? o["header"] : "",
      options,
      multiSelect: o["multiSelect"] === true,
    });
  }
  return out;
};

/** What the answer sheet asks for `r`: an `AskUserQuestion`'s parsed
 *  questions, or a `question` as one free-text item with its context under
 *  it. Null for anything the sheet does not answer, or a call with nothing
 *  usable in it. */
export const sheetQuestions = (
  r: SessionInteraction | null | undefined,
): AskUserQuestionItem[] | null => {
  if (r?.kind === "question") {
    const question = r.question + (r.context ? "\n\n" + r.context : "");
    return [{ question, header: "", options: [], freeText: true }];
  }
  if (r?.kind !== "user_question") return null;
  const qs = parseAskUserQuestions(r.input);
  return qs.length > 0 ? qs : null;
};

/** `nav`, but only if it still describes the request `sid` / `rid` is parked
 *  on — a stale nav (resolved request, or a different session) reads as none. */
export const liveQNav = (
  nav: QNav | null | undefined,
  sid: string | null | undefined,
  rid: string | null | undefined,
): QNav | null =>
  nav && sid && rid && nav.sessionId === sid && nav.requestId === rid ? nav : null;

/** The question a session is parked on, if any — its request id and what the
 *  sheet asks (see {@link sheetQuestions}), plus the live {@link QNav} for it
 *  (answers gathered so far, which question is in view). */
export const questionState = (
  fleet: Fleet,
  qnav: QNav | null,
  sessionId: string | null | undefined,
): { requestId: string; qs: AskUserQuestionItem[]; nav: QNav | null } | null => {
  if (!sessionId) return null;
  const r = activeRequest(fleet, sessionId);
  const qs = sheetQuestions(r);
  if (!r || !qs) return null;
  return { requestId: r.id, qs, nav: liveQNav(qnav, sessionId, r.id) };
};

/** The questions of one specific request, looked up by id rather
 *  than by whichever request is active — an open answer sheet stays on the
 *  request it was opened for while others queue or resolve around it. Null once
 *  the daemon stops listing it. */
export const questionsOf = (
  fleet: Fleet,
  sessionId: string,
  requestId: string,
): AskUserQuestionItem[] | null =>
  sheetQuestions(requestsFor(fleet, sessionId).find((x) => x.id === requestId));

/** The whole `AskUserQuestion` call as a readable sheet for the `o` / `⌥o`
 *  editor view — each question numbered when there's more than one, its options
 *  numbered `1) … 2) …` with descriptions, as the request panel and the answer
 *  sheet number them. Beats dumping the raw tool JSON. */
export const formatQuestionsForEditor = (qs: AskUserQuestionItem[]): string =>
  qs
    .map((q, qi) => {
      const head = qs.length > 1 ? `${qi + 1}. ${q.question}` : q.question;
      const opts = q.options.map(
        (o, oi) => `   ${oi + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`,
      );
      return [head, ...opts].join("\n");
    })
    .join("\n\n")
    .concat("\n");

// ---- decisions -------------------------------------------------------------

/**
 * What the user decided about one request. `answers` resolves an
 * `AskUserQuestion` by allowing the tool call with the gathered answers folded
 * into the input the SDK sent, so they ride back on the shape the tool expects.
 */
export type Decision =
  | { t: "allow" }
  | { t: "deny"; message: string }
  | { t: "answer"; text: string }
  | { t: "answers"; request: SessionInteraction | undefined; answers: Record<string, string> };

/** What a submitted answer sheet decides: a free-text `question` is answered
 *  with its one answer, an `AskUserQuestion` allowed with all of them. */
export const sheetDecision = (
  request: SessionInteraction | undefined,
  answers: Record<string, string>,
): Decision =>
  request?.kind === "question"
    ? { t: "answer", text: Object.values(answers)[0] ?? "" }
    : { t: "answers", request, answers };

/** The RPC a decision becomes — pure, so the wire shape is checkable without a
 *  client and the handle below has only the guard left to get right. */
export const decisionCall = (
  sessionId: string,
  requestId: string,
  d: Decision,
  by: string,
): { method: string; params: Record<string, unknown> } => {
  const on = { id: sessionId, requestId, by };
  switch (d.t) {
    case "allow":
      return { method: "session.respondPermission", params: { ...on, decision: "allow" } };
    case "deny":
      return {
        method: "session.respondPermission",
        params: { ...on, decision: "deny", ...(d.message ? { message: d.message } : {}) },
      };
    case "answer":
      return { method: "session.answer", params: { ...on, text: d.text } };
    case "answers": {
      // The answer sheet already resolved choices to their labels; custom
      // answers travel exactly as typed.
      const raw = d.request?.kind === "user_question" ? d.request.input : undefined;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      return {
        method: "session.respondPermission",
        params: { ...on, decision: "allow", updatedInput: { ...base, answers: { ...d.answers } } },
      };
    }
  }
};

/** What the status line says once the daemon has taken the decision. */
const outcome = (d: Decision, requestId: string, already: boolean): string => {
  switch (d.t) {
    case "allow":
      return already ? `${requestId} already resolved` : `approved ${requestId}`;
    case "deny":
      return already ? `${requestId} already resolved` : `denied ${requestId}`;
    case "answer":
      return already ? "already answered" : "answered";
    case "answers":
      return already ? "already resolved" : "answered";
  }
};

// ---- the handle ------------------------------------------------------------

export interface InteractionDeps {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  /** Recorded as the actor on every decision. */
  by: string;
  /** The newest snapshots. Read on every call, never cached here. */
  fleet: () => Fleet;
}

export interface Interactions {
  /** Send `d` back for `requestId`. Resolves to a line for the status bar, or
   *  `""` when an identical decision is already in flight — a batched double
   *  keypress issues one command, not two. */
  respond: (sessionId: string, requestId: string, d: Decision) => Promise<string>;
  /** Drop the guard on every request the daemon has stopped listing. Called on
   *  each snapshot: once a request is gone it is settled, and holding its guard
   *  would only strand the id. */
  settle: () => void;
}

export const mkInteractions = ({ request, by, fleet }: InteractionDeps): Interactions => {
  // One guard per request rather than one for the whole UI: deciding on one
  // request must never block a different one, and a second request arriving
  // must not release the guard on the one still in flight.
  const acting = new Set<string>();
  const key = (sessionId: string, requestId: string): string => `${sessionId} ${requestId}`;

  return {
    respond: async (sessionId, requestId, d) => {
      const k = key(sessionId, requestId);
      if (acting.has(k)) return "";
      acting.add(k);
      const { method, params } = decisionCall(sessionId, requestId, d, by);
      try {
        const r = await request<{ alreadyResolved: boolean }>(method, params);
        return outcome(d, requestId, r.alreadyResolved);
      } catch (e) {
        // A dropped or timed-out reply may well have been applied, so keep the
        // guard until the snapshot stops listing the request — retrying would
        // answer it twice, possibly with a different answer. Anything else
        // failed outright and is the user's to retry.
        if (!isAmbiguousFailure(e)) acting.delete(k);
        throw e;
      }
    },
    settle: () => {
      if (acting.size === 0) return;
      const live = new Set<string>();
      for (const s of fleet()) for (const r of s.requests) live.add(key(s.id, r.id));
      for (const k of acting) if (!live.has(k)) acting.delete(k);
    },
  };
};
