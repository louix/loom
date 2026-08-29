/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import type { HarnessEvent, SessionStatus } from "../protocol/events.ts";
import type { ProviderInfo, PushFrame, SessionSnapshot } from "../protocol/wire.ts";
import { SESSION_MODES, type SessionMode } from "../provider/types.ts";
import { buffer, type Buffer } from "./editor.ts";
import { STATUS, STATUS_ORDER, clock, humanTokens, shortId, truncate, type Tone } from "./theme.ts";

export type Connection = "connecting" | "live" | "reconnecting" | "closed";
export type UiMode = "browse" | "prompt" | "help" | "confirm" | "sendChoice" | "plan" | "picker";
export type LogFilter = "selected" | "all";

export interface DaemonInfo {
  pid: number;
  version: string;
  repoRoot: string;
}

export interface LogLine {
  seq: number;
  sessionId: string;
  /** Sub-agent that produced the event, when applicable. */
  agentId?: string;
  glyph: string;
  text: string;
  tone: Tone;
  ts: number;
}

export interface Notice {
  text: string;
  tone: Tone;
  at: number;
}

export type PromptKind = "send" | "answer" | "deny" | "new" | "title" | "budget" | "discuss";

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

export function makePrompt(init: {
  kind: PromptKind;
  sessionId: string | null;
  requestId?: string;
  label: string;
  text?: string;
  mode?: SessionMode;
  /** For `new`: the provider / model chosen in the `N` picker flow. */
  provider?: string;
  model?: string;
}): PromptState {
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
}

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
  kind: "provider" | "model" | "find";
  title: string;
  items: PickItem[];
  /** Live filter text. */
  filter: string;
  /** Highlight into the *filtered* list. */
  index: number;
  /** Carried context: provider id from the provider step; a live session for `M`. */
  ctx?: { provider?: string; liveSessionId?: string };
}

export function makePicker(init: {
  kind: PickerState["kind"];
  title: string;
  items: PickItem[];
  ctx?: PickerState["ctx"];
}): PickerState {
  return {
    kind: init.kind,
    title: init.title,
    items: init.items,
    filter: "",
    index: 0,
    ...(init.ctx ? { ctx: init.ctx } : {}),
  };
}

