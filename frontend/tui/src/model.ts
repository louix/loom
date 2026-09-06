/**
 * The TUI's state and its pure transitions (design spec §11.5). The Ink
 * components are a thin projection of a {@link TuiState}; everything that
 * decides *what* to show lives here as a `reduce(state, action)` function and
 * a set of selectors, all unit-tested without React or a live daemon.
 */
import { absurd } from "@loom/core/absurd";
import type { BackgroundTaskKind, HarnessEvent, SessionStateKind } from "@loom/core/events";
import { isClaudeId } from "@loom/core/provider-id";
import { sessionStateLabel } from "@loom/core/session-state";
import type { SessionInteraction } from "@loom/core/interaction";
import type {
  DaemonInfo,
  DaemonSnapshot,
  DoctorReport,
  HistoryCursor,
  HistoryPage,
  ProviderInfo,
  PushFrame,
  SessionSnapshot,
  TranscriptId,
} from "@loom/core/wire";
import type { ClientState, ConnectionError } from "@loom/client";
import {
  foldLoadable,
  loadableFailed,
  loadableIdle,
  loadableLoaded,
  loadablePending,
  type Loadable,
} from "@loom/core/loadable";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { buffer, type Buffer } from "./editor.ts";
import {
  newPrompt,
  promptTarget,
  sessionPrompt,
  type NewSessionSettings,
  type Prompt,
} from "./overlay.ts";
import { searchSessions, type FleetView } from "./fleet-search.ts";
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

/**
 * How the connection reads in the status line. Derived from the snapshot's
 * `Loadable` tag rather than tracked beside it — there is no state the client
 * can be in that this doesn't already say.
 */
export type Connection = "connecting" | "live" | "reconnecting" | "closed";

export const connectionOf = (s: TuiState): Connection =>
  foldLoadable<ConnectionError, DaemonSnapshot, Connection>({
    onIdle: () => "connecting",
    onPending: () => "reconnecting",
    onError: () => "closed",
    onData: () => "live",
  })(s.fleet);

/** The fleet in display order, or empty while there is no current snapshot. */
export const fleetSessions = (s: TuiState): SessionSnapshot[] =>
  s.fleet.tag === "data" ? s.fleet.value.sessions : [];

/** What the fleet search engine sees — sessions plus their event lines. */
const fleetView = (s: TuiState): FleetView => ({
  sessions: fleetSessions(s),
  transcripts: s.transcripts,
});

/** Configured providers from the current snapshot, or empty while pending. */
export const fleetProviders = (s: TuiState): ProviderInfo[] =>
  s.fleet.tag === "data" ? s.fleet.value.providers : [];

export const fleetDaemon = (s: TuiState): DaemonInfo | null =>
  s.fleet.tag === "data" ? s.fleet.value.daemon : null;

/** A session's mode as the UI should show it: a local un-acknowledged cycle
 *  wins over the snapshot until the debounced RPC settles. */
export const sessionMode = (s: TuiState, session: SessionSnapshot): string =>
  s.modeDraft[session.id] ?? session.mode;
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

