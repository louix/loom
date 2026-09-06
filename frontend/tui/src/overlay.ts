/**
 * Pure overlay state: what the TUI has open over the fleet, and the payload
 * that thing needs to resolve.
 *
 * The rule here is that a payload lives inside the variant that requires it. A
 * request answer cannot exist without the request it answers; a new-session
 * prompt cannot exist with one. That is what makes submitting a prompt an
 * exhaustive switch with no null guards, and what stops a stale id from being
 * re-aimed at whatever replaced it.
 */
import type { SessionMode } from "@loom/core/types";
import { buffer, type Buffer } from "./editor.ts";

/** The editor fields every prompt shares — the text and its ↑/↓ history walk. */
export interface PromptEditor {
  /** Bold caption above the input ("send", "deny req-3", a question header). */
  label: string;
  buffer: Buffer;
  /** History cursor: 0 = the live buffer, 1..N = {@link TuiState.promptHistory}
   *  counted from the newest. */
  histIdx: number;
  /** Live buffer text, stashed while browsing history. */
  draft: string;
}

/** What a `new` prompt will create its session with. `mode` is always known
 *  (⇧⇥ cycles it); the rest stay null until the ⌥p wizard settles them, and
 *  null means "let the daemon pick its default". */
export interface NewSessionSettings {
  mode: SessionMode;
  provider: string | null;
  model: string | null;
  effort: string | null;
}

/** Prompts that act on a session as a whole. */
export type SessionPromptKind = "send" | "title" | "comment" | "compact";
/** Prompts that resolve one outstanding request, addressed by its id. */
export type RequestPromptKind = "answer" | "deny" | "discuss";

export type Prompt =
  | (PromptEditor & { t: "new"; settings: NewSessionSettings })
  | (PromptEditor & { t: "session"; kind: SessionPromptKind; sessionId: string })
  | (PromptEditor & { t: "request"; kind: RequestPromptKind; sessionId: string; requestId: string })
  /**
   * One question of a multi-question `AskUserQuestion`. *Which* question, and
   * the answers gathered so far, live in {@link TuiState.qnav} rather than
   * here: they outlive the prompt, because `Esc` drops back to the request
   * panel with them intact and `a` resumes where you left off.
   */
  | (PromptEditor & { t: "questions"; sessionId: string; requestId: string });

/** A prompt's flat name, for the per-kind display tables (placeholder text, the
 *  `⏎ …` hint). Presentation only — nothing branches on it to decide an RPC. */
export type PromptKind = "new" | "questions" | SessionPromptKind | RequestPromptKind;

export const promptKind = (p: Prompt): PromptKind =>
  p.t === "new" || p.t === "questions" ? p.t : p.kind;

const ed = (label: string, text: string): PromptEditor => ({
  label,
  buffer: buffer(text),
  histIdx: 0,
  draft: "",
});

export const newPrompt = (settings: NewSessionSettings, text = ""): Prompt => ({
  t: "new",
  settings,
  ...ed("new session", text),
});

export const sessionPrompt = (
  kind: SessionPromptKind,
  sessionId: string,
  label: string,
  text = "",
): Prompt => ({ t: "session", kind, sessionId, ...ed(label, text) });

export const requestPrompt = (
  kind: RequestPromptKind,
  sessionId: string,
  requestId: string,
  label: string,
  text = "",
): Prompt => ({ t: "request", kind, sessionId, requestId, ...ed(label, text) });

export const questionsPrompt = (
  sessionId: string,
  requestId: string,
  label: string,
  text = "",
): Prompt => ({ t: "questions", sessionId, requestId, ...ed(label, text) });

/** What a prompt is aimed at: the session it acts on, and the one request it
 *  resolves. Either is `null` when the variant has none — a `new` prompt has no
 *  session, a session prompt no request. Reconciliation against a snapshot
 *  reads these; nothing else needs to ask a prompt what it targets. */
export const promptTarget = (p: Prompt): { sessionId: string | null; requestId: string | null } =>
  p.t === "new"
    ? { sessionId: null, requestId: null }
    : { sessionId: p.sessionId, requestId: p.t === "session" ? null : p.requestId };

/** Where a prompt's input renders. Every prompt but `new` targets a session and
 *  draws on that session's EVENTS pane — you're replying to a specific agent,
 *  so the input sits with its transcript. `new` has no session, so it stays in
 *  the footer. */
export const promptOnPane = (p: Prompt | null): boolean => p !== null && p.t !== "new";