/** Case-insensitive subsequence match — every char of `q` appears in order. */
function fuzzyMatch(hay: string, q: string): boolean {
  if (q === "") return true;
  const h = hay.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

/** The picker's items narrowed to the current filter (label + blob). */
export function pickerVisible(p: PickerState): PickItem[] {
  if (p.filter === "") return p.items;
  return p.items.filter((it) => fuzzyMatch(`${it.label} ${it.blob ?? ""}`, p.filter));
}

/** The currently-highlighted item, honouring the filter. */
export function pickerCurrent(p: PickerState): PickItem | null {
  const vis = pickerVisible(p);
  return vis[Math.max(0, Math.min(vis.length - 1, p.index))] ?? null;
}

export interface ConfirmState {
  title: string;
  body?: string;
  danger: boolean;
  action: "restart" | "quitAll";
}

/**
 * Outstanding round-trips per session, recovered from the event stream — the
 * ids to answer with, plus enough of the request to show what it's asking.
 */
export interface Pending {
  permission?: string;
  permTool?: string;
  permInput?: unknown;
  question?: string;
  questionText?: string;
  questionContext?: string;
  plan?: string;
  planText?: string;
}

export interface TuiState {
  connection: Connection;
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
  notice: Notice | null;
  mode: UiMode;
  prompt: PromptState | null;
  confirm: ConfirmState | null;
  /** A composed `send` awaiting the asap / turn-end choice (target is running). */
  sendChoice: { sessionId: string; text: string } | null;
  /** An open plan-review overlay: the plan text + the ids to resolve it with. */
  plan: { sessionId: string; requestId: string; text: string } | null;
  /** An open picker overlay (provider / model / find). */
  picker: PickerState | null;
  /** Submitted `new` / `send` prompts, oldest first, for ↑/↓ recall. */
  promptHistory: string[];
}

export function initialState(logCap = 400): TuiState {
  return {
    connection: "connecting",
    daemon: null,
    providers: [],
    sessions: [],
    selectedId: null,
    log: [],
    logCap,
    logFilter: "selected",
    pending: {},
    queue: {},
    notice: null,
    mode: "browse",
    prompt: null,
    confirm: null,
    sendChoice: null,
    plan: null,
    picker: null,
    promptHistory: [],
  };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export type Action =
  | { t: "hello"; daemon: DaemonInfo; sessions: SessionSnapshot[] }
  | { t: "providers"; list: ProviderInfo[] }
  | { t: "sessions"; sessions: SessionSnapshot[] }
  | { t: "push"; frame: PushFrame }
  | { t: "connection"; value: Connection }
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
  | { t: "closePrompt" }
  | { t: "echo"; line: LogLine }
  | { t: "enqueue"; sessionId: string; text: string }
  | { t: "dequeue"; sessionId: string }
  | { t: "clearQueue"; sessionId: string }
  | { t: "openSendChoice"; sessionId: string; text: string }
  | { t: "closeSendChoice" }
  | { t: "openPlan"; sessionId: string; requestId: string; text: string }
  | { t: "closePlan" }
  | { t: "openConfirm"; confirm: ConfirmState }
  | { t: "closeConfirm" }
  | { t: "openPicker"; picker: PickerState }
  | { t: "pickerFilter"; value: string }
  | { t: "pickerMove"; delta: number }
  | { t: "closePicker" }
  | { t: "help"; value: boolean };

export function reduce(s: TuiState, a: Action): TuiState {
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
      };
    }

    case "sessions": {
      const sessions = sortSessions(a.sessions);
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending: pruneByLive(s.pending, sessions),
        queue: pruneByLive(s.queue, sessions),
      };
    }

    case "push":
      return applyPush(s, a.frame);

    case "connection":
      return { ...s, connection: a.value };

    case "move": {
      if (s.sessions.length === 0) return s;
      const idx = s.sessions.findIndex((x) => x.id === s.selectedId);
      const from = idx < 0 ? 0 : idx;
      const next = Math.max(0, Math.min(s.sessions.length - 1, from + a.delta));
      const picked = s.sessions[next];
      return picked ? { ...s, selectedId: picked.id } : s;
    }

    case "select":
      return s.sessions.some((x) => x.id === a.id) ? { ...s, selectedId: a.id } : s;

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
      const next = SESSION_MODES[(SESSION_MODES.indexOf(cur) + 1) % SESSION_MODES.length] ?? "default";
      return { ...s, prompt: { ...s.prompt, mode: next } };
    }

    case "promptHistoryNav": {
      if (!s.prompt || s.promptHistory.length === 0) return s;
      const p = s.prompt;
      const draft = p.histIdx === 0 && a.dir === -1 ? p.buffer.text : p.draft;
      const idx = Math.max(0, Math.min(s.promptHistory.length, p.histIdx + (a.dir === -1 ? 1 : -1)));
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

    case "closePrompt":
      return { ...s, mode: "browse", prompt: null };

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

    case "openSendChoice":
      return { ...s, mode: "sendChoice", sendChoice: { sessionId: a.sessionId, text: a.text }, prompt: null };

    case "closeSendChoice":
      return { ...s, mode: "browse", sendChoice: null };

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

    case "help":
      return { ...s, mode: a.value ? "help" : "browse" };
  }
}

function applyPush(s: TuiState, frame: PushFrame): TuiState {
  switch (frame.type) {
    case "event": {
      const ev = frame.event;
      const pending = trackPending(s.pending, ev);
      const notice = noticeForEvent(s, ev) ?? s.notice;
      // `status_changed` is already shown live in the detail / fleet panes;
      // keep it out of the log so the log reads as a transcript.
      if (ev.type === "status_changed") return { ...s, pending, notice };
      // A frame may arrive twice around startup (history backfill overlapping
      // the live stream) — the seq is authoritative, so drop the repeat.
      if (frame.seq > 0 && s.log.some((l) => l.seq === frame.seq)) return { ...s, pending, notice };
      const log = [...s.log, toLogLine(frame.seq, ev)];
      if (log.length > s.logCap) log.splice(0, log.length - s.logCap);
      return { ...s, log, pending, notice };
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
        ...(planGone ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode } : {}),
      };
    }
    case "session_removed": {
      const sessions = s.sessions.filter((x) => x.id !== frame.sessionId);
      const planGone = s.plan?.sessionId === frame.sessionId;
      const pickerGone = s.picker?.ctx?.liveSessionId === frame.sessionId;
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending: without(s.pending, frame.sessionId),
        queue: without(s.queue, frame.sessionId),
        ...(planGone ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode } : {}),
        ...(pickerGone ? { picker: null, mode: s.mode === "picker" ? ("browse" as UiMode) : s.mode } : {}),
      };
    }
    case "resync":
      // The client refetches and dispatches a fresh `sessions` action.
      return s;
  }
}