export interface LogLine {
  /**
   * The entry's durable {@link TranscriptId}: the id the daemon's live push and
   * its history pages both carry, so the two merge by identity rather than by
   * guessing from timestamps. `null` for a locally synthesised line, which has
   * no durable counterpart and lives in {@link Transcript.echoes}.
   */
  id: TranscriptId | null;
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

/**
 * One session's transcript cache.
 *
 * Entries are keyed and ordered by their durable id, never by timestamp: a
 * burst of events shares one millisecond and a provider can report them out of
 * order, so a timestamp-sorted merge stitches history back together wrongly at
 * exactly the boundaries that matter — a daemon restart, a tool storm.
 */
export interface Transcript {
  /** Durable entries, ascending by id and deduplicated by it. */
  lines: readonly LogLine[];
  /** The newest page. `idle` until the session is first selected. */
  head: Loadable<string, null>;
  /** The next older page. Loaded entries stay put while this runs. */
  older: Loadable<string, null>;
  /**
   * Where the next older page starts. Always the retained front, so anything
   * dropped to stay inside {@link TRANSCRIPT_CAP} is refetchable by
   * construction. `null` iff {@link lines} reaches the oldest entry the daemon
   * holds — running out of room here can never be mistaken for the daemon
   * running out of history.
   */
  olderCursor: HistoryCursor | null;
  /**
   * True while {@link lines} ends at the live tail, so an arriving event
   * belongs immediately after the last retained line.
   *
   * Paging back past the cap sets it false: entries between this window and the
   * live stream have been evicted, and appending an arriving event onto the
   * window would draw a gap as continuous history. While false, live entries
   * are not folded in at all — the notice line still reports them, and `End`
   * (jump to latest) reloads the newest window and resumes following.
   */
  following: boolean;
  /**
   * Locally synthesised lines with no durable counterpart — the "queued: …"
   * marker for a follow-up waiting on the current turn. Rendered after
   * {@link lines}; never deduplicated, ordered or paged, because there is no
   * server-side entry to reconcile them against.
   */
  echoes: readonly LogLine[];
}

export interface Notice {
  text: string;
  tone: Tone;
  at: number;
}

const mkNotice = (text: string, tone: Tone): Notice => ({ text, tone, at: Date.now() });

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
  theme: ThemeMode;
  /**
   * The daemon's authoritative state, exactly as the client hands it over.
   * There is no second copy and no merging: a snapshot replaces the last one
   * wholesale, and while it is `pending` the UI genuinely has no fleet to show
   * rather than a stale one it might act on. Sessions are stored in display
   * order — {@link sortSessions} runs once at install, not per read.
   */
  fleet: ClientState;
  /**
   * Permission modes cycled locally but not yet acknowledged. `session.setMode`
   * is debounced in fleet-handle, so the chip has to move before the round trip
   * — but it moves *here*, beside the snapshot, never inside it. Cleared when
   * the debounced RPC settles either way, so a rejected change falls back to
   * whatever the daemon actually reports.
   */
  modeDraft: Record<string, SessionMode>;
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
  /** Per-session transcript caches, keyed by session id. Absent = never seen. */
  transcripts: Record<string, Transcript>;
  /**
   * Bumped every time the caches are cleared (a dropped connection). A fetch
   * carries the generation it was issued under, so a response that was already
   * in flight when the connection went cannot reinstate cache state belonging
   * to a history the next connection re-reads from scratch.
   */
  transcriptGen: number;
  logFilter: LogFilter;
  /** Follow-up messages typed at a still-running session, awaiting its next idle. */
  queue: Record<string, string[]>;
  /**
   * Per session, the text of one drained queue entry whose `session.send` never
   * came back — the connection dropped or the request timed out, so whether the
   * daemon ran it is unknowable from here. It has left {@link queue} (draining
   * it again would be a second send) and waits here until the user opens that
   * session's `send` prompt, which restores it as editable text.
   */
  heldSend: Record<string, string>;
  notice: Notice | null;
  mode: UiMode;
  /** The last `daemon.doctor` snapshot, shown by the doctor overlay. Fetched
   *  on open; kept between opens so a reopen paints immediately. */
  doctor: DoctorReport | null;
  prompt: Prompt | null;
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
    // The active theme — a theme restored from `.loom/tui.json` was applied
    // via `setThemeMode` before the handle built its initial state.
    theme: themeMode(),
    fleet: loadableIdle,
    modeDraft: {},
    selectedId: null,
    selectedChild: null,
    transcripts: {},
    transcriptGen: 0,
    logFilter: "everything",
    queue: {},
    heldSend: {},
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
  | { t: "state"; state: ClientState }
  | { t: "modeDraft"; sessionId: string; mode: SessionMode | null }
  | { t: "push"; frame: PushFrame }
  | { t: "historyStart"; sessionId: string; older: boolean; gen: number }
  | { t: "historyPage"; sessionId: string; page: HistoryPage; older: boolean; gen: number }
  | { t: "historyFailed"; sessionId: string; older: boolean; error: string; gen: number }
  | { t: "transcriptReset" }
  /** Jump to latest: discard an older browsing window and refetch the newest. */
  | { t: "transcriptFollow"; sessionId: string }
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
  | { t: "openPrompt"; prompt: Prompt }
  | { t: "promptSet"; buffer: Buffer }
  | { t: "promptCycleMode" }
  | { t: "promptHistoryNav"; dir: -1 | 1 }
  | { t: "pushHistory"; text: string }
  | { t: "closePrompt"; saveDraft?: boolean }
  | { t: "echo"; line: LogLine }
  | { t: "enqueue"; sessionId: string; text: string }
  /** `null` releases the hold — the text is now in an open prompt. */
  | { t: "holdSend"; sessionId: string; text: string | null }
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
  | { t: "qnavSet"; nav: QNav | null }
  | { t: "help"; value: boolean }
  | { t: "doctor"; value: boolean }
  | { t: "doctorLoaded"; report: DoctorReport };

/**
 * Retained durable lines per session — roughly 20MB of event text per 10k lines
 * in a tool-heavy session. It bounds both the footprint and the per-event cost:
 * every append copies the array, so an uncapped window makes each arriving
 * frame more expensive than the last.
 *
 * The window is always *contiguous*. Whichever end the reader is at survives:
 * following the tail evicts the front, paging back evicts the tail. Nothing
 * evicted is lost — `olderCursor` is always the retained front — but the two
 * cases are not symmetric, because only tail eviction leaves a hole between
 * what is held and what is arriving. {@link Transcript.following} carries that.
 */
export const TRANSCRIPT_CAP = 10_000;

const EMPTY_TRANSCRIPT: Transcript = {
  lines: [],
  head: loadableIdle,
  older: loadableIdle,
  olderCursor: null,
  following: true,
  echoes: [],
};

const transcriptOf = (s: TuiState, sessionId: string): Transcript =>
  s.transcripts[sessionId] ?? EMPTY_TRANSCRIPT;

/**
 * Drop every transcript cache and move to a new generation, so a fetch already
 * in flight cannot land afterwards and reinstate what this discarded. Every
 * `head` is back to `idle`, which is what makes the selected session refetch.
 */
const resetTranscripts = (s: TuiState): TuiState => {
  if (Object.keys(s.transcripts).length === 0) return s;
  return { ...s, transcripts: {}, transcriptGen: s.transcriptGen + 1 };
};

const withTranscript = (
  s: TuiState,
  sessionId: string,
  t: Transcript,
): Record<string, Transcript> => ({ ...s.transcripts, [sessionId]: t });

/** Merge `add` into `have` by durable id, keeping id order. Entries already
 *  held win, so a page overlapping the live stream re-uses the objects the
 *  renderer has already measured instead of replacing them. */
const mergeById = (have: readonly LogLine[], add: readonly LogLine[]): LogLine[] => {
  if (add.length === 0) return [...have];
  const byId = new Map<TranscriptId, LogLine>();
  for (const l of have) if (l.id !== null) byId.set(l.id, l);
  for (const l of add) if (l.id !== null && !byId.has(l.id)) byId.set(l.id, l);
  return [...byId.values()].sort((x, y) => (x.id ?? 0) - (y.id ?? 0));
};

/**
 * The one retention rule, applied wherever a window grows: page merges,
 * ordinary live appends, and out-of-order live merges all come through here.
 *
 * `keep` says which end the reader is at and therefore which end survives.
 * `atOldest` is what the source claims about the *front* it supplied — a page
 * whose `olderCursor` was `null`, or a window we already believed reached the
 * daemon's first entry. That claim only holds while that front is still here,
 * which is why `olderCursor` is recomputed from the retained window rather than
 * copied from the page.
 */
const retain = (
  t: Transcript,
  lines: readonly LogLine[],
  keep: "newest" | "oldest",
  atOldest: boolean,
): Transcript => {
  const fits = lines.length <= TRANSCRIPT_CAP;
  // Not `fits ? lines : slice(...)`: this runs on every arriving event, and
  // computing the trim eagerly would put an O(n) copy on the common path where
  // there is nothing to trim.
  let kept = lines;
  if (!fits) {
    kept =
      keep === "newest"
        ? lines.slice(lines.length - TRANSCRIPT_CAP)
        : lines.slice(0, TRANSCRIPT_CAP);
  }
  const front = kept[0];
  // `null` — and only `null` — means the retained front IS the daemon's oldest
  // entry. Evicting the front withdraws that claim and points the cursor at
  // what was dropped, so scroll-back can always get it back.
  const frontKept = front !== undefined && front === lines[0];
  let olderCursor = t.olderCursor;
  if (atOldest && frontKept) olderCursor = null;
  else if (front?.id != null) olderCursor = { olderThan: front.id };
  return {
    ...t,
    lines: kept,
    olderCursor,
    // Dropping the newest end puts unrepresented history between this window
    // and the live stream. Nothing may be appended onto it until it is reloaded.
    following: t.following && (fits || keep === "newest"),
  };
};

/**
 * Fold one live entry in. Almost always a plain append — its id is newer than
 * anything held — so that case avoids building a map per event.
 */
const appendLive = (t: Transcript, line: LogLine): Transcript => {
  // Browsing an older window: the entries between it and this one were evicted,
  // so there is nowhere to put this that wouldn't misrepresent the history in
  // between. `End` reloads the newest window; until then this line reaches the
  // reader through the notice line, not the transcript.
  if (!t.following) return t;
  const atOldest = t.olderCursor === null;
  const last = t.lines[t.lines.length - 1];
  if (last !== undefined && last.id !== null && line.id !== null && line.id <= last.id) {
    // Out of order, or a repeat of something already held. `mergeById` dedupes
    // by durable id, so neither can grow the window twice — but a merge is a
    // growth like any other and takes the same cap.
    return retain(t, mergeById(t.lines, [line]), "newest", atOldest);
  }
  return retain(t, [...t.lines, line], "newest", atOldest);
};

/**
 * Fold a fetched page in. An older page extends the front, so the window keeps
 * its oldest end; a head page is the newest window by definition, so it keeps
 * its newest and resumes following.
 */
const foldPage = (
  t: Transcript,
  page: HistoryPage,
  lines: readonly LogLine[],
  older: boolean,
): Transcript => {
  const merged = mergeById(t.lines, lines);
  const atOldest = page.olderCursor === null;
  if (older) return retain(t, merged, "oldest", atOldest);
  return retain({ ...t, following: true }, merged, "newest", atOldest);
};

/** The lines a page contributes, in page order. Non-transcript kinds are
 *  dropped exactly as the live path drops them. */
const pageLines = (page: HistoryPage): LogLine[] => {
  // Per-page only: a call/result pair split across two pages falls back to
  // generic formatting, a fine default for history that old.
  const toolNames: Record<string, string> = {};
  const out: LogLine[] = [];
  for (const entry of page.items) {
    const ev = entry.event;
    if (NON_TRANSCRIPT.has(ev.type)) continue;
    if (ev.type === "tool_call") toolNames[ev.id] = ev.name;
    const toolName = ev.type === "tool_result" ? toolNames[ev.id] : undefined;
    out.push(toLogLine(entry.id, ev, toolName));
  }
  return out;
};

export const reduce = (s: TuiState, a: Action): TuiState => {
  switch (a.t) {
    case "state":
      return applyClientState(s, a.state);

    case "modeDraft":
      return {
        ...s,
        modeDraft:
          a.mode === null
            ? without(s.modeDraft, a.sessionId)
            : {
                ...s.modeDraft,
                [a.sessionId]: a.mode,
              },
      };

    case "push":
      return applyPush(s, a.frame);

    case "transcriptReset":
      return resetTranscripts(s);

    case "transcriptFollow": {
      // Jump to latest from an older window: drop what is held (it is a region
      // of history the newest page may not touch) and put `head` back to
      // `idle`, which is what makes the handle refetch the newest page. Echoes
      // are ours, not the daemon's, and stay.
      const t = transcriptOf(s, a.sessionId);
      if (t.following) return s;
      const next: Transcript = {
        ...EMPTY_TRANSCRIPT,
        echoes: t.echoes,
      };
      return { ...s, transcripts: withTranscript(s, a.sessionId, next) };
    }

    case "historyStart": {
      if (a.gen !== s.transcriptGen) return s;
      const t = transcriptOf(s, a.sessionId);
      const next: Transcript = a.older
        ? { ...t, older: loadablePending }
        : { ...t, head: loadablePending };
      return { ...s, transcripts: withTranscript(s, a.sessionId, next) };
    }

    case "historyPage": {
      // Issued against a connection we no longer have: its entries and its
      // cursor describe a history the current connection has re-read from
      // scratch, so installing them would resurrect exactly what the reset
      // discarded.
      if (a.gen !== s.transcriptGen) return s;
      const t = transcriptOf(s, a.sessionId);
      const folded = foldPage(t, a.page, pageLines(a.page), a.older);
      const next: Transcript = a.older
        ? { ...folded, older: loadableLoaded(null) }
        : { ...folded, head: loadableLoaded(null) };
      return { ...s, transcripts: withTranscript(s, a.sessionId, next) };
    }

    case "historyFailed": {
      if (a.gen !== s.transcriptGen) return s;
      const t = transcriptOf(s, a.sessionId);
      // Entries already loaded stay put: a failed older-page fetch loses the
      // page, not the transcript the reader is looking at.
      const next: Transcript = a.older
        ? { ...t, older: loadableFailed(a.error) }
        : { ...t, head: loadableFailed(a.error) };
      return { ...s, transcripts: withTranscript(s, a.sessionId, next) };
    }

    case "toggleTheme":
      return { ...s, theme: nextThemeMode(s.theme) };

    case "move": {
      // With the fleet filter up, ↑/↓ walk the matching sessions in relevance
      // order — the rows the fleet is actually showing. Off-list (the
      // selection was filtered out), ↓ lands on the best match and ↑ on the
      // last.
      const find = s.find;
      const list = find
        ? searchSessions(fleetView(s), find.buffer.text).map((m) => m.session)
        : fleetSessions(s);
      if (list.length === 0) return s;
      let from = list.findIndex((x) => x.id === s.selectedId);
      if (from < 0) from = a.delta < 0 ? list.length : -1;
      const next = Math.max(0, Math.min(list.length - 1, from + a.delta));
      const picked = list[next];
      if (!picked || picked.id === s.selectedId) return s;
      return { ...s, selectedId: picked.id, selectedChild: null };
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
      const p = s.prompt;
      if (p?.t !== "new") return s;
      const next =
        SESSION_MODES[(SESSION_MODES.indexOf(p.settings.mode) + 1) % SESSION_MODES.length] ??
        "default";
      return { ...s, prompt: { ...p, settings: { ...p.settings, mode: next } } };
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
      // Only the two free-text prompts leave a recoverable draft behind.
      const draftable = p?.t === "new" || (p?.t === "session" && p.kind === "send");
      if (!draftable) return { ...s, mode: "browse", prompt: null };
      return { ...s, mode: "browse", prompt: null, lastDraft: a.saveDraft ? p.buffer.text : "" };
    }

    case "echo": {
      const t = transcriptOf(s, a.line.sessionId);
      return {
        ...s,
        transcripts: withTranscript(s, a.line.sessionId, { ...t, echoes: [...t.echoes, a.line] }),
      };
    }

    case "enqueue": {
      const t = a.text.trim();
      if (!t) return s;
      return { ...s, queue: { ...s.queue, [a.sessionId]: [...(s.queue[a.sessionId] ?? []), t] } };
    }

    case "holdSend":
      return {
        ...s,
        heldSend:
          a.text === null
            ? without(s.heldSend, a.sessionId)
            : { ...s.heldSend, [a.sessionId]: a.text },
      };

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
      const matches = searchSessions(fleetView(s), q);
      if (matches.length === 0 || matches.some((m) => m.session.id === s.selectedId)) return next;
      return { ...next, selectedId: matches[0]!.session.id, selectedChild: null };
    }

    case "closeFind":
      return s.find ? { ...s, find: null } : s;

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
    // while we were away and our cursors are positions in a history the next
    // connection re-reads from scratch. Drop the caches with the fleet and bump
    // the generation, so a fetch already in flight cannot land afterwards and
    // reinstate what this just discarded. Drafts and selection are ours, not
    // the daemon's, and survive.
    return { ...resetTranscripts(s), fleet: state };
  }
  const sessions = sortSessions(state.value.sessions);
  const fleet: ClientState = { tag: "data", value: { ...state.value, sessions } };
  const live = new Set(sessions.map((x) => x.id));
  // Every outstanding request, addressed the way the UI holds one — request ids
  // are unique within a session, not across the fleet.
  const open = new Set<string>();
  for (const x of sessions) for (const r of x.requests) open.add(`${x.id} ${r.id}`);
  /**
   * Anything bound to a *specific* request survives only while that exact
   * request is still outstanding. Answered here, answered in another window, or
   * the turn moved on — all three read the same way in a snapshot, and all
   * three mean the thing on screen can no longer be acted on. Whatever replaced
   * it is a different request, and nothing typed for one is re-aimed at it.
   */
  const goneFor = (sid: string | null | undefined, rid: string | null | undefined): boolean =>
    sid != null && rid != null && !open.has(`${sid} ${rid}`);
  const planGone = s.plan !== null && goneFor(s.plan.sessionId, s.plan.requestId);
  // A send / answer / title / compact prompt or a picker aimed at a session
  // another client just removed would loop on submit (RPC error → reopen). A
  // request-bound prompt also goes when its request does; a `send` or `title`
  // prompt carries no request id, so resolving one never closes it.
  const promptAt = s.prompt ? promptTarget(s.prompt) : null;
  const promptGone =
    promptAt !== null &&
    ((promptAt.sessionId !== null && !live.has(promptAt.sessionId)) ||
      goneFor(promptAt.sessionId, promptAt.requestId));
  const qnavGone = s.qnav !== null && goneFor(s.qnav.sessionId, s.qnav.requestId);
  const pickerSession = s.picker?.ctx?.liveSessionId;
  const pickerGone = pickerSession != null && !live.has(pickerSession);
  const picker = pickerGone ? null : rederiveOpenPicker({ ...s, fleet });
  return {
    ...s,
    fleet,
    selectedId: clampSelection(sessions, s.selectedId, s.pendingSelectId),
    ...settlePendingSelect(s, sessions),
    selectedChild: clampChild(sessions, s.selectedId, s.selectedChild),
    ...(qnavGone ? { qnav: null } : {}),
    // `queue` is deliberately NOT pruned here. A queue whose session has gone
    // is stranded, and stranding it is news — silently dropping it loses a
    // message the user typed with no word about it. `drainQueues` clears it and
    // says so, in the same dispatch this snapshot triggers.
    heldSend: pruneByLive(s.heldSend, sessions),
    modeDraft: pruneByLive(s.modeDraft, sessions),
    transcripts: pruneByLive(s.transcripts, sessions),
    ...(planGone ? { plan: null, mode: s.mode === "plan" ? ("browse" as UiMode) : s.mode } : {}),
    ...(promptGone
      ? {
          prompt: null,
          mode: s.mode === "prompt" ? ("browse" as UiMode) : s.mode,
          // Say why it vanished, but only when the session is still there —
          // a removed session already reports itself.
          ...(promptAt?.requestId != null && live.has(promptAt.sessionId ?? "")
            ? { notice: mkNotice("that request was resolved elsewhere", "dim") }
            : {}),
        }
      : {}),
    ...pickerPatch(s, pickerGone, picker),
  };
};

