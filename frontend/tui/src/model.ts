/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import { absurd } from "@loom/core/absurd";
import type {
  AwaitReason,
  BackgroundTaskKind,
  HarnessEvent,
  SessionStateKind,
} from "@loom/core/events";
import { isClaudeId } from "@loom/core/provider-id";
import { sessionStateLabel } from "@loom/core/session-state";
import type {
  DoctorReport,
  EventPush,
  ProviderInfo,
  PushFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { buffer, type Buffer } from "./editor.ts";
import { searchSessions } from "./fleet-search.ts";
import {
  STATUS_ORDER,
  clock,
  humanTokens,
  nextThemeMode,
  shortId,
  statusLook,
  themeMode,
  truncate,
  type ThemeMode,
  type Tone,
} from "./theme.ts";

export type Connection = "connecting" | "live" | "reconnecting" | "closed";
export type UiMode = "browse" | "prompt" | "help" | "doctor" | "confirm" | "plan" | "picker";
/**
 * Keybinding grammar (see docs/keybindings.md):
 *   • bare key  → act on the selected session, or move
 *   • Shift+key → the heavier / structural sibling (Q quit-all · R restart · X delete · F fork)
 *   • Ctrl+key  → text editing only, inside the prompt (⌃a/⌃e/⌃b/⌃f/⌃u/⌃k/⌃w); ⌃c quits
 *   • Alt+key   → run an action without leaving the prompt (⌥e ⌥o ⌥p ⌥m ⌥t ⌥x)
 *   • Space     → the command palette: everything valid right now, fuzzy, with its key
 */
/** How much of the selected session's log to show:
 *   - `chat`           — just the conversation (tool traffic and thinking
 *                        collapsed to one-line markers)
 *   - `chat_and_tools` — conversation plus each individual tool call, but not
 *                        its output
 *   - `everything`     — the raw log, unfiltered */
export type LogFilter = "chat" | "chat_and_tools" | "everything";

/** `v` cycles through {@link LogFilter} in this order. */
export const cycleLogFilter = (f: LogFilter): LogFilter => {
  switch (f) {
    case "chat":
      return "chat_and_tools";
    case "chat_and_tools":
      return "everything";
    default:
      return "chat";
  }
};

/** Human label for what pressing `v` would switch the event log *to*. */
export const logFilterLabel = (f: LogFilter): string => {
  switch (f) {
    case "chat":
      return "chat only";
    case "chat_and_tools":
      return "chat + tool calls";
    case "everything":
      return "show everything";
    default:
      return absurd(f);
  }
};

/** Compact label for the *current* filter, as shown in the event-log header. */
export const logFilterTag = (f: LogFilter): string => {
  switch (f) {
    case "everything":
      return "full";
    case "chat_and_tools":
      return "chat+tools";
    default:
      return "chat";
  }
};

export interface DaemonInfo {
  pid: number;
  version: string;
  repoRoot: string;
}

export interface LogLine {
  seq: number;
  /**
   * The daemon epoch that issued {@link seq} — seq resets on every daemon
   * restart, so (epoch, seq) is the real frame identity and the dedupe key.
   * `""` for locally synthesised lines (echoes).
   */
  epoch: string;
  sessionId: string;
  /** The event kind, so `chat` view can collapse tool / thinking runs. */
  kind: HarnessEvent["type"] | "echo";
  /** Sub-agent that produced the event, when applicable. */
  agentId?: string;
  glyph: string;
  /** Compact one-liner for the log pane (may be truncated). */
  text: string;
  /**
   * The event's full body, newlines intact — for the `o` / `⌥o` editor view. The pane
   * itself renders it in full too (wrapped, never clipped). Omitted when it
   * would just equal {@link text}.
   */
  full?: string;
  /** For `tool_call`: the input's `description` field, when the tool provided one
   *  (e.g. Bash) — used by the `chat` view instead of a generic count. */
  toolDescription?: string;
  tone: Tone;
  ts: number;
}

export interface Notice {
  text: string;
  tone: Tone;
  at: number;
}

export type PromptKind =
  | "send"
  | "answer"
  | "answerQuestion"
  | "deny"
  | "new"
  | "title"
  | "discuss"
  | "compact";

export interface PromptState {
  kind: PromptKind;
  /** Target session; `null` only for `new`. */
  sessionId: string | null;
  /** Permission / question id, for `answer` and `deny`. */
  requestId?: string;
  label: string;
  buffer: Buffer;
  /** Permission mode for the session to be created — `new` only. */
  mode?: SessionMode;
  /** Provider / model for the session to be created — `new` via the `N` flow. */
  provider?: string;
  model?: string;
  /** Thinking effort for the session to be created, when the model takes one. */
  effort?: string;
  /** History cursor: 0 = the live buffer, 1..N = {@link TuiState.promptHistory} from newest. */
  histIdx: number;
  /** Live buffer text, stashed while browsing history. */
  draft: string;
  /** `answerQuestion` only: every question from this `AskUserQuestion` call, in
   *  order — the prompt shows them one at a time rather than all at once. */
  qaAll?: AskUserQuestionItem[];
  /** `answerQuestion` only: index into {@link qaAll} of the question this prompt
   *  is currently collecting. `⇥` / `⇧⇥` (also `⌥→` / `⌥←`) move between them in
   *  any order; `Enter` jumps to the next one still unanswered and resolves the
   *  permission once none are left. */
  qaIdx?: number;
  /** `answerQuestion` only: answers collected so far, keyed by question text —
   *  carried as you move between questions so nothing typed is lost. */
  qaAnswers?: Record<string, string>;
}

export const makePrompt = (init: {
  kind: PromptKind;
  sessionId: string | null;
  requestId?: string;
  label: string;
  text?: string;
  mode?: SessionMode;
  /** For `new`: the provider / model / effort chosen in the `N` picker flow. */
  provider?: string;
  model?: string;
  effort?: string;
  qaAll?: AskUserQuestionItem[];
  qaIdx?: number;
  qaAnswers?: Record<string, string>;
}): PromptState => {
  return {
    kind: init.kind,
    sessionId: init.sessionId,
    label: init.label,
    ...(init.requestId ? { requestId: init.requestId } : {}),
    ...(init.mode ? { mode: init.mode } : {}),
    ...(init.provider ? { provider: init.provider } : {}),
    ...(init.model ? { model: init.model } : {}),
    ...(init.effort ? { effort: init.effort } : {}),
    ...(init.qaAll ? { qaAll: init.qaAll } : {}),
    ...(init.qaIdx !== undefined ? { qaIdx: init.qaIdx } : {}),
    ...(init.qaAnswers ? { qaAnswers: init.qaAnswers } : {}),
    buffer: buffer(init.text ?? ""),
    histIdx: 0,
    draft: "",
  };
};

/**
 * Where a prompt's input renders. Every session-targeted prompt (send, answer,
 * deny, rename, discuss, compact) draws on that session's EVENTS pane — you're
 * replying to a specific agent, so the input sits with its transcript. Only the
 * sessionless `new` prompt stays in the footer.
 */
export const promptOnPane = (p: PromptState | null | undefined): boolean => {
  return p?.sessionId != null;
};

// ---------------------------------------------------------------------------
// picker overlay — provider choice, model choice, undo, the command palette
// ---------------------------------------------------------------------------

export interface PickItem {
  id: string;
  label: string;
  hint?: string;
  /** Extra text folded into the fuzzy match (a turn's user text for `undo`). */
  blob?: string;
}

export interface PickerState {
  kind: "provider" | "model" | "effort" | "undo" | "command";
  title: string;
  items: PickItem[];
  /** Shown when `items` is empty (e.g. no models detected for a provider). */
  emptyText?: string;
  /** Live filter text, as an editor buffer — the readline motions work on it. */
  filter: Buffer;
  /** Highlight into the *filtered* list. */
  index: number;
  /** Carried context: provider id from the provider step; `model` id from the
   *  model step, for an `effort` step that follows it; `liveSessionId` for a
   *  live `⌥m` / `⌥t` switch; `draft` restores a half-typed prompt after the
   *  detour; `reopenSend` returns to that session's send prompt afterwards.
   *  `viaModelStep` marks an `effort` step reached by picking a model that
   *  takes one (⌥p wizard, or ⌥m onto such a model) — `Esc` there steps back
   *  to that model list. A bare ⌥t skips straight to `effort` with no model
   *  step to return to, so `Esc` closes (or restores the prompt) instead. */
  ctx?: {
    provider?: string;
    model?: string;
    liveSessionId?: string;
    draft?: string;
    reopenSend?: string;
    viaModelStep?: boolean;
    /** The provider→model→effort wizard was opened from the plan-review overlay
     *  (`⌥p`); each step resolves by staging onto `state.plan.impl`, not a live
     *  switch or a `new` prompt, and `Esc` returns to the overlay. */
    planStage?: true;
    /** The `model` step was reached from a live provider step (`⌥p` mid-chat)
     *  — `Esc` there steps back to the provider list rather than closing. */
    viaProviderStep?: boolean;
  };
}

export const makePicker = (init: {
  kind: PickerState["kind"];
  title: string;
  items: PickItem[];
  emptyText?: string;
  ctx?: PickerState["ctx"];
  /** Initial highlight into `items`; clamped, defaults to 0. Used to pre-select
   *  the session's current provider / model / effort in the `⌥p` wizard. */
  index?: number;
}): PickerState => {
  return {
    kind: init.kind,
    title: init.title,
    items: init.items,
    filter: buffer(),
    index: init.index !== undefined ? Math.max(0, Math.min(init.index, init.items.length - 1)) : 0,
    ...(init.emptyText ? { emptyText: init.emptyText } : {}),
    ...(init.ctx ? { ctx: init.ctx } : {}),
  };
};

/**
 * Case-insensitive subsequence match — every char of `q` appears in order.
 * The command palette's matcher over short labels; the fleet filter ranks
 * instead (see `searchSessions`).
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
export const pickerVisible = (p: PickerState): PickItem[] => {
  const q = p.filter.text;
  if (q === "") return p.items;
  return p.items.filter((it) => fuzzyMatch(`${it.label} ${it.blob ?? ""}`, q));
};

/** The currently-highlighted item, honouring the filter. */
export const pickerCurrent = (p: PickerState): PickItem | null => {
  const vis = pickerVisible(p);
  return vis[Math.max(0, Math.min(vis.length - 1, p.index))] ?? null;
};

export interface ConfirmState {
  title: string;
  body?: string;
  danger: boolean;
  action: "restart" | "quitAll" | "deleteSession" | "archiveSession" | "gc";
  /** Target session for `deleteSession` / `archiveSession`. */
  sessionId?: string;
  /** `deleteSession`: the session's branch, when it has one — `b` toggles
   *  whether it's deleted along with the row + worktree. */
  branchName?: string;
  deleteBranch?: boolean;
  /** `deleteSession`: the worktree had uncommitted changes — confirming the
   *  delete also discards those, so the request passes `force`. */
  force?: boolean;
}

export interface PendingPerm {
  id: string;
  tool: string;
  input: unknown;
}

/**
 * Outstanding round-trips per session, recovered from the event stream — the
 * ids to answer with, plus enough of the request to show what it's asking.
 * `permissions` is a queue: parallel tool calls in one step each raise their
 * own `permission_request`, and the turn stays blocked until every one is
 * answered. `ask_user` / `ExitPlanMode` don't parallelise, so those stay single.
 */
export interface Pending {
  permissions?: PendingPerm[];
  question?: string;
  questionText?: string;
  questionContext?: string;
  plan?: string;
  planText?: string;
}

/** The permission request the UI should surface next (FIFO). */
export const firstPerm = (p: Pending): PendingPerm | undefined => {
  return p.permissions?.[0];
};

/**
 * Keep only the surface the daemon says the session is parked on. `pending` is
 * reconstructed from the event stream, and not every resolution leaves a mark
 * there (a plan approved on another client / before a reconnect never emits
 * one), so a stale entry can outlive the request it describes. `status.on` is
 * the daemon's own outstanding-request map — authoritative for what the turn
 * is blocked on *now* — so when it matches something we hold, drop the rest.
 * An `on` with nothing matching (or none at all) keeps everything.
 */
export const focusedPending = (p: Pending, on: AwaitReason | null): Pending => {
  if (!on) return p;
  if (on === "plan_review" && p.plan !== undefined)
    return { plan: p.plan, ...(p.planText ? { planText: p.planText } : {}) };
  if (on === "question" && p.question !== undefined)
    return {
      question: p.question,
      ...(p.questionText ? { questionText: p.questionText } : {}),
      ...(p.questionContext ? { questionContext: p.questionContext } : {}),
    };
  if ((on === "permission" || on === "user_question") && p.permissions && p.permissions.length > 0)
    return { permissions: p.permissions };
  return p;
};

/** One question from an `AskUserQuestion` tool call, narrowed for display. */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
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
    });
  }
  return out;
};

/**
 * In-progress answering of a multi-question `AskUserQuestion`. Lives outside the
 * answer prompt so it survives the prompt closing: `Esc` drops back to the
 * request panel, where `←` / `→` move between questions, and `a` re-opens the
 * prompt on whichever one is shown. Answers gathered so far are kept keyed by
 * question text; the permission resolves once every question has one.
 */