function trackPending(pending: Record<string, Pending>, ev: HarnessEvent): Record<string, Pending> {
  if (ev.type === "permission_request") {
    return {
      ...pending,
      [ev.sessionId]: { ...pending[ev.sessionId], permission: ev.id, permTool: ev.tool, permInput: ev.input },
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
  // A resolved permission is cleared wholesale when the session leaves
  // awaiting_input — see the `session_updated` case.
  return pending;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
}

/** Drop entries keyed by a session that no longer exists. */
function pruneByLive<T>(rec: Record<string, T>, sessions: readonly SessionSnapshot[]): Record<string, T> {
  const live = new Set(sessions.map((x) => x.id));
  let changed = false;
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(rec)) {
    if (live.has(id)) out[id] = v;
    else changed = true;
  }
  return changed ? out : rec;
}

// ---------------------------------------------------------------------------
// selection / ordering
// ---------------------------------------------------------------------------

const RANK: Record<SessionStatus, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 1,
  interrupted: 2,
  idle: 3,
  error: 4,
  done: 5,
};

/** Fleet-view order: by status group, then most-recently-active first. */
export function sortSessions(list: readonly SessionSnapshot[]): SessionSnapshot[] {
  return [...list].sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r !== 0) return r;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function clampSelection(list: readonly SessionSnapshot[], current: string | null): string | null {
  if (current && list.some((x) => x.id === current)) return current;
  return list[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

export function selectedSession(s: TuiState): SessionSnapshot | null {
  return s.sessions.find((x) => x.id === s.selectedId) ?? null;
}

export function pendingFor(s: TuiState, id: string | null): Pending {
  return (id && s.pending[id]) || {};
}

export function queueFor(s: TuiState, id: string | null): string[] {
  return (id && s.queue[id]) || [];
}

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
export function cacheStatus(s: SessionSnapshot | null, now: number): CacheStatus {
  if (!s || s.cache.ttlMinutes <= 0 || s.cache.lastTurnAt <= 0) {
    return { state: "unknown", remainingMs: 0, fraction: 0, lastHit: null };
  }
  const { lastTurnAt, ttlMinutes, lastRead, lastWrite } = s.cache;
  const lastHit: CacheStatus["lastHit"] =
    lastRead > 0 && lastRead >= lastWrite ? "hit" : lastWrite > 0 ? "rewrote" : null;
  const ttlMs = ttlMinutes * 60_000;
  const remainingMs = lastTurnAt + ttlMs - now;
  return remainingMs > 0
    ? { state: "warm", remainingMs, fraction: Math.min(1, remainingMs / ttlMs), lastHit }
    : { state: "cold", remainingMs: 0, fraction: 0, lastHit };
}

/** Fraction of TTL left above which the cache dot reads as fresh / still-usable. */
export const CACHE_FRESH_FRACTION = 0.33;
/** …and below which it reads as about to lapse. */
export const CACHE_EXPIRING_FRACTION = 0.08;

/** Coarsen a warm {@link CacheStatus} into a heat band for the fleet dot; `null` when not warm. */
export function cacheHeat(cs: CacheStatus): "fresh" | "fading" | "expiring" | null {
  if (cs.state !== "warm") return null;
  if (cs.fraction >= CACHE_FRESH_FRACTION) return "fresh";
  if (cs.fraction >= CACHE_EXPIRING_FRACTION) return "fading";
  return "expiring";
}

export function visibleLog(s: TuiState): LogLine[] {
  if (s.logFilter === "all" || !s.selectedId) return s.log;
  return s.log.filter((l) => l.sessionId === s.selectedId);
}

// ---------------------------------------------------------------------------
// provider / model / find helpers for the picker flow
// ---------------------------------------------------------------------------

/** The Ink colour a provider's session ids render in, or "" for the default. */
export function providerColorOf(s: TuiState, providerId: string): string {
  return s.providers.find((p) => p.id === providerId)?.color ?? "";
}

export function providerInfo(s: TuiState, providerId: string): ProviderInfo | null {
  return s.providers.find((p) => p.id === providerId) ?? null;
}

export function defaultProviderId(s: TuiState): string {
  return s.providers.find((p) => p.isDefault)?.id ?? "claude";
}

export function providerPickItems(s: TuiState): PickItem[] {
  return s.providers.map((p) => ({
    id: p.id,
    label: p.tag || p.id,
    hint: p.isDefault ? "default" : p.models.length ? `${p.models.length} models` : "",
  }));
}

export function modelPickItems(s: TuiState, providerId: string): PickItem[] {
  return (providerInfo(s, providerId)?.models ?? []).map((m) => ({ id: m, label: m }));
}

/** Sessions as find targets — title + this session's log text folded into the match. */
export function findPickItems(s: TuiState): PickItem[] {
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
}

export interface Group {
  status: SessionStatus;
  label: string;
  sessions: SessionSnapshot[];
}

export function groupsOf(sessions: readonly SessionSnapshot[]): Group[] {
  const out: Group[] = [];
  for (const status of STATUS_ORDER) {
    const inGroup = sessions.filter((x) => x.status === status);
    if (inGroup.length > 0) out.push({ status, label: STATUS[status].label, sessions: inGroup });
  }
  return out;
}

// ---------------------------------------------------------------------------
// contextual actions — what the footer offers and the keymap allows
// ---------------------------------------------------------------------------

export type ActName =
  | "approve"
  | "deny"
  | "answer"
  | "send"
  | "interrupt"
  | "resume"
  | "done"
  | "compact"
  | "planreview"
  | "mode"
  | "model"
  | "title"
  | "budget"
  | "new"
  | "find"
  | "filter"
  | "help"
  | "quit";

export interface KeyHint {
  keys: string;
  label: string;
  act: ActName;
}

const GLOBAL_HINTS: KeyHint[] = [
  { keys: "n", label: "new", act: "new" },
  { keys: "f", label: "find", act: "find" },
  { keys: "?", label: "help", act: "help" },
  { keys: "q", label: "quit", act: "quit" },
];

/** The actions valid for the given session, most salient first, then globals. */
export function actionsFor(session: SessionSnapshot | null): KeyHint[] {
  const local: KeyHint[] = [];
  if (session) {
    const { status, awaitReason } = session;
    if (status === "awaiting_input" && awaitReason === "question") {
      local.push({ keys: "a", label: "answer", act: "answer" });
    } else if (status === "awaiting_input" && awaitReason === "plan_review") {
      local.push({ keys: "a", label: "review plan", act: "planreview" });
    } else if (status === "awaiting_input") {
      local.push({ keys: "a", label: "approve", act: "approve" });
      local.push({ keys: "d", label: "deny", act: "deny" });
    }
    if (status === "running" || status === "starting" || status === "awaiting_input") {
      local.push({ keys: "i", label: "interrupt", act: "interrupt" });
    }
    if (status === "running" || status === "idle") {
      local.push({ keys: "s", label: "send", act: "send" });
    }
    if (
      (status === "running" || status === "idle") &&
      session.contextLimit > 0 &&
      session.contextUsed / session.contextLimit > 0.5
    ) {
      local.push({ keys: "c", label: "compact", act: "compact" });
    }
    if (status === "interrupted" || status === "error") {
      local.push({ keys: "r", label: "resume", act: "resume" });
    }
    if (status === "idle" || status === "error" || status === "interrupted") {
      local.push({ keys: "x", label: "done", act: "done" });
    }
    local.push({ keys: "⇧⇥", label: "mode", act: "mode" });
    local.push({ keys: "M", label: "model", act: "model" });
    local.push({ keys: "e", label: "rename", act: "title" });
    local.push({ keys: "b", label: "budget", act: "budget" });
  }
  return [...local, ...GLOBAL_HINTS];
}

/** Convenience for tests / keymap: the bare set of permitted act names. */
export function allowedActs(session: SessionSnapshot | null): Set<ActName> {
  return new Set(actionsFor(session).map((h) => h.act));
}

// ---------------------------------------------------------------------------
// event → log line
// ---------------------------------------------------------------------------

export function toLogLine(seq: number, ev: HarnessEvent): LogLine {
  const f = formatEvent(ev);
  return {
    seq,
    sessionId: ev.sessionId,
    ...(ev.agentId ? { agentId: ev.agentId } : {}),
    glyph: f.glyph,
    text: f.text,
    tone: f.tone,
    ts: ev.ts,
  };
}

export interface EventFormat {
  glyph: string;
  text: string;
  tone: Tone;
}

const oneLine = (s: string, n = 200): string => truncate(s.replace(/\s+/g, " ").trim(), n);

export function formatEvent(ev: HarnessEvent): EventFormat {
  switch (ev.type) {
    case "assistant_text":
      return { glyph: "▪", text: oneLine(ev.text), tone: "plain" };
    case "thinking":
      return { glyph: "·", text: oneLine(ev.text), tone: "think" };
    case "tool_call":
      return { glyph: "⚙", text: `${ev.name}${summarizeInput(ev.input)}`, tone: "warn" };
    case "tool_result":
      return { glyph: "↳", text: ev.ok ? "ok" : `error ${oneLine(String(valueOf(ev.output)), 120)}`, tone: ev.ok ? "good" : "bad" };
    case "permission_request":
      return { glyph: "⇱", text: `${ev.tool} needs approval · req ${ev.id}`, tone: "accent" };
    case "question":
      return { glyph: "?", text: `${oneLine(ev.question, 120)} · req ${ev.id}`, tone: "accent" };
    case "answer":
      return { glyph: "↩", text: oneLine(ev.text, 120), tone: "accent" };
    case "plan_review":
      return { glyph: "❖", text: `plan ready for review · req ${ev.id}`, tone: "accent" };
    case "usage":
      return {
        glyph: "∑",
        text: `+${humanTokens(ev.tokens.input)}in +${humanTokens(ev.tokens.output)}out · ctx ${humanTokens(ev.contextUsed)}/${humanTokens(ev.contextLimit)}`,
        tone: "dim",
      };
    case "compact":
      return {
        glyph: "⇊",
        text: `context compacted ${humanTokens(ev.before)}${ev.after > 0 ? ` → ${humanTokens(ev.after)}` : ""}${ev.summary ? ` · ${oneLine(ev.summary, 80)}` : ""}`,
        tone: "accent",
      };
    case "subagent_started":
      return { glyph: "⤷", text: `sub-agent “${ev.name}” started`, tone: "dim" };
    case "subagent_stopped":
      return { glyph: "⤴", text: `sub-agent finished`, tone: "dim" };
    case "status_changed":
      return { glyph: "◈", text: `${ev.status}${ev.reason ? ` (${ev.reason})` : ""}`, tone: "dim" };
    case "error":
      return { glyph: "✕", text: oneLine(ev.message, 160), tone: "bad" };
    case "result":
      // The turn's text is already in the log as assistant_text; a failure gets
      // its own `error` line. So this is just a terse end-of-turn marker.
      return { glyph: "■", text: ev.ok ? "turn complete" : "turn failed", tone: ev.ok ? "good" : "bad" };
  }
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "pattern", "query", "url"]) {
      if (typeof o[k] === "string") return `  ${oneLine(o[k] as string, 80)}`;
    }
  }
  return "";
}

function valueOf(x: unknown): unknown {
  if (x && typeof x === "object" && "text" in (x as Record<string, unknown>)) {
    return (x as Record<string, unknown>)["text"];
  }
  return x;
}

function noticeForEvent(s: TuiState, ev: HarnessEvent): Notice | null {
  const tag = ev.sessionId === s.selectedId ? "" : ` [${shortId(ev.sessionId)}]`;
  if (ev.type === "permission_request") return { text: `${ev.tool} needs approval${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "question") return { text: `question waiting${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "plan_review") return { text: `plan ready for review${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "error" && ev.fatal) return { text: `error: ${oneLine(ev.message, 80)}${tag}`, tone: "bad", at: Date.now() };
  return null;
}

/** Re-export for components that render timestamps. */
export { clock };