/**
 * A provider/model picker opened before the start-up model probes settled holds
 * a stale copy of the loading state — re-derive it off the new snapshot so it
 * fills in without being closed and reopened. A picker whose session is gone
 * closes instead.
 */
const pickerPatch = (
  s: TuiState,
  gone: boolean,
  rederived: PickerState | null,
): Partial<TuiState> => {
  if (gone) return { picker: null, mode: s.mode === "picker" ? "browse" : s.mode };
  return rederived ? { picker: rederived } : {};
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
      // No durable id means the daemon did not persist this event, which is its
      // way of saying "not transcript": status transitions and compaction beats
      // are read off the session snapshot instead. They can still raise a
      // transient notice, which is what the live stream is for.
      if (frame.id === undefined || NON_TRANSCRIPT.has(ev.type)) {
        return notice === s.notice ? s : { ...s, notice };
      }
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
      const t = appendLive(transcriptOf(s, ev.sessionId), toLogLine(frame.id, ev, toolName));
      return {
        ...s,
        transcripts: withTranscript(s, ev.sessionId, t),
        notice,
        toolNames,
      };
    }
    case "resync":
      // The push stream rolled past our seq, so entries in the gap never
      // arrived and the cache would have a hole in it with nothing on screen to
      // say so. Everything describing *current* state comes whole in the next
      // snapshot; the transcript is the one thing that has to be re-read.
      return resetTranscripts(s);

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

