/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import { absurd } from "@loom/core/absurd";
import type { BackgroundTaskKind, HarnessEvent, SessionStateKind } from "@loom/core/events";
import { isClaudeId } from "@loom/core/provider-id";
import type {
  DaemonInfo,
  DaemonSnapshot,
  DoctorReport,
  ProviderInfo,
  PushFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import type { ClientState, ConnectionError } from "@loom/client";
import { foldLoadable, loadableIdle } from "@loom/core/loadable";
import type { SessionMode } from "@loom/core/types";
import { buffer, type Buffer } from "./editor.ts";
import {
  browse,
  makePicker,
  openPrompt,
  pickerCurrent,
  pickerVisible,
  reconcileOverlay,
  unwind,
  type NewSessionSettings,
  type Overlay,
  type PickItem,
  type Picker,
  type PickerDest,
  type PickerStep,
  type Prompt,
} from "./overlay.ts";
import { nextMode } from "./mode-control.ts";
import type { QNav } from "./interactions.ts";
import {
  noDrafts,
  outboxOf,
  waiting,
  pending,
  recalled,
  recorded,
  type Drafts,
  type Outboxes,
} from "./composer.ts";
import { queryOf, searchMatches, type Find } from "./fleet-search.ts";
import {
  cycleLogFilter,
  filterLog,
  noTranscript,
  queuedLine,
  transcriptLines,
  type Transcript,
  logFilterLabel,
  oneLine,
  type LogFilter,
  type LogLine,
} from "./transcript.ts";
import {
  STATUS_ORDER,
  clock,
  humanTokens,
  nextThemeMode,
  shortId,
  statusLook,
  themeMode,
  type ThemeMode,
  type Tone,
} from "./theme.ts";

/**
 * How the connection reads in the status line. Derived from the snapshot's
 * `Loadable` tag rather than tracked beside it — there is no state the client
 * can be in that this doesn't already say.
 */
export type Connection = "connecting" | "live" | "reconnecting" | "closed";

export const connectionOf = (s: Pick<TuiState, "fleet">): Connection =>
  foldLoadable<ConnectionError, DaemonSnapshot, Connection>({
    onIdle: () => "connecting",
    onPending: () => "reconnecting",
    onError: () => "closed",
    onData: () => "live",
  })(s.fleet);

/** The fleet in display order, or empty while there is no current snapshot. */
export const fleetSessions = (s: Pick<TuiState, "fleet">): SessionSnapshot[] =>
  s.fleet.tag === "data" ? s.fleet.value.sessions : [];

/** Configured providers from the current snapshot, or empty while pending. */
export const fleetProviders = (s: Pick<TuiState, "fleet">): ProviderInfo[] =>
  s.fleet.tag === "data" ? s.fleet.value.providers : [];

export const fleetDaemon = (s: Pick<TuiState, "fleet">): DaemonInfo | null =>
  s.fleet.tag === "data" ? s.fleet.value.daemon : null;

/**
 * Keybinding grammar (see docs/keybindings.md):
 *   • bare key  → act on the selected session, or move
 *   • Shift+key → the heavier / structural sibling (Q quit-all · R restart · X delete · F fork)
 *   • Ctrl+key  → text editing only, inside the prompt (⌃a/⌃e/⌃b/⌃f/⌃u/⌃k/⌃w); ⌃c quits
 *   • Alt+key   → run an action without leaving the prompt (⌥e ⌥o ⌥p ⌥m ⌥t ⌥x)
 *   • Space     → the command palette: everything valid right now, fuzzy, with its key
 */

export interface Notice {
  text: string;
  tone: Tone;
  at: number;
}

/** How long a transient notice stays up. The root arms one timer at this
 *  deadline when a notice appears; nothing polls for it. */
export const NOTICE_TTL_MS = 4_000;

const mkNotice = (text: string, tone: Tone): Notice => ({ text, tone, at: Date.now() });

export interface TuiState {
  theme: ThemeMode;
  /**
   * The daemon's authoritative state, exactly as the client hands it over.
   * There is no second copy and no merging: a snapshot replaces the last one
   * wholesale, and while it is `pending` the UI genuinely has no fleet to show
   * rather than a stale one it might act on. Sessions are stored in display
   * order — {@link sortSessions} runs once at install, not per read.
   */
  fleet: ClientState;
  selectedId: string | null;
  /**
   * A session just picked (create / fork / find) whose row hasn't landed in
   * the fleet yet — the snapshot carrying it can trail the RPC response.
   * `clampSelection` keeps `selectedId` on this id even while it's absent, so
   * an unrelated snapshot in that window can't bounce the user to the fleet
   * head (U4). Cleared once the id appears (or is removed).
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
  logFilter: LogFilter;
  notice: Notice | null;
  /**
   * What is open over the fleet, with its payload inside it — see
   * {@link Overlay}. `browse` is the fleet itself.
   */
  overlay: Overlay;
  /** The last `daemon.doctor` snapshot, shown by the doctor overlay. Fetched
   *  on open; kept between opens so a reopen paints immediately. */
  doctor: DoctorReport | null;
  /** In-progress answers for a multi-question `AskUserQuestion` — see
   *  {@link QNav}. Persists across the answer prompt opening and closing. */
  qnav: QNav | null;
  /** Unsent `new` / `send` text with no session behind it yet — see
   *  {@link Drafts}. */
  drafts: Drafts;
}

export const initialState = (): TuiState => {
  return {
    // The active theme — a theme restored from `.loom/tui.json` was applied
    // via `setThemeMode` before the handle built its initial state.
    theme: themeMode(),
    fleet: loadableIdle,
    selectedId: null,
    selectedChild: null,
    logFilter: "everything",
    notice: null,
    overlay: browse,
    doctor: null,
    qnav: null,
    drafts: noDrafts,
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
  | { t: "state"; state: ClientState }
  | { t: "push"; frame: PushFrame }
  | { t: "toggleTheme" }
  | { t: "move"; delta: number; ids?: readonly string[] }
  | { t: "select"; id: string }
  | { t: "selectChild"; sessionId: string; key: string }
  | { t: "childEnter" }
  | { t: "childExit" }
  | { t: "childMove"; delta: number }
  | { t: "logFilter"; value: LogFilter }
  | { t: "notice"; text: string; tone: Tone }
  | { t: "expireNotice"; now: number; ttlMs?: number }
  /** Put an overlay on screen, or take one off (`browse`). One action for
   *  every open/close: with the payload inside the overlay there is nothing
   *  left to null out alongside it. */
  | { t: "overlay"; overlay: Overlay }
  | { t: "promptSet"; buffer: Buffer }
  | { t: "promptCycleMode" }
  | { t: "promptHistoryNav"; dir: -1 | 1 }
  | { t: "pushHistory"; text: string }
  | { t: "recoverDraft"; text: string }
  /** Close an open prompt, stashing (or dropping) a `new` / `send` draft. */
  | { t: "closePrompt"; saveDraft?: boolean }
  | { t: "cyclePlanMode" }
  | { t: "toggleConfirmBranch" }
  | { t: "pickerFilter"; buffer: Buffer }
  | { t: "pickerMove"; delta: number }
  | { t: "qnavSet"; nav: QNav | null }
  | { t: "doctorLoaded"; report: DoctorReport };

/** Replace the prompt of an open prompt overlay, keeping everything the
 *  variant carries (a discuss prompt keeps its review). */
const withPrompt = (s: TuiState, prompt: Prompt): TuiState =>
  s.overlay.t === "prompt" ? { ...s, overlay: { t: "prompt", prompt } } : s;

export const reduce = (s: TuiState, a: Action): TuiState => {
  switch (a.t) {
    case "state":
      return applyClientState(s, a.state);

    case "push":
      return applyPush(s, a.frame);

    case "toggleTheme":
      return { ...s, theme: nextThemeMode(s.theme) };

    case "move": {
      // With the fleet filter up, ↑/↓ walk the matching sessions in relevance
      // order — the rows the fleet is actually showing. Off-list (the
      // selection was filtered out), ↓ lands on the best match and ↑ on the
      // last.
      const list = a.ids ?? fleetSessions(s).map((x) => x.id);
      let from = list.indexOf(s.selectedId ?? "");
      if (from < 0) from = a.delta < 0 ? list.length : -1;
      const next = Math.max(0, Math.min(list.length - 1, from + a.delta));
      const picked = list[next];
      if (!picked || picked === s.selectedId) return s;
      return { ...s, selectedId: picked, selectedChild: null };
    }

    case "select": {
      // Optimistic: a freshly-created / forked session may not be in the fleet
      // yet (the snapshot carrying it can trail the RPC response). Record it
      // as the pending selection so `clampSelection` holds it until it arrives.
      // A different session invalidates any child focus along with it.
      if (a.id === s.selectedId) return s;
      const known = fleetSessions(s).some((x) => x.id === a.id);
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
      const sess = fleetSessions(s).find((x) => x.id === a.sessionId) ?? null;
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
      return { ...s, notice: mkNotice(a.text, a.tone) };

    case "expireNotice":
      if (!s.notice) return s;
      return a.now - s.notice.at >= (a.ttlMs ?? NOTICE_TTL_MS) ? { ...s, notice: null } : s;

    case "overlay":
      return { ...s, overlay: a.overlay };

    case "promptSet": {
      const p = openPrompt(s.overlay);
      if (!p) return s;
      // Editing a recalled history entry detaches it from the walk: the text
      // becomes the live buffer (histIdx 0) — ↓ can't yank it back to the
      // stashed draft, and ↑ restarts from the newest entry. A cursor-only
      // move (same text) keeps the walk position.
      const histIdx = a.buffer.text !== p.buffer.text ? 0 : p.histIdx;
      return withPrompt(s, { ...p, buffer: a.buffer, histIdx });
    }

    case "promptCycleMode": {
      const p = openPrompt(s.overlay);
      if (p?.t !== "new") return s;
      // A session that doesn't exist yet has no daemon to tell: the `new`
      // prompt's mode is settled the moment it's cycled.
      const mode = nextMode(p.settings.mode);
      return withPrompt(s, { ...p, settings: { ...p.settings, mode } });
    }

    case "promptHistoryNav": {
      const p = openPrompt(s.overlay);
      if (!p || s.drafts.history.length === 0) return s;
      // At the live buffer there is nothing newer — ↓ must not clobber it
      // with the stashed draft.
      if (p.histIdx === 0 && a.dir === 1) return s;
      const draft = p.histIdx === 0 ? p.buffer.text : p.draft;
      const idx = Math.max(
        0,
        Math.min(s.drafts.history.length, p.histIdx + (a.dir === -1 ? 1 : -1)),
      );
      const text = idx === 0 ? draft : recalled(s.drafts, idx);
      return withPrompt(s, { ...p, histIdx: idx, draft, buffer: buffer(text) });
    }

    case "recoverDraft":
      return {
        ...s,
        drafts: { ...s.drafts, last: [s.drafts.last, a.text].filter(Boolean).join("\n\n") },
      };

    case "pushHistory":
      return { ...s, drafts: recorded(s.drafts, a.text) };

    case "closePrompt": {
      const p = openPrompt(s.overlay);
      // A discuss prompt drops back to the review it was opened over; every
      // other prompt to the fleet.
      const overlay = p ? unwind(s.overlay) : s.overlay;
      // Only the two free-text prompts leave a recoverable draft behind.
      const draftable = p?.t === "new" || (p?.t === "session" && p.kind === "send");
      if (!draftable) return { ...s, overlay };
      return { ...s, overlay, drafts: { ...s.drafts, last: a.saveDraft ? p.buffer.text : "" } };
    }

    case "cyclePlanMode": {
      if (s.overlay.t !== "plan") return s;
      // The modes an implementation can run in — `plan` itself is excluded.
      const order: readonly SessionMode[] = ["default", "acceptEdits", "auto"];
      const mode = order[(order.indexOf(s.overlay.plan.mode) + 1) % order.length] ?? "acceptEdits";
      return { ...s, overlay: { t: "plan", plan: { ...s.overlay.plan, mode } } };
    }

    case "toggleConfirmBranch": {
      const c = s.overlay.t === "confirm" ? s.overlay.confirm : null;
      if (!c?.branchName) return s;
      return { ...s, overlay: { t: "confirm", confirm: { ...c, deleteBranch: !c.deleteBranch } } };
    }

    case "pickerFilter": {
      if (s.overlay.t !== "picker") return s;
      return {
        ...s,
        overlay: { t: "picker", picker: { ...s.overlay.picker, filter: a.buffer, index: 0 } },
      };
    }

    case "pickerMove": {
      if (s.overlay.t !== "picker") return s;
      const p = s.overlay.picker;
      const n = pickerVisible(p).length;
      if (n === 0) return s;
      const next = Math.max(0, Math.min(n - 1, p.index + a.delta));
      return next === p.index
        ? s
        : { ...s, overlay: { t: "picker", picker: { ...p, index: next } } };
    }
    case "qnavSet":
      return { ...s, qnav: a.nav };

    case "doctorLoaded":
      return { ...s, doctor: a.report };

    default:
      return absurd(a);
  }
};

/**
 * Install a client snapshot. The fleet is *replaced*, never merged — there are
 * no versions or timestamps to reconcile, so a snapshot that arrives during an
 * in-flight command simply wins.
 *
 * Local state (drafts, prompt buffers, queued follow-ups, the selection the
 * user is holding) survives untouched; what does get reconciled is everything
 * that names a session or a request the new snapshot no longer has — a
 * selection, a child focus, an open plan overlay whose exact request id is
 * gone. While pending there is nothing to reconcile *against*, so those holds
 * are left alone for the next snapshot to settle.
 */
const applyClientState = (s: TuiState, state: ClientState): TuiState => {
  if (state.tag !== "data") {
    // No connection means no transcript we can trust: entries were appended
    // while we were away and the cursor is a position in a history the next
    // connection re-reads from scratch. Drop it with the fleet; the handle
    // bumps its own lifetime in the same breath, so a fetch already in flight
    // cannot land afterwards and reinstate what this just discarded. Drafts
    // and selection are ours, not the daemon's, and survive.
    return { ...s, fleet: state };
  }
  const sessions = sortSessions(state.value.sessions);
  const fleet: ClientState = { tag: "data", value: { ...state.value, sessions } };
  const live = new Set(sessions.map((x) => x.id));
  // Every outstanding request, addressed the way the UI holds one — request ids
  // are unique within a session, not across the fleet.
  const open = new Set<string>();
  for (const x of sessions) for (const r of x.requests) open.add(`${x.id} ${r.id}`);
  const isLive = (sid: string): boolean => live.has(sid);
  const outstanding = (sid: string, rid: string): boolean => open.has(`${sid} ${rid}`);
  // One pass over the open overlay: a prompt, plan review or picker aimed at a
  // session another client removed would loop on submit (RPC error → reopen),
  // and anything bound to a specific request goes when that request does.
  const { overlay, notice } = reconcileOverlay(
    // A picker opened before the start-up model probes settled holds a stale
    // copy of the loading state — refresh its items off the new snapshot so it
    // fills in rather than sitting empty until reopened.
    rederiveOpenPicker({ ...s, fleet }),
    isLive,
    outstanding,
  );
  const qnavGone = s.qnav !== null && !outstanding(s.qnav.sessionId, s.qnav.requestId);
  return {
    ...s,
    fleet,
    selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId),
    ...settlePendingSelect(s, sessions),
    selectedChild: clampChild(sessions, s.selectedId, s.selectedChild),
    ...(qnavGone ? { qnav: null } : {}),
    overlay,
    ...(notice ? { notice: mkNotice(notice, "dim") } : {}),
  };
};

const applyPush = (s: TuiState, frame: PushFrame): TuiState => {
  switch (frame.type) {
    case "event": {
      const ev = frame.event;
      // Only the live stream reaches here, so a notice is always news. History
      // arrives as a `historyPage`, which never touches the notice line — a
      // long-settled "Bash needs approval" flashing for 4s on scroll-back was
      // exactly the confusion that separating the two resources removes (U2).
      const notice = noticeForEvent(s, ev) ?? s.notice;
      return notice === s.notice ? s : { ...s, notice };
    }
    case "resync":
      return s;

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

export const selectedSession = (
  s: Pick<TuiState, "fleet" | "selectedId">,
): SessionSnapshot | null => {
  return fleetSessions(s).find((x) => x.id === s.selectedId) ?? null;
};

/** The focused child of the selected session, when the fleet is drilled in. */
export const focusedChildOf = (
  s: Pick<TuiState, "fleet" | "selectedId" | "selectedChild">,
): FleetChild | null => {
  const sel = selectedSession(s);
  if (!sel || s.selectedChild == null) return null;
  return childrenOf(sel).find((k) => k.key === s.selectedChild) ?? null;
};

/** A compaction the daemon reports in flight for `id`, or null. */
export const compactingFor = (
  s: TuiState,
  id: string | null,
): { startedAt: number; before: number; generated: number } | null => {
  if (!id) return null;
  return fleetSessions(s).find((x) => x.id === id)?.compacting ?? null;
};
/** What the selected session still owes the daemon, oldest first. */
export const queueFor = (
  s: TuiState & { outbox?: Outboxes },
  id: string | null,
): readonly string[] => pending(outboxOf(s.outbox ?? {}, id));

export interface CacheStatus {
  /**
   * `live` — a turn is in flight, so every request in it rewrites the prefix
   *   and no fixed expiry exists to count down to; the cache is warm by
   *   construction. `warm` / `cold` — nothing is running, so `lastTurnAt + ttl`
   *   is the real deadline. `unknown` — no TTL, or no turn has ever run.
   */
  state: "live" | "warm" | "cold" | "unknown";
  /** ms until the cache goes cold (0 unless `warm` — a `live` one has no deadline). */
  remainingMs: number;
  /** Fraction of the TTL still left, 0..1 (0 unless `warm`). */
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
 * estimate — it can't see server-side eviction, and on a `config` source not
 * even the TTL is confirmed — hence `lastHit`, the ground truth from the last
 * turn's cache read/write split.
 *
 * A `running` session is reported `live` rather than counted down. `lastTurnAt`
 * is armed by the turn that *finished*, so during the next one the countdown
 * isn't merely stale, it runs the wrong way: each request of a live turn
 * rewrites the prefix at the pinned TTL, so the true remaining lifetime keeps
 * being restored while the display drains toward zero and eventually claims
 * `cold` for a session that is demonstrably hitting cache. Only `running`
 * qualifies — a session parked on `awaiting_input` (a permission prompt, a plan
 * review) is issuing no requests, and its cache really is draining, which is
 * exactly when the countdown earns its place.
 */
export const cacheStatus = (s: SessionSnapshot | null, now: number): CacheStatus => {
  if (!s || s.cache.ttlMinutes <= 0 || s.cache.lastTurnAt <= 0) {
    return { state: "unknown", remainingMs: 0, fraction: 0, lastHit: null, source: "none" };
  }
  const { lastTurnAt, ttlMinutes, lastRead, lastWrite } = s.cache;
  let lastHit: CacheStatus["lastHit"] = null;
  if (lastRead > 0 && lastRead >= lastWrite) lastHit = "hit";
  else if (lastWrite > 0) lastHit = "rewrote";
  const source = s.cache.ttlSource;
  if (s.status.kind === "running") {
    return { state: "live", remainingMs: 0, fraction: 0, lastHit, source };
  }
  const ttlMs = ttlMinutes * 60_000;
  const remainingMs = lastTurnAt + ttlMs - now;
  return remainingMs > 0
    ? { state: "warm", remainingMs, fraction: Math.min(1, remainingMs / ttlMs), lastHit, source }
    : { state: "cold", remainingMs: 0, fraction: 0, lastHit, source };
};

/** Fraction of TTL left above which the cache dot reads as fresh / still-usable. */
export const CACHE_FRESH_FRACTION = 0.33;
/** …and below which it reads as about to lapse. */
export const CACHE_EXPIRING_FRACTION = 0.08;

/** Coarsen a {@link CacheStatus} into a heat band for the fleet dot; `null` when
 *  there is no warm cache to show. A `live` one is `fresh` without consulting
 *  `fraction`: it is being rewritten, so it is as warm as it ever gets. */
export const cacheHeat = (cs: CacheStatus): "fresh" | "fading" | "expiring" | null => {
  if (cs.state === "live") return "fresh";
  if (cs.state !== "warm") return null;
  if (cs.fraction >= CACHE_FRESH_FRACTION) return "fresh";
  if (cs.fraction >= CACHE_EXPIRING_FRACTION) return "fading";
  return "expiring";
};

/** The selected session's log lines, oldest first: the durable entries the
 *  transcript holds, then a marker per follow-up still waiting to go out.
 *  Those markers are derived, not stored — the outbox is where a queued
 *  message lives, so one disappears exactly when its message goes on the wire
 *  and the daemon's own `user_message` takes its place. */
export const sessionLog = (
  s: TuiState & { outbox?: Outboxes; transcript?: Transcript },
): LogLine[] => {
  const lines = transcriptLines(s.transcript ?? noTranscript);
  const id = s.selectedId;
  if (id === null) return [...lines];
  const queued = waiting(outboxOf(s.outbox ?? {}, id));
  if (queued.length === 0) return [...lines];
  return [...lines, ...queued.map((text) => queuedLine(id, text))];
};

/**
 * What the event pane shows: the selected session's log, narrowed to the
 * focused child when drilled in and condensed per {@link LogFilter} — see
 * {@link filterLog}.
 */
export const visibleLog = (
  s: TuiState & { outbox?: Outboxes; transcript?: Transcript },
  child: FleetChild | null = null,
): LogLine[] => filterLog(sessionLog(s), s.logFilter, child?.id ?? null);

/** The lines the event pane is actually drawing right now — the selected
 *  session's log under the current filter and child focus. What the scrollback
 *  offset is measured against. */
export const shownLog = (s: TuiState & { outbox?: Outboxes; transcript?: Transcript }): LogLine[] =>
  visibleLog(s, focusedChildOf(s));

// ---------------------------------------------------------------------------
// provider / model / find helpers for the picker flow
// ---------------------------------------------------------------------------

/** The Ink colour a provider's session ids render in, or "" for the default. */
export const providerColorOf = (s: Pick<TuiState, "fleet">, providerId: string): string => {
  return fleetProviders(s).find((p) => p.id === providerId)?.color ?? "";
};

export const providerInfo = (
  s: Pick<TuiState, "fleet">,
  providerId: string,
): ProviderInfo | null => {
  return fleetProviders(s).find((p) => p.id === providerId) ?? null;
};

/** `<login method> (<org>)` for a Claude profile, or "" when unknown. */
export const providerAccountOf = (s: Pick<TuiState, "fleet">, providerId: string): string => {
  const a = providerInfo(s, providerId)?.account;
  if (!a) return "";
  if (a.loginMethod && a.org) return `${a.loginMethod} (${a.org})`;
  return a.loginMethod || a.org;
};

export const defaultProviderId = (s: TuiState): string => {
  return fleetProviders(s).find((p) => p.isDefault)?.id ?? "claude";
};

/** The model a new session on `providerId` will use unless changed — the
 *  daemon's remembered "last used", a config pin, or the first detected id. */
export const defaultModelOf = (s: TuiState, providerId: string): string => {
  return providerInfo(s, providerId)?.defaultModel ?? "";
};

/** The permission mode a new session will use unless changed — the daemon's
 *  remembered "last used", or `default` (manual). Not per-provider. */
export const defaultModeOf = (s: TuiState): SessionMode => {
  return fleetProviders(s)[0]?.defaultMode ?? "default";
};

/** The creation settings a `new` prompt starts from. Anything the ⌥p wizard
 *  already settled is passed in; the rest comes from the daemon's remembered
 *  defaults, so the prompt always shows what it would actually create. */
export const newSettings = (
  s: TuiState,
  provider: string | null,
  model: string | null,
  effort: string | null,
): NewSessionSettings => {
  const pid = provider ?? defaultProviderId(s);
  return {
    mode: defaultModeOf(s),
    provider: pid,
    model: model ?? (defaultModelOf(s, pid) || null),
    effort,
  };
};

export const providerPickItems = (s: TuiState): PickItem[] => {
  return fleetProviders(s).map((p) => ({
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
  const error = providerInfo(s, providerId)?.modelsError;
  if (error) return error;
  if (isClaudeId(providerId)) return "claude uses its configured model — enter to continue";
  return `no models detected for "${providerId}" — check \`loom models ${providerId}\` or set model / models in config; enter to use the provider default`;
};

/** A snapshot landed while a provider/model picker is open: rebuild its items
 *  from the fresh list — one opened while the daemon was still detecting models
 *  resolves here instead of sitting empty until reopened. The highlight follows
 *  its id when it survives. Any other overlay passes straight through. */
export const rederiveOpenPicker = (s: TuiState): Overlay => {
  if (s.overlay.t !== "picker") return s.overlay;
  const p = s.overlay.picker;
  if (p.step !== "model" && p.step !== "provider") return s.overlay;
  const providerId = p.chosen.provider ?? "";
  const items = p.step === "model" ? modelPickItems(s, providerId) : providerPickItems(s);
  const cur = pickerCurrent(p)?.id;
  const at = cur ? items.findIndex((it) => it.id === cur) : -1;
  // The list loaded — the empty-state note is dead.
  const emptyText =
    p.step === "model" && items.length === 0 ? modelPickEmptyText(s, providerId) : null;
  return { t: "picker", picker: { ...p, items, index: at >= 0 ? at : 0, emptyText } };
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

/** The items one wizard step offers, off the current snapshot. */
const stepItems = (
  s: TuiState,
  step: WizardStep,
  chosen: { provider: string | null; model: string | null },
): PickItem[] => {
  if (step === "provider") return providerPickItems(s);
  if (step === "model") return modelPickItems(s, chosen.provider ?? "");
  return effortPickItems(s, chosen.provider ?? "", chosen.model ?? "");
};

/** The steps of the provider → model → effort wizard, in order. */
export type WizardStep = "provider" | "model" | "effort";

/**
 * One step of the provider → model → effort wizard, built off the current
 * snapshot: `dest` says where the choices land and what to restore when the
 * wizard unwinds, `chosen` what earlier steps settled, `from` the step this
 * wizard opened at, and `pick` the id to highlight (the session's current
 * value, or the one being stepped back to).
 */
export const pickerStep = (
  s: TuiState,
  step: WizardStep,
  o: {
    dest: PickerDest;
    chosen: { provider: string | null; model: string | null };
    from: PickerStep;
    pick?: string | null;
  },
): Overlay => {
  const pid = o.chosen.provider ?? "";
  const tag = providerInfo(s, pid)?.tag || pid;
  // The ⌥p retarget wizard says so in its title — it stages onto the plan
  // review rather than switching anything live.
  const lead = o.dest.t === "planImpl" ? "retarget · " : "";
  const items = stepItems(s, step, o.chosen);
  const at = o.pick ? items.findIndex((it) => it.id === o.pick) : -1;
  return {
    t: "picker",
    picker: makePicker({
      step,
      title: step === "provider" ? `${lead}provider` : `${lead}${step} · ${tag}`,
      items,
      dest: o.dest,
      chosen: o.chosen,
      from: o.from,
      ...(step === "model" && items.length === 0 ? { emptyText: modelPickEmptyText(s, pid) } : {}),
      index: Math.max(0, at),
    }),
  };
};

/**
 * `Esc` inside a picker: step back one level of the provider → model →
 * (optional) effort wizard rather than discarding the whole detour and any
 * draft typed before it. `from` bounds how far back it can go — a bare `⌥t`
 * opens straight at `effort`, so there is no model list behind it.
 *
 * Past the first step the picker unwinds to whatever it was opened over: the
 * plan review it was retargeting, the send prompt with its half-typed message,
 * the `new` prompt with its settings, or the fleet.
 */
export const escapePicker = (p: Picker, s: TuiState): Overlay => {
  if (p.step === "effort" && p.from !== "effort") {
    return pickerStep(s, "model", {
      dest: p.dest,
      chosen: { provider: p.chosen.provider, model: null },
      from: p.from,
      pick: p.chosen.model,
    });
  }
  if (p.step === "model" && p.from === "provider") {
    return pickerStep(s, "provider", {
      dest: p.dest,
      chosen: { provider: null, model: null },
      from: p.from,
      pick: p.chosen.provider,
    });
  }
  return unwind({ t: "picker", picker: p });
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
export const fleetEntries = (
  state: Pick<TuiState, "fleet" | "selectedId" | "selectedChild"> & { find?: Find | null },
): FleetEntry[] => {
  const matched = searchMatches(state.find ?? null, fleetSessions(state));
  const active = state.find != null && queryOf(state.find) !== "";
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
export const fleetSelectedEntryIndex = (
  state: Pick<TuiState, "fleet" | "selectedId" | "selectedChild">,
  entries: FleetEntry[],
): number => {
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
export const fleetLayout = (
  state: Pick<TuiState, "fleet" | "selectedId" | "selectedChild"> & { find?: Find | null },
  budget: number,
): FleetLayout => {
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
  state: Pick<TuiState, "fleet" | "selectedId" | "selectedChild"> & { find?: Find | null },
  geom: { originX: number; listW: number; originY: number; maxY: number },
  /** The window this frame drew. Defaults to computing it, so a test can ask
   *  for the hit map on its own; the root passes the one it already has, since
   *  hit-testing a *different* window than the one on screen is the bug this
   *  parameter exists to make impossible. */
  layout: FleetLayout = fleetLayout(
    state,
    fleetRowBudget(geom.maxY - geom.originY + 1, state.find != null),
  ),
): FleetHit[] => {
  const { originX, originY } = geom;
  const x0 = originX;
  const x1 = originX + geom.listW - 1;
  const hasFilter = state.find != null;
  const { visible } = layout;

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
  | "comment"
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
    // Palette-only, like keepwarm — a rarely-used per-session note, not a
    // footer verb. No dedicated key.
    local.push({
      keys: "",
      label: session.comment ? "edit comment" : "add comment",
      act: "comment",
    });
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
export const commandsFor = (s: TuiState & { outbox?: Outboxes }): PickItem[] => {
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
  if (fleetSessions(s).some((x) => x.status.kind === "done" && x.worktree)) {
    items.push({ id: "gc", label: "gc — remove worktrees of done sessions", hint: "" });
  }
  if (s.selectedId && queueFor(s, s.selectedId).length > 0) {
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
  switch (s.overlay.t) {
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
        ...(s.overlay.t === "confirm" && s.overlay.confirm.branchName
          ? [{ keys: "b", label: s.overlay.confirm.deleteBranch ? "keep branch" : "+ branch" }]
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
      return absurd(s.overlay);
  }
};

const noticeForEvent = (s: TuiState, ev: HarnessEvent): Notice | null => {
  const tag = ev.sessionId === s.selectedId ? "" : ` [${shortId(ev.sessionId)}]`;
  if (ev.type === "permission_request")
    return { text: `${ev.tool} needs approval${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "question")
    return { text: `question waiting${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "plan_review")
    return { text: `plan ready for review${tag}`, tone: "accent", at: Date.now() };
  if (ev.type === "error")
    return {
      text: `${ev.fatal ? "error" : "recovered"}: ${oneLine(ev.message, 80)}${tag}`,
      tone: ev.fatal ? "bad" : "warn",
      at: Date.now(),
    };
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