export interface QNav {
  sessionId: string;
  requestId: string;
  /** Which question the panel previews and the next `a` opens. */
  idx: number;
  /** Answers gathered so far, keyed by question text. */
  answers: Record<string, string>;
}

/** `nav`, but only if it still describes the request `sid` / `rid` is parked
 *  on — a stale nav (resolved request, or a different session) reads as none. */
export const liveQNav = (
  nav: QNav | null | undefined,
  sid: string | null | undefined,
  rid: string | null | undefined,
): QNav | null =>
  nav && sid && rid && nav.sessionId === sid && nav.requestId === rid ? nav : null;

export interface TuiState {
  connection: Connection;
  theme: ThemeMode;
  daemon: DaemonInfo | null;
  /** Configured providers, from `providers.list` at connect time. */
  providers: ProviderInfo[];
  sessions: SessionSnapshot[];
  selectedId: string | null;
  /**
   * A session just picked (create / fork / find) whose row hasn't landed in
   * `sessions` yet — its `session_updated` push can trail the RPC response.
   * `clampSelection` keeps `selectedId` on this id even while it's absent, so
   * an unrelated `session_updated` in that window can't bounce the user to the
   * fleet head (U4). Cleared once the id appears (or is removed).
   */
  pendingSelectId?: string | undefined;
  /**
   * The focused child of the selected session — a {@link FleetChild} key from
   * `childrenOf`, i.e. background work (async subagent, backgrounded shell) or
   * an in-flight foreground sub-agent. Non-null = "drilled in": ↑/↓ moves
   * between that session's children and the event pane narrows to just that
   * child's stream. Cleared by ←/Esc (`childExit`), by an explicit `select`,
   * and whenever churn empties the child list (`clampChild`).
   */
  selectedChild: string | null;
  /** Every event across every session, oldest first — never truncated: the
   *  daemon has the durable copy, but this is what's actually rendered, so a
   *  cap here would silently cut off history (a busy session evicting a quiet
   *  one's transcript). */
  log: LogLine[];
  logFilter: LogFilter;
  pending: Record<string, Pending>;
  /** Follow-up messages typed at a still-running session, awaiting its next idle. */
  queue: Record<string, string[]>;
  /** Sessions with a compaction in flight → when it started (for a live "compacting… Ns"). */
  compacting: Record<string, { startedAt: number; generated: number; before: number }>;
  notice: Notice | null;
  mode: UiMode;
  /** The last `daemon.doctor` snapshot, shown by the doctor overlay. Fetched
   *  on open; kept between opens so a reopen paints immediately. */
  doctor: DoctorReport | null;
  prompt: PromptState | null;
  confirm: ConfirmState | null;
  /**
   * An open plan-review overlay: the plan text + the ids to resolve it with,
   * plus the permission mode the implementation will run in (`⇧⇥` cycles it).
   * `impl` is the `f` (implement fresh) retarget staged by `⌥p` — absent until
   * the user picks one; a differing `provider` forks a fresh session.
   */
  plan: {
    sessionId: string;
    requestId: string;
    text: string;
    mode: SessionMode;
    impl?: { provider: string; model?: string; effort?: string };
  } | null;
  /** An open picker overlay (provider / model / undo, or the command palette). */
  picker: PickerState | null;
  /**
   * The fleet filter (`/`) — a single-line query that narrows the FLEET list
   * in place and ranks it: title hits first, then your messages, then the
   * agent's; space-separated terms are AND'd and `'term` pins a literal
   * substring. ↑/↓ keep moving the session selection while it's up; ⏎ accepts
   * (keeping enter's fleet-row meaning) and esc clears. null = closed.
   */
  find: { buffer: Buffer } | null;
  /** In-progress answers for a multi-question `AskUserQuestion` — see
   *  {@link QNav}. Persists across the answer prompt opening and closing. */
  qnav: QNav | null;
  /** Submitted `new` / `send` prompts, oldest first, for ↑/↓ recall. */
  promptHistory: string[];
  /**
   * The last unsubmitted `new` / `send` buffer, kept after an `Esc` cancel so
   * reopening either prompt (whichever one the user meant) restores it. Cleared
   * once the text is actually sent.
   */
  lastDraft: string;
  /** Tool name for every in-flight `tool_call`, keyed by its id — looked up
   *  when the matching `tool_result` lands so tool-aware formatting (Read's
   *  result staying terse, an Edit rendering as a diff) doesn't need the
   *  event itself to carry the name. */
  toolNames: Record<string, string>;
}

export const initialState = (): TuiState => {
  return {
    connection: "connecting",
    // The active theme — a theme restored from `.loom/tui.json` was applied
    // via `setThemeMode` before the handle built its initial state.
    theme: themeMode(),
    daemon: null,
    providers: [],
    sessions: [],
    selectedId: null,
    selectedChild: null,
    log: [],
    logFilter: "everything",
    pending: {},
    queue: {},
    compacting: {},
    notice: null,
    mode: "browse",
    doctor: null,
    prompt: null,
    confirm: null,
    plan: null,
    picker: null,
    find: null,
    qnav: null,
    promptHistory: [],
    lastDraft: "",
    toolNames: {},
  };
};

/**
 * What a TUI should do when it finds the daemon on a different build than
 * itself. A restart fixes the mismatch but interrupts *every* attached client
 * and running turn, so it's only unattended when this UI is alone with no live
 * work. `nag` = we already prompted/tried once; just remind.
 */
export type VersionAction = "ok" | "auto-restart" | "prompt" | "nag";

export const versionMismatchAction = (o: {
  daemonVersion: string | null | undefined;
  uiVersion: string;
  otherClients: number;
  liveSessions: number;
  alreadyHandled: boolean;
}): VersionAction => {
  if (!o.daemonVersion || o.daemonVersion === o.uiVersion) return "ok";
  if (o.alreadyHandled) return "nag";
  if (o.otherClients > 0 || o.liveSessions > 0) return "prompt";
  return "auto-restart";
};

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export type Action =
  | { t: "hello"; daemon: DaemonInfo; sessions: SessionSnapshot[] }
  | { t: "providers"; list: ProviderInfo[] }
  | { t: "sessions"; sessions: SessionSnapshot[] }
  | { t: "push"; frame: PushFrame; replay?: boolean }
  | { t: "backfill"; frames: readonly EventPush[] }
  | { t: "connection"; value: Connection }
  | { t: "toggleTheme" }
  | { t: "move"; delta: number }
  | { t: "select"; id: string }
  | { t: "selectChild"; sessionId: string; key: string }
  | { t: "childEnter" }
  | { t: "childExit" }
  | { t: "childMove"; delta: number }
  | { t: "logFilter"; value: LogFilter }
  | { t: "notice"; text: string; tone: Tone }
  | { t: "expireNotice"; now: number; ttlMs?: number }
  | { t: "openPrompt"; prompt: PromptState }
  | { t: "promptSet"; buffer: Buffer }
  | { t: "promptCycleMode" }
  | { t: "promptHistoryNav"; dir: -1 | 1 }
  | { t: "pushHistory"; text: string }
  | { t: "closePrompt"; saveDraft?: boolean }
  | { t: "echo"; line: LogLine }
  | { t: "enqueue"; sessionId: string; text: string }
  | { t: "dequeue"; sessionId: string }
  | { t: "clearQueue"; sessionId: string }
  | { t: "openPlan"; sessionId: string; requestId: string; text: string }
  | { t: "closePlan" }
  | { t: "cyclePlanMode" }
  | { t: "stagePlanImpl"; provider: string; model?: string; effort?: string }
  | { t: "openConfirm"; confirm: ConfirmState }
  | { t: "toggleConfirmBranch" }
  | { t: "closeConfirm" }
  | { t: "openPicker"; picker: PickerState }
  | { t: "pickerFilter"; buffer: Buffer }
  | { t: "pickerMove"; delta: number }
  | { t: "closePicker" }
  | { t: "openFind" }
  | { t: "findSet"; buffer: Buffer }
  | { t: "closeFind" }
  | { t: "resolvePerm"; sessionId: string; id: string }
  | { t: "modeOptimistic"; sessionId: string; mode: SessionMode }
  | { t: "qnavSet"; nav: QNav | null }
  | { t: "help"; value: boolean }
  | { t: "doctor"; value: boolean }
  | { t: "doctorLoaded"; report: DoctorReport };

/**
 * Ceiling on `state.log`. It accumulates every echo / notice / event line for
 * the whole session and is never otherwise pruned. The event pane measures and
 * renders a window of the wrapped rows (never the whole list), so the cap is a
 * memory bound — roughly 20MB of retained event text per 10k lines in a
 * tool-heavy session — not a scroll limit: paging back reaches the start of
 * anything below it.
 */
export const LOG_CAP = 100_000;

/** Append one line to the log, trimming the oldest once past {@link LOG_CAP}. */
const appendLog = (log: readonly LogLine[], line: LogLine): LogLine[] => {
  const next = [...log, line];
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
};