/** The non-transcript event kinds — surfaced via the session snapshot /
 *  indicators, never the conversation (`applyPush` filters the same list). */
const NON_TRANSCRIPT: ReadonlySet<string> = new Set([
  "status_changed",
  "compact_progress",
  "context",
  "background_tasks",
  "rate_limit",
]);

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
  return fleetSessions(s).find((x) => x.id === s.selectedId) ?? null;
};

/** The focused child of the selected session, when the fleet is drilled in. */
export const focusedChildOf = (s: TuiState): FleetChild | null => {
  const sel = selectedSession(s);
  if (!sel || s.selectedChild == null) return null;
  return childrenOf(sel).find((k) => k.key === s.selectedChild) ?? null;
};

/**
 * The session's outstanding requests, projected into the shape the prompts
 * read. Derived from the snapshot's authoritative `requests` list rather than
 * accumulated from the event stream: a request is outstanding exactly while the
 * daemon says it is, so a history page can never resurrect a settled one and
 * another client answering one makes it disappear here with no local
 * bookkeeping. Ids this client has just answered are hidden until the snapshot
 * agrees (see {@link TuiState.resolved}).
 */
const NO_REQUESTS: readonly SessionInteraction[] = [];

/** Everything the session is parked on, in the daemon's order — oldest first,
 *  which is the order parallel permissions must be answered in. */
