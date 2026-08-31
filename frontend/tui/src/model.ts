/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import { absurd } from "@loom/core/absurd";
import type { HarnessEvent, SessionStatus } from "@loom/core/events";
import type { ProviderInfo, PushFrame, SessionSnapshot } from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { buffer, type Buffer } from "./editor.ts";
import {
  STATUS_ORDER,
  clock,
  humanTokens,
  shortId,
  statusLook,
  truncate,
  type ThemeMode,
  type Tone,
} from "./theme.ts";

export type Connection = "connecting" | "live" | "reconnecting" | "closed";
export type UiMode = "browse" | "prompt" | "help" | "confirm" | "plan" | "picker";
/**
 * Keybinding grammar (see docs/keybindings.md):
 *   • bare key  → act on the selected session, or move
 *   • Shift+key → the heavier / structural sibling (Q quit-all · R restart · X delete · F fork)
 *   • Ctrl+key  → text editing only, inside the prompt (⌃a/⌃e/⌃b/⌃f/⌃u/⌃k/⌃w); ⌃c quits
 *   • Alt+key   → run an action without leaving the prompt (⌥e ⌥o ⌥p ⌥m ⌥x)
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
export const cycleLogFilter = (f: LogFilter): LogFilter =>
  f === "chat" ? "chat_and_tools" : f === "chat_and_tools" ? "everything" : "chat";

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

export interface DaemonInfo {
  pid: number;
  version: string;
  repoRoot: string;
}

export interface LogLine {
  seq: number;
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
  tone: Tone;
  ts: number;
}

export interface Notice {
  text: string;
  tone: Tone;
  at: number;
}

export type PromptKind = "send" | "answer" | "deny" | "new" | "title" | "discuss" | "compact";

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
  /** History cursor: 0 = the live buffer, 1..N = {@link TuiState.promptHistory} from newest. */
  histIdx: number;
  /** Live buffer text, stashed while browsing history. */
  draft: string;
}

