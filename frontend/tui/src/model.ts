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
import type { DoctorReport, ProviderInfo, PushFrame, SessionSnapshot } from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { buffer, type Buffer } from "./editor.ts";
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
   *  order — the prompt walks them one at a time rather than all at once. */
  qaAll?: AskUserQuestionItem[];
  /** `answerQuestion` only: index into {@link qaAll} of the question this prompt
   *  is currently collecting. `Enter` advances to the next; `Esc` on anything
   *  past the first steps back to the previous one (its answer still filled in). */
  qaIdx?: number;
  /** `answerQuestion` only: answers collected so far, keyed by question text —
   *  kept across stepping back and forth so nothing typed is lost. */
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

// ---------------------------------------------------------------------------
// picker overlay — provider choice, model choice, session find
// ---------------------------------------------------------------------------

export interface PickItem {
  id: string;
  label: string;
  hint?: string;
  /** Extra text folded into the fuzzy match (message content for `find`). */
  blob?: string;
}

export interface PickerState {
  kind: "provider" | "model" | "effort" | "find" | "undo" | "command";
  title: string;
  items: PickItem[];
  /** Shown when `items` is empty (e.g. no models detected for a provider). */
  emptyText?: string;
  /** Live filter text. */
  filter: string;
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
  };
}

export const makePicker = (init: {
  kind: PickerState["kind"];
  title: string;
  items: PickItem[];
  emptyText?: string;
  ctx?: PickerState["ctx"];
}): PickerState => {
  return {
    kind: init.kind,
    title: init.title,
    items: init.items,
    filter: "",
    index: 0,
    ...(init.emptyText ? { emptyText: init.emptyText } : {}),
    ...(init.ctx ? { ctx: init.ctx } : {}),
  };
};

/** Case-insensitive subsequence match — every char of `q` appears in order. */
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
  if (p.filter === "") return p.items;
  return p.items.filter((it) => fuzzyMatch(`${it.label} ${it.blob ?? ""}`, p.filter));
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
  action: "restart" | "quitAll" | "deleteSession";
  /** Target session for `deleteSession`. */
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
   * plus the permission mode the implementation will run in (`m` cycles it).
   */
  plan: { sessionId: string; requestId: string; text: string; mode: SessionMode } | null;
  /** An open picker overlay (provider / model / find). */
  picker: PickerState | null;
  /** Submitted `new` / `send` prompts, oldest first, for ↑/↓ recall. */
  promptHistory: string[];
  /**
   * The last unsubmitted `new` / `send` buffer, kept after an `Esc` cancel so
   * reopening either prompt (whichever one the user meant) restores it. Cleared
   * once the text is actually sent.
   */
  lastDraft: string;
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
    promptHistory: [],
    lastDraft: "",
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
  | { t: "connection"; value: Connection }
  | { t: "toggleTheme" }
  | { t: "move"; delta: number }
  | { t: "select"; id: string }
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
  | { t: "openConfirm"; confirm: ConfirmState }
  | { t: "toggleConfirmBranch" }
  | { t: "closeConfirm" }
  | { t: "openPicker"; picker: PickerState }
  | { t: "pickerFilter"; value: string }
  | { t: "pickerMove"; delta: number }
  | { t: "closePicker" }
  | { t: "resolvePerm"; sessionId: string; id: string }
  | { t: "help"; value: boolean }
  | { t: "doctor"; value: boolean }
  | { t: "doctorLoaded"; report: DoctorReport };

/**
 * Ceiling on `state.log`. It accumulates every echo / notice / event line for
 * the whole session and is never otherwise pruned — a long-lived TUI would grow
 * it without bound. Generous: the transcript view, find, and `$EDITOR` export
 * all read from it, so this only bites a genuinely marathon session.
 */