export const requestsFor = (s: TuiState, id: string | null): readonly SessionInteraction[] =>
  (id ? fleetSessions(s).find((x) => x.id === id)?.requests : undefined) ?? NO_REQUESTS;

/**
 * The one request the panel shows and the keys act on.
 *
 * `awaiting_input`'s reason is the daemon's own answer to "what is this turn
 * blocked on", so prefer the first request of that kind; a session that reports
 * no reason, or one nothing matches, falls back to the first request it has.
 * Selecting never discards the rest — {@link requestsFor} still has them, in
 * order, and the panel says how many are queued behind this one.
 */
export const activeRequest = (s: TuiState, id: string | null): SessionInteraction | null => {
  const requests = requestsFor(s, id);
  if (requests.length === 0) return null;
  const status = fleetSessions(s).find((x) => x.id === id)?.status;
  const on = status?.kind === "awaiting_input" ? status.on : null;
  return (on ? requests.find((r) => r.kind === on) : undefined) ?? requests[0] ?? null;
};

/** A compaction the daemon reports in flight for `id`, or null. */
export const compactingFor = (
  s: TuiState,
  id: string | null,
): { startedAt: number; before: number; generated: number } | null => {
  if (!id) return null;
  return fleetSessions(s).find((x) => x.id === id)?.compacting ?? null;
};