export const makePrompt = (init: {
  kind: PromptKind;
  sessionId: string | null;
  requestId?: string;
  label: string;
  text?: string;
  mode?: SessionMode;
  /** For `new`: the provider / model chosen in the `N` picker flow. */
  provider?: string;
  model?: string;
}): PromptState => {
  return {
    kind: init.kind,
    sessionId: init.sessionId,
    label: init.label,
    ...(init.requestId ? { requestId: init.requestId } : {}),
    ...(init.mode ? { mode: init.mode } : {}),
    ...(init.provider ? { provider: init.provider } : {}),
    ...(init.model ? { model: init.model } : {}),
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
  kind: "provider" | "model" | "find" | "undo" | "command";
  title: string;
  items: PickItem[];
  /** Shown when `items` is empty (e.g. no models detected for a provider). */
  emptyText?: string;
  /** Live filter text. */
  filter: string;
  /** Highlight into the *filtered* list. */
  index: number;
  /** Carried context: provider id from the provider step; `liveSessionId` for a
   *  live `⌥m` model switch; `draft` restores a half-typed prompt after the
   *  detour; `reopenSend` returns to that session's send prompt afterwards. */
  ctx?: { provider?: string; liveSessionId?: string; draft?: string; reopenSend?: string };
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

export interface TuiState {
  connection: Connection;
  theme: ThemeMode;
  daemon: DaemonInfo | null;
  /** Configured providers, from `providers.list` at connect time. */
  providers: ProviderInfo[];
  sessions: SessionSnapshot[];
  selectedId: string | null;
  log: LogLine[];
  logCap: number;
  logFilter: LogFilter;
  pending: Record<string, Pending>;
  /** Follow-up messages typed at a still-running session, awaiting its next idle. */
  queue: Record<string, string[]>;
  /** Sessions with a compaction in flight → when it started (for a live "compacting… Ns"). */
  compacting: Record<string, { startedAt: number; generated: number; before: number }>;
  notice: Notice | null;
  mode: UiMode;
  prompt: PromptState | null;
  confirm: ConfirmState | null;
  /** An open plan-review overlay: the plan text + the ids to resolve it with. */
  plan: { sessionId: string; requestId: string; text: string } | null;
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

export const initialState = (logCap = 400): TuiState => {
  return {
    connection: "connecting",
    theme: "dark",
    daemon: null,
    providers: [],
    sessions: [],
    selectedId: null,
    log: [],
    logCap,
    logFilter: "everything",
    pending: {},
    queue: {},
    compacting: {},
    notice: null,
    mode: "browse",
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
  | { t: "push"; frame: PushFrame }
  | { t: "connection"; value: Connection }
  | { t: "toggleTheme" }
  | { t: "move"; delta: number }
  | { t: "select"; id: string }
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
  | { t: "openConfirm"; confirm: ConfirmState }
  | { t: "toggleConfirmBranch" }
  | { t: "closeConfirm" }
  | { t: "openPicker"; picker: PickerState }
  | { t: "pickerFilter"; value: string }
  | { t: "pickerMove"; delta: number }
  | { t: "closePicker" }
  | { t: "resolvePerm"; sessionId: string; id: string }
  | { t: "help"; value: boolean };

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
        selectedId: clampSelection(sessions, s.selectedId),
        pending: pruneByLive(s.pending, sessions),
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
        selectedId: clampSelection(sessions, s.selectedId),
        pending: pruneByLive(s.pending, sessions),
        queue: pruneByLive(s.queue, sessions),
        compacting: pruneByLive(s.compacting, sessions),
      };
    }

    case "push":
      return applyPush(s, a.frame);

    case "connection":
      return { ...s, connection: a.value };

    case "toggleTheme":
      return { ...s, theme: s.theme === "dark" ? "light" : "dark" };

    case "move": {
      if (s.sessions.length === 0) return s;
      const idx = s.sessions.findIndex((x) => x.id === s.selectedId);
      const from = idx < 0 ? 0 : idx;
      const next = Math.max(0, Math.min(s.sessions.length - 1, from + a.delta));
      const picked = s.sessions[next];
      return picked ? { ...s, selectedId: picked.id } : s;
    }

    case "select":
      // Optimistic: a freshly-created / forked session may not be in `sessions`
      // yet (its `session_updated` push can trail the RPC response). Any later
      // `clampSelection` keeps this id if it's real, or falls back to the head.
      return a.id === s.selectedId ? s : { ...s, selectedId: a.id };

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

    case "echo": {
      const log = [...s.log, a.line];
      if (log.length > s.logCap) log.splice(0, log.length - s.logCap);
      return { ...s, log };
    }

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
        plan: { sessionId: a.sessionId, requestId: a.requestId, text: a.text },
        prompt: null,
      };

    case "closePlan":
      return { ...s, mode: s.mode === "plan" ? "browse" : s.mode, plan: null };

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

    default:
      return absurd(a);
  }
};

const applyPush = (s: TuiState, frame: PushFrame): TuiState => {
  switch (frame.type) {
    case "event": {
      const ev = frame.event;
      const pending = trackPending(s.pending, ev);
      const compacting = trackCompacting(s.compacting, ev);
      const notice = noticeForEvent(s, ev) ?? s.notice;
      // `status_changed` is already shown live in the detail / fleet panes;
      // keep it out of the log so the log reads as a transcript. `compact_progress`
      // is a bare heartbeat — it drives the "compacting…" indicator, nothing more.
      if (ev.type === "status_changed") return { ...s, pending, compacting, notice };
      if (ev.type === "compact_progress") return { ...s, compacting, notice };
      // Account-plan usage — surfaced live via the session snapshot's
      // `rateLimits`, not the transcript; it isn't a conversational entry.
      if (ev.type === "rate_limit") return { ...s, pending, compacting, notice };
      // A frame may arrive twice around startup (history backfill overlapping
      // the live stream) — the seq is authoritative, so drop the repeat.
      if (frame.seq > 0 && s.log.some((l) => l.seq === frame.seq))
        return { ...s, pending, compacting, notice };
      const log = [...s.log, toLogLine(frame.seq, ev)];
      if (log.length > s.logCap) log.splice(0, log.length - s.logCap);
      return { ...s, log, pending, compacting, notice };
    }
    case "session_updated": {
      const rest = s.sessions.filter((x) => x.id !== frame.session.id);
      const sessions = sortSessions([...rest, frame.session]);
      // Any outstanding round-trip is settled once the session leaves awaiting_input.
      const settled = frame.session.status !== "awaiting_input";
      const pending = settled ? without(s.pending, frame.session.id) : s.pending;
      // An open plan overlay for a session that has moved on is stale — drop it.
      const planGone = settled && s.plan?.sessionId === frame.session.id;
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending,
        ...(planGone
          ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode }
          : {}),
      };
    }
    case "session_removed": {
      const sessions = s.sessions.filter((x) => x.id !== frame.sessionId);
      const planGone = s.plan?.sessionId === frame.sessionId;
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
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending: without(s.pending, frame.sessionId),
        queue: without(s.queue, frame.sessionId),
        compacting: without(s.compacting, frame.sessionId),
        ...(planGone
          ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode }
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
    // never advances to whatever's genuinely still pending.
    const cur = pending[ev.sessionId];
    if (!cur?.permissions) return pending;
    const rest = cur.permissions.filter((p) => p.id !== ev.id);
    if (rest.length === cur.permissions.length) return pending;
    const { permissions: _drop, ...others } = cur;
    return { ...pending, [ev.sessionId]: rest.length ? { ...others, permissions: rest } : others };
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

// ---------------------------------------------------------------------------
// selection / ordering
// ---------------------------------------------------------------------------

const RANK: Record<SessionStatus, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 2,
  interrupted: 3,
  idle: 4,
  error: 5,
  done: 6,
};