export const reduce = (s: TuiState, a: Action): TuiState => {
  switch (a.t) {
    case "providers":
      return { ...s, providers: a.list };

    case "hello": {
      const sessions = sortSessions(a.sessions);
      return {
        ...s,
        connection: "live",
        daemon: a.daemon,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId),
        ...settlePendingSelect(s, sessions),
        selectedChild: clampChild(sessions, s.selectedId, s.selectedChild),
        pending: pruneSettledPending(pruneByLive(s.pending, sessions), sessions),
        queue: pruneByLive(s.queue, sessions),
        compacting: rebaseCompacting(pruneByLive(s.compacting, sessions), sessions),
      };
    }

    case "sessions": {
      // Rebase, don't blindly replace: a `session.list` response that was in
      // flight while a `session_updated` push landed would otherwise overwrite
      // the newer per-session state with the older snapshot. Keep whichever
      // row has the more recent `updatedAt`.
      const prev = new Map(s.sessions.map((x) => [x.id, x]));
      const merged = a.sessions.map((next) => {
        const cur = prev.get(next.id);
        return cur && cur.updatedAt > next.updatedAt ? cur : next;
      });
      const sessions = sortSessions(merged);
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId),
        ...settlePendingSelect(s, sessions),
        selectedChild: clampChild(sessions, s.selectedId, s.selectedChild),
        pending: pruneSettledPending(pruneByLive(s.pending, sessions), sessions),
        queue: pruneByLive(s.queue, sessions),
        compacting: rebaseCompacting(pruneByLive(s.compacting, sessions), sessions),
      };
    }

    case "push":
      return applyPush(s, a.frame, a.replay === true);

    case "backfill":
      return applyBackfill(s, a.frames);

    case "connection":
      return { ...s, connection: a.value };

    case "toggleTheme":
      return { ...s, theme: nextThemeMode(s.theme) };

    case "move": {
      // With the fleet filter up, ↑/↓ walk the matching sessions in relevance
      // order — the rows the fleet is actually showing. Off-list (the
      // selection was filtered out), ↓ lands on the best match and ↑ on the
      // last.
      const find = s.find;
      const list = find ? searchSessions(s, find.buffer.text).map((m) => m.session) : s.sessions;
      if (list.length === 0) return s;
      let from = list.findIndex((x) => x.id === s.selectedId);
      if (from < 0) from = a.delta < 0 ? list.length : -1;
      const next = Math.max(0, Math.min(list.length - 1, from + a.delta));
      const picked = list[next];
      if (!picked || picked.id === s.selectedId) return s;
      return { ...s, selectedId: picked.id, selectedChild: null };
    }

    case "select": {
      // Optimistic: a freshly-created / forked session may not be in `sessions`
      // yet (its `session_updated` push can trail the RPC response). Record it
      // as the pending selection so `clampSelection` holds it until it arrives.
      // A different session invalidates any child focus along with it.
      if (a.id === s.selectedId) return s;
      const known = s.sessions.some((x) => x.id === a.id);
      return {
        ...s,
        selectedId: a.id,
        selectedChild: null,
        // Resolve any prior pending hold: a new pick either targets a known
        // session (no hold) or becomes the new hold.
        pendingSelectId: known ? undefined : a.id,
      };
    }

    case "selectChild": {
      // A click on a child row: select its session and focus that child. Guard
      // the key against a stale hit map — fall back to the first live sibling
      // (childEnter's semantics) if it's gone.
      const sess = s.sessions.find((x) => x.id === a.sessionId) ?? null;
      const kids = sess ? childrenOf(sess) : [];
      const child = kids.some((k) => k.key === a.key) ? a.key : (kids[0]?.key ?? null);
      return {
        ...s,
        selectedId: a.sessionId,
        selectedChild: child,
        pendingSelectId: sess ? undefined : a.sessionId,
      };
    }

    case "childEnter": {
      const sel = selectedSession(s);
      const kids = sel ? childrenOf(sel) : [];
      if (kids.length === 0) return s;
      // Re-entering restores the remembered child while it's still live;
      // otherwise the cursor lands on the first one.
      const again = s.selectedChild != null && kids.some((k) => k.key === s.selectedChild);
      return { ...s, selectedChild: again ? s.selectedChild : kids[0]!.key };
    }

    case "childExit":
      return s.selectedChild == null ? s : { ...s, selectedChild: null };

    case "childMove": {
      const sel = selectedSession(s);
      const kids = sel ? childrenOf(sel) : [];
      if (kids.length === 0) return s;
      const from = Math.max(
        0,
        kids.findIndex((k) => k.key === s.selectedChild),
      );
      const next = Math.max(0, Math.min(kids.length - 1, from + a.delta));
      return { ...s, selectedChild: kids[next]!.key };
    }

    case "logFilter":
      return { ...s, logFilter: a.value };

    case "notice":
      return { ...s, notice: { text: a.text, tone: a.tone, at: Date.now() } };

    case "expireNotice":
      if (!s.notice) return s;
      return a.now - s.notice.at >= (a.ttlMs ?? 4000) ? { ...s, notice: null } : s;

    case "openPrompt":
      return { ...s, mode: "prompt", prompt: a.prompt, confirm: null };

    case "promptSet": {
      const p = s.prompt;
      if (!p) return s;
      // Editing a recalled history entry detaches it from the walk: the text
      // becomes the live buffer (histIdx 0) — ↓ can't yank it back to the
      // stashed draft, and ↑ restarts from the newest entry. A cursor-only
      // move (same text) keeps the walk position.
      const histIdx = a.buffer.text !== p.buffer.text ? 0 : p.histIdx;
      return { ...s, prompt: { ...p, buffer: a.buffer, histIdx } };
    }

    case "promptCycleMode": {
      if (!s.prompt || s.prompt.kind !== "new") return s;
      const cur = s.prompt.mode ?? "default";
      const next =
        SESSION_MODES[(SESSION_MODES.indexOf(cur) + 1) % SESSION_MODES.length] ?? "default";
      return { ...s, prompt: { ...s.prompt, mode: next } };
    }

    case "promptHistoryNav": {
      if (!s.prompt || s.promptHistory.length === 0) return s;
      const p = s.prompt;
      // At the live buffer there is nothing newer — ↓ must not clobber it
      // with the stashed draft.
      if (p.histIdx === 0 && a.dir === 1) return s;
      const draft = p.histIdx === 0 ? p.buffer.text : p.draft;
      const idx = Math.max(
        0,
        Math.min(s.promptHistory.length, p.histIdx + (a.dir === -1 ? 1 : -1)),
      );
      const text = idx === 0 ? draft : (s.promptHistory[s.promptHistory.length - idx] ?? "");
      return { ...s, prompt: { ...p, histIdx: idx, draft, buffer: buffer(text) } };
    }

    case "pushHistory": {
      const t = a.text.trim();
      if (!t) return s;
      const hist = s.promptHistory.filter((x) => x !== t);
      hist.push(t);
      if (hist.length > 50) hist.splice(0, hist.length - 50);
      return { ...s, promptHistory: hist };
    }

    case "closePrompt": {
      const p = s.prompt;
      const draftable = p && (p.kind === "new" || p.kind === "send");
      let lastDraft = s.lastDraft;
      if (draftable) lastDraft = a.saveDraft ? p.buffer.text : "";
      return { ...s, mode: "browse", prompt: null, lastDraft };
    }

    case "echo":
      return { ...s, log: appendLog(s.log, a.line) };

    case "enqueue": {
      const t = a.text.trim();
      if (!t) return s;
      return { ...s, queue: { ...s.queue, [a.sessionId]: [...(s.queue[a.sessionId] ?? []), t] } };
    }

    case "dequeue": {
      const cur = s.queue[a.sessionId];
      if (!cur || cur.length === 0) return s;
      const rest = cur.slice(1);
      return {
        ...s,
        queue: rest.length ? { ...s.queue, [a.sessionId]: rest } : without(s.queue, a.sessionId),
      };
    }

    case "clearQueue":
      return a.sessionId in s.queue ? { ...s, queue: without(s.queue, a.sessionId) } : s;

    case "openPlan": {
      // A reopen of the same review (esc out of the discuss prompt) keeps the
      // permission mode already cycled to and the `⌥p` retarget already staged,
      // rather than resetting them.
      const sameReview =
        s.plan && s.plan.sessionId === a.sessionId && s.plan.requestId === a.requestId
          ? s.plan
          : null;
      return {
        ...s,
        mode: "plan",
        plan: {
          sessionId: a.sessionId,
          requestId: a.requestId,
          text: a.text,
          mode: sameReview ? sameReview.mode : "acceptEdits",
          ...(sameReview?.impl ? { impl: sameReview.impl } : {}),
        },
        prompt: null,
      };
    }

    case "closePlan":
      return { ...s, mode: s.mode === "plan" ? "browse" : s.mode, plan: null };

    case "stagePlanImpl":
      return s.plan
        ? {
            ...s,
            mode: "plan",
            picker: null,
            plan: {
              ...s.plan,
              impl: {
                provider: a.provider,
                ...(a.model ? { model: a.model } : {}),
                ...(a.effort ? { effort: a.effort } : {}),
              },
            },
          }
        : s;

    case "cyclePlanMode": {
      if (!s.plan) return s;
      // The modes an implementation can run in — `plan` itself is excluded.
      const order: readonly SessionMode[] = ["default", "acceptEdits", "auto"];
      const mode = order[(order.indexOf(s.plan.mode) + 1) % order.length] ?? "acceptEdits";
      return { ...s, plan: { ...s.plan, mode } };
    }

    case "openConfirm":
      return { ...s, mode: "confirm", confirm: a.confirm };

    case "toggleConfirmBranch":
      return s.confirm && s.confirm.branchName
        ? { ...s, confirm: { ...s.confirm, deleteBranch: !s.confirm.deleteBranch } }
        : s;

    case "closeConfirm":
      return { ...s, mode: "browse", confirm: null };

    case "openPicker":
      // `plan` rides through: the `⌥p` retarget wizard opens over an open plan
      // review and `closePicker` / `stagePlanImpl` return to it.
      return { ...s, mode: "picker", picker: a.picker, prompt: null, confirm: null };

    case "pickerFilter":
      return s.picker ? { ...s, picker: { ...s.picker, filter: a.buffer, index: 0 } } : s;

    case "pickerMove": {
      if (!s.picker) return s;
      const n = pickerVisible(s.picker).length;
      if (n === 0) return s;
      const next = Math.max(0, Math.min(n - 1, s.picker.index + a.delta));
      return next === s.picker.index ? s : { ...s, picker: { ...s.picker, index: next } };
    }

    case "closePicker": {
      // An `⌥p` wizard cancelled with `Esc` drops back to the plan review it
      // opened over, not to browse.
      const back: UiMode = s.plan ? "plan" : "browse";
      return { ...s, mode: s.mode === "picker" ? back : s.mode, picker: null };
    }

    case "openFind":
      return { ...s, find: { buffer: buffer() } };

    case "findSet": {
      if (!s.find) return s;
      const next = { ...s, find: { buffer: a.buffer } };
      // As the query narrows, ride the selection onto the best-ranked match
      // (fzf-style) — the Detail / EVENTS panes then follow the row the
      // filter is pointing at. An empty query (or no match) leaves the
      // selection be; a selection that still matches stays put, so it doesn't
      // fight ↑/↓ walking the ranked rows.
      const q = a.buffer.text;
      if (q === "") return next;
      const matches = searchSessions(s, q);
      if (matches.length === 0 || matches.some((m) => m.session.id === s.selectedId)) return next;
      return { ...next, selectedId: matches[0]!.session.id, selectedChild: null };
    }

    case "closeFind":
      return s.find ? { ...s, find: null } : s;

    case "resolvePerm": {
      const qnav = liveQNav(s.qnav, a.sessionId, a.id) ? null : s.qnav;
      const cur = s.pending[a.sessionId];
      if (!cur?.permissions) return qnav === s.qnav ? s : { ...s, qnav };
      const rest = cur.permissions.filter((p) => p.id !== a.id);
      const { permissions: _drop, ...others } = cur;
      return {
        ...s,
        qnav,
        pending: {
          ...s.pending,
          [a.sessionId]: rest.length ? { ...others, permissions: rest } : others,
        },
      };
    }

    // Local-only, ahead of the round trip: `session.setMode` is debounced in
    // fleet-handle, so the chip must update on its own for cycling to feel
    // responsive. The authoritative `session_updated` push that eventually
    // lands (settled mode, from the debounced RPC) simply overwrites this.
    case "modeOptimistic": {
      const sessions = s.sessions.map((x) => (x.id === a.sessionId ? { ...x, mode: a.mode } : x));
      return { ...s, sessions };
    }

    case "qnavSet":
      return { ...s, qnav: a.nav };

    case "help":
      return { ...s, mode: a.value ? "help" : "browse" };

    case "doctor":
      return { ...s, mode: a.value ? "doctor" : "browse" };

    case "doctorLoaded":
      return { ...s, doctor: a.report };

    default:
      return absurd(a);
  }
};

const applyPush = (s: TuiState, frame: PushFrame, replay = false): TuiState => {
  switch (frame.type) {
    case "event": {
      const ev = frame.event;
      // A frame may arrive twice around startup (history backfill overlapping
      // the live stream) — (epoch, seq) is authoritative, so drop the repeat
      // whole.
      const epoch = frame.epoch ?? "";
      // Live path: an O(n) log scan to drop a frame that arrived twice (history
      // backfill overlapping the live stream). A `replay` frame skips it — the
      // backfill caller has already filtered against the log by (epoch, seq),
      // so this would be O(N·log) for nothing (U1).
      if (!replay && frame.seq > 0 && s.log.some((l) => l.seq === frame.seq && l.epoch === epoch)) {
        return s;
      }
      const pending = trackPending(s.pending, ev);
      const compacting = trackCompacting(s.compacting, ev);
      // A backfilled frame is *transcript*, not a live event (U2): re-running
      // `noticeForEvent` would flash a long-settled "Bash needs approval" /
      // "error: …" on the notice line for 4s. `pending` / `compacting` still
      // track (a genuinely-outstanding permission must still show on reopen —
      // a settled one is pruned when the session snapshot lands, see the
      // `hello` / `sessions` reducers).
      const notice = replay ? s.notice : (noticeForEvent(s, ev) ?? s.notice);
      // `status_changed` is already shown live in the detail / fleet panes;
      // keep it out of the log so the log reads as a transcript. `compact_progress`
      // is a bare heartbeat — it drives the "compacting…" indicator, nothing more.
      if (ev.type === "status_changed") return { ...s, pending, compacting, notice };
      if (ev.type === "compact_progress") return { ...s, compacting, notice };
      // The live background-task set — surfaced via the session status (the
      // `working_background` group) and the fleet's nested task rows, not the
      // transcript. REPLACE-semantics level signal, not a conversational entry.
      if (ev.type === "background_tasks") return { ...s, pending, compacting, notice };
      // Account-plan usage — surfaced live via the session snapshot's
      // `rateLimits`, not the transcript; it isn't a conversational entry.
      if (ev.type === "rate_limit") return { ...s, pending, compacting, notice };
      // Remember each tool_call's name by id so its later tool_result can be
      // formatted tool-aware (an Edit's diff needs no lookup — its own event
      // already carries the name — but a Read's terse result does).
      let toolNames = s.toolNames;
      let toolName: string | undefined;
      if (ev.type === "tool_call") {
        toolNames = { ...toolNames, [ev.id]: ev.name };
      } else if (ev.type === "tool_result") {
        toolName = toolNames[ev.id];
        if (toolName !== undefined) toolNames = without(toolNames, ev.id);
      }
      const log = appendLog(s.log, toLogLine(frame.seq, epoch, ev, toolName));
      return { ...s, log, pending, compacting, notice, toolNames };
    }
    case "session_updated": {
      const rest = s.sessions.filter((x) => x.id !== frame.session.id);
      const sessions = sortSessions([...rest, frame.session]);
      // Any outstanding round-trip is settled once the session leaves awaiting_input.
      const settled = frame.session.status.kind !== "awaiting_input";
      const pending = settled ? without(s.pending, frame.session.id) : s.pending;
      // An open plan overlay for a session that has moved on is stale — drop it.
      const planGone = settled && s.plan?.sessionId === frame.session.id;
      // A compaction that started before this client attached shows up on the
      // snapshot — see rebaseCompacting (drainQueues holds queued sends on it).
      const compacting = rebaseCompacting(s.compacting, [frame.session]);
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId),
        ...settlePendingSelect(s, sessions),
        pending,
        compacting,
        ...(planGone
          ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode }
          : {}),
      };
    }
    case "providers_updated": {
      // The daemon's remembered new-session defaults changed, or the start-up
      // model probes settled — adopt the fresh list. A provider/model picker
      // opened before the probes landed holds a snapshot of the loading
      // state; re-derive it so it fills in without being closed and reopened.
      const next = { ...s, providers: frame.providers };
      const picker = rederiveOpenPicker(next);
      return picker ? { ...next, picker } : next;
    }

    case "session_removed": {
      const removedIdx = s.sessions.findIndex((x) => x.id === frame.sessionId);
      const sessions = s.sessions.filter((x) => x.id !== frame.sessionId);
      const planGone = s.plan?.sessionId === frame.sessionId;
      // A send/answer/title/compact prompt aimed at a session another client
      // just removed would loop on submit (RPC error → reopen). Close it.
      const promptGone = s.prompt?.sessionId === frame.sessionId;
      const pickerGone = s.picker?.ctx?.liveSessionId === frame.sessionId;
      // The pending selection itself was removed before it ever arrived — drop
      // the hold so the clamp falls back to the fleet head.
      const pendingSel = s.pendingSelectId === frame.sessionId ? undefined : s.pendingSelectId;
      // If the removed row was the selected one, land on the row that was
      // just above it rather than snapping to the fleet head.
      const selectedId =
        s.selectedId === frame.sessionId && removedIdx > 0
          ? (sessions[removedIdx - 1]?.id ?? clampSelection(sessions, s.selectedId, pendingSel))
          : clampSelection(sessions, s.selectedId, pendingSel);
      return {
        ...s,
        sessions,
        selectedId,
        pendingSelectId: pendingSel,
        pending: without(s.pending, frame.sessionId),
        queue: without(s.queue, frame.sessionId),
        compacting: without(s.compacting, frame.sessionId),
        ...(planGone
          ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode }
          : {}),
        ...(promptGone
          ? { prompt: null, mode: s.mode === "prompt" ? ("browse" as UiMode) : s.mode }
          : {}),
        ...(pickerGone
          ? { picker: null, mode: s.mode === "picker" ? ("browse" as UiMode) : s.mode }
          : { picker: s.picker }),
      };
    }
    case "resync":
      // The client refetches and dispatches a fresh `sessions` action. Drop the
      // compacting indicators — the heartbeats that feed them were in the frames
      // we rolled past; the refetch re-seeds any still-running compaction from
      // the snapshot's `compacting` overlay (rebaseCompacting).
      return { ...s, compacting: {} };

    case "notice":
      // A daemon-level advisory (config reload). Transient — same channel as a
      // local notice, styled by tone.
      return {
        ...s,
        notice: {
          text: frame.text,
          tone: frame.tone === "warn" ? "bad" : "accent",
          at: Date.now(),
        },
      };

    default:
      return absurd(frame);
  }
};