/** Is any session compacting? Drives the spinner tick. */
export const anyCompacting = (s: TuiState): boolean => {
  return fleetSessions(s).some((x) => x.compacting !== undefined);
};

export const queueFor = (s: TuiState, id: string | null): string[] => {
  return (id && s.queue[id]) || [];
};

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

/** The selected session's transcript cache. */
export const transcriptFor = (s: TuiState, id: string | null): Transcript => {
  return (id && s.transcripts[id]) || EMPTY_TRANSCRIPT;
};

/** The selected session's log lines, oldest first: durable entries in durable
 *  order, then the local echoes, which have no place in that order. */
export const sessionLog = (s: TuiState): LogLine[] => {
  const t = transcriptFor(s, s.selectedId);
  return t.echoes.length === 0 ? [...t.lines] : [...t.lines, ...t.echoes];
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
      id: first.id,
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
          id: pending.id,
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
              id: line.id,
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
    case "context":
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
  return fleetProviders(s).find((p) => p.id === providerId)?.color ?? "";
};

export const providerInfo = (s: TuiState, providerId: string): ProviderInfo | null => {
  return fleetProviders(s).find((p) => p.id === providerId) ?? null;
};

/** `<login method> (<org>)` for a Claude profile, or "" when unknown. */
export const providerAccountOf = (s: TuiState, providerId: string): string => {
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
  if (isClaudeId(providerId)) return "claude uses its configured model — enter to continue";
  return `no models detected for "${providerId}" — check \`loom models ${providerId}\` or set model / models in config; enter to use the provider default`;
};