/** Fleet-view order: by status group, then most-recently-active first. */
export const sortSessions = (list: readonly SessionSnapshot[]): SessionSnapshot[] => {
  return [...list].sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r !== 0) return r;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : Number(a.id > b.id);
  });
};

const clampSelection = (
  list: readonly SessionSnapshot[],
  current: string | null,
): string | null => {
  if (current && list.some((x) => x.id === current)) return current;
  return list[0]?.id ?? null;
};

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

export const selectedSession = (s: TuiState): SessionSnapshot | null => {
  return s.sessions.find((x) => x.id === s.selectedId) ?? null;
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

/** What the event pane shows, per {@link LogFilter}. */
export const visibleLog = (s: TuiState): LogLine[] => {
  const rows = sessionLog(s);
  switch (s.logFilter) {
    case "chat":
      return condenseLog(rows);
    case "chat_and_tools":
      return condenseToolResults(rows);
    case "everything":
      return rows;
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
      let calls = 0;
      while (
        j < lines.length &&
        (lines[j]?.kind === "tool_call" || lines[j]?.kind === "tool_result")
      ) {
        if (lines[j]?.kind === "tool_call") calls += 1;
        j += 1;
      }
      const first = lines[i]!;
      out.push({
        seq: first.seq,
        sessionId: first.sessionId,
        kind: "tool_call",
        ...(first.agentId ? { agentId: first.agentId } : {}),
        glyph: "⚙",
        text: `${calls || 1} tool call${calls === 1 ? "" : "s"}`,
        tone: "warn",
        ts: first.ts,
      });
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
  if (providerId === "claude") return "claude uses its configured model — enter to continue";
  return `no models detected for "${providerId}" — check \`loom models ${providerId}\` or set model / models in config; enter to use the provider default`;
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
    hint: `${sess.provider}${sess.model ? `/${sess.model}` : ""} · ${sess.status}`,
    blob: (logBySession.get(sess.id) ?? []).join(" "),
  }));
};

export interface Group {
  status: SessionStatus;
  label: string;
  sessions: SessionSnapshot[];
}