const LOG_CAP = 10_000;

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
        compacting: pruneByLive(s.compacting, sessions),
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
        compacting: pruneByLive(s.compacting, sessions),
      };
    }

    case "push":
      return applyPush(s, a.frame, a.replay === true);

    case "connection":
      return { ...s, connection: a.value };

    case "toggleTheme":
      return { ...s, theme: nextThemeMode(s.theme) };

    case "move": {
      if (s.sessions.length === 0) return s;
      const idx = s.sessions.findIndex((x) => x.id === s.selectedId);
      const from = idx < 0 ? 0 : idx;
      const next = Math.max(0, Math.min(s.sessions.length - 1, from + a.delta));
      const picked = s.sessions[next];
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
        ...(known ? {} : { pendingSelectId: a.id }),
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

    case "promptSet":
      return s.prompt ? { ...s, prompt: { ...s.prompt, buffer: a.buffer } } : s;

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
      const draft = p.histIdx === 0 && a.dir === -1 ? p.buffer.text : p.draft;
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

    case "openPlan":
      return {
        ...s,
        mode: "plan",
        plan: {
          sessionId: a.sessionId,
          requestId: a.requestId,
          text: a.text,
          // Implementations auto-accept edits unless `m` switches the mode. A
          // reopen of the same review (esc out of the discuss prompt) keeps the
          // mode already cycled to rather than resetting it.
          mode:
            s.plan && s.plan.sessionId === a.sessionId && s.plan.requestId === a.requestId
              ? s.plan.mode
              : "acceptEdits",
        },
        prompt: null,
      };

    case "closePlan":
      return { ...s, mode: s.mode === "plan" ? "browse" : s.mode, plan: null };

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
      return { ...s, mode: "picker", picker: a.picker, prompt: null, confirm: null, plan: null };

    case "pickerFilter":
      return s.picker ? { ...s, picker: { ...s.picker, filter: a.value, index: 0 } } : s;

    case "pickerMove": {
      if (!s.picker) return s;
      const n = pickerVisible(s.picker).length;
      if (n === 0) return s;
      const next = Math.max(0, Math.min(n - 1, s.picker.index + a.delta));
      return next === s.picker.index ? s : { ...s, picker: { ...s.picker, index: next } };
    }

    case "closePicker":
      return { ...s, mode: s.mode === "picker" ? "browse" : s.mode, picker: null };

    case "resolvePerm": {
      const cur = s.pending[a.sessionId];
      if (!cur?.permissions) return s;
      const rest = cur.permissions.filter((p) => p.id !== a.id);
      const { permissions: _drop, ...others } = cur;
      return {
        ...s,
        pending: {
          ...s.pending,
          [a.sessionId]: rest.length ? { ...others, permissions: rest } : others,
        },
      };
    }

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
      const log = appendLog(s.log, toLogLine(frame.seq, epoch, ev));
      return { ...s, log, pending, compacting, notice };
    }
    case "session_updated": {
      const rest = s.sessions.filter((x) => x.id !== frame.session.id);
      const sessions = sortSessions([...rest, frame.session]);
      // Any outstanding round-trip is settled once the session leaves awaiting_input.
      const settled = frame.session.status.kind !== "awaiting_input";
      const pending = settled ? without(s.pending, frame.session.id) : s.pending;
      // An open plan overlay for a session that has moved on is stale — drop it.
      const planGone = settled && s.plan?.sessionId === frame.session.id;
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId),
        ...settlePendingSelect(s, sessions),
        pending,
        ...(planGone
          ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode }
          : {}),
      };
    }
    case "providers_updated":
      // The daemon's remembered new-session defaults (last provider / model /
      // effort / mode) changed — adopt the fresh provider list so the `new`
      // prompt seeds from what the next create would actually use.
      return { ...s, providers: frame.providers };

    case "session_removed": {
      const sessions = s.sessions.filter((x) => x.id !== frame.sessionId);
      const planGone = s.plan?.sessionId === frame.sessionId;
      // A send/answer/title/compact prompt aimed at a session another client
      // just removed would loop on submit (RPC error → reopen). Close it.
      const promptGone = s.prompt?.sessionId === frame.sessionId;
      const pickerGone = s.picker?.ctx?.liveSessionId === frame.sessionId;
      // A `find` picker lists sessions by id — drop the vanished row so `enter`
      // can't land on a ghost.
      let picker = s.picker;
      if (
        !pickerGone &&
        picker?.kind === "find" &&
        picker.items.some((it) => it.id === frame.sessionId)
      ) {
        const items = picker.items.filter((it) => it.id !== frame.sessionId);
        picker = { ...picker, items, index: Math.min(picker.index, Math.max(0, items.length - 1)) };
      }
      // The pending selection itself was removed before it ever arrived — drop
      // the hold so the clamp falls back to the fleet head.
      const pendingSel = s.pendingSelectId === frame.sessionId ? undefined : s.pendingSelectId;
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId, pendingSel),
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
          : { picker }),
      };
    }
    case "resync":
      // The client refetches and dispatches a fresh `sessions` action. Drop the
      // compacting indicators — the heartbeats that feed them were in the frames
      // we rolled past; a still-running compaction re-announces within ~10s.
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
}