/** A snapshot landed while a provider/model picker is open: rebuild
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
            prompt: sessionPrompt("send", p.ctx.reopenSend, "send", p.ctx.draft ?? ""),
          }
        : { t: "closePicker" };
    }
    return {
      t: "openPrompt",
      prompt: newPrompt(newSettings(s, null, null, null), p.ctx?.draft ?? ""),
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
    if (fleetProviders(s).length > 1) {
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
      prompt: newPrompt(newSettings(s, null, null, null), draft),
    };
  }
  if (p.kind === "model" && p.ctx?.liveSessionId && p.ctx.reopenSend !== undefined) {
    return {
      t: "openPrompt",
      prompt: sessionPrompt("send", p.ctx.reopenSend, "send", p.ctx.draft ?? ""),
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
      prompt: sessionPrompt("send", p.ctx.reopenSend, "send", p.ctx.draft ?? ""),
    };
  }
  if (p.kind === "effort" && !p.ctx?.liveSessionId) {
    return {
      t: "openPrompt",
      prompt: newPrompt(newSettings(s, p.ctx?.provider ?? null, null, null), p.ctx?.draft ?? ""),
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
  const matched = searchSessions(fleetView(state), query).map((m) => m.session);
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
  if (fleetSessions(s).some((x) => x.status.kind === "done" && x.worktree)) {
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
  id: TranscriptId | null,
  ev: HarnessEvent,
  toolName?: string,
): LogLine => {
  const f = formatEvent(ev, toolName);
  return {
    id,
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

/**
 * One `"question"="answer"` pair from an `AskUserQuestion` tool result. Non-greedy
 * on both sides, ended by the next pair's opening quote or the trailing sentence
 * that follows the whole set — not by any `"` inside the answer itself, so a quote
 * embedded in free-text (`the session would "know" about it`) doesn't cut it short.
 */
