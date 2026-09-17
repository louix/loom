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
  /** Feedback for non-chat actions and failures before a request was accepted. */
  feedback?: { pending: boolean; uncertain?: boolean; text: string };
  /** Bold caption above the input ("send", "deny req-3", a question header). */
  label: string;
  buffer: Buffer;
  /** History cursor: 0 = the live buffer, 1..N = {@link TuiState.promptHistory}
   *  counted from the newest. */
  histIdx: number;
  /** Scoped recall loaded independently of the visible transcript. */
  history?: readonly string[];
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
  /** Omitted uses the selected provider default. */
  isolation?: "vm" | "local";
}

/** Prompts that act on a session as a whole. */
export type SessionPromptKind = "send" | "title" | "comment" | "compact";
/** Prompts that resolve one outstanding request, addressed by its id. */
export type RequestPromptKind = "answer" | "deny";

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
  | (PromptEditor & { t: "questions"; sessionId: string; requestId: string })
  /** A note back about an open plan review, carrying the review itself: `Esc`
   *  puts it back exactly as it was, cycled mode and staged retarget included. */
  | (PromptEditor & { t: "discuss"; plan: PlanReview });

/** A prompt's flat name, for the per-kind display tables (placeholder text, the
 *  `⏎ …` hint). Presentation only — nothing branches on it to decide an RPC. */
export type PromptKind = "new" | "questions" | "discuss" | SessionPromptKind | RequestPromptKind;

export const promptKind = (p: Prompt): PromptKind =>
  p.t === "session" || p.t === "request" ? p.kind : p.t;

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

export const discussPrompt = (plan: PlanReview): Prompt => ({
  t: "discuss",
  plan,
  ...ed("discuss plan", ""),
});

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
export const promptTarget = (p: Prompt): { sessionId: string | null; requestId: string | null } => {
  switch (p.t) {
    case "new":
      return { sessionId: null, requestId: null };
    case "session":
      return { sessionId: p.sessionId, requestId: null };
    case "discuss":
      return { sessionId: p.plan.sessionId, requestId: p.plan.requestId };
    default:
      return { sessionId: p.sessionId, requestId: p.requestId };
  }
};
/** Where a prompt's input renders. Every prompt but `new` targets a session and
 *  draws on that session's EVENTS pane — you're replying to a specific agent,
 *  so the input sits with its transcript. `new` has no session, so it floats above
 *  the existing panes. */
export const promptOnPane = (p: Prompt | null): boolean => p !== null && p.t !== "new";

// ---------------------------------------------------------------------------
// plan review
// ---------------------------------------------------------------------------

/**
 * An open plan review: the plan text, the request it answers, the permission
 * mode the implementation will run in (`⇧⇥` cycles it), and the `f` (implement
 * fresh) retarget staged by the `⌥p` wizard — null until one is picked, and a
 * `provider` differing from the session's forks a fresh session.
 *
 * The review is a value, not a slot: a discuss prompt or a retarget picker
 * opened over it carries this whole thing, so backing out restores exactly the
 * review that was interrupted — cycled mode, staged retarget and all.
 */
export interface PlanReview {
  sessionId: string;
  requestId: string;
  text: string;
  mode: SessionMode;
  impl: { provider: string; model: string | null; effort: string | null } | null;
}

// ---------------------------------------------------------------------------
// confirmation
// ---------------------------------------------------------------------------

export type Confirm = {
  title: string;
  body?: string;
  danger: boolean;
} & (
  | { action: "restart" | "quitAll" | "gc" }
  | { action: "archiveSession"; sessionId: string }
  | { action: "forkSession"; sessionId: string; isolation: "vm" | "local" }
  | {
      action: "deleteSession";
      sessionId: string;
      /** The session's branch, when it has one — b toggles its deletion. */
      branchName?: string;
      deleteBranch?: boolean;
      /** Confirm discarding uncommitted worktree changes. */
      force?: boolean;
    }
);

// ---------------------------------------------------------------------------
// picker — provider / model / effort choice, undo, the command palette
// ---------------------------------------------------------------------------