/**
 * Fold a session's durable history (the `session.events` fetch) into the log.
 *
 * On startup the TUI stitches two history sources together: the daemon's
 * in-memory push ring (replayed via `hello`, but only the *current* daemon
 * epoch) and this durable table (every epoch a session ever ran under). They
 * cover different spans, so dispatching the durable frames as plain appends
 * drops a pre-daemon-restart turn *below* the newer frames the ring already
 * seeded — the transcript stops reading chronologically at the restart
 * boundary (see the `2c991027` report). Instead: dedupe by `(epoch, seq)` —
 * the real frame identity — against what's already logged, then re-sort the
 * whole log by `ts` (stable, so exact ties keep insertion order). Like a
 * `replay` push, `pending` / `compacting` still track but no notice flashes:
 * this is transcript, not a live event.
 */
/** The non-transcript event kinds — surfaced via the session snapshot /
 *  indicators, never the conversation (`applyPush` filters the same list). */
const NON_TRANSCRIPT: ReadonlySet<string> = new Set([
  "status_changed",
  "compact_progress",
  "background_tasks",
  "rate_limit",
]);

/**
 * Which of `frames` would add a line to `log`: the transcript kinds, deduped by
 * `(epoch, seq)` — the real frame identity — against what's already held (and
 * within the batch). {@link applyBackfill} folds exactly these; the scrollback
 * handler counts them to tell a page that made progress from one the log
 * couldn't absorb.
 */
export const backfillAdds = (log: readonly LogLine[], frames: readonly EventPush[]): LogLine[] => {
  const have = new Set(log.map((l) => `${l.epoch}:${l.seq}`));
  // Per-batch only (see the TuiState `toolNames` map for the live-push path) —
  // a call/result pair split across two backfill pages falls back to generic
  // formatting, which is a fine default for history this old.
  const toolNames: Record<string, string> = {};
  const added: LogLine[] = [];
  for (const frame of frames) {
    const event = frame.event;
    if (NON_TRANSCRIPT.has(event.type)) continue;
    const key = `${frame.epoch ?? ""}:${frame.seq}`;
    if (have.has(key)) continue;
    have.add(key);
    if (event.type === "tool_call") toolNames[event.id] = event.name;
    const toolName = event.type === "tool_result" ? toolNames[event.id] : undefined;
    added.push(toLogLine(frame.seq, frame.epoch ?? "", event, toolName));
  }
  return added;
};

const applyBackfill = (s: TuiState, frames: readonly EventPush[]): TuiState => {
  let pending = s.pending;
  let compacting = s.compacting;
  for (const frame of frames) {
    pending = trackPending(pending, frame.event);
    compacting = trackCompacting(compacting, frame.event);
  }
  const added = backfillAdds(s.log, frames);
  if (added.length === 0 && pending === s.pending && compacting === s.compacting) return s;
  let log = s.log;
  if (added.length > 0) {
    // Tie-break equal-millisecond timestamps by seq: the fold's frames are
    // strictly older than everything held (the daemon's `before` cursor), but
    // a burst of events can share one millisecond — a stable ts-only sort then
    // keeps the existing (newer) lines ahead of the just-folded older ones and
    // the transcript stitches out of order.
    const merged = [...s.log, ...added].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    log = merged.length > LOG_CAP ? merged.slice(merged.length - LOG_CAP) : merged;
  }
  return { ...s, log, pending, compacting };
};

const trackPending = (
  pending: Record<string, Pending>,
  ev: HarnessEvent,
): Record<string, Pending> => {
  if (ev.type === "permission_request") {
    const cur = pending[ev.sessionId] ?? {};
    const perms = cur.permissions ?? [];
    if (perms.some((x) => x.id === ev.id)) return pending; // history replay
    return {
      ...pending,
      [ev.sessionId]: {
        ...cur,
        permissions: [...perms, { id: ev.id, tool: ev.tool, input: ev.input }],
      },
    };
  }
  if (ev.type === "question") {
    return {
      ...pending,
      [ev.sessionId]: {
        ...pending[ev.sessionId],
        question: ev.id,
        questionText: ev.question,
        ...(ev.context ? { questionContext: ev.context } : {}),
      },
    };
  }
  if (ev.type === "plan_review") {
    return {
      ...pending,
      [ev.sessionId]: { ...pending[ev.sessionId], plan: ev.id, planText: ev.plan },
    };
  }
  if (ev.type === "answer") {
    const cur = pending[ev.sessionId];
    if (!cur) return pending;
    const { question: _q, questionText: _qt, questionContext: _qc, ...rest } = cur;
    return { ...pending, [ev.sessionId]: rest };
  }
  if (ev.type === "tool_result") {
    // Mirrors the daemon's own `#trackPerms`: no event marks a permission
    // resolved (aisdk emits `tool_call` *before* the gate; Claude the other
    // way round), so the matching `tool_result` is the only reliable signal.
    // Without this a replayed/reconnected history leaves long-since-approved
    // requests stuck in `permissions`, and `firstPerm` — the oldest one —
    // never advances to whatever's genuinely still pending. A plan resolves
    // the same way: the `plan_review` is keyed on the ExitPlanMode /
    // exit_plan tool-call id, so its `tool_result` is the only durable mark
    // that the plan was decided (the daemon clears its own map in
    // `respondToPlan`, but that never reaches the event log).
    const cur = pending[ev.sessionId];
    if (!cur) return pending;
    const keptPerms = cur.permissions?.filter((p) => p.id !== ev.id);
    const permsChanged =
      cur.permissions !== undefined &&
      keptPerms !== undefined &&
      keptPerms.length !== cur.permissions.length;
    const planCleared = cur.plan === ev.id;
    if (!permsChanged && !planCleared) return pending;
    const next: Pending = { ...cur };
    if (permsChanged) {
      if (keptPerms && keptPerms.length > 0) next.permissions = keptPerms;
      else delete next.permissions;
    }
    if (planCleared) {
      delete next.plan;
      delete next.planText;
    }
    return { ...pending, [ev.sessionId]: next };
  }
  // Any leftovers are also wiped wholesale when the session leaves
  // awaiting_input — see the `session_updated` case.
  return pending;
};

/** Start/refresh a "compacting…" entry on each heartbeat; clear it when the
 *  compaction lands (`compact`) or the session reports an error — the provider
 *  emits a non-fatal `error` if the summariser times out or fails. */
const trackCompacting = (cur: TuiState["compacting"], ev: HarnessEvent): TuiState["compacting"] => {
  if (ev.type === "compact_progress") {
    return {
      ...cur,
      [ev.sessionId]: {
        startedAt: ev.ts - ev.elapsedMs,
        generated: ev.generated,
        before: ev.before,
      },
    };
  }
  if (ev.type === "compact" || ev.type === "error") {
    return without(cur, ev.sessionId);
  }
  return cur;
};

/**
 * Rebase the "compacting…" map onto snapshot-reported state for exactly these
 * sessions (others untouched). `compact_progress` beats are deliberately not
 * persisted, so a client that attaches mid-compaction (reopened TUI, second
 * window) learns about it from the snapshot's `compacting` overlay: seed an
 * entry when the daemon reports one and no live entry exists yet (beats carry
 * fresher data once they arrive), drop it when the daemon says the gate has
 * released. Without the seed the session reads as idle and a queued send would
 * race the daemon's `busy` gate; without the drop a stale entry would pin
 * "compacting…" forever.
 */
const rebaseCompacting = (
  cur: TuiState["compacting"],
  sessions: readonly SessionSnapshot[],
): TuiState["compacting"] => {
  let out = cur;
  for (const s of sessions) {
    const flag = s.compacting;
    if (flag) {
      if (!out[s.id]) {
        out = { ...out, [s.id]: { startedAt: flag.startedAt, generated: 0, before: flag.before } };
      }
    } else if (out[s.id]) {
      out = without(out, s.id);
    }
  }
  return out;
};

const without = <T>(rec: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
};

/** Drop entries keyed by a session that no longer exists. */
const pruneByLive = <T>(
  rec: Record<string, T>,
  sessions: readonly SessionSnapshot[],
): Record<string, T> => {
  const live = new Set(sessions.map((x) => x.id));
  let changed = false;
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(rec)) {
    if (live.has(id)) out[id] = v;
    else changed = true;
  }
  return changed ? out : rec;
};

/**
 * Drop `pending` for any session the fresh snapshot says is not blocked. A
 * backfill / buffered replay can re-add a long-answered `permission_request`
 * to the map (its own dedup only sees the current map, cleared when the
 * session settled); the authoritative `status` is the snapshot's (U2).
 */
const pruneSettledPending = (
  pending: Record<string, Pending>,
  sessions: readonly SessionSnapshot[],
): Record<string, Pending> => {
  const blocked = new Set(
    sessions.filter((x) => x.status.kind === "awaiting_input").map((x) => x.id),
  );
  let changed = false;
  const out: Record<string, Pending> = {};
  for (const [id, v] of Object.entries(pending)) {
    if (blocked.has(id)) out[id] = v;
    else changed = true;
  }
  return changed ? out : pending;
};

// ---------------------------------------------------------------------------
// selection / ordering
// ---------------------------------------------------------------------------

const RANK: Record<SessionStateKind, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 2,
  working_background: 3,
  interrupted: 4,
  idle: 5,
  error: 6,
  done: 7,
};

/** Fleet-view order: by status group, then most-recently-active first. */
export const sortSessions = (list: readonly SessionSnapshot[]): SessionSnapshot[] => {
  return [...list].sort((a, b) => {
    const r = RANK[a.status.kind] - RANK[b.status.kind];
    if (r !== 0) return r;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : Number(a.id > b.id);
  });
};

/** One live child of a fleet row: a background task or an in-flight sub-agent. */
export interface FleetChild {
  /** Stable selection key — `bg:<task id>` or `sub:<subagent id>`. */
  key: string;
  /** Which snapshot array it came from; picks the pane's empty-state wording. */
  source: "bg" | "sub";
  /** The id events from this child carry (`HarnessEventBase.agentId`). */
  id: string;
  /** One-line label — the task's title, or the sub-agent's name. */
  label: string;
  /** Background-task kind (for the glyph); absent for foreground sub-agents. */
  taskKind?: BackgroundTaskKind;
}

/**
 * The work a session has fanned out — background tasks first, then still-running
 * foreground sub-agents (a backgrounded sub-agent already shows as a task, so
 * the two never double up). Single source of truth for the fleet's child rows
 * *and* for child selection, so the cursor can never point at a row the fleet
 * doesn't render.
 */
export const childrenOf = (s: SessionSnapshot): FleetChild[] => {
  return [
    ...(s.backgroundTasks ?? []).map((t): FleetChild => ({
      key: `bg:${t.id}`,
      source: "bg",
      id: t.id,
      label: t.title,
      taskKind: t.kind,
    })),
    ...(s.subagents ?? [])
      .filter((a) => a.active)
      .map((a): FleetChild => ({
        key: `sub:${a.id}`,
        source: "sub",
        id: a.id,
        label: a.name,
      })),
  ];
};

const clampSelection = (
  list: readonly SessionSnapshot[],
  current: string | null,
  pending?: string,
): string | null => {
  if (current && list.some((x) => x.id === current)) return current;
  // A just-picked session whose row hasn't arrived yet — hold the selection on
  // it rather than snapping to the fleet head (U4).
  if (current && current === pending) return current;
  return list[0]?.id ?? null;
};