/**
 * Prompt-cache liveness for a session, given the current time. `unknown` when
 * the TTL isn't pinned or the session hasn't taken a turn. The countdown is an
 * estimate — it can't see mid-turn refreshes or server-side eviction — hence
 * `lastHit`, the ground truth from the last turn's cache read/write split.
 */
export const cacheStatus = (s: SessionSnapshot | null, now: number): CacheStatus => {
  if (!s || s.cache.ttlMinutes <= 0 || s.cache.lastTurnAt <= 0) {
    return { state: "unknown", remainingMs: 0, fraction: 0, lastHit: null };
  }
  const { lastTurnAt, ttlMinutes, lastRead, lastWrite } = s.cache;
  let lastHit: CacheStatus["lastHit"] = null;
  if (lastRead > 0 && lastRead >= lastWrite) lastHit = "hit";
  else if (lastWrite > 0) lastHit = "rewrote";
  const ttlMs = ttlMinutes * 60_000;
  const remainingMs = lastTurnAt + ttlMs - now;
  return remainingMs > 0
    ? { state: "warm", remainingMs, fraction: Math.min(1, remainingMs / ttlMs), lastHit }
    : { state: "cold", remainingMs: 0, fraction: 0, lastHit };
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
 * drill-down) narrows the session's log first to the events that child
 * produced — the `agentId` tag the adapter stamps on sub-agent frames — and
 * the condensers then run on that narrowed stream, so thinking-runs collapse
 * within the child rather than across the whole session.
 */