const ASK_USER_QUESTION_PAIR = /"([^]*?)"="([^]*?)"(?=, "|\.\s|\.$|$)/g;

/**
 * The SDK renders a resolved `AskUserQuestion` as one run-on confirmation
 * sentence (`The user answered: "…"="…", "…"="…". <note>`) — technically
 * correct but unreadable once the answer is more than a few words. Reflow it
 * into `Q:`/`A:` blocks for the event log; `null` (leave the raw text as-is)
 * if the shape doesn't match.
 */
const formatAskUserQuestionResult = (raw: string): string | null => {
  const prefix = "The user answered: ";
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const pairs: Array<{ q: string; a: string }> = [];
  ASK_USER_QUESTION_PAIR.lastIndex = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = ASK_USER_QUESTION_PAIR.exec(rest))) {
    pairs.push({ q: m[1]!, a: m[2]! });
    end = ASK_USER_QUESTION_PAIR.lastIndex;
  }
  if (pairs.length === 0) return null;
  const note = rest
    .slice(end)
    .replace(/^\.\s*/, "")
    .trim();
  const blocks = pairs.map((p, i) => {
    const n = pairs.length > 1 ? String(i + 1) : "";
    return `Q${n}: ${p.q}\nA${n}: ${p.a}`;
  });
  return [...blocks, ...(note ? [note] : [])].join("\n\n");
};

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
      const full = ev.ok ? (formatAskUserQuestionResult(out) ?? out) : `error\n${out}`;
      return {
        glyph: "↳",
        text: ev.ok ? "ok" : `error ${oneLine(out || String(raw), 120)}`,
        ...(out && !terse ? { full } : {}),
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
    case "context":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return { glyph: "∑", text: `ctx ${humanTokens(ev.contextUsed)}`, tone: "dim" };
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

const pathOf = (o: Record<string, unknown>): string | undefined => {
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.path === "string") return o.path;
  return undefined;
};

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