/** Clear `pendingSelectId` once its session is in `list` (or gone). */
const settlePendingSelect = (
  s: TuiState,
  list: readonly SessionSnapshot[],
): { pendingSelectId?: string | undefined } => {
  if (!s.pendingSelectId) return {};
  return list.some((x) => x.id === s.pendingSelectId) ? { pendingSelectId: undefined } : {};
};

/**
 * Keep a focused child consistent with the live fleet — runs wherever
 * `clampSelection` does, since a session rebase can silently drop the focused
 * child (a task drained, a sub-agent finished). Membership churns constantly,
 * so instead of dropping the user out of the drill-down we snap to the first
 * surviving sibling; focus exits only when the child list is empty (or the
 * selected session is gone).
 */
const clampChild = (
  list: readonly SessionSnapshot[],
  sessionId: string | null,
  child: string | null,
): string | null => {
  if (child == null) return null;
  const sel = (sessionId && list.find((x) => x.id === sessionId)) || null;
  const kids = sel ? childrenOf(sel) : [];
  if (kids.some((k) => k.key === child)) return child;
  return kids[0]?.key ?? null;
};

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

export const selectedSession = (s: TuiState): SessionSnapshot | null => {
  return s.sessions.find((x) => x.id === s.selectedId) ?? null;
};

/** The focused child of the selected session, when the fleet is drilled in. */
export const focusedChildOf = (s: TuiState): FleetChild | null => {
  const sel = selectedSession(s);
  if (!sel || s.selectedChild == null) return null;
  return childrenOf(sel).find((k) => k.key === s.selectedChild) ?? null;
};

export const pendingFor = (s: TuiState, id: string | null): Pending => {
  return (id && s.pending[id]) || {};
};

export const queueFor = (s: TuiState, id: string | null): string[] => {
  return (id && s.queue[id]) || [];
};

export interface CacheStatus {
  state: "warm" | "cold" | "unknown";
  /** ms until the cache goes cold (0 unless warm). */
  remainingMs: number;
  /** Fraction of the TTL still left, 0..1 (0 unless warm). */
  fraction: number;
  /** What the last turn's read/write split says actually happened. */
  lastHit: "hit" | "rewrote" | null;
  /**
   * Where the TTL behind the countdown came from — `observed` was read back off
   * a response, `config` is the `prompt_cache_ttl` pin standing in until the
   * session has written cache once (and the provider may not be honouring it).
   */
  source: "observed" | "config" | "none";
}

/**
 * Prompt-cache liveness for a session, given the current time. `unknown` when
 * no TTL is known or the session hasn't taken a turn. The countdown is an
 * estimate — it can't see mid-turn refreshes or server-side eviction, and on a
 * `config` source not even the TTL is confirmed — hence `lastHit`, the ground
 * truth from the last turn's cache read/write split.
 */
export const cacheStatus = (s: SessionSnapshot | null, now: number): CacheStatus => {
  if (!s || s.cache.ttlMinutes <= 0 || s.cache.lastTurnAt <= 0) {
    return { state: "unknown", remainingMs: 0, fraction: 0, lastHit: null, source: "none" };
  }
  const { lastTurnAt, ttlMinutes, lastRead, lastWrite } = s.cache;
  let lastHit: CacheStatus["lastHit"] = null;
  if (lastRead > 0 && lastRead >= lastWrite) lastHit = "hit";
  else if (lastWrite > 0) lastHit = "rewrote";
  const ttlMs = ttlMinutes * 60_000;
  const remainingMs = lastTurnAt + ttlMs - now;
  const source = s.cache.ttlSource;
  return remainingMs > 0
    ? { state: "warm", remainingMs, fraction: Math.min(1, remainingMs / ttlMs), lastHit, source }
    : { state: "cold", remainingMs: 0, fraction: 0, lastHit, source };
};

/** Fraction of TTL left above which the cache dot reads as fresh / still-usable. */
export const CACHE_FRESH_FRACTION = 0.33;
/** …and below which it reads as about to lapse. */
export const CACHE_EXPIRING_FRACTION = 0.08;

/** Coarsen a warm {@link CacheStatus} into a heat band for the fleet dot; `null` when not warm. */
export const cacheHeat = (cs: CacheStatus): "fresh" | "fading" | "expiring" | null => {
  if (cs.state !== "warm") return null;
  if (cs.fraction >= CACHE_FRESH_FRACTION) return "fresh";
  if (cs.fraction >= CACHE_EXPIRING_FRACTION) return "fading";
  return "expiring";
};

/** The selected session's log lines, oldest first. */
export const sessionLog = (s: TuiState): LogLine[] => {
  if (!s.selectedId) return [];
  return s.log.filter((l) => l.sessionId === s.selectedId);
};

/**
 * What the event pane shows, per {@link LogFilter}. A focused child (fleet
 * drill-down) narrows the session's log to the events that child produced —
 * the `agentId` tag the adapter stamps on sub-agent frames — and the
 * condensers then run on that narrowed stream, so thinking-runs collapse
 * within the child rather than across the whole session. Unfocused, those
 * child-tagged frames are hidden: they live in the child's subtree, and the
 * main stream keeps only the ⤷/⤴ markers that announce a sub-agent.
 */
export const visibleLog = (s: TuiState, child: FleetChild | null = null): LogLine[] => {
  const rows = sessionLog(s);
  const base = child ? rows.filter((l) => l.agentId === child.id) : rows.filter((l) => !l.agentId);
  switch (s.logFilter) {
    case "chat":
      return condenseLog(base);
    case "chat_and_tools":
      return condenseToolResults(base);
    case "everything":
      return base;
    default:
      return absurd(s.logFilter);
  }
};

/** Collapse a run of consecutive `thinking` lines (starting at `i`) into one
 *  `· thought for Ns` marker, returning it and the index past the run. */
const collapseThinking = (lines: readonly LogLine[], i: number): [LogLine, number] => {
  let j = i;
  while (j < lines.length && lines[j]?.kind === "thinking") j += 1;
  const first = lines[i]!;
  const last = lines[j - 1]!;
  const secs = Math.round((last.ts - first.ts) / 1000);
  return [
    {
      seq: first.seq,
      epoch: first.epoch,
      sessionId: first.sessionId,
      kind: "thinking",
      ...(first.agentId ? { agentId: first.agentId } : {}),
      glyph: "·",
      text: secs > 0 ? `thought for ${secs}s` : "thought a moment",
      tone: "think",
      ts: first.ts,
    },
    j,
  ];
};

/** `⌃E`-style: fold consecutive `thinking` into `· thought for Ns`, and
 *  consecutive `tool_call` / `tool_result` into `⚙ N tool calls`. Everything
 *  else passes through untouched. */
export const condenseLog = (lines: readonly LogLine[]): LogLine[] => {
  const out: LogLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l) break;
    if (l.kind === "usage") {
      i += 1; // pure metering — not conversation
      continue;
    }
    if (l.kind === "thinking") {
      const [marker, next] = collapseThinking(lines, i);
      out.push(marker);
      i = next;
      continue;
    }
    if (l.kind === "tool_call" || l.kind === "tool_result") {
      let j = i;
      // Runs of tool calls with no `description` collapse into one `N tool
      // call(s)` marker (as before); calls that do have one get their own
      // line instead, in place among the undescribed runs' markers.
      let pending: LogLine | null = null;
      let pendingCount = 0;
      const flushPending = () => {
        if (!pending) return;
        out.push({
          seq: pending.seq,
          epoch: pending.epoch,
          sessionId: pending.sessionId,
          kind: "tool_call",
          ...(pending.agentId ? { agentId: pending.agentId } : {}),
          glyph: "⚙",
          text: `${pendingCount} tool call${pendingCount === 1 ? "" : "s"}`,
          tone: "warn",
          ts: pending.ts,
        });
        pending = null;
        pendingCount = 0;
      };
      while (
        j < lines.length &&
        (lines[j]?.kind === "tool_call" || lines[j]?.kind === "tool_result")
      ) {
        const line = lines[j]!;
        if (line.kind === "tool_call") {
          if (line.toolDescription) {
            flushPending();
            out.push({
              seq: line.seq,
              epoch: line.epoch,
              sessionId: line.sessionId,
              kind: "tool_call",
              ...(line.agentId ? { agentId: line.agentId } : {}),
              glyph: "⚙",
              text: line.toolDescription,
              tone: "warn",
              ts: line.ts,
            });
          } else {
            if (!pending) pending = line;
            pendingCount += 1;
          }
        }
        j += 1;
      }
      flushPending();
      i = j;
      continue;
    }
    out.push(l);
    i += 1;
  }
  return out;
};

/** `chat_and_tools`: like {@link condenseLog}, but keeps each tool call as
 *  its own line instead of collapsing the run — only the tool *results* (the
 *  output) are dropped. */
export const condenseToolResults = (lines: readonly LogLine[]): LogLine[] => {
  const out: LogLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l) break;
    if (l.kind === "usage" || l.kind === "tool_result") {
      i += 1;
      continue;
    }
    if (l.kind === "thinking") {
      const [marker, next] = collapseThinking(lines, i);
      out.push(marker);
      i = next;
      continue;
    }
    out.push(l);
    i += 1;
  }
  return out;
};

/** Role label for a log line in the `o` / `⌥o` transcript, or null to omit it. */
const transcriptHeader = (l: LogLine): string | null => {
  const midTurn = l.glyph === "»" ? " (mid-turn)" : "";
  switch (l.kind) {
    case "assistant_text":
      return "agent";
    case "thinking":
      return "agent (thinking)";
    case "tool_call":
      return `tool call: ${(l.full ?? l.text).split("\n")[0]}`;
    case "tool_result":
      return l.tone === "bad" ? "tool result (error)" : "tool result";
    case "user_message":
    case "echo":
      return `you${midTurn}`;
    case "question":
      return "agent asks";
    case "answer":
      return "you (answer)";
    case "plan_review":
      return "agent (plan ready for review)";
    case "permission_request":
      return "agent (needs approval)";
    case "compact":
      return "context compacted";
    case "error":
      return "error";
    case "subagent_started":
      return "sub-agent started";
    case "subagent_stopped":
      return "sub-agent finished";
    case "rewind":
      return "rewound";
    case "provider_changed":
      return "provider switched";
    // metadata, not conversation
    case "usage":
    case "result":
    case "status_changed":
    case "compact_progress":
    case "rate_limit":
    case "background_tasks":
      return null;
    default:
      return absurd(l.kind);
  }
};

/** Body text for the `o` / `⌥o` transcript — the header already names the role. */
const transcriptBody = (l: LogLine): string => {
  const raw = (l.full ?? l.text).replace(/[ \t]+$/gm, "").trimEnd();
  if (l.kind === "tool_call") return raw.split("\n").slice(1).join("\n").trim() || "(no arguments)";
  if (l.kind === "tool_result")
    return raw.replace(/^error\n/, "").trim() || (l.tone === "bad" ? "(failed)" : "ok");
  return raw;
};

/**
 * The selected session's log as a readable transcript for `$EDITOR`: one entry
 * per event as `[time]  <role>` then the body, blank line between. Raw bodies,
 * no `chat`-view collapsing — the "give me everything" view.
 */
export const transcriptText = (lines: readonly LogLine[]): string => {
  const parts: string[] = [];
  for (const l of lines) {
    const header = transcriptHeader(l);
    if (header === null) continue;
    parts.push(`[${clock(l.ts)}]  ${header}\n${transcriptBody(l)}`);
  }
  return parts.join("\n\n") || "(no events)";
};

// ---------------------------------------------------------------------------
// provider / model / find helpers for the picker flow
// ---------------------------------------------------------------------------

/** The Ink colour a provider's session ids render in, or "" for the default. */
export const providerColorOf = (s: TuiState, providerId: string): string => {
  return s.providers.find((p) => p.id === providerId)?.color ?? "";
};

export const providerInfo = (s: TuiState, providerId: string): ProviderInfo | null => {
  return s.providers.find((p) => p.id === providerId) ?? null;
};

/** `<login method> (<org>)` for a Claude profile, or "" when unknown. */
export const providerAccountOf = (s: TuiState, providerId: string): string => {
  const a = providerInfo(s, providerId)?.account;
  if (!a) return "";
  if (a.loginMethod && a.org) return `${a.loginMethod} (${a.org})`;
  return a.loginMethod || a.org;
};

export const defaultProviderId = (s: TuiState): string => {
  return s.providers.find((p) => p.isDefault)?.id ?? "claude";
};

/** The model a new session on `providerId` will use unless changed — the
 *  daemon's remembered "last used", a config pin, or the first detected id. */
export const defaultModelOf = (s: TuiState, providerId: string): string => {
  return providerInfo(s, providerId)?.defaultModel ?? "";
};

/** The permission mode a new session will use unless changed — the daemon's
 *  remembered "last used", or `default` (manual). Not per-provider. */
export const defaultModeOf = (s: TuiState): SessionMode => {
  return s.providers[0]?.defaultMode ?? "default";
};

