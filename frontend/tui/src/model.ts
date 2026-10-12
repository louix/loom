/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import { absurd } from "@loom/core/absurd";
import { sortSessions, sortSessionsBy } from "@loom/core/session-order";
export { sortSessions };
import type { BackgroundTaskKind, HarnessEvent, SessionStateKind } from "@loom/core/events";
import { isClaudeId } from "@loom/core/provider-id";
import type {
  BaseChoices,
  DaemonInfo,
  DaemonSnapshot,
  DoctorReport,
  ProviderInfo,
  PushFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import type { ClientState, ConnectionError } from "@loom/client";
import type { AgentProfileInfo } from "@loom/core/agents";
import { foldLoadable, loadableIdle, type Loadable } from "@loom/core/loadable";
import type { SessionMode } from "@loom/core/types";
import { DEFAULT_EFFORT_LEVELS, modelEfforts } from "@loom/core/model-catalogue";
import { buffer, type Buffer } from "./editor.ts";
import {
  browse,
  makePicker,
  newPrompt,
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
import { applyProfile, profileBlocked } from "./new-workspace.ts";
import type { QNav } from "./interactions.ts";
import { noDrafts, recalled, recorded, type Drafts } from "./composer.ts";
import type { QueueEntryView } from "@loom/core/message-queue";
import { queryOf, searchMatches, type Find } from "./fleet-search.ts";
import { shownStatusIn, waitingAgentsIn } from "./fleet-status.ts";
import {
  filterLog,
  noTranscript,
  queuedLines,
  transcriptLines,
  type Transcript,
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

/** The agent profiles this repository offers, for the new-session `⌥p` list. */
export const fleetAgentProfiles = (s: Pick<TuiState, "fleet">): AgentProfileInfo[] =>
  s.fleet.tag === "data" ? (s.fleet.value.agentProfiles ?? []) : [];

export const fleetDaemon = (s: Pick<TuiState, "fleet">): DaemonInfo | null =>
  s.fleet.tag === "data" ? s.fleet.value.daemon : null;

/**
 * Keybinding grammar (see docs/keybindings.md):
 *   • bare key  → act on the selected session, or move
 *   • Shift+key → the heavier / structural sibling (Q quit-all · R restart · X delete · F fork)
 *   • Ctrl+key  → text editing only, inside the prompt (⌃a/⌃e/⌃b/⌃f/⌃u/⌃k/⌃w); ⌃c quits
 *   • Alt+key   → run an action without leaving the prompt (⌥e ⌥o ⌥p ⌥m ⌥t ⌥q ⌥x)
 *   • Space     → the command palette: every command, its key, and why not (see commands.ts)
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
  sessionTab: import("../../../core/src/session-inspection.ts").SessionTab;
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
  archiving: readonly string[];
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
   * and whenever churn empties the child list (`clampChild`). A Loom agent
   * drawn under its supervisor is a child row too, but a session in full: the
   * cursor on it is `selectedId` with no child (see {@link cursorParentOf}).
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
  /** What a new session can branch from, read from the repository each time
   *  a `new` prompt opens (the checked-out branch moves). An error is why it
   *  could not be read. */
  bases: Loadable<string, BaseChoices>;
  /** In-progress answers for a multi-question `AskUserQuestion` — see
   *  {@link QNav}. Persists across the answer sheet opening and closing. */
  qnav: QNav | null;
  /** Unsent `new` / `send` text with no session behind it yet — see
   *  {@link Drafts}. */
  drafts: Drafts;
}

export const initialState = (): TuiState => {
  return {
    // The active theme — a theme restored from `tui.json` was applied
    // via `setThemeMode` before the handle built its initial state.
    sessionTab: "chat",
    theme: themeMode(),
    fleet: loadableIdle,
    selectedId: null,
    selectedChild: null,
    archiving: [],
    logFilter: "everything",
    notice: null,
    overlay: browse,
    doctor: null,
    bases: loadableIdle,
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
  | { t: "sessionTab"; tab: TuiState["sessionTab"] }
  | { t: "state"; state: ClientState }
  | { t: "push"; frame: PushFrame }
  | { t: "archivePending"; id: string; pending: boolean }
  | { t: "toggleTheme" }
  /** `ids` on the cursor's moves: the flat list an active filter ranks,
   *  where no agent is nested; absent while the fleet draws its tree. */
  | { t: "move"; delta: number; ids?: readonly string[] }
  | { t: "select"; id: string }
  | { t: "selectChild"; sessionId: string; key: string }
  | { t: "childEnter"; ids?: readonly string[] }
  | { t: "childExit"; ids?: readonly string[] }
  | { t: "childMove"; delta: number; ids?: readonly string[] }
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
  | { t: "restoreHistory"; sessionId: string; texts: readonly string[] }
  | { t: "recoverDraft"; text: string }
  /** Close an open prompt, stashing (or dropping) a `new` / `send` draft. */
  | { t: "closePrompt"; saveDraft?: boolean }
  | { t: "cyclePlanMode" }
  | { t: "toggleConfirmBranch" }
  /** Archiving or deleting a supervisor: stop its agents, or detach them. */
  | { t: "toggleConfirmChildren" }
  | { t: "pickerFilter"; buffer: Buffer }
  | { t: "pickerMove"; delta: number }
  | { t: "qnavSet"; nav: QNav | null }
  | { t: "doctorLoaded"; report: DoctorReport }
  | { t: "basesLoaded"; bases: Loadable<string, BaseChoices> };

/** Replace the prompt of an open prompt overlay, keeping everything the
 *  variant carries (a discuss prompt keeps its review). */
const withPrompt = (s: TuiState, prompt: Prompt): TuiState =>
  s.overlay.t === "prompt" ? { ...s, overlay: { t: "prompt", prompt } } : s;

export const reduce = (s: TuiState, a: Action): TuiState => {
  switch (a.t) {
    case "sessionTab":
      return { ...s, sessionTab: a.tab };
    case "state":
      return applyClientState(s, a.state);

    case "push":
      return applyPush(s, a.frame);

    case "archivePending":
      return {
        ...s,
        archiving: a.pending ? [...s.archiving, a.id] : s.archiving.filter((id) => id !== a.id),
      };
    case "toggleTheme":
      return { ...s, theme: nextThemeMode(s.theme) };

    case "move": {
      // With the fleet filter up, ↑/↓ walk the matching sessions in relevance
      // order — the rows the fleet is actually showing. Off-list (the
      // selection was filtered out), ↓ lands on the best match and ↑ on the
      // last.
      // In the tree they walk the top-level rows; → and ← reach what is
      // nested under one.
      const list = a.ids ?? topRows(fleetSessions(s));
      let from = list.indexOf(a.ids ? (s.selectedId ?? "") : topRowOf(s));
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
      // A task row has nothing under it.
      if (!sel || s.selectedChild != null) return s;
      const first = childSpots(fleetSessions(s), sel, a.ids !== undefined)[0];
      return first ? { ...s, selectedId: first.id, selectedChild: first.child } : s;
    }

    case "childExit": {
      if (s.selectedChild != null) return { ...s, selectedChild: null };
      const parent = cursorParentOf(s, a.ids !== undefined);
      return parent ? { ...s, selectedId: parent.id } : s;
    }

    case "childMove": {
      const ranked = a.ids !== undefined;
      const parent = cursorParentOf(s, ranked);
      if (!parent) return s;
      const spots = childSpots(fleetSessions(s), parent, ranked);
      const from = Math.max(
        0,
        spots.findIndex((p) => p.id === s.selectedId && p.child === s.selectedChild),
      );
      const next = spots[Math.max(0, Math.min(spots.length - 1, from + a.delta))];
      return next ? { ...s, selectedId: next.id, selectedChild: next.child } : s;
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
      const mode = nextMode(
        p.settings.mode,
        fleetProviders(s).find((x) => x.id === p.settings.provider)?.modes,
      );
      return withPrompt(s, { ...p, settings: { ...p.settings, mode } });
    }

    case "promptHistoryNav": {
      const p = openPrompt(s.overlay);
      if (!p) return s;
      const history = p.history ?? s.drafts.history;
      if (history.length === 0) return s;
      // At the live buffer there is nothing newer — ↓ must not clobber it
      // with the stashed draft.
      if (p.histIdx === 0 && a.dir === 1) return s;
      const draft = p.histIdx === 0 ? p.buffer.text : p.draft;
      const idx = Math.max(0, Math.min(history.length, p.histIdx + (a.dir === -1 ? 1 : -1)));
      const text = idx === 0 ? draft : recalled({ ...s.drafts, history }, idx);
      return withPrompt(s, { ...p, histIdx: idx, draft, buffer: buffer(text) });
    }

    case "recoverDraft":
      return {
        ...s,
        drafts: { ...s.drafts, last: [s.drafts.last, a.text].filter(Boolean).join("\n\n") },
      };

    case "restoreHistory": {
      const p = openPrompt(s.overlay);
      if (p?.t !== "session" || p.kind !== "send" || p.sessionId !== a.sessionId || p.histIdx !== 0)
        return s;
      return withPrompt(s, { ...p, history: a.texts });
    }

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
      // The modes an implementation can run in — `plan` itself is excluded,
      // and so is any mode the session's provider doesn't offer.
      const sessionId = s.overlay.plan.sessionId;
      const offered = fleetSessions(s).find((x) => x.id === sessionId)?.modes;
      const implementing: SessionMode[] = ["default", "acceptEdits", "auto"];
      const order = implementing.filter((m) => !offered || offered.includes(m));
      const mode = order[(order.indexOf(s.overlay.plan.mode) + 1) % order.length] ?? "default";
      return { ...s, overlay: { t: "plan", plan: { ...s.overlay.plan, mode } } };
    }

    case "toggleConfirmBranch": {
      const c = s.overlay.t === "confirm" ? s.overlay.confirm : null;
      if (c?.action !== "deleteSession" || !c.branchName) return s;
      return { ...s, overlay: { t: "confirm", confirm: { ...c, deleteBranch: !c.deleteBranch } } };
    }

    case "toggleConfirmChildren": {
      const c = s.overlay.t === "confirm" ? s.overlay.confirm : null;
      if ((c?.action !== "archiveSession" && c?.action !== "deleteSession") || !c.children)
        return s;
      const choice = c.children.choice === "stop" ? "detach" : "stop";
      return {
        ...s,
        overlay: { t: "confirm", confirm: { ...c, children: { ...c.children, choice } } },
      };
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

    case "basesLoaded":
      return { ...s, bases: a.bases };

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
  // Grouped by what each row shows, a supervisor by its agents' work too.
  const sessions = sortSessionsBy(shownStatusIn(state.value.sessions))(state.value.sessions);
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
    selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId, fleetSessions(s)),
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

/** A place the cursor can rest among a session's child rows: a task or
 *  sub-agent of its own (`child` its key), or one of its Loom agents' rows. */
export interface ChildSpot {
  readonly id: string;
  readonly child: string | null;
}

/** What → reaches under `p`, in the order drawn: its tasks and sub-agents,
 *  then its Loom agents — in the tree; a ranked list draws those flat. */
export const childSpots = (
  all: readonly SessionSnapshot[],
  p: SessionSnapshot,
  ranked: boolean,
): ChildSpot[] => [
  ...childrenOf(p).map((c) => ({ id: p.id, child: c.key })),
  ...(ranked ? [] : agentsOf(all, p.id)).map((a) => ({ id: a.id, child: null })),
];

/** The session whose child rows the cursor is among — the selected one while
 *  one of its tasks is focused, a Loom agent's supervisor while the agent is
 *  (in the tree) — or null on a top-level row. */
export const cursorParentOf = (
  s: Pick<TuiState, "fleet" | "selectedId" | "selectedChild">,
  ranked: boolean,
): SessionSnapshot | null => {
  const all = fleetSessions(s);
  const sel = all.find((x) => x.id === s.selectedId);
  if (!sel) return null;
  if (s.selectedChild != null) return sel;
  if (ranked || !nestedIn(all)(sel)) return null;
  return all.find((x) => x.id === sel.supervisorId) ?? null;
};

/** The sessions the cursor is inside of: whose child rows it is among, and
 *  their supervisors up to the top-level row. */
const enteredIds = (
  s: Pick<TuiState, "fleet" | "selectedId" | "selectedChild">,
  ranked: boolean,
): ReadonlySet<string> => {
  const all = fleetSessions(s);
  const nested = nestedIn(all);
  const up = (at: SessionSnapshot | undefined, seen: ReadonlySet<string>): ReadonlySet<string> =>
    at === undefined || seen.has(at.id)
      ? seen
      : up(
          ranked || !nested(at) ? undefined : all.find((x) => x.id === at.supervisorId),
          new Set([...seen, at.id]),
        );
  return up(cursorParentOf(s, ranked) ?? undefined, new Set());
};

/** The tree's top-level rows, in display order. */
const topRows = (all: readonly SessionSnapshot[]): string[] => {
  const nested = nestedIn(all);
  return all.filter((x) => !nested(x)).map((x) => x.id);
};

/** The top-level row the cursor is on or nested under. */
const topRowOf = (s: Pick<TuiState, "fleet" | "selectedId">): string => {
  const all = fleetSessions(s);
  const nested = nestedIn(all);
  const up = (id: string, seen: ReadonlySet<string>): string => {
    const at = all.find((x) => x.id === id);
    return at?.supervisorId !== undefined && nested(at) && !seen.has(at.supervisorId)
      ? up(at.supervisorId, new Set([...seen, id]))
      : id;
  };
  return s.selectedId === null ? "" : up(s.selectedId, new Set());
};

const clampSelection = (
  list: readonly SessionSnapshot[],
  current: string | null,
  pending?: string,
  previous: readonly SessionSnapshot[] = [],
): string | null => {
  const selected = list.find((x) => x.id === current);
  const wasSelected = previous.find((x) => x.id === current);
  const archived =
    selected?.status.kind === "done" &&
    wasSelected !== undefined &&
    wasSelected.status.kind !== "done";
  if (selected && !archived) return selected.id;
  // A just-picked session whose row hasn't arrived yet — hold the selection on
  // it rather than snapping to the fleet head (U4).
  if (current && current === pending) return current;
  const candidates = archived ? list.filter((x) => x.id !== current) : list;
  // A removed or archived Loom agent hands the cursor back to its supervisor.
  const supervisor = wasSelected?.supervisorId;
  if (supervisor !== undefined && candidates.some((x) => x.id === supervisor && x.id !== current))
    return supervisor;
  // Keep the cursor near a removed or archived row in the order last shown.
  const live = new Set(candidates.map((x) => x.id));
  for (let i = previous.findIndex((x) => x.id === current) - 1; i >= 0; i--) {
    const id = previous[i]!.id;
    if (live.has(id)) return id;
  }
  return candidates[0]?.id ?? selected?.id ?? null;
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
/** A session's queued messages as the daemon reports them, in dispatch order. */
export const queueFor = (
  s: Pick<TuiState, "fleet">,
  id: string | null,
): readonly QueueEntryView[] =>
  (id ? fleetSessions(s).find((x) => x.id === id)?.queue?.entries : undefined) ?? [];

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
 *  transcript holds, then a marker per kind of wait its queue still has
 *  messages in. Those markers are derived from the snapshot, not stored — the
 *  daemon's queue is where a queued message lives, so a count drops exactly
 *  when the agent takes one and the daemon's own `user_message` takes its
 *  place. */
export const sessionLog = (s: TuiState & { transcript?: Transcript }): LogLine[] => {
  const lines = transcriptLines(s.transcript ?? noTranscript);
  const id = s.selectedId;
  if (id === null) return [...lines];
  const queued = queueFor(s, id);
  if (queued.length === 0) return [...lines];
  return [...lines, ...queuedLines(id, queued)];
};

/**
 * What the event pane shows: the selected session's log, narrowed to the
 * focused child when drilled in and condensed per {@link LogFilter} — see
 * {@link filterLog}.
 */
export const visibleLog = (
  s: TuiState & { transcript?: Transcript },
  child: FleetChild | null = null,
): LogLine[] => filterLog(sessionLog(s), s.logFilter, child?.id ?? null);

/** The lines the event pane is actually drawing right now — the selected
 *  session's log under the current filter and child focus. What the scrollback
 *  offset is measured against. */
export const shownLog = (s: TuiState & { transcript?: Transcript }): LogLine[] =>
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
    label: p.tag ?? p.id,
    hint: [
      p.isDefault ? "default" : "",
      p.defaultModel || (p.models.length ? `${p.models.length} models` : ""),
    ]
      .filter(Boolean)
      .join(" · "),
  }));
};

/** The heading over the providers in the new-session `⌥p` list, and the one
 *  over the agent profiles under them. */
export const PROVIDERS_SECTION = "providers";
export const PROFILES_SECTION = "agent profiles";

/** The picker id of a profile row: apart from every provider id. */
export const profileItemId = (name: string): string => `profile:${name}`;

/**
 * The new-session `⌥p` list: the providers, then the agent profiles this
 * repository offers, each under its heading. A profile row says what it sets;
 * one on a provider this daemon lacks stays listed and says why it cannot be
 * picked. With no profiles it is the plain provider list.
 */
export const newSessionPickItems = (s: TuiState): PickItem[] => {
  const profiles = fleetAgentProfiles(s);
  if (profiles.length === 0) return providerPickItems(s);
  const providers = fleetProviders(s);
  return [
    ...providerPickItems(s).map((it) => ({ ...it, section: PROVIDERS_SECTION })),
    ...profiles.map((p): PickItem => {
      const blocked = profileBlocked(p, providers);
      const target = [p.provider ? (providerInfo(s, p.provider)?.tag ?? p.provider) : "", p.model]
        .filter(Boolean)
        .join(" / ");
      const hint = [p.description, target, p.effort, p.mode].filter(Boolean).join(" · ");
      return {
        id: profileItemId(p.name),
        label: p.name,
        section: PROFILES_SECTION,
        profile: p.name,
        blob: hint,
        ...(hint ? { hint } : {}),
        ...(blocked ? { disabled: blocked } : {}),
      };
    }),
  ];
};

/** The provider step's rows for `dest`: the new session's carry the profiles. */
const providerStepItems = (s: TuiState, dest: PickerDest): PickItem[] =>
  dest.t === "newSession" ? newSessionPickItems(s) : providerPickItems(s);

/**
 * The model rows every selector shows for `providerId` — new session, live
 * switch and plan retarget alike — straight from that provider's catalogue:
 * each label beside the stable id it stands for (once, when the two are the
 * same), with its context window. `keep` is a session's current
 * model; when the catalogue no longer lists it, it stays choosable and says
 * so rather than vanishing (nothing is substituted for it).
 */
export const modelPickItems = (
  s: TuiState,
  providerId: string,
  keep?: string | null,
): PickItem[] => {
  const p = providerInfo(s, providerId);
  if (!p) return [];
  const items: PickItem[] = p.modelChoices?.length
    ? p.modelChoices.map((c) => {
        const hint = c.context ? `${humanTokens(c.context)} ctx` : "";
        return {
          id: c.id,
          label: c.label,
          ...(c.label !== c.id ? { slug: c.id } : {}),
          ...(hint ? { hint } : {}),
        };
      })
    : p.models.map((m) => ({ id: m, label: m }));
  if (keep && items.length > 0 && !items.some((it) => it.id === keep))
    items.push({ id: keep, label: keep, hint: "current · no longer listed" });
  return items;
};

/** The model picker's status line for `providerId`: a refresh in progress,
 *  or why the last one failed while an older list is still shown. */
export const modelPickNote = (s: TuiState, providerId: string): string | undefined => {
  const p = providerInfo(s, providerId);
  if (p?.modelsLoading) return "refreshing the model catalogue… · ⌥r cancel";
  if (p?.modelsError && modelPickItems(s, providerId).length > 0)
    return `last refresh failed: ${p.modelsError} · ⌥r retry`;
  return undefined;
};

/**
 * What a finished Refresh models says for `providerId`: how many models it
 * lists now, and how many of that provider's sessions run a model it no
 * longer lists — which keep it (their settings are never rewritten).
 */
export const modelRefreshSummary = (
  s: TuiState,
  providerId: string,
  models: readonly string[],
): string => {
  const tag = providerInfo(s, providerId)?.tag || providerId;
  const listed = new Set(models);
  const stale = fleetSessions(s).filter(
    (x) => x.provider === providerId && x.model && !listed.has(x.model),
  ).length;
  const kept =
    stale > 0
      ? ` · ${stale} session${stale === 1 ? "" : "s"} keep${stale === 1 ? "s" : ""} a model no longer listed`
      : "";
  return `${tag}: ${models.length} model${models.length === 1 ? "" : "s"}${kept}`;
};

/** Message for an empty model picker — why there's nothing to pick. */
export const modelPickEmptyText = (s: TuiState, providerId: string): string => {
  if (providerInfo(s, providerId)?.modelsLoading) {
    return "loading the model catalogue — the list fills in when discovery completes";
  }
  const error = providerInfo(s, providerId)?.modelsError;
  if (error) return `${error} — ⌥r to retry`;
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
  // The fork wizard's provider list carries its own history hints.
  if (p.step === "provider" && p.dest.t === "fork") return s.overlay;
  // Always the picker's own provider: a snapshot carrying another provider's
  // refreshed catalogue (one still settling after the user moved on) leaves
  // this list as it is.
  const providerId = p.chosen.provider ?? "";
  const items =
    p.step === "model"
      ? modelPickItems(s, providerId, keptModel(s, p.dest, providerId))
      : providerStepItems(s, p.dest);
  const cur = pickerCurrent(p)?.id;
  const at = cur ? items.findIndex((it) => it.id === cur) : -1;
  // The list loaded — the empty-state note is dead.
  const emptyText =
    p.step === "model" && items.length === 0 ? modelPickEmptyText(s, providerId) : null;
  const { note: _note, ...rest } = p;
  const note = p.step === "model" ? modelPickNote(s, providerId) : undefined;
  return {
    t: "picker",
    picker: { ...rest, items, index: at >= 0 ? at : 0, emptyText, ...(note ? { note } : {}) },
  };
};

/** A live session's current model, when the wizard is choosing for that
 *  session (or a fork of it) on its own provider — the row
 *  {@link modelPickItems} keeps. */
const keptModel = (s: TuiState, dest: PickerDest, providerId: string): string | null => {
  let id: string | null = null;
  if (dest.t === "session") id = dest.sessionId;
  else if (dest.t === "fork") id = dest.fork.sessionId;
  if (id === null) return null;
  const sess = fleetSessions(s).find((x) => x.id === id);
  return sess && sess.provider === providerId ? sess.model : null;
};

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
  // The catalogue's own rule for which levels a model takes — shared with
  // the daemon's effort validation, so a level offered here is accepted there.
  const levels = choice?.supportsEffort ? modelEfforts(choice) : DEFAULT_EFFORT_LEVELS;
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
  dest: PickerDest,
): PickItem[] => {
  if (step === "provider") return providerStepItems(s, dest);
  if (step === "model")
    return modelPickItems(s, chosen.provider ?? "", keptModel(s, dest, chosen.provider ?? ""));
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
  const tag = providerInfo(s, pid)?.tag ?? pid;
  // The ⌥p retarget wizard says so in its title — it stages onto the plan
  // review rather than switching anything live.
  const lead = { planImpl: "retarget · ", fork: "fork · " }[o.dest.t as string] ?? "";
  const items = stepItems(s, step, o.chosen, o.dest);
  const withProfiles = items.some((it) => it.profile !== undefined);
  const note = step === "model" ? modelPickNote(s, pid) : undefined;
  const at = o.pick ? items.findIndex((it) => it.id === o.pick) : -1;
  return {
    t: "picker",
    picker: makePicker({
      step,
      title:
        step === "provider"
          ? `${lead}provider${withProfiles ? " or agent profile" : ""}`
          : `${lead}${step} · ${tag}`,
      items,
      dest: o.dest,
      chosen: o.chosen,
      from: o.from,
      ...(step === "model" && items.length === 0 ? { emptyText: modelPickEmptyText(s, pid) } : {}),
      ...(note ? { note } : {}),
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
  // A new session's single-model provider had no model step: back to the list.
  if (
    p.step === "effort" &&
    p.from === "provider" &&
    p.dest.t === "newSession" &&
    onlyModel(s, p.chosen.provider ?? "") !== null
  ) {
    return pickerStep(s, "provider", {
      dest: p.dest,
      chosen: { provider: null, model: null },
      from: p.from,
      pick: p.chosen.provider,
    });
  }
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

/** A model picker either advances, returns a choice, or restores its caller. */
export interface ModelSelection {
  provider: string | null;
  model: string | null;
  effort: string | null;
}
export type ModelSelectionStep =
  | { tag: "show"; overlay: Overlay }
  | { tag: "selected"; dest: PickerDest; selection: ModelSelection };

/** The one model `providerId`'s catalogue lists, when it lists exactly one —
 *  a new session picking that provider has no model to choose. */
const onlyModel = (s: TuiState, providerId: string): string | null => {
  const models = modelPickItems(s, providerId);
  return models.length === 1 ? models[0]!.id : null;
};

export const selectModel = (s: TuiState, p: Picker): ModelSelectionStep => {
  const item = pickerCurrent(p);
  const show = (overlay: Overlay): ModelSelectionStep => ({ tag: "show", overlay });
  // A row that says why it cannot be picked stays put, saying so.
  if (item?.disabled) return show({ t: "picker", picker: p });
  // An agent profile, from the new session's list: applied whole, and done.
  if (item?.profile !== undefined && p.dest.t === "newSession") {
    const profile = fleetAgentProfiles(s).find((x) => x.name === item.profile);
    const step = profile
      ? applyProfile(profile, fleetProviders(s), p.dest.settings, newSettings(s, null, null, null))
      : null;
    if (!step || "disabled" in step) return show(unwind({ t: "picker", picker: p }));
    return show({ t: "prompt", prompt: newPrompt(step.settings, p.dest.draft) });
  }
  const provider = p.step === "provider" && item ? item.id : p.chosen.provider;
  const model = p.step === "model" && item ? item.id : p.chosen.model;
  if (!item && (provider === null || (p.dest.t === "session" && p.step !== "effort")))
    return show(unwind({ t: "picker", picker: p }));
  const next = (step: WizardStep) =>
    show(
      pickerStep(s, step, {
        dest: p.dest,
        chosen: { provider, model: step === "model" ? null : model },
        from: p.from,
      }),
    );
  // A new session on a provider with one model goes straight to its effort.
  const fresh = p.dest.t === "newSession" ? p.dest.settings : null;
  const only = fresh ? onlyModel(s, provider ?? "") : null;
  if (item && p.step === "provider" && only !== null) {
    if (modelSupportsEffort(s, provider ?? "", only))
      return show(
        pickerStep(s, "effort", {
          dest: p.dest,
          chosen: { provider, model: only },
          from: p.from,
          pick: fresh?.provider === provider ? fresh.effort : null,
        }),
      );
    return { tag: "selected", dest: p.dest, selection: { provider, model: only, effort: null } };
  }
  if (item && p.step === "provider") return next("model");
  if (item && p.step === "model" && modelSupportsEffort(s, provider ?? "claude", model!))
    return next("effort");
  return {
    tag: "selected",
    dest: p.dest,
    selection: {
      provider,
      model,
      effort: p.step === "effort" ? (item?.id ?? null) : null,
    },
  };
};

/** Open the same selection flow for a prompt, a live session, or a plan. */
export const startModelSelection = (
  s: TuiState,
  dest: PickerDest,
  current: Pick<ModelSelection, "provider" | "model"> & { effort?: string | null },
  start: WizardStep = "provider",
): Overlay => {
  const providers = fleetProviders(s);
  const step = start === "provider" && providers.length <= 1 ? "model" : start;
  const provider =
    start === "provider" && providers.length <= 1
      ? (providers[0]?.id ?? current.provider ?? "claude")
      : current.provider;
  return pickerStep(s, step, {
    dest,
    from: step,
    chosen: {
      provider: step === "provider" ? null : provider,
      model: step === "effort" ? current.model : null,
    },
    pick: { provider: current.provider, model: current.model, effort: current.effort ?? null }[
      step
    ],
  });
};

/**
 * `⌥p` in the new-session prompt: the providers and, under them, the agent
 * profiles, with the current choice highlighted. With no profiles it is the
 * ordinary provider → model → effort wizard (which skips a lone provider).
 */
export const startNewSessionPicker = (
  s: TuiState,
  settings: NewSessionSettings,
  draft: string,
): Overlay => {
  const dest: PickerDest = { t: "newSession", settings, draft };
  if (fleetAgentProfiles(s).length === 0) return startModelSelection(s, dest, settings);
  return pickerStep(s, "provider", {
    dest,
    from: "provider",
    chosen: { provider: null, model: null },
    pick: settings.profile !== undefined ? profileItemId(settings.profile) : settings.provider,
  });
};

export interface Group {
  status: SessionStateKind;
  label: string;
  sessions: SessionSnapshot[];
}

/** Is `s` drawn nested under its supervisor — is that supervisor listed too? */
const nestedIn = (sessions: readonly SessionSnapshot[]) => {
  const ids = new Set(sessions.map((s) => s.id));
  return (s: SessionSnapshot): boolean =>
    s.supervisorId !== undefined && s.supervisorId !== s.id && ids.has(s.supervisorId);
};

/** The status groups, by what each shows (`shown`), of the sessions nobody
 *  listed supervises; each one's Loom agents are drawn under it (see
 *  {@link fleetEntries}), not in their own group. */
export const groupsOf = (
  sessions: readonly SessionSnapshot[],
  shown: (s: SessionSnapshot) => SessionStateKind,
): Group[] => {
  const nested = nestedIn(sessions);
  const roots = sessions.filter((s) => !nested(s));
  const out: Group[] = [];
  for (const status of STATUS_ORDER) {
    const inGroup = roots.filter((x) => shown(x) === status);
    if (inGroup.length > 0)
      out.push({ status, label: statusLook(status).label, sessions: inGroup });
  }
  return out;
};

/** The Loom agents `id` supervises, in fleet order. */
export const agentsOf = (sessions: readonly SessionSnapshot[], id: string): SessionSnapshot[] =>
  sessions.filter((s) => s.supervisorId === id && s.id !== id);

/** What a supervisor and every agent under it (however deep) have spent. */
export const treeCost = (
  s: SessionSnapshot,
  sessions: readonly SessionSnapshot[],
): Pick<SessionSnapshot, "costUsd" | "costSource"> => {
  const seen = new Set<string>();
  const all: SessionSnapshot[] = [];
  const walk = (at: SessionSnapshot): void => {
    if (seen.has(at.id)) return;
    seen.add(at.id);
    all.push(at);
    for (const agent of agentsOf(sessions, at.id)) walk(agent);
  };
  walk(s);
  const sources = new Set(all.map((x) => x.costSource));
  let costSource: SessionSnapshot["costSource"] = sources.size === 1 ? s.costSource : "mixed";
  if (sources.size > 1 && (sources.has("none") || sources.has("partial"))) costSource = "partial";
  return { costUsd: all.reduce((sum, x) => sum + x.costUsd, 0), costSource };
};

/** A clickable region in the current frame: one terminal row, columns `x0..x1`
 *  inclusive, in 1-based screen coordinates (the same space SGR mouse reports
 *  use). Built by {@link fleetHits} / `modeChipHit`, carried on the `FleetView`
 *  so the keymap can hit-test a click without any Ink measurement API. */
export type FleetHit =
  | { kind: "sessionTab"; y: number; x0: number; x1: number; tab: TuiState["sessionTab"] }
  | { kind: "session"; y: number; x0: number; x1: number; id: string }
  | { kind: "child"; y: number; x0: number; x1: number; sessionId: string; key: string }
  | { kind: "childMore"; y: number; x0: number; x1: number; sessionId: string }
  | { kind: "mode" | "promptMode"; y: number; x0: number; x1: number };

/** Where a FLEET row hangs in its session's tree: for each level above its
 *  own branch, whether that level's line runs on past it (`│`), and whether
 *  it is the last thing under its parent (`└` rather than `├`). */
export interface TreeBranch {
  readonly rails: readonly boolean[];
  readonly isLast: boolean;
}

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
  | {
      kind: "session";
      s: SessionSnapshot;
      /** What the row shows — see `fleet-status.ts`. */
      status: SessionStateKind;
      /** A Loom agent drawn under its supervisor. Absent for a row at the
       *  top of its group. */
      nest?: TreeBranch;
      /** For a supervisor: its spend with its agents', and how many of them
       *  (however deep) wait on the person (display only). Absent for a
       *  session that supervises none. */
      agents?: { cost: Pick<SessionSnapshot, "costUsd" | "costSource">; waiting: number };
    }
  | { kind: "child"; s: SessionSnapshot; c: FleetChild; branch: TreeBranch }
  | { kind: "childMore"; s: SessionSnapshot; extra: number; branch: TreeBranch };

/** An active filter renders one flat ranked list; otherwise the status
 *  groups (see {@link groupsOf}). */
export const fleetEntries = (
  state: Pick<TuiState, "fleet" | "selectedId" | "selectedChild"> & { find?: Find | null },
): FleetEntry[] => {
  const matched = searchMatches(state.find ?? null, fleetSessions(state));
  const active = state.find != null && queryOf(state.find) !== "";
  const all = fleetSessions(state);
  const status = shownStatusIn(all);
  const waiting = waitingAgentsIn(all);
  const entered = enteredIds(state, active);
  const parent = cursorParentOf(state, active);
  const out: FleetEntry[] = [];
  const placed = new Set<string>();

  const pushSession = (s: SessionSnapshot, nest?: TreeBranch): void => {
    if (placed.has(s.id)) return;
    placed.add(s.id);
    const mine = agentsOf(all, s.id);
    out.push({
      kind: "session",
      s,
      status: status(s),
      ...(nest ? { nest } : {}),
      ...(mine.length > 0
        ? { agents: { cost: treeCost(s, all), waiting: waiting(s).length } }
        : {}),
    });
    // Its Loom agents are full sessions, drawn under it after its children,
    // one level deeper than it (a filtered list is flat, ranked by relevance).
    const agents = active ? [] : mine.filter((a) => entered.has(s.id) || status(a) !== "done");
    const rails = nest ? [...nest.rails, !nest.isLast] : [];
    const kids = childrenOf(s);
    // Mirrors the FLEET row cap: 4 children shown, lifted while drilled in.
    const drilled = parent?.id === s.id;
    const shown = drilled ? kids : kids.slice(0, 4);
    const extra = drilled ? 0 : kids.length - shown.length;
    const lastChild = extra === 0 && agents.length === 0 ? shown.length - 1 : -1;
    shown.forEach((c, i) =>
      out.push({ kind: "child", s, c, branch: { rails, isLast: i === lastChild } }),
    );
    if (extra > 0)
      out.push({ kind: "childMore", s, extra, branch: { rails, isLast: agents.length === 0 } });
    agents.forEach((agent, i) => pushSession(agent, { rails, isLast: i === agents.length - 1 }));
  };

  if (active) {
    for (const s of matched) pushSession(s);
  } else {
    for (const group of groupsOf(matched, status)) {
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
  if (ev.type === "result" && ev.kind === "interrupted")
    return {
      text: `turn interrupted${ev.reason ? `: ${oneLine(ev.reason, 80)}` : ""}${tag}`,
      tone: "warn",
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