export interface PickItem {
  id: string;
  label: string;
  hint?: string;
  /** Extra text folded into the fuzzy match (a turn's user text for `undo`). */
  blob?: string;
}

/** Which list the picker is showing. */
export type PickerStep = "provider" | "model" | "effort" | "undo" | "command" | "repository";

/**
 * What the picker is choosing *for*: where a pick lands, and what to put back
 * on screen when it unwinds. This replaces the old bag of navigation flags —
 * a picker no longer has to be asked whether it "came from" a send prompt or a
 * plan review, because it is holding the thing it came from.
 */
export type PickerDest =
  /** Steps that fold into the `new`-session prompt waiting behind them. */
  | { t: "newSession"; settings: NewSessionSettings; draft: string }
  /** Steps applied to a live session. `back` is the send prompt's text when the
   *  wizard was opened mid-message (`⌥m` / `⌥p` / `⌥t` from a send prompt), so
   *  the half-typed message comes back with the switch; null otherwise. */
  | { t: "session"; sessionId: string; back: string | null }
  /** Steps staged onto an open plan review's `impl`, for `f` (implement fresh). */
  | { t: "planImpl"; plan: PlanReview }
  /** `u` — rewind to a turn on this session. */
  | { t: "undo"; sessionId: string }
  /** The command palette; it resolves in the keymap, not here. */
  | { t: "command" }
  | { t: "repository" };

export interface Picker {
  step: PickerStep;
  title: string;
  items: PickItem[];
  /** Shown when `items` is empty (e.g. no models detected for a provider). */
  emptyText: string | null;
  /** Live filter text, as an editor buffer — the readline motions work on it. */
  filter: Buffer;
  /** Highlight into the *filtered* list. */
  index: number;
  /** Provider / model settled by earlier steps of this wizard. */
  chosen: { provider: string | null; model: string | null };
  /** The step this wizard opened at, which is how far back `Esc` can step: a
   *  bare `⌥t` opens straight at `effort` with no model list behind it, `⌥m` at
   *  `model`, `⌥p` at `provider`. Past that, `Esc` unwinds to {@link dest}. */
  from: PickerStep;
  dest: PickerDest;
}

export const makePicker = (init: {
  step: PickerStep;
  title: string;
  items: PickItem[];
  dest: PickerDest;
  emptyText?: string;
  chosen?: { provider: string | null; model: string | null };
  from?: PickerStep;
  /** Initial highlight into `items`; clamped, defaults to 0. Used to pre-select
   *  the session's current provider / model / effort in the `⌥p` wizard. */
  index?: number;
}): Picker => ({
  step: init.step,
  title: init.title,
  items: init.items,
  emptyText: init.emptyText ?? null,
  filter: buffer(),
  index: init.index !== undefined ? Math.max(0, Math.min(init.index, init.items.length - 1)) : 0,
  chosen: init.chosen ?? { provider: null, model: null },
  from: init.from ?? init.step,
  dest: init.dest,
});

/**
 * Case-insensitive subsequence match — every char of `q` appears in order.
 * The picker's matcher over short labels; the fleet filter ranks instead, in
 * the daemon (see `session.search`).
 */
const fuzzyMatch = (hay: string, q: string): boolean => {
  if (q === "") return true;
  const h = hay.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
};

/** The picker's items narrowed to the current filter (label + blob). */
export const pickerVisible = (p: Picker): PickItem[] => {
  const q = p.filter.text;
  if (q === "") return p.items;
  return p.items.filter((it) => fuzzyMatch(`${it.label} ${it.blob ?? ""}`, q));
};

/** The currently-highlighted item, honouring the filter. */
export const pickerCurrent = (p: Picker): PickItem | null => {
  const vis = pickerVisible(p);
  return vis[Math.max(0, Math.min(vis.length - 1, p.index))] ?? null;
};

// ---------------------------------------------------------------------------
// the overlay itself
// ---------------------------------------------------------------------------

/**
 * What the TUI has open over the fleet. Exactly one thing at a time, and its
 * payload is inside it — there is no "which overlay" tag that can disagree
 * with a set of nullable payload slots, and nothing to null out when the mode
 * changes. Rendering and the keymap both fold over this.
 */