export const providerPickItems = (s: TuiState): PickItem[] => {
  return s.providers.map((p) => ({
    id: p.id,
    label: p.tag || p.id,
    hint: [
      p.isDefault ? "default" : "",
      p.defaultModel || (p.models.length ? `${p.models.length} models` : ""),
    ]
      .filter(Boolean)
      .join(" · "),
  }));
};

export const modelPickItems = (s: TuiState, providerId: string): PickItem[] => {
  const p = providerInfo(s, providerId);
  if (!p) return [];
  if (p.modelChoices && p.modelChoices.length > 0) {
    return p.modelChoices.map((c) => ({
      id: c.id,
      label: c.label,
      ...(c.context ? { hint: `${humanTokens(c.context)} ctx` } : {}),
    }));
  }
  return p.models.map((m) => ({ id: m, label: m }));
};

/** Message for an empty model picker — why there's nothing to pick. */
export const modelPickEmptyText = (s: TuiState, providerId: string): string => {
  if (providerInfo(s, providerId)?.modelsLoading) {
    return "loading the model catalog — the list fills in when detection completes";
  }
  if (isClaudeId(providerId)) return "claude uses its configured model — enter to continue";
  return `no models detected for "${providerId}" — check \`loom models ${providerId}\` or set model / models in config; enter to use the provider default`;
};

/** A `providers_updated` landed while a provider/model picker is open: rebuild
 *  its items from the fresh list — one opened while the daemon was still
 *  detecting models resolves here instead of sitting empty until reopened.
 *  The highlight follows its id when it survives. Null when the open picker
 *  doesn't depend on the provider list. */
export const rederiveOpenPicker = (s: TuiState): PickerState | null => {
  const p = s.picker;
  if (!p || (p.kind !== "model" && p.kind !== "provider")) return null;
  const providerId = p.ctx?.provider ?? "";
  const items = p.kind === "model" ? modelPickItems(s, providerId) : providerPickItems(s);
  const cur = pickerCurrent(p)?.id;
  const at = cur ? items.findIndex((it) => it.id === cur) : -1;
  const out: PickerState = { ...p, items, index: at >= 0 ? at : 0 };
  if (p.kind === "model") {
    if (items.length === 0) out.emptyText = modelPickEmptyText(s, providerId);
    else delete out.emptyText; // the list loaded — the empty-state note is dead
  }
  return out;
};

/** The default effort levels offered when a model supports effort but doesn't
 *  enumerate which ones — the SDK's full `EffortLevel` set. */
const DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Whether `providerId`'s `modelId` accepts a thinking-effort level, per the
 *  discovered catalog — the gate for offering the `effort` picker step. */
export const modelSupportsEffort = (s: TuiState, providerId: string, modelId: string): boolean => {
  return (
    providerInfo(s, providerId)?.modelChoices?.some((c) => c.id === modelId && c.supportsEffort) ??
    false
  );
};

export const effortPickItems = (s: TuiState, providerId: string, modelId: string): PickItem[] => {
  const choice = providerInfo(s, providerId)?.modelChoices?.find((c) => c.id === modelId);
  const levels = choice?.effortLevels?.length ? choice.effortLevels : DEFAULT_EFFORT_LEVELS;
  return levels.map((lvl) => ({
    id: lvl,
    label: lvl,
    // The endpoint's advertised default (`default_reasoning_effort`) — also
    // what a new session sends when this step is skipped.
    ...(choice?.defaultEffort === lvl ? { hint: "default" } : {}),
  }));
};

/**
 * `Esc` inside a picker: step back one level of the provider → model →
 * (optional) effort → prompt wizard instead of discarding the whole detour
 * (and any draft text typed before it). Kinds with no "back" step — `undo`,
 * `command`, or a bare live `⌥m` / `⌥t` switch with nothing to
 * return to — just close.
 *
 * An `effort` step reached by picking a model that takes one (⌥p wizard, or
 * ⌥m onto such a model — `ctx.viaModelStep`) steps back to that model list,
 * regardless of whether it's also a live switch. A bare `⌥t` skips straight
 * to `effort` with no model step behind it, so it falls back to the same
 * `reopenSend` / close / restore-the-prompt handling `model` uses for a bare
 * `⌥m`.
 */
export const escapeTarget = (p: PickerState, s: TuiState): Action => {
  // The `⌥p` retarget wizard has no "back" — any step just returns to the plan
  // review, leaving whatever was staged before untouched.
  if (p.ctx?.planStage) return { t: "closePicker" };
  if (p.kind === "provider") {
    // A live provider switch (⌥p mid-chat) has no `new` prompt to fall into:
    // step back to the send prompt we came from, else just close.
    if (p.ctx?.liveSessionId) {
      return p.ctx.reopenSend !== undefined
        ? {
            t: "openPrompt",
            prompt: makePrompt({
              kind: "send",
              sessionId: p.ctx.reopenSend,
              label: "send",
              ...(p.ctx.draft !== undefined ? { text: p.ctx.draft } : {}),
            }),
          }
        : { t: "closePicker" };
    }
    return {
      t: "openPrompt",
      prompt: makePrompt({
        kind: "new",
        sessionId: null,
        label: "new session",
        text: p.ctx?.draft ?? "",
      }),
    };
  }
  // Live ⌥p wizard: Esc from the model list steps back to the provider list.
  if (p.kind === "model" && p.ctx?.viaProviderStep && p.ctx.liveSessionId) {
    const back: PickerState["ctx"] = {
      liveSessionId: p.ctx.liveSessionId,
      ...(p.ctx.reopenSend !== undefined ? { reopenSend: p.ctx.reopenSend } : {}),
      ...(p.ctx.draft !== undefined ? { draft: p.ctx.draft } : {}),
    };
    return {
      t: "openPicker",
      picker: makePicker({
        kind: "provider",
        title: "provider",
        items: providerPickItems(s),
        ctx: back,
        index: Math.max(
          0,
          providerPickItems(s).findIndex((it) => it.id === p.ctx?.provider),
        ),
      }),
    };
  }
  if (p.kind === "model" && !p.ctx?.liveSessionId) {
    const draft = p.ctx?.draft ?? "";
    if (s.providers.length > 1) {
      return {
        t: "openPicker",
        picker: makePicker({
          kind: "provider",
          title: "provider",
          items: providerPickItems(s),
          ctx: { draft },
        }),
      };
    }
    return {
      t: "openPrompt",
      prompt: makePrompt({ kind: "new", sessionId: null, label: "new session", text: draft }),
    };
  }
  if (p.kind === "model" && p.ctx?.liveSessionId && p.ctx.reopenSend !== undefined) {
    return {
      t: "openPrompt",
      prompt: makePrompt({
        kind: "send",
        sessionId: p.ctx.reopenSend,
        label: "send",
        ...(p.ctx.draft !== undefined ? { text: p.ctx.draft } : {}),
      }),
    };
  }
  if (p.kind === "effort" && p.ctx?.viaModelStep) {
    const providerId = p.ctx?.provider ?? "claude";
    const label = providerInfo(s, providerId)?.tag ?? providerId;
    return {
      t: "openPicker",
      picker: makePicker({
        kind: "model",
        title: `model · ${label}`,
        items: modelPickItems(s, providerId),
        emptyText: modelPickEmptyText(s, providerId),
        ctx: { ...p.ctx, provider: providerId },
      }),
    };
  }
  if (p.kind === "effort" && p.ctx?.liveSessionId && p.ctx.reopenSend !== undefined) {
    return {
      t: "openPrompt",
      prompt: makePrompt({
        kind: "send",
        sessionId: p.ctx.reopenSend,
        label: "send",
        ...(p.ctx.draft !== undefined ? { text: p.ctx.draft } : {}),
      }),
    };
  }
  if (p.kind === "effort" && !p.ctx?.liveSessionId) {
    return {
      t: "openPrompt",
      prompt: makePrompt({
        kind: "new",
        sessionId: null,
        label: "new session",
        ...(p.ctx?.provider ? { provider: p.ctx.provider } : {}),
        text: p.ctx?.draft ?? "",
      }),
    };
  }
  return { t: "closePicker" };
};

export interface Group {
  status: SessionStateKind;
  label: string;
  sessions: SessionSnapshot[];
}

export const groupsOf = (sessions: readonly SessionSnapshot[]): Group[] => {
  const out: Group[] = [];
  for (const status of STATUS_ORDER) {
    const inGroup = sessions.filter((x) => x.status.kind === status);
    if (inGroup.length > 0)
      out.push({ status, label: statusLook(status).label, sessions: inGroup });
  }
  return out;
};

/** A clickable region in the current frame: one terminal row, columns `x0..x1`
 *  inclusive, in 1-based screen coordinates (the same space SGR mouse reports
 *  use). Built by {@link fleetHits} / `modeChipHit`, carried on the `FleetView`
 *  so the keymap can hit-test a click without any Ink measurement API. */
export type FleetHit =
  | { kind: "session"; y: number; x0: number; x1: number; id: string }
  | { kind: "child"; y: number; x0: number; x1: number; sessionId: string; key: string }
  | { kind: "childMore"; y: number; x0: number; x1: number; sessionId: string }
  | { kind: "mode"; y: number; x0: number; x1: number };

/**
 * One row of the FLEET list, in the exact order `Fleet` draws it: a blank
 * spacer before every status group but the first, its header, then each
 * session and the (possibly capped) rows for the work it has fanned out.
 * `fleetHits` (click hit-testing) and the `Fleet` JSX both window *this* list
 * — via {@link fleetLayout} — instead of re-deriving the grouping/children
 * logic, so a click can never land on a row the pane doesn't actually draw.
 */
export type FleetEntry =
  | { kind: "blank" }
  | { kind: "groupHeader"; group: Group }
  | { kind: "session"; s: SessionSnapshot }
  | { kind: "child"; s: SessionSnapshot; c: FleetChild; isLast: boolean }
  | { kind: "childMore"; s: SessionSnapshot; extra: number };

/** An active filter renders one flat ranked list; otherwise the status
 *  groups (see {@link groupsOf}). */
export const fleetEntries = (state: TuiState): FleetEntry[] => {
  const query = state.find?.buffer.text ?? "";
  const matched = searchSessions(state, query).map((m) => m.session);
  const active = query.trim() !== "";
  const focused = focusedChildOf(state);
  const out: FleetEntry[] = [];

  const pushSession = (s: SessionSnapshot): void => {
    out.push({ kind: "session", s });
    const kids = childrenOf(s);
    if (kids.length === 0) return;
    // Mirrors the FLEET row cap: 4 children shown, lifted while drilled in.
    const drilled = focused != null && s.id === state.selectedId;
    const shown = drilled ? kids : kids.slice(0, 4);
    const extra = drilled ? 0 : kids.length - shown.length;
    shown.forEach((c, i) =>
      out.push({ kind: "child", s, c, isLast: i === shown.length - 1 && extra === 0 }),
    );
    if (extra > 0) out.push({ kind: "childMore", s, extra });
  };

  if (active) {
    for (const s of matched) pushSession(s);
  } else {
    for (const group of groupsOf(matched)) {
      if (out.length > 0) out.push({ kind: "blank" });
      out.push({ kind: "groupHeader", group });
      for (const s of group.sessions) pushSession(s);
    }
  }
  return out;
};

/** The entry that carries the visual cursor: the focused child's row while
 *  drilled in, else the selected session's row. -1 if neither survives the
 *  current filter — nothing to scroll toward. */
export const fleetSelectedEntryIndex = (state: TuiState, entries: FleetEntry[]): number => {
  const focused = focusedChildOf(state);
  if (focused) {
    const i = entries.findIndex(
      (e) => e.kind === "child" && e.s.id === state.selectedId && e.c.key === focused.key,
    );
    if (i >= 0) return i;
  }
  return entries.findIndex((e) => e.kind === "session" && e.s.id === state.selectedId);
};

/**
 * FLEET has no manual scroll — it just keeps the cursor on screen. Centers
 * the selected row in the visible window (clamped to the list's ends),
 * recomputed fresh from `selectedIndex` on every render, so there's no
 * separate scroll-position state that could fall out of sync with it.
 */
export const fleetScrollOffset = (total: number, selectedIndex: number, budget: number): number => {
  if (total <= budget || selectedIndex < 0) return 0;
  const maxOffset = total - budget;
  return Math.min(maxOffset, Math.max(0, selectedIndex - Math.floor(budget / 2)));
};

/** Chrome rows the FLEET pane spends before its first entry: the top border,
 *  the title, and the blocks box's marginTop. The filter box (its own
 *  marginTop plus the InputLine) spends two more while it's open. */
const FLEET_CHROME_ROWS = 3;
const FLEET_FILTER_ROWS = 2;

/** Entry rows the FLEET pane can draw for a given body height — shared by
 *  the JSX (its `height` prop) and hit-testing (`maxY - originY + 1`) so
 *  neither can drift from what the other thinks fits. */
export const fleetRowBudget = (bodyH: number, hasFilter: boolean): number =>
  Math.max(1, bodyH - FLEET_CHROME_ROWS - (hasFilter ? FLEET_FILTER_ROWS : 0));