export const groupsOf = (sessions: readonly SessionSnapshot[]): Group[] => {
  const out: Group[] = [];
  for (const status of STATUS_ORDER) {
    const inGroup = sessions.filter((x) => x.status === status);
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
  | "planreview"
  | "mode"
  | "model"
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
    const { status, awaitReason } = session;

    // Request mode — the turn is parked on a decision. Offer only the keys that
    // resolve it (plus interrupt); mode / model / rename / undo / fork are all
    // noise while the agent is blocked, so they're dropped from both the
    // footer and the permitted set the keymap checks.
    if (status === "awaiting_input") {
      if (awaitReason === "question") {
        local.push({ keys: "⏎", label: "answer", act: "answer", footer: true });
      } else if (awaitReason === "plan_review") {
        local.push({ keys: "⏎", label: "review plan", act: "planreview", footer: true });
      } else {
        local.push({ keys: "a", label: "approve", act: "approve", footer: true });
        local.push({ keys: "d", label: "deny", act: "deny", footer: true });
      }
      local.push({ keys: "i", label: "interrupt", act: "interrupt", footer: true });
      return [...local, ...GLOBAL_HINTS];
    }

    if (status === "running" || status === "starting") {
      local.push({ keys: "i", label: "interrupt", act: "interrupt", footer: true });
    }
    // `send` is the one "talk to this session" verb, bound to Enter — it works
    // while running (injects), idle, or stopped (interrupted / errored → the
    // daemon revives the session first). No separate "resume" step.
    if (status !== "starting") {
      local.push({ keys: "⏎", label: "send", act: "send", footer: true });
    }
    if (
      (status === "running" || status === "idle") &&
      session.contextLimit > 0 &&
      session.contextUsed / session.contextLimit > 0.5
    ) {
      local.push({ keys: "c", label: "compact", act: "compact", footer: true });
    }
    if (status === "idle" || status === "error" || status === "interrupted") {
      local.push({ keys: "x", label: "done", act: "done", footer: true });
    }
    // Second tier — palette / help only (see the grammar note at the top of the
    // file). `⇧⇥` cycles the permission mode, `⌥m` its rarer sibling the model;
    // both also work inside a prompt, so you can re-mode / re-model mid-message.
    local.push({ keys: "⇧⇥", label: "mode", act: "mode" });
    local.push({ keys: "⌥m", label: "model", act: "model" });
    // undo + hard fork don't work on Claude sessions yet (fork-tree F3), so
    // don't advertise them there. Hard fork additionally needs an isolated
    // branch, which an in-place session doesn't have — undo (conversation-only)
    // still works there.
    const isAisdk = session.provider !== "claude";
    if (isAisdk && (status === "idle" || status === "interrupted") && session.turns > 1) {
      local.push({ keys: "u", label: "undo", act: "undo" });
    }
    if (isAisdk && !session.inPlace) local.push({ keys: "F", label: "fork", act: "fork" });
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
    ["viewlog", "view the log in $EDITOR", "o"],
    ["logs", "view the daemon + TUI logs in $EDITOR", ""],
    ["filter", `event log: ${logFilterLabel(cycleLogFilter(s.logFilter))}`, "v"],
    ["fullscreen", "fullscreen the event log", "⇥"],
    ["theme", s.theme === "dark" ? "switch to light theme" : "switch to dark theme", "t"],
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
    case "browse": {
      const hints = actionsFor(selectedSession(s))
        .filter((h) => h.footer)
        .map((h) => ({ keys: h.keys, label: h.label }));
      return [...hints, { keys: "␣", label: "more" }];
    }
    default:
      return absurd(s.mode);
  }
};

// ---------------------------------------------------------------------------
// event → log line
// ---------------------------------------------------------------------------

export const toLogLine = (seq: number, ev: HarnessEvent): LogLine => {
  const f = formatEvent(ev);
  return {
    seq,
    sessionId: ev.sessionId,
    kind: ev.type,
    ...(ev.agentId ? { agentId: ev.agentId } : {}),
    glyph: f.glyph,
    text: f.text,
    ...(f.full !== undefined && f.full !== f.text ? { full: f.full } : {}),
    tone: f.tone,
    ts: ev.ts,
  };
};

export interface EventFormat {
  glyph: string;
  text: string;
  /** Untruncated body with newlines, when it differs from {@link text}. */
  full?: string;
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
    case "tool_call":
      return {
        glyph: "⚙",
        text: `${ev.name}${summarizeInput(ev.input)}`,
        full: toolCallFull(ev.name, ev.input),
        tone: "warn",
      };
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
    case "status_changed":
      return { glyph: "◈", text: `${ev.status}${ev.reason ? ` (${ev.reason})` : ""}`, tone: "dim" };
    case "error":
      return { glyph: "✕", text: oneLine(ev.message, 160), full: body(ev.message), tone: "bad" };
    case "result":
      // The turn's text is already in the log as assistant_text; a failure gets
      // its own `error` line. So this is just a terse end-of-turn marker.
      if (ev.stopReason === "step_limit")
        return {
          glyph: "■",
          text: "turn paused — step ceiling hit repeatedly (send to continue)",
          tone: "warn",
        };
      return {
        glyph: "■",
        text: ev.ok ? "turn complete" : "turn failed",
        tone: ev.ok ? "good" : "bad",
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
  if (ev.type === "result" && ev.stopReason === "step_limit")
    return {
      text: `turn paused at the step ceiling${tag} — send to continue`,
      tone: "accent",
      at: Date.now(),
    };
  return null;
};

/** Re-export for components that render timestamps. */
export { clock };
