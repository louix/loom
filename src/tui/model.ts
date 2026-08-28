/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import type { HarnessEvent, SessionStatus } from "../protocol/events.ts";
import type { PushFrame, SessionSnapshot } from "../protocol/wire.ts";
import { STATUS, STATUS_ORDER, clock, humanTokens, shortId, truncate, type Tone } from "./theme.ts";

export type Connection = "connecting" | "live" | "reconnecting" | "closed";
export type UiMode = "browse" | "prompt" | "help";
export type LogFilter = "selected" | "all";

export interface DaemonInfo {
  pid: number;
  version: string;
  repoRoot: string;
}

export interface LogLine {
  seq: number;
  sessionId: string;
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

export type PromptKind = "send" | "answer" | "deny" | "new";

export interface PromptState {
  kind: PromptKind;
  /** Target session; `null` only for `new`. */
  sessionId: string | null;
  /** Permission / question id, for `answer` and `deny`. */
  requestId?: string;
  label: string;
  value: string;
}

/** Outstanding round-trips per session, recovered from the event stream. */
export interface Pending {
  permission?: string;
  question?: string;
}

export interface TuiState {
  connection: Connection;
  daemon: DaemonInfo | null;
  sessions: SessionSnapshot[];
  selectedId: string | null;
  log: LogLine[];
  logCap: number;
  logFilter: LogFilter;
  pending: Record<string, Pending>;
  notice: Notice | null;
  mode: UiMode;
  prompt: PromptState | null;
}

export function initialState(logCap = 400): TuiState {
  return {
    connection: "connecting",
    daemon: null,
    sessions: [],
    selectedId: null,
    log: [],
    logCap,
    logFilter: "selected",
    pending: {},
    notice: null,
    mode: "browse",
    prompt: null,
  };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export type Action =
  | { t: "hello"; daemon: DaemonInfo; sessions: SessionSnapshot[] }
  | { t: "sessions"; sessions: SessionSnapshot[] }
  | { t: "push"; frame: PushFrame }
  | { t: "connection"; value: Connection }
  | { t: "move"; delta: number }
  | { t: "select"; id: string }
  | { t: "logFilter"; value: LogFilter }
  | { t: "notice"; text: string; tone: Tone }
  | { t: "expireNotice"; now: number; ttlMs?: number }
  | { t: "openPrompt"; prompt: PromptState }
  | { t: "promptInput"; value: string }
  | { t: "closePrompt" }
  | { t: "help"; value: boolean };

export function reduce(s: TuiState, a: Action): TuiState {
  switch (a.t) {
    case "hello": {
      const sessions = sortSessions(a.sessions);
      return {
        ...s,
        connection: "live",
        daemon: a.daemon,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending: prunePending(s.pending, sessions),
      };
    }

    case "sessions": {
      const sessions = sortSessions(a.sessions);
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending: prunePending(s.pending, sessions),
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
      return { ...s, mode: "prompt", prompt: a.prompt };

    case "promptInput":
      return s.prompt ? { ...s, prompt: { ...s.prompt, value: a.value } } : s;

    case "closePrompt":
      return { ...s, mode: "browse", prompt: null };

    case "help":
      return { ...s, mode: a.value ? "help" : "browse" };
  }
}

function applyPush(s: TuiState, frame: PushFrame): TuiState {
  switch (frame.type) {
    case "event": {
      const ev = frame.event;
      const line = toLogLine(frame.seq, ev);
      const log = [...s.log, line];
      if (log.length > s.logCap) log.splice(0, log.length - s.logCap);
      return {
        ...s,
        log,
        pending: trackPending(s.pending, ev),
        notice: noticeForEvent(s, ev) ?? s.notice,
      };
    }
    case "session_updated": {
      const rest = s.sessions.filter((x) => x.id !== frame.session.id);
      const sessions = sortSessions([...rest, frame.session]);
      // Any outstanding round-trip is settled once the session leaves awaiting_input.
      const pending =
        frame.session.status === "awaiting_input"
          ? s.pending
          : without(s.pending, frame.session.id);
      return { ...s, sessions, selectedId: clampSelection(sessions, s.selectedId), pending };
    }
    case "session_removed": {
      const sessions = s.sessions.filter((x) => x.id !== frame.sessionId);
      return {
        ...s,
        sessions,
        selectedId: clampSelection(sessions, s.selectedId),
        pending: without(s.pending, frame.sessionId),
      };
    }
    case "resync":
      // The client refetches and dispatches a fresh `sessions` action.
      return s;
  }
}

function trackPending(pending: Record<string, Pending>, ev: HarnessEvent): Record<string, Pending> {
  if (ev.type === "permission_request") {
    return { ...pending, [ev.sessionId]: { ...pending[ev.sessionId], permission: ev.id } };
  }
  if (ev.type === "question") {
    return { ...pending, [ev.sessionId]: { ...pending[ev.sessionId], question: ev.id } };
  }
  if (ev.type === "answer") {
    const cur = pending[ev.sessionId];
    if (!cur) return pending;
    const { question: _drop, ...rest } = cur;
    return { ...pending, [ev.sessionId]: rest };
  }
  return pending;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
}

function prunePending(
  pending: Record<string, Pending>,
  sessions: readonly SessionSnapshot[],
): Record<string, Pending> {
  const live = new Set(sessions.map((x) => x.id));
  const out: Record<string, Pending> = {};
  for (const [id, p] of Object.entries(pending)) if (live.has(id)) out[id] = p;
  return out;
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

export function visibleLog(s: TuiState): LogLine[] {
  if (s.logFilter === "all" || !s.selectedId) return s.log;
  return s.log.filter((l) => l.sessionId === s.selectedId);
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
  | "new"
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
  { keys: "f", label: "filter", act: "filter" },
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
    if (status === "interrupted") local.push({ keys: "r", label: "resume", act: "resume" });
    if (status === "idle" || status === "error" || status === "interrupted") {
      local.push({ keys: "x", label: "done", act: "done" });
    }
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
  return { seq, sessionId: ev.sessionId, glyph: f.glyph, text: f.text, tone: f.tone, ts: ev.ts };
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
    case "usage":
      return {
        glyph: "∑",
        text: `+${humanTokens(ev.tokens.input)}in +${humanTokens(ev.tokens.output)}out · ctx ${humanTokens(ev.contextUsed)}/${humanTokens(ev.contextLimit)}`,
        tone: "dim",
      };
    case "subagent_started":
      return { glyph: "⤷", text: `subagent ${ev.name} started`, tone: "dim" };
    case "subagent_stopped":
      return { glyph: "⤴", text: `subagent ${ev.subagentId} stopped`, tone: "dim" };
    case "status_changed":
      return { glyph: "◈", text: `${ev.status}${ev.reason ? ` (${ev.reason})` : ""}`, tone: "dim" };
    case "error":
      return { glyph: "✕", text: oneLine(ev.message, 160), tone: "bad" };
    case "result":
      return { glyph: "■", text: ev.ok ? oneLine(ev.summary ?? "done") : "failed", tone: ev.ok ? "good" : "bad" };
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
  if (ev.type === "error" && ev.fatal) return { text: `error: ${oneLine(ev.message, 80)}${tag}`, tone: "bad", at: Date.now() };
  return null;
}

/** Re-export for components that render timestamps. */
export { clock };