export interface FleetLayout {
  /** Entries to actually draw this frame, top to bottom. */
  readonly visible: FleetEntry[];
  /** Index into the full list of `visible[0]` — 0 unless scrolled. */
  readonly offset: number;
  /** The full (unwindowed) entry count, for the "N of M" indicator. */
  readonly total: number;
}

/**
 * Windows {@link fleetEntries} to `budget` rows, scrolled to keep the
 * current selection on screen. Children add rows per session, so this is
 * the only way to know how many sessions actually fit. When the list
 * doesn't fit, the last row is given up to a scroll indicator instead of an
 * entry — see `Fleet` in components.tsx.
 */
export const fleetLayout = (state: TuiState, budget: number): FleetLayout => {
  const entries = fleetEntries(state);
  if (entries.length <= budget) return { visible: entries, offset: 0, total: entries.length };
  const shown = Math.max(1, budget - 1);
  const offset = fleetScrollOffset(entries.length, fleetSelectedEntryIndex(state, entries), shown);
  return { visible: entries.slice(offset, offset + shown), offset, total: entries.length };
};

/**
 * The screen row of every visible FLEET entry for the current state — walks
 * the same windowed list `Fleet` draws (see {@link fleetLayout}), so a click
 * always resolves to what's actually on screen, scrolled or not. `originY`
 * is the fleet pane's top screen row, `maxY` the last row the body area
 * gives it. Kept in lockstep with the JSX by construction, not convention —
 * both read `fleetEntries`/`fleetLayout`, neither re-derives the other.
 */
export const fleetHits = (
  state: TuiState,
  geom: { originX: number; listW: number; originY: number; maxY: number },
): FleetHit[] => {
  const { originX, originY, maxY } = geom;
  const x0 = originX;
  const x1 = originX + geom.listW - 1;
  const hasFilter = state.find != null;
  const budget = fleetRowBudget(maxY - originY + 1, hasFilter);
  const { visible } = fleetLayout(state, budget);

  const out: FleetHit[] = [];
  let y = originY + FLEET_CHROME_ROWS + (hasFilter ? FLEET_FILTER_ROWS : 0);
  for (const entry of visible) {
    if (entry.kind === "session") out.push({ kind: "session", y, x0, x1, id: entry.s.id });
    else if (entry.kind === "child")
      out.push({ kind: "child", y, x0, x1, sessionId: entry.s.id, key: entry.c.key });
    else if (entry.kind === "childMore")
      out.push({ kind: "childMore", y, x0, x1, sessionId: entry.s.id });
    y += 1;
  }
  return out;
};

// ---------------------------------------------------------------------------
// contextual actions — what the footer offers and the keymap allows
// ---------------------------------------------------------------------------

export type ActName =
  | "approve"
  | "deny"
  | "answer"
  | "send"
  | "interrupt"
  | "done"
  | "compact"
  | "keepwarm"
  | "planreview"
  | "mode"
  | "model"
  | "effort"
  | "provider"
  | "undo"
  | "fork"
  | "rebase"
  | "title"
  | "delete"
  | "copybranch"
  | "viewlog"
  | "logs"
  | "theme"
  | "clearqueue"
  | "restart"
  | "quitall"
  | "gc"
  | "new"
  | "find"
  | "filter"
  | "help"
  | "doctor"
  | "quit";

export interface KeyHint {
  keys: string;
  label: string;
  act: ActName;
  /** Shown on the footer (the few most pertinent). Everything else is
   *  palette-and-help only — see {@link commandsFor}. */
  footer?: boolean;
}

const GLOBAL_HINTS: KeyHint[] = [
  { keys: "n", label: "new", act: "new", footer: true },
  { keys: "/", label: "find", act: "find", footer: true },
  { keys: "?", label: "help", act: "help", footer: true },
  { keys: "q", label: "quit", act: "quit", footer: true },
];

/** The actions valid for the given session, most salient first, then globals. */
export const actionsFor = (session: SessionSnapshot | null): KeyHint[] => {
  const local: KeyHint[] = [];
  if (session) {
    const { status } = session;

    // Request mode — the turn is parked on a decision. Offer only the keys that
    // resolve it (plus interrupt); mode / model / rename / undo / fork are all
    // noise while the agent is blocked, so they're dropped from both the
    // footer and the permitted set the keymap checks.
    if (status.kind === "awaiting_input") {
      if (status.on === "question") {
        local.push({ keys: "⏎", label: "answer", act: "answer", footer: true });
      } else if (status.on === "user_question") {
        // AskUserQuestion is a real permission gate underneath, so — unlike
        // Loom's own ask_user — denying it is a meaningful choice, not just
        // "come back later".
        local.push({ keys: "⏎", label: "answer", act: "answer", footer: true });
        local.push({ keys: "d", label: "deny", act: "deny", footer: true });
      } else if (status.on === "plan_review") {
        local.push({ keys: "⏎", label: "review plan", act: "planreview", footer: true });
      } else {
        local.push({ keys: "a", label: "approve", act: "approve", footer: true });
        local.push({ keys: "d", label: "deny", act: "deny", footer: true });
      }
      local.push({ keys: "i", label: "interrupt", act: "interrupt", footer: true });
      return [...local, ...GLOBAL_HINTS];
    }

    if (
      status.kind === "running" ||
      status.kind === "starting" ||
      status.kind === "working_background"
    ) {
      // `working_background` is settled-but-not-done: interrupt kills the
      // outstanding background work too.
      local.push({ keys: "i", label: "interrupt", act: "interrupt", footer: true });
    }
    // `send` is the one "talk to this session" verb, bound to Enter — it works
    // while running (injects), idle, or stopped (interrupted / errored → the
    // daemon revives the session first). No separate "resume" step.
    if (status.kind !== "starting") {
      local.push({ keys: "⏎", label: "send", act: "send", footer: true });
    }
    // `compact` is legal on any live session — the half-full meter is when it's
    // worth *suggesting*, not when it becomes possible (you may well want to
    // compact a 40%-full context before handing over a big task). Below the
    // mark it's palette-and-help only, so the footer doesn't carry a verb you
    // rarely reach for; `c` works either way.
    if (
      status.kind === "running" ||
      status.kind === "idle" ||
      status.kind === "working_background"
    ) {
      const half = session.contextLimit > 0 && session.contextUsed / session.contextLimit > 0.5;
      local.push({
        keys: "c",
        label: "compact",
        act: "compact",
        ...(half ? { footer: true } : {}),
      });
    }
    // Keep-warm — palette only (a rarely-flipped toggle). Offered once the
    // session has a known cache TTL to race (measured, or a config pin),
    // running or idle; the label reflects the current state.
    if ((status.kind === "running" || status.kind === "idle") && session.cache.ttlMinutes > 0) {
      local.push({
        keys: "",
        label: session.keepWarm ? "stop keeping cache warm" : "keep cache warm",
        act: "keepwarm",
      });
    }
    if (status.kind === "idle" || status.kind === "error" || status.kind === "interrupted") {
      local.push({ keys: "x", label: "archive", act: "done", footer: true });
    }
    // Second tier — palette / help only (see the grammar note at the top of the
    // file). `⇧⇥` cycles the permission mode, `⌥m` its rarer sibling the model;
    // both also work inside a prompt, so you can re-mode / re-model mid-message.
    local.push({ keys: "⇧⇥", label: "mode", act: "mode" });
    local.push({ keys: "⌥m", label: "model", act: "model" });
    local.push({ keys: "⌥t", label: "effort", act: "effort" });
    local.push({ keys: "⌥p", label: "provider", act: "provider" });
    // Undo needs a rewind-capable provider (the daemon reports `canRewind`);
    // it's conversation-only, so an in-place session can still do it. Hard fork
    // is aisdk-only for now (fork-tree F3) and additionally needs an isolated
    // branch, which an in-place session doesn't have.
    if (
      session.canRewind &&
      (status.kind === "idle" || status.kind === "interrupted") &&
      session.turns >= 1
    ) {
      local.push({ keys: "u", label: "undo", act: "undo" });
    }
    if (!isClaudeId(session.provider) && !session.inPlace) {
      local.push({ keys: "F", label: "fork", act: "fork" });
    }
    local.push({ keys: "e", label: "rename", act: "title" });
    if (session.branch || session.worktree) {
      local.push({ keys: "y", label: "copy branch", act: "copybranch" });
    }
    // Any worktree session can rebase onto its base — `syncOntoBase` is the
    // manual side of `[auto_rebase]`. Offered even when `behindBase` reads 0:
    // that count is a snapshot fact that lags a base branch advanced from
    // outside Loom, and the RPC is a harmless "already current" no-op when
    // there's genuinely nothing to replay. The label sharpens when we know
    // it'd do something.
    if (session.worktree) {
      const behind = session.git?.behindBase ?? 0;
      local.push({
        keys: "r",
        label: behind > 0 ? `rebase onto base (-${behind})` : "rebase onto base",
        act: "rebase",
      });
    }
    // `X` — a destructive, structural op (worktree + transcript go); `d` is
    // deny-only now, never delete.
    local.push({ keys: "X", label: "delete", act: "delete" });
  }
  return [...local, ...GLOBAL_HINTS];
};

/** Convenience for tests / keymap: the bare set of permitted act names. */
export const allowedActs = (session: SessionSnapshot | null): Set<ActName> => {
  return new Set(actionsFor(session).map((h) => h.act));
};

/**
 * Every action reachable right now, for the `Space` command palette — the
 * selected session's contextual verbs ({@link actionsFor}) plus the app / view
 * commands that never earn a footer slot. One entry per act; `hint` is its key.
 */
export const commandsFor = (s: TuiState): PickItem[] => {
  const seen = new Set<ActName>();
  const items: PickItem[] = [];
  for (const h of actionsFor(selectedSession(s))) {
    if (seen.has(h.act)) continue;
    seen.add(h.act);
    items.push({ id: h.act, label: h.label, hint: h.keys });
  }
  const extra: Array<[ActName, string, string]> = [
    ["doctor", "doctor — tools, connectors, daemon", ""],
    ["viewlog", "view the log in $EDITOR", "o"],
    ["logs", "view the daemon + TUI logs in $EDITOR", ""],
    ["filter", `event log: ${logFilterLabel(cycleLogFilter(s.logFilter))}`, "v"],
    ["theme", `switch to ${nextThemeMode(s.theme)} theme`, "t"],
    ["restart", "restart the daemon", "R"],
    ["quitall", "quit and stop the daemon", "Q"],
  ];
  for (const [id, label, key] of extra) {
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, label, hint: key });
  }
  // gc only when there's something to collect — done sessions with worktrees.
  if (s.sessions.some((x) => x.status.kind === "done" && x.worktree)) {
    items.push({ id: "gc", label: "gc — remove worktrees of done sessions", hint: "" });
  }
  if (s.selectedId && (s.queue[s.selectedId]?.length ?? 0) > 0) {
    items.push({ id: "clearqueue", label: "clear the queued messages", hint: "⌥x" });
  }
  return items;
};

/**
 * The hint chips the footer shows for the current UI mode. `browse` delegates to
 * {@link actionsFor} (the selected session's contextual actions); every overlay
 * mode gets a fixed set so the footer never advertises a key the mode won't
 * accept. `prompt` returns `[]` — {@link FooterArea} draws the editor there.
 */
export const footerHints = (s: TuiState): Array<{ keys: string; label: string }> => {
  switch (s.mode) {
    case "prompt":
      return [];
    case "picker":
      return [
        { keys: "↑↓", label: "move" },
        { keys: "enter", label: "pick" },
        { keys: "esc", label: "cancel" },
      ];
    case "confirm":
      return [
        { keys: "enter", label: "confirm" },
        ...(s.confirm?.branchName
          ? [{ keys: "b", label: s.confirm.deleteBranch ? "keep branch" : "+ branch" }]
          : []),
        { keys: "esc", label: "cancel" },
      ];
    case "plan":
      return [
        { keys: "i", label: "implement" },
        { keys: "f", label: "fresh" },
        { keys: "e", label: "edit" },
        { keys: "d", label: "discuss" },
        { keys: "⌥o / o", label: "view" },
      ];
    case "help":
      return [{ keys: "? / esc", label: "close help" }];
    case "doctor":
      return [{ keys: "esc", label: "close" }];
    case "browse": {
      const sel = selectedSession(s);
      const hints = actionsFor(sel)
        .filter((h) => h.footer)
        .map((h) => ({ keys: h.keys, label: h.label }));
      // Drill-down affordances: → appears only when there's something to
      // inspect; ← leads while focused (every other key still acts on the
      // session, so its hints stay).
      const tail = [...hints, { keys: "␣", label: "more" }];
      if (s.selectedChild != null) return [{ keys: "←", label: "fleet" }, ...tail];
      if (sel && childrenOf(sel).length > 0) return [...tail, { keys: "→", label: "inspect" }];
      return tail;
    }
    default:
      return absurd(s.mode);
  }
};

// ---------------------------------------------------------------------------
// event → log line
// ---------------------------------------------------------------------------