export type Overlay =
  | { t: "browse" }
  | { t: "help" }
  | { t: "doctor" }
  | { t: "prompt"; prompt: Prompt }
  | { t: "confirm"; confirm: Confirm }
  | { t: "plan"; plan: PlanReview }
  | { t: "picker"; picker: Picker };

export const browse: Overlay = { t: "browse" };

/** The prompt on screen, if the overlay is one. */
export const openPrompt = (o: Overlay): Prompt | null => (o.t === "prompt" ? o.prompt : null);

/** The plan review an overlay is showing *or* holding open behind it — a
 *  discuss prompt and a retarget picker both keep the review they interrupted,
 *  and `Esc` from either puts it back. */
export const heldPlan = (o: Overlay): PlanReview | null => {
  if (o.t === "plan") return o.plan;
  if (o.t === "prompt" && o.prompt.t === "discuss") return o.prompt.plan;
  if (o.t === "picker" && o.picker.dest.t === "planImpl") return o.picker.dest.plan;
  return null;
};

/** Where a picker's destination puts the user when the wizard unwinds — the
 *  prompt or review it was opened over, rebuilt from the payload it carried. */
const closeTo = (d: PickerDest): Overlay => {
  switch (d.t) {
    case "newSession":
      return { t: "prompt", prompt: newPrompt(d.settings, d.draft) };
    case "session":
      // `back` is the send prompt's text when the wizard interrupted one.
      return d.back === null
        ? browse
        : { t: "prompt", prompt: sessionPrompt("send", d.sessionId, "send", d.back) };
    case "planImpl":
      return { t: "plan", plan: d.plan };
    default:
      return browse;
  }
};

/** Where an overlay lands when whatever it is doing is finished or abandoned:
 *  back to whatever it was opened over, or to the fleet. */
export const unwind = (o: Overlay): Overlay => {
  if (o.t === "prompt" && o.prompt.t === "discuss") return { t: "plan", plan: o.prompt.plan };
  if (o.t === "picker") return closeTo(o.picker.dest);
  return browse;
};

/**
 * The session an overlay acts on and the one request it resolves — including
 * through a prompt or picker that is holding a plan review open behind it.
 * Either is null when the overlay has none.
 */
export const overlayTarget = (
  o: Overlay,
): { sessionId: string | null; requestId: string | null } => {
  const none = { sessionId: null, requestId: null };
  switch (o.t) {
    case "prompt":
      return promptTarget(o.prompt);
    case "plan":
      return { sessionId: o.plan.sessionId, requestId: o.plan.requestId };
    case "picker":
      switch (o.picker.dest.t) {
        case "planImpl":
          return {
            sessionId: o.picker.dest.plan.sessionId,
            requestId: o.picker.dest.plan.requestId,
          };
        case "session":
        case "undo":
          return { sessionId: o.picker.dest.sessionId, requestId: null };
        default:
          return none;
      }
    default:
      return none;
  }
};

/**
 * Close an open overlay that the newest snapshot says can no longer be acted
 * on. Anything bound to a *specific* request survives only while that exact
 * request is still outstanding: answered here, answered in another window, or
 * the turn simply moved on all read the same way in a snapshot, and all three
 * mean what is on screen can no longer be acted on. Whatever replaced it is a
 * different request, and nothing typed for one is re-aimed at it.
 *
 * One function for prompts, plan reviews and pickers alike, so a removed
 * session and a resolved request cannot disagree about what is still up.
 */
export const reconcileOverlay = (
  o: Overlay,
  live: (sessionId: string) => boolean,
  outstanding: (sessionId: string, requestId: string) => boolean,
): { overlay: Overlay; notice: string | null } => {
  const at = overlayTarget(o);
  if (at.sessionId === null) return { overlay: o, notice: null };
  // A removed session already reports itself; a resolved request does not.
  if (!live(at.sessionId)) return { overlay: browse, notice: null };
  if (at.requestId !== null && !outstanding(at.sessionId, at.requestId)) {
    return { overlay: browse, notice: "that request was resolved elsewhere" };
  }
  return { overlay: o, notice: null };
};