export const visibleLog = (s: TuiState, child: FleetChild | null = null): LogLine[] => {
  const rows = sessionLog(s);
  const base = child ? rows.filter((l) => l.agentId === child.id) : rows;
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
export const modelPickEmptyText = (providerId: string): string => {
  if (isClaudeId(providerId)) return "claude uses its configured model — enter to continue";
  return `no models detected for "${providerId}" — check \`loom models ${providerId}\` or set model / models in config; enter to use the provider default`;
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
  return levels.map((lvl) => ({ id: lvl, label: lvl }));
};

/**
 * `Esc` inside a picker: step back one level of the provider → model →
 * (optional) effort → prompt wizard instead of discarding the whole detour
 * (and any draft text typed before it). Kinds with no "back" step — `find`,
 * `undo`, `command`, or a bare live `⌥m` / `⌥t` switch with nothing to
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
  if (p.kind === "provider") {
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
        emptyText: modelPickEmptyText(providerId),
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

/** Sessions as find targets — title + this session's log text folded into the match. */
export const findPickItems = (s: TuiState): PickItem[] => {
  const logBySession = new Map<string, string[]>();
  for (const l of s.log) {
    const arr = logBySession.get(l.sessionId) ?? [];
    arr.push(l.text);
    logBySession.set(l.sessionId, arr);
  }
  return s.sessions.map((sess) => ({
    id: sess.id,
    label: sess.title ?? shortId(sess.id),
    hint: `${sess.provider}${sess.model ? `/${sess.model}` : ""} · ${sess.status.kind}`,
    blob: (logBySession.get(sess.id) ?? []).join(" "),
  }));
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
  | "undo"
  | "fork"
  | "title"
  | "delete"
  | "copybranch"
  | "viewlog"
  | "logs"
  | "fullscreen"
  | "theme"
  | "clearqueue"
  | "restart"
  | "quitall"
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
  { keys: "f", label: "find", act: "find", footer: true },
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
    if (
      (status.kind === "running" ||
        status.kind === "idle" ||
        status.kind === "working_background") &&
      session.contextLimit > 0 &&
      session.contextUsed / session.contextLimit > 0.5
    ) {
      local.push({ keys: "c", label: "compact", act: "compact", footer: true });
    }
    // Keep-warm — palette only (a rarely-flipped toggle). Offered on Claude
    // sessions with a pinned cache TTL, running or idle; the label reflects the
    // current state.
    if ((status.kind === "running" || status.kind === "idle") && session.cache.ttlMinutes > 0) {
      local.push({
        keys: "",
        label: session.keepWarm ? "stop keeping cache warm" : "keep cache warm",
        act: "keepwarm",
      });
    }
    if (status.kind === "idle" || status.kind === "error" || status.kind === "interrupted") {
      local.push({ keys: "x", label: "done", act: "done", footer: true });
    }
    // Second tier — palette / help only (see the grammar note at the top of the
    // file). `⇧⇥` cycles the permission mode, `⌥m` its rarer sibling the model;
    // both also work inside a prompt, so you can re-mode / re-model mid-message.
    local.push({ keys: "⇧⇥", label: "mode", act: "mode" });
    local.push({ keys: "⌥m", label: "model", act: "model" });
    local.push({ keys: "⌥t", label: "effort", act: "effort" });
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
    ["fullscreen", "fullscreen the event log", "⇥"],
    ["theme", `switch to ${nextThemeMode(s.theme)} theme`, "t"],
    ["restart", "restart the daemon", "R"],
    ["quitall", "quit and stop the daemon", "Q"],
  ];
  for (const [id, label, key] of extra) {
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, label, hint: key });
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

export const toLogLine = (seq: number, epoch: string, ev: HarnessEvent): LogLine => {
  const f = formatEvent(ev);
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

export const formatEvent = (ev: HarnessEvent): EventFormat => {
  switch (ev.type) {
    case "assistant_text":
      return { glyph: "▪", text: oneLine(ev.text), full: body(ev.text), tone: "plain" };
    case "thinking":
      return { glyph: "·", text: oneLine(ev.text), full: body(ev.text), tone: "think" };
    case "tool_call": {
      const desc = toolDescriptionOf(ev.input);
      return {
        glyph: "⚙",
        text: `${ev.name}${summarizeInput(ev.input)}`,
        full: toolCallFull(ev.name, ev.input),
        ...(desc !== undefined ? { toolDescription: desc } : {}),
        tone: "warn",
      };
    }
    case "tool_result": {
      const raw = valueOf(ev.output);
      const out = typeof raw === "string" ? body(raw) : "";
      return {
        glyph: "↳",
        text: ev.ok ? "ok" : `error ${oneLine(out || String(raw), 120)}`,
        ...(out ? { full: ev.ok ? out : `error\n${out}` } : {}),
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

const summarizeInput = (input: unknown): string => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
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
 * Full tool-call rendering for the editor / wrapped view: the name, then one
 * `key: value` line per argument — strings verbatim (multi-line ones indented
 * under their key), anything else as compact JSON. Readable, not a raw dump.
 */
const toolCallFull = (name: string, input: unknown): string => {
  if (input == null || typeof input !== "object") return name;
  const entries = Object.entries(input as Record<string, unknown>);
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
  return null;
};

/** Re-export for components that render timestamps. */
export { clock };