export const toLogLine = (
  seq: number,
  epoch: string,
  ev: HarnessEvent,
  toolName?: string,
): LogLine => {
  const f = formatEvent(ev, toolName);
  return {
    seq,
    epoch,
    sessionId: ev.sessionId,
    kind: ev.type,
    ...(ev.agentId ? { agentId: ev.agentId } : {}),
    glyph: f.glyph,
    text: f.text,
    ...(f.full !== undefined && f.full !== f.text ? { full: f.full } : {}),
    ...(f.toolDescription !== undefined ? { toolDescription: f.toolDescription } : {}),
    tone: f.tone,
    ts: ev.ts,
  };
};

export interface EventFormat {
  glyph: string;
  text: string;
  /** Untruncated body with newlines, when it differs from {@link text}. */
  full?: string;
  /** `tool_call` only: the input's `description` field, when present. */
  toolDescription?: string;
  tone: Tone;
}

const oneLine = (s: string, n = 200): string => truncate(s.replace(/\s+/g, " ").trim(), n);
/**
 * Full body: normalise newlines, expand tabs, trim trailing space, keep
 * everything else. Tabs matter here — a tab counts as ~1 column to our word
 * wrap and to Ink's own width math, but a real terminal jumps it to the next
 * 8-column stop. Left in, a tab-indented diff can render wider than the
 * terminal thinks, so the line hard-wraps outside Ink's row accounting and
 * every subsequent redraw lands one row off (looks like a blank line wedged
 * between every row) until the offending line scrolls out of view.
 */
const body = (s: string): string =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();

export const formatEvent = (ev: HarnessEvent, toolName?: string): EventFormat => {
  switch (ev.type) {
    case "assistant_text":
      return { glyph: "▪", text: oneLine(ev.text), full: body(ev.text), tone: "plain" };
    case "thinking":
      return { glyph: "·", text: oneLine(ev.text), full: body(ev.text), tone: "think" };
    case "tool_call": {
      const desc = toolDescriptionOf(ev.input);
      return {
        glyph: "⚙",
        text: `${ev.name}${summarizeInput(ev.name, ev.input)}`,
        full: toolCallFull(ev.name, ev.input),
        ...(desc !== undefined ? { toolDescription: desc } : {}),
        tone: "warn",
      };
    }
    case "tool_result": {
      const raw = valueOf(ev.output);
      const out = typeof raw === "string" ? body(raw) : "";
      // A read-only whole-file tool's result is just the file the user can
      // already see — the call line (path + range) says enough; don't dump
      // the content into the log a second time.
      const terse = ev.ok && toolName !== undefined && isReadTool(toolName);
      return {
        glyph: "↳",
        text: ev.ok ? "ok" : `error ${oneLine(out || String(raw), 120)}`,
        ...(out && !terse ? { full: ev.ok ? out : `error\n${out}` } : {}),
        tone: ev.ok ? "good" : "bad",
      };
    }
    case "permission_request":
      return { glyph: "⇱", text: `${ev.tool} needs approval · req ${ev.id}`, tone: "accent" };
    case "question":
      return {
        glyph: "?",
        text: `${oneLine(ev.question, 120)} · req ${ev.id}`,
        full: body(ev.question),
        tone: "accent",
      };
    case "answer":
      return { glyph: "↩", text: oneLine(ev.text, 120), full: body(ev.text), tone: "accent" };
    case "plan_review":
      return { glyph: "❖", text: `plan ready for review · req ${ev.id}`, tone: "accent" };
    case "usage":
      return {
        glyph: "∑",
        text: `+${humanTokens(ev.tokens.input)}in +${humanTokens(ev.tokens.output)}out · ctx ${humanTokens(ev.contextUsed)}/${humanTokens(ev.contextLimit)}`,
        tone: "dim",
      };
    case "compact": {
      const head = `context compacted ${humanTokens(ev.before)}${ev.after > 0 ? ` → ${humanTokens(ev.after)}` : ""}`;
      return {
        glyph: "⇊",
        text: `${head}${ev.summary ? ` · ${oneLine(ev.summary, 80)}` : ""}`,
        ...(ev.summary ? { full: `${head}\n\n${body(ev.summary)}` } : {}),
        tone: "accent",
      };
    }
    case "compact_progress":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return { glyph: "⇊", text: `compacting… ${Math.round(ev.elapsedMs / 1000)}s`, tone: "dim" };
    case "rate_limit":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return { glyph: "◷", text: `${ev.window ?? "plan"} ${ev.utilization ?? "?"}%`, tone: "dim" };
    case "subagent_started":
      return { glyph: "⤷", text: `sub-agent “${ev.name}” started`, tone: "dim" };
    case "subagent_stopped":
      return { glyph: "⤴", text: `sub-agent finished`, tone: "dim" };
    case "background_tasks":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return {
        glyph: "◐",
        text:
          ev.tasks.length === 0
            ? "background work drained"
            : `${ev.tasks.length} background task${ev.tasks.length === 1 ? "" : "s"} running`,
        tone: "dim",
      };
    case "status_changed":
      return {
        glyph: "◈",
        text: `${sessionStateLabel(ev.status)}${ev.note ? ` (${ev.note})` : ""}`,
        tone: "dim",
      };
    case "error":
      return { glyph: "✕", text: oneLine(ev.message, 160), full: body(ev.message), tone: "bad" };
    case "result":
      // The turn's text is already in the log as assistant_text; a failure gets
      // its own `error` line. So this is just a terse end-of-turn marker.
      if (ev.kind === "ok" && ev.stopReason === "step_limit")
        return {
          glyph: "■",
          text: "turn paused — step ceiling hit repeatedly (send to continue)",
          tone: "warn",
        };
      return {
        glyph: "■",
        text: ev.kind === "ok" ? "turn complete" : "turn failed",
        tone: ev.kind === "ok" ? "good" : "bad",
      };
    case "rewind":
      return { glyph: "↶", text: `rewound to turn ${ev.toTurn}`, tone: "accent" };
    case "provider_changed":
      return {
        glyph: "⇄",
        text: `provider · ${ev.from} → ${ev.provider}${ev.model ? `/${ev.model}` : ""}${
          ev.effort ? ` · ${ev.effort}` : ""
        }${ev.lossy ? " · context summarized" : ""}`,
        tone: "accent",
      };
    case "user_message":
      return {
        glyph: ev.injected ? "»" : "›",
        text: ev.injected ? `${oneLine(ev.text, 160)} · sent mid-turn` : oneLine(ev.text, 160),
        full: ev.injected ? `${body(ev.text)}\n\n(sent mid-turn)` : body(ev.text),
        tone: "accent",
      };
    default:
      return absurd(ev);
  }
};

/** Claude's built-in whole-file reader, and tilth's structural equivalent — a
 *  tool_result here is just the file, already visible to the user; showing it
 *  again in the log is pure noise (see `formatEvent`'s `tool_result` case). */
const isReadTool = (name: string): boolean => name === "Read" || name.endsWith("tilth_read");

/** String-replacement editors, across every connector's naming for one. */
const isEditTool = (name: string): boolean =>
  name === "Edit" || name === "MultiEdit" || name === "edit" || name.endsWith("tilth_edit");

/** tilth's batch multi-file write — its `files` array gets one block per file
 *  instead of rendering as a single JSON blob (see `tilthWriteBody`). */
const isTilthWriteTool = (name: string): boolean => name.endsWith("tilth_write");

const pathOf = (o: Record<string, unknown>): string | undefined =>
  typeof o.file_path === "string" ? o.file_path : typeof o.path === "string" ? o.path : undefined;

const summarizeInput = (name: string, input: unknown): string => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (isTilthWriteTool(name) && Array.isArray(o.files)) {
      const paths = o.files.map((f) =>
        f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string"
          ? ((f as Record<string, unknown>).path as string)
          : "?",
      );
      return `  ${paths.length} file${paths.length === 1 ? "" : "s"}: ${oneLine(paths.join(", "), 80)}`;
    }
    if (isReadTool(name)) {
      const path = pathOf(o);
      if (path !== undefined) {
        const offset = typeof o.offset === "number" ? o.offset : undefined;
        const limit = typeof o.limit === "number" ? o.limit : undefined;
        const range =
          offset !== undefined || limit !== undefined
            ? ` [${offset ?? 0}${limit !== undefined ? `+${limit}` : "+"}]`
            : "";
        return `  ${oneLine(path, 80)}${range}`;
      }
    }
    for (const k of ["command", "file_path", "path", "pattern", "query", "url"]) {
      if (typeof o[k] === "string") return `  ${oneLine(o[k] as string, 80)}`;
    }
  }
  return "";
};

/** The tool input's `description` field (e.g. Bash's), when present and non-blank. */
const toolDescriptionOf = (input: unknown): string | undefined => {
  if (input && typeof input === "object") {
    const d = (input as Record<string, unknown>).description;
    if (typeof d === "string" && d.trim()) return oneLine(d, 120);
  }
  return undefined;
};

/**
 * Full tool-call rendering for the editor / wrapped view. Edit-shaped tools
 * (`old_string` / `new_string`) render as a removed/added block; tilth_write's
 * batch `files` gets one block per file; everything else falls back to one
 * `key: value` line per argument — strings verbatim (multi-line ones indented
 * under their key), anything else as compact JSON. Readable, not a raw dump.
 */
const toolCallFull = (name: string, input: unknown): string => {
  if (input == null || typeof input !== "object") return name;
  const o = input as Record<string, unknown>;
  if (isEditTool(name)) {
    const diff = editDiffBody(name, o);
    if (diff !== undefined) return diff;
  }
  if (isTilthWriteTool(name) && Array.isArray(o.files)) {
    return tilthWriteBody(name, o.files);
  }
  const entries = Object.entries(o);
  if (entries.length === 0) return name;
  const lines = [name];
  for (const [k, v] of entries) {
    if (typeof v === "string") {
      const normalized = v.includes("\t") || v.includes("\r") ? body(v) : v;
      if (normalized.includes("\n")) {
        lines.push(`${k}:`);
        for (const ln of normalized.split("\n")) lines.push(`  ${ln}`);
      } else {
        lines.push(`${k}: ${normalized}`);
      }
    } else {
      let rendered: string;
      try {
        rendered = JSON.stringify(v);
      } catch {
        rendered = String(v);
      }
      lines.push(`${k}: ${rendered}`);
    }
  }
  return lines.join("\n");
};

/** `old_string` / `new_string` (any connector's naming for them) as a
 *  removed/added block — a full diff library is overkill for a single
 *  anchored replacement, and this is what the call already tells you changed. */
const editDiffBody = (name: string, o: Record<string, unknown>): string | undefined => {
  const oldS = typeof o.old_string === "string" ? o.old_string : undefined;
  const newS = typeof o.new_string === "string" ? o.new_string : undefined;
  if (oldS === undefined || newS === undefined) return undefined;
  const path = pathOf(o);
  const lines = [path ? `${name}  ${path}` : name];
  for (const ln of body(oldS).split("\n")) lines.push(`- ${ln}`);
  for (const ln of body(newS).split("\n")) lines.push(`+ ${ln}`);
  return lines.join("\n");
};

/** One block per file for tilth_write's batch `files` array, instead of the
 *  whole call rendering as a single JSON blob. */
const tilthWriteBody = (name: string, files: unknown[]): string => {
  const blocks = files.map((f) => {
    const rec = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const path = typeof rec.path === "string" ? rec.path : "?";
    const mode = typeof rec.mode === "string" ? rec.mode : "hash";
    if (typeof rec.content === "string") {
      const lines = [`${path}  (${mode})`];
      for (const ln of body(rec.content).split("\n")) lines.push(`+ ${ln}`);
      return lines.join("\n");
    }
    if (Array.isArray(rec.edits)) {
      const lines = [`${path}  (${mode})`];
      for (const e of rec.edits) {
        const edit = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        const start = typeof edit.start === "string" ? edit.start : "?";
        const end = typeof edit.end === "string" ? edit.end : undefined;
        lines.push(`@ ${start}${end ? `-${end}` : ""}`);
        const content = typeof edit.content === "string" ? edit.content : "";
        for (const ln of body(content).split("\n")) lines.push(`+ ${ln}`);
      }
      return lines.join("\n");
    }
    return path;
  });
  return [name, ...blocks].join("\n\n");
};

const valueOf = (x: unknown): unknown => {
  if (x && typeof x === "object" && "text" in (x as Record<string, unknown>)) {
    return (x as Record<string, unknown>)["text"];
  }
  return x;
};

const noticeForEvent = (s: TuiState, ev: HarnessEvent): Notice | null => {
  const tag = ev.sessionId === s.selectedId ? "" : ` [${shortId(ev.sessionId)}]`;
  if (ev.type === "permission_request")
    return { text: `${ev.tool} needs approval${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "question")
    return { text: `question waiting${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "plan_review")
    return { text: `plan ready for review${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "error" && ev.fatal)
    return { text: `error: ${oneLine(ev.message, 80)}${tag}`, tone: "bad", at: Date.now() };
  if (ev.type === "result" && ev.kind === "ok" && ev.stopReason === "step_limit")
    return {
      text: `turn paused at the step ceiling${tag} — send to continue`,
      tone: "accent",
      at: Date.now(),
    };
  if (ev.type === "provider_changed")
    return {
      text: `provider → ${ev.provider}${ev.model ? `/${ev.model}` : ""}${tag}`,
      tone: "good",
      at: Date.now(),
    };
  return null;
};

/** Re-export for components that render timestamps. */
export { clock };
