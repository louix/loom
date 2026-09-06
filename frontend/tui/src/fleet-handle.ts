/**
 * Everything the TUI does that isn't drawing: owns the {@link TuiState}, the
 * keymap, and every daemon round-trip. The React side (`./app.tsx`) is a pure
 * subscriber — it hands this factory the terminal capabilities it needs, starts
 * it once in a `useEffect`, forwards key presses to {@link FleetHandle.handleKey},
 * and renders whatever {@link FleetHandle.getView} last produced.
 *
 * No RxJS: a single {@link Store} holds the derived view; `reduce` is the only
 * writer and Node runs it on one thread, so the synchronous read the keymap
 * needs is safe. The `useRef`-as-store mirrors the component used to keep
 * (restart latch, echo seq, backfill/drain bookkeeping) are plain closure
 * variables here.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Key } from "ink";
import { absurd } from "@loom/core/absurd";
import { isClaudeId } from "@loom/core/provider-id";
import { isLiveState } from "@loom/core/session-state";
import { foldInteraction, type SessionInteraction } from "@loom/core/interaction";
import type { ClientState } from "@loom/client";
import { makeLogger } from "@loom/core/logger";
import type {
  DaemonInfo,
  DoctorReport,
  HistoryPage,
  PushFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { LOOM_VERSION } from "@loom/core/version";
import { spawnEditor, type EditorHandoff } from "./editor-handoff.ts";
import { applyKey, buffer } from "./editor.ts";
import { modeLabel, setThemeMode, shortId, truncate } from "./theme.ts";
import { loadPersistedTheme, persistTheme } from "./theme-store.ts";
import {
  detailRows,
  logRowCount,
  modeChipHit,
  promptPaneRows,
  promptRows,
  requestPanelRows,
} from "./components.tsx";
import { mkStore } from "./store.ts";
import { cleared, enqueue, mkComposer, outboxOf, pending, release } from "./composer.ts";
import {
  fleetProviders,
  fleetSessions,
  sessionMode,
  allowedActs,
  commandsFor,
  cycleLogFilter,
  defaultModelOf,
  defaultProviderId,
  escapePicker,
  fleetHits,
  anyCompacting,
  compactingFor,
  initialState,
  newSettings,
  transcriptFor,
  modelPickItems,
  modelSupportsEffort,
  pickerStep,
  type WizardStep,
  providerAccountOf,
  providerInfo,
  queueFor,
  reduce,
  selectedSession,
  sessionLog,
  transcriptText,
  versionMismatchAction,
  type ActName,
  type Action,
  type FleetHit,
  type LogLine,
  type TuiState,
} from "./model.ts";
import {
  browse,
  discussPrompt,
  heldPlan,
  newPrompt,
  openPrompt,
  pickerCurrent,
  makePicker,
  promptKind,
  promptOnPane,
  requestPrompt,
  sessionPrompt,
  unwind,
  type Confirm,
  type Overlay,
  type NewSessionSettings,
  type Picker,
  type PickerDest,
  type PickerStep,
  type PlanReview,
  type RequestPromptKind,
  type SessionPromptKind,
} from "./overlay.ts";
import {
  activeRequest,
  formatQuestionsForEditor,
  liveQNav,
  mkInteractions,
  nextUnanswered,
  parseAskUserQuestions,
  questionPromptFor,
  questionState,
  requestsFor,
  type AskUserQuestionItem,
} from "./interactions.ts";

/** How much of each log file the `logs` command pulls into `$EDITOR`. */
const LOG_TAIL_BYTES = 256 * 1024;

/** Last `maxBytes` of `path` as text, partial first line dropped. Never throws —
 *  a missing / unreadable file comes back as a one-line note. */
const tailFileSync = (path: string, maxBytes: number): string => {
  let fd: number | null = null;
  try {
    const { size } = statSync(path);
    if (size === 0) return `(${path} is empty)`;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    fd = openSync(path, "r");
    const n = readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, n).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (e) {
    return `(could not read ${path}: ${e instanceof Error ? e.message : String(e)})`;
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const nextMode = (m: SessionMode): SessionMode =>
  SESSION_MODES[(SESSION_MODES.indexOf(m) + 1) % SESSION_MODES.length] ?? "default";

/**
 * Actions that touch nothing but this process, so they stay live while the
 * connection is down: reading the UI, changing how it looks, viewing the log
 * files, leaving. Everything else needs a daemon, and is gated once in
 * `runAct` on ClientState's discriminant rather than failing per-RPC.
 */
const OFFLINE_ACTS = new Set<ActName>(["help", "theme", "filter", "viewlog", "logs", "quit"]);

/** Overlays that arm the batched-input latch ({@link overlayActed}). */
const LATCHED_OVERLAYS = new Set<Overlay["t"]>(["confirm", "plan", "picker"]);

/**
 * The C0 control bytes behind the prompt's readline motions: ⌃a ⌃b ⌃e ⌃f ⌃k
 * ⌃u ⌃w. Ink's input parser splits a held Backspace or arrow into one event
 * per repeat, but hands a run of these to us as a single coalesced chunk — so
 * a held ⌃k stalls after the first delete the moment a render lag batches the
 * bytes. {@link handleKey} expands such a run back into discrete presses.
 * `\r` / `\n` / `\t` are pointedly absent: they turn up inside pasted text.
 */
const REPEATABLE_CTRL = new Set([0x01, 0x02, 0x05, 0x06, 0x0b, 0x15, 0x17]);

/**
 * The acts {@link runAct} hands off to {@link act} — session verbs plus the
 * always-on globals. Everything else in {@link ActName} (view / structural
 * commands) `runAct` handles inline. Splitting the union this way makes both
 * switches exhaustive: a new `ActName` fails to compile until it's placed.
 */
type DelegatedAct =
  | "approve"
  | "deny"
  | "answer"
  | "send"
  | "interrupt"
  | "done"
  | "compact"
  | "keepwarm"
  | "rebase"
  | "planreview"
  | "mode"
  | "undo"
  | "title"
  | "comment"
  | "new"
  | "find"
  | "filter"
  | "help"
  | "quit";

/** The {@link DelegatedAct}s allowed regardless of the selected session's state. */
const GLOBAL_ACTS = new Set<DelegatedAct>(["new", "find", "filter", "help", "quit"]);

/** The terminal capabilities the handle needs, gathered by the component from Ink. */
export interface Term {
  readonly exit: () => void;
  readonly suspendTerminal: (fn: () => Promise<void> | void) => Promise<void>;
  readonly write: (s: string) => void;
  readonly isTTY: boolean;
  readonly getSize: () => { cols: number; rows: number };
  readonly onResize: (fn: () => void) => () => void;
}

/** At or above this width the workspace is the three-column split; below it
 *  `overview` is the fleet list alone and `session` renders full-width — see
 *  {@link deriveView}. */
export const NARROW_COLS = 80;

/**
 * The layout's two views, toggled with `⇥` and reset with `Esc`:
 *
 *  - `overview` — the whole workspace: fleet + detail + events (the split). On a
 *    narrow terminal there's only room for the fleet list here.
 *  - `session` — one session up close: its detail card + event log, the fleet
 *    list toggled away.
 */
export type LayoutView = "overview" | "session";

/** Which body the layout draws — each overlay owns the screen, and carries what
 *  it draws, so the renderer never has to guard a payload against a mode.
 *  `fleetOnly` is the narrow `overview` (the fleet list alone); `sessionPane`
 *  is the `session` view at any width, and `split` the wide `overview`. */
export type BodyKind =
  | { t: "help" }
  | { t: "doctor" }
  | { t: "confirm"; confirm: Confirm }
  | { t: "plan"; plan: PlanReview }
  | { t: "picker"; picker: Picker }
  | { t: "split" }
  | { t: "fleetOnly" }
  | { t: "sessionPane" };

/** Everything `./app.tsx` needs for one frame. Pure projection of the state + UI bits. */
export interface FleetView {
  readonly state: TuiState;
  readonly tick: number;
  /** Viewport offset into the event log, in physical (wrapped) rows up from the
   *  live tail — `EventLog` pins the viewport at `rows - capacity`, the top. */
  readonly logScroll: number;
  /** Top-anchored offset into the plan-review body (PgUp/PgDn/wheel). */
  readonly planScroll: number;
  /** The active layout view — `⇥` toggles it, `Esc` resets to `overview`. */
  readonly layoutView: LayoutView;
  readonly sel: SessionSnapshot | null;
  /** The request the panel shows and the keys act on — see `activeRequest`. */
  readonly request: SessionInteraction | null;
  /** How many the selected session has outstanding in total, `request` included. */
  readonly requestCount: number;
  readonly allowed: ReadonlySet<ActName>;
  /** What the selected session still owes the daemon, oldest first — the
   *  Detail pane shows the count and the head. */
  readonly queued: readonly string[];
  readonly showRequest: boolean;
  /** Which `AskUserQuestion` question the request panel should show — the one
   *  the open `answerQuestion` prompt is collecting, else the first. */
  readonly questionIdx: number;
  readonly body: BodyKind;
  readonly cols: number;
  readonly rows: number;
  readonly bodyH: number;
  readonly leftW: number;
  readonly rightW: number;
  readonly splitLogH: number;
  readonly logPage: number;
  /** Clickable regions for this frame — FLEET rows + the Detail `[mode]` chip.
   *  The keymap's mouse branch hit-tests a left click against these. */
  readonly hits: readonly FleetHit[];
}

export interface FleetHandle {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getView: () => FleetView;
  readonly handleKey: (input: string, key: Key) => void;
  /** Subscribe the daemon feed + tickers; returns teardown. One `useEffect`. */
  readonly effectStart: () => () => void;
}

/**
 * The slice of the `LoomClient` surface the handle actually drives. Named as its own
 * contract so a test can hand over a stand-in it controls — snapshots, pushes
 * and each RPC's settlement — without casting a half-built object to the whole
 * client. `LoomClient` satisfies it structurally; nothing implements it twice.
 */
export interface FleetClient {
  readonly clientId: string;
  readonly daemonInfo: DaemonInfo | null;
  readonly request: <T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly subscribe: (fn: (state: ClientState) => void) => () => void;
  readonly onPush: (fn: (frame: PushFrame) => void) => () => void;
  readonly on: (
    event: "disconnect" | "reconnect" | "resync" | "close",
    fn: () => void,
  ) => () => void;
  readonly close: () => Promise<void>;
}

export interface MkFleetHandleInput {
  readonly client: FleetClient;
  readonly term: Term;
  /** Daemon + TUI log paths for the "view logs" command; absent in tests. */
  readonly logs?: { readonly daemon: string; readonly tui: string };
  /** Path to the TUI preference file — the `t` theme persists there across
   *  restarts. Absent in tests, where nothing touches disk. */
  readonly themeState?: string;
  /** Test seam: stands in for the real `$EDITOR` handoff. */
  readonly openEditorOverride?: EditorHandoff;
  /** Test seam: rows per durable-history page (default 500). Lets a test drive
   *  scroll-back paging without emitting hundreds of events. */
  readonly historyPageSize?: number;
}

const deriveView = (
  state: TuiState,
  tick: number,
  logScroll: number,
  planScroll: number,
  layoutView: LayoutView,
  dims: { cols: number; rows: number },
): FleetView => {
  const sel = selectedSession(state);
  // The panel shows what the turn is parked on, straight off the snapshot: the
  // request's id, kind and payload travel together from here to the screen and
  // back to the RPC that answers it.
  const request = sel ? activeRequest(fleetSessions(state), sel.id) : null;
  const requestCount = sel ? requestsFor(fleetSessions(state), sel.id).length : 0;
  const allowed = allowedActs(sel);

  // The approve / answer / plan panel sits full-width just above the footer in
  // both layout views; every overlay owns the screen.
  const showRequest =
    (state.overlay.t === "browse" || state.overlay.t === "prompt") &&
    sel?.status.kind === "awaiting_input" &&
    request !== null;

  // Never floor these above the real terminal size: the whole frame is laid
  // out at exactly `cols` × `rows`, and a frame wider/taller than the terminal
  // soft-wraps or scrolls — Ink's repaints then drift and the top bar slides
  // off the alt screen. Tiny terminals degrade; they don't corrupt.
  const cols = Math.max(1, dims.cols);
  const rows = Math.max(1, dims.rows);
  const footerH = promptRows(state, cols);
  // Which question the request panel previews — the one `qnav` is parked on,
  // which is also the one an open answer prompt is collecting. The panel sizes
  // itself to fit it (see `requestPanelRows`), so this has to be settled before
  // the row budget.
  const questionIdx = liveQNav(state.qnav, sel?.id, request?.id)?.idx ?? 0;
  const requestH = showRequest ? requestPanelRows(request, cols, questionIdx) : 0;

  // Below this width the three-column split starves every column (~20 cols each
  // on a phone-sized SSH window), so `overview` is the fleet list alone — the
  // detail + events panes wait for `⇥`.
  const narrow = cols < NARROW_COLS;

  const bodyFor = (): BodyKind => {
    const o = state.overlay;
    // Every overlay but the prompt owns the screen; a prompt draws over the
    // ordinary body (in the footer, or on its session's events pane).
    if (o.t !== "browse" && o.t !== "prompt") return o;
    if (layoutView === "session") return { t: "sessionPane" };
    return narrow ? { t: "fleetOnly" } : { t: "split" }; // wide `overview`
  };
  const body = bodyFor();

  const bodyH = Math.max(1, rows - 1 - footerH - requestH);
  // Fleet column: 32-col floor where the terminal affords it, yielding below
  // ~53 cols so `leftW + 1 + rightW` always sums to `cols`. Narrow views each
  // own the full width.
  const leftW = narrow
    ? cols
    : Math.min(Math.max(32, Math.round(cols * 0.4)), Math.max(8, cols - 21));
  const rightW = narrow ? cols : Math.max(1, cols - leftW - 1);
  // The right column is Detail (natural height) + gap 1 + the log, and must
  // sum to exactly bodyH — size the log against Detail's real row count
  // (detailRows), not a hardcoded guess, or a rich claude session overflows
  // the body and pushes the top of the UI off screen.
  const queued = sel ? queueFor(state, sel.id) : [];
  const detailAccount = sel ? providerAccountOf(state, sel.provider) : "";
  const detailH = detailRows(sel, {
    account: detailAccount,
    compacting: compactingFor(state, sel?.id ?? null),
    queued,
  });
  // The `session` view gives Detail + events the whole terminal; the wide
  // `overview` split confines them to the right column.
  const eventsW = body.t === "sessionPane" ? cols : rightW;
  // A session-targeted prompt draws its input group under the EVENTS log (its
  // label + editor rows) — budget them against the log's height.
  const paneH = promptPaneRows(state, eventsW);
  const splitLogH = Math.max(4, bodyH - detailH - 1 - paneH);
  const logPage = Math.max(1, splitLogH - 3);

  // Clickable regions — screen coordinates the keymap's mouse branch hit-tests
  // against. The body starts at screen row 2 (Header is one row); Ink clips the
  // fleet list past `bodyH + 1`.
  const hits: FleetHit[] = [];
  const fleetGeom = { originX: 1, originY: 2, maxY: bodyH + 1 };
  if (body.t === "split") {
    hits.push(...fleetHits(state, { ...fleetGeom, listW: leftW }));
    const chip = modeChipHit(sel, {
      originX: leftW + 2,
      originY: 2,
      paneW: rightW,
      account: detailAccount,
    });
    if (chip) hits.push({ kind: "mode", ...chip });
  } else if (body.t === "fleetOnly") {
    hits.push(...fleetHits(state, { ...fleetGeom, listW: cols }));
  } else if (body.t === "sessionPane") {
    const chip = modeChipHit(sel, {
      originX: 1,
      originY: 2,
      paneW: cols,
      account: detailAccount,
    });
    if (chip) hits.push({ kind: "mode", ...chip });
  }

  return {
    state,
    tick,
    logScroll,
    planScroll,
    layoutView,
    sel,
    request,
    requestCount,
    queued,
    allowed,
    showRequest: showRequest === true,
    questionIdx,
    body,
    cols,
    rows,
    bodyH,
    leftW,
    rightW,
    splitLogH,
    logPage,
    hits,
  };
};

/**
 * The authoritative session list, or `null` when there is no snapshot to read
 * one from. {@link fleetSessions} answers `[]` for both "no sessions" and "no
 * connection", and a *fresh* `[]` each call — comparing those to decide whether
 * the fleet changed fires on every dispatch and reads a dropped connection as
 * an emptied fleet. Compare this instead; `null !== null` is false.
 */
const sessionsRef = (s: TuiState): readonly SessionSnapshot[] | null =>
  s.fleet.tag === "data" ? s.fleet.value.sessions : null;

export const mkFleetHandle = ({
  client,
  term,
  logs,
  themeState,
  openEditorOverride,
  historyPageSize,
}: MkFleetHandleInput): FleetHandle => {
  // File-only (stderr is silenced upstream); absent in tests, where nothing logs.
  const log = logs ? makeLogger("tui") : null;
  // Restore the persisted theme before building state: `setThemeMode` swaps C
  // in place and `initialState()` reports the active mode, so state and
  // palette already agree on the first frame.
  const savedTheme = themeState ? loadPersistedTheme(themeState) : null;
  if (savedTheme) setThemeMode(savedTheme);
  let state = initialState();
  /** Whether the daemon has given us a snapshot to act on. The single source
   *  for "is this UI connected" — see {@link connectionOf}. */
  const connected = (): boolean => state.fleet.tag === "data";
  let tick = 0;
  let logScroll = 0;
  let planScroll = 0;
  // Fleet toggle: `⇥` swaps the overview split ↔ the session's detail + events,
  // `Esc` snaps back to overview. On a narrow terminal overview is the list alone.
  let layoutView: LayoutView = "overview";
  let dims = term.getSize();

  // Was `useRef` in the component — plain closure state here.
  let restarting = false;
  let versionRestartTried = false;
  // Synchronous latch: Ink invokes the key handler once per byte of a stdin
  // chunk before the view updates, so a batched "aa" would resolve an overlay
  // twice. Holds the overlay object already acted on — a fresh overlay has a
  // new identity and passes.
  let overlayActed: object | null = null;
  // Deciding on a request goes through the interaction handle, which holds one
  // guard per request: Ink hands a batched stdin chunk to the key handler one
  // byte at a time, before the view updates, so "aa" would otherwise issue two
  // `respondPermission` calls for the same request.
  const interactions = mkInteractions({
    request: (method, params) => client.request(method, params),
    by: client.clientId,
    fleet: () => fleetSessions(state),
  });
  // Ink delivers a batched stdin chunk one byte at a time before the view
  // updates. A second `\r` right after `submitPrompt` closed the prompt would
  // otherwise be handled in `browse` mode and fire `runAct("send"|"answer")` on
  // the selection (U5). Suppress a fleet-row Enter for a beat after a submit.
  let promptSubmittedAt = 0;

  // `⇧⇥` mode cycling: the debounce window before `session.setMode` actually
  // reaches the daemon for a session (see `cycleSessionMode` below).
  const modeDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  // How many `session.setMode` calls are still outstanding per session. The
  // draft is what the chip shows; retiring it on the *first* reply would snap
  // the chip back to a snapshot that a later call is still on its way to
  // change, so it survives until nothing is in flight.
  const modeInFlight = new Map<string, number>();

  const store = mkStore<FleetView>(
    deriveView(state, tick, logScroll, planScroll, layoutView, dims),
  );
  const publish = (): void =>
    store.set(deriveView(state, tick, logScroll, planScroll, layoutView, dims));

  // Width the log pane renders at for the current body (see app.tsx): the zoomed
  // and session views give it the whole terminal, the overview split its right
  // column.
  const logPaneWidth = (): number => {
    const v = store.get();
    return v.body.t === "split" ? v.rightW : v.cols;
  };
  // Physical (wrapped) rows in the log pane as currently rendered — narrowed to
  // the focused child while drilled in. This — not the logical line count,
  // which wrapping inflates several-fold — is the unit `logScroll` offsets in
  // and what `EventLog` clamps that offset against.
  const shownLogRows = (): number => logRowCount(state, logPaneWidth());

  // Ceiling for `logScroll`: EventLog pins the viewport at `rows - capacity`
  // (the top of the log), so the backing offset must clamp there too — running
  // it past the top would leave you scrolling back down the same distance
  // before the viewport moves again.
  const scrollUp = (by: number): void => {
    const page = store.get().logPage;
    const maxScroll = Math.max(0, shownLogRows() - page);
    logScroll = Math.min(maxScroll, logScroll + by);
    // Prefetch the next older page as the viewport nears the top, so paging back
    // feels seamless instead of stalling at the current oldest line.
    if (maxScroll - logScroll < page) loadOlderHistory();
    publish();
  };

  // Plan-review body scroll: a top-anchored offset (0 = first line; larger =
  // further down — the opposite sense to `logScroll`). No line count is known
  // here, so clamp only at ≥ 0; `PlanReview` clamps the bottom against its
  // window.
  const planScrollBy = (by: number): void => {
    planScroll = Math.max(0, planScroll + by);
    publish();
  };

  // Rows per page. The first pull matches the daemon's own default so a session
  // that fits in one page arrives whole; scroll-back adds more.
  const HISTORY_PAGE = historyPageSize ?? 500;

  /**
   * Fetch the selected session's newest page, once. Whether a page is wanted,
   * in flight, or already loaded is the transcript's own `head` Loadable — no
   * second bookkeeping map to keep in step with it, and clearing the caches on
   * a reconnect is therefore all it takes to make every session fetch again.
   *
   * Live frames are already arriving for every session before this runs (the
   * push subscription is established at start-up, not at selection), so an
   * entry landing while the page is in flight is merged by durable id rather
   * than lost between the two sources.
   */
  const loadHistory = (): void => {
    const id = state.selectedId;
    if (!id) return;
    const head = transcriptFor(state, id).head;
    // `error` retries. This runs only on a selection change, a cache reset or a
    // regained snapshot — never on a render or an arbitrary snapshot — so a
    // failed head is retried by leaving and coming back, and cannot loop.
    if (head.tag === "pending" || head.tag === "data") return;
    const gen = state.transcriptGen;
    dispatch({ t: "historyStart", sessionId: id, older: false, gen });
    client
      .request<HistoryPage>("session.events", { id, limit: HISTORY_PAGE })
      .then((page) => {
        if (gen !== state.transcriptGen) return;
        dispatch({ t: "historyPage", sessionId: id, page, older: false, gen });
      })
      .catch((e: unknown) => {
        dispatch({
          t: "historyFailed",
          sessionId: id,
          older: false,
          gen,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  };

  /**
   * Pull the next older page when the log is scrolled near its top. `null`
   * cursor means the daemon has nothing older — and only that, since retention
   * re-points the cursor at whatever it evicted rather than clearing it.
   */
  const loadOlderHistory = (): void => {
    if (!connected()) return;
    const id = state.selectedId;
    if (!id) return;
    const t = transcriptFor(state, id);
    if (t.head.tag !== "data" || t.older.tag === "pending" || t.olderCursor === null) return;
    const gen = state.transcriptGen;
    const cursor = t.olderCursor;
    dispatch({ t: "historyStart", sessionId: id, older: true, gen });
    const page = store.get().logPage;
    // Was the viewport showing the top of the log before the fold-in? Only then
    // does `logScroll` need touching: rows land above the viewport and the
    // render's `end = rows.length - off` grows by the same amount, so any other
    // view stays anchored on its own rows. A top-pinned view must follow the
    // new top — otherwise the older page lands above it unseen.
    const beforeRows = shownLogRows();
    const wasPinnedTop = logScroll >= Math.max(0, beforeRows - page);
    const tailBefore = t.lines[t.lines.length - 1]?.id ?? null;
    client
      .request<HistoryPage>("session.events", { id, limit: HISTORY_PAGE, cursor })
      .then((got) => {
        // The generation this page was asked under is gone — a reconnect or a
        // resync re-read the transcript from scratch. The reducer already
        // refuses its entries; `beforeRows` and `wasPinnedTop` describe a
        // viewport that no longer exists, so nothing below may run either.
        if (gen !== state.transcriptGen || state.selectedId !== id) return;
        dispatch({ t: "historyPage", sessionId: id, page: got, older: true, gen });
        const after = transcriptFor(state, id);
        const rows = shownLogRows();
        // At the cap the fold drops rows below the viewport as well as adding
        // them above it, and `logScroll` counts *up from the tail* — so neither
        // delta can be applied to it once the tail has moved. Re-derive the
        // position from the top the reader is at instead. This fetch only fires
        // within a page of the top, so that is where they already were.
        const tailLost = (after.lines[after.lines.length - 1]?.id ?? null) !== tailBefore;
        if (wasPinnedTop || tailLost) {
          logScroll = Math.max(0, rows - page);
          publish();
        } else if (rows !== beforeRows) {
          // Publish even when the view wasn't pinned: the fold changed the log
          // (the "↑N more" indicator included), and an anchored view renders the
          // same rows either way — the re-render is free. Without this the fold
          // sits invisible until the next keypress republishes.
          publish();
        }
      })
      .catch((e: unknown) => {
        dispatch({
          t: "historyFailed",
          sessionId: id,
          older: true,
          gen,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  };

  // Follow-ups typed at a busy session, the sends already on the wire, and
  // anything whose reply was lost — all of it lives in `state.outbox`, and the
  // composer is what moves a message between those. It sees the snapshots and
  // one commit function; it does not see the rest of the app.
  const composer = mkComposer({
    send: (sessionId, text) => client.request("session.send", { id: sessionId, text }).then(),
    fleet: () => fleetSessions(state),
    boxes: () => state.outbox,
    commit: (sessionId, box) => dispatch({ t: "outbox", sessionId, box }),
    note: (text) => note(text, "bad"),
  });

  const dispatch = (a: Action): void => {
    const prev = state;
    state = reduce(state, a);
    if (state === prev) return;
    // Was `useEffect(() => setLogScroll(0), [selectedId, logFilter])`. Child
    // focus joins the reset set: entering/leaving a drill-down (or the focused
    // child draining) re-anchors the pane at the live tail.
    if (
      state.selectedId !== prev.selectedId ||
      state.logFilter !== prev.logFilter ||
      state.selectedChild !== prev.selectedChild ||
      // A cache reset (a dropped connection, a rolled push stream) took the rows
      // the viewport was anchored to with it — go back to the live tail.
      state.transcriptGen !== prev.transcriptGen
    ) {
      logScroll = 0;
    } else if (
      a.t === "push" &&
      logScroll > 0 &&
      transcriptFor(state, state.selectedId) !== transcriptFor(prev, prev.selectedId)
    ) {
      // Scrolled back through history (the pane border shows the accent) and a
      // live frame just landed at the tail: pin the viewport to the lines
      // you're reading instead of letting the new rows shove your view older.
      // `logScroll` counts physical rows up from the live tail, so grow it by
      // however many rows the log gained — `end = total - logScroll` (see
      // EventLog) then holds still and the same window renders. Clamp to the
      // top the way `scrollUp` does; a LOG_CAP trim (net rows <= 0) is a no-op.
      // Only `push` (tail append): an older page lands *above* the viewport,
      // where a tail-anchored offset already keeps your place, and
      // `loadOlderHistory` owns the top-pinned case.
      const width = logPaneWidth();
      const grew = logRowCount(state, width) - logRowCount(prev, width);
      if (grew > 0) {
        const max = Math.max(0, logRowCount(state, width) - store.get().logPage);
        logScroll = Math.min(max, logScroll + grew);
      }
    }
    // A different plan review (or the overlay opening / closing) re-anchors the
    // plan body at its top.
    if (heldPlan(state.overlay)?.requestId !== heldPlan(prev.overlay)?.requestId) planScroll = 0;
    // Narrow layout: opening a reply to a session pulls the events pane into
    // view (its input renders there) — from `overview` there's no room for it.
    if (
      promptOnPane(openPrompt(state.overlay)) &&
      !promptOnPane(openPrompt(prev.overlay)) &&
      layoutView === "overview" &&
      dims.cols < NARROW_COLS
    )
      layoutView = "session";
    // Was `useEffect(() => { if (!overlay) overlayActed.current = null }, [mode])`.
    if (!LATCHED_OVERLAYS.has(state.overlay.t)) overlayActed = null;
    if (state.theme !== prev.theme) {
      setThemeMode(state.theme);
      // Remember the choice for the next launch — best-effort, like the log.
      if (themeState) persistTheme(themeState, state.theme);
    }
    publish();
    // One gate for every daemon-dependent effect, read off ClientState's
    // discriminant rather than a flag beside it. Without a snapshot there is
    // nothing to fetch (the caches were dropped when the connection went), no
    // session proven dead, and no queue that can be drained — an unknown fleet
    // is not an empty fleet, and treating it as one strands every queue.
    if (!connected()) return;
    // Three transitions want the selected session's newest page, and only
    // these three: a different session, a cache reset (which put every `head`
    // back to `idle`), and regaining a snapshot after losing one. The reset a
    // dropped connection performs deliberately does *not* refetch — there is
    // nothing to ask — which is why regaining data has to be its own trigger.
    if (
      state.selectedId !== prev.selectedId ||
      state.transcriptGen !== prev.transcriptGen ||
      prev.fleet.tag !== "data"
    ) {
      loadHistory();
    }
    if (sessionsRef(state) !== sessionsRef(prev)) interactions.settle();
    // A new snapshot may have taken a session idle (or ended a compaction, or
    // killed it outright), and a newly queued message may be releasable right
    // now — both are the composer's to work out.
    if (sessionsRef(state) !== sessionsRef(prev) || state.outbox !== prev.outbox) {
      composer.advance();
    }
  };

  const note = (text: string, tone: "good" | "bad" | "dim" | "accent" = "good"): void =>
    dispatch({ t: "notice", text, tone });

  /** A fresh review overlay for a session's pending `plan_review`, if it has one. */
  const planReviewFor = (sessionId: string): PlanReview | null => {
    const r = requestsFor(fleetSessions(state), sessionId).find((x) => x.kind === "plan_review");
    return r?.kind === "plan_review"
      ? { sessionId, requestId: r.id, text: r.plan, mode: "acceptEdits", impl: null }
      : null;
  };

  /** Put an overlay up, or take one down (`browse`). */
  const show = (overlay: Overlay): void => void dispatch({ t: "overlay", overlay });

  const quitTui = (): void => {
    client.close().catch(() => {});
    term.exit();
  };

  const echoLine = (sessionId: string, text: string): LogLine => ({
    id: null, // locally synthesised — there is no durable row behind it
    sessionId,
    kind: "echo",
    glyph: "›",
    text: text.replace(/\s+/g, " ").trim(),
    tone: "accent",
    ts: Date.now(),
  });

  /** `o` / `⌥o` dump: the selected session's whole log as a readable transcript. */
  const logText = (): string => transcriptText(sessionLog(state));

  /**
   * Hand the terminal to `$EDITOR` and hand it back. `suspendTerminal` (Ink 7.1)
   * flushes the frame, pauses input, runs the child, then resets Ink's diff
   * state and forces a full redraw. Bracketed paste is set outside Ink (in
   * `run.tsx`), so Ink's `resumeInput` won't restore it — re-assert it here.
   */
  const openEditor: EditorHandoff = async (text, opts) => {
    if (openEditorOverride) return openEditorOverride(text, opts);
    let saved: string | null = null;
    try {
      await term.suspendTerminal(async () => {
        saved = spawnEditor(text, opts);
      });
    } catch (e) {
      saved = null;
      const msg = e instanceof Error ? e.message : String(e);
      log?.warn("editor handoff failed", { err: msg });
      note(msg, "bad");
    }
    if (term.isTTY) term.write("\x1b[?2004h\x1b[?1000h\x1b[?1006h");
    return saved;
  };

  /** `⌃e` — edit the open prompt's text in `$EDITOR`, with the event log alongside. */
  const editPrompt = async (): Promise<void> => {
    const p = openPrompt(state.overlay);
    if (!p) return note("open a prompt first — press o to view the log", "dim");
    const next = await openEditor(p.buffer.text, {
      ext: p.t === "new" ? "md" : "txt",
      aside: { name: "events.log", body: logText() },
    });
    if (next != null) dispatch({ t: "promptSet", buffer: buffer(next.replace(/\s+$/, "")) });
  };

  /** `o` / `⌥o` — open the pending request, or the event log, in `$EDITOR` read-only. */
  const viewInEditor = async (): Promise<void> => {
    const s = selectedSession(state);
    const r = s ? activeRequest(fleetSessions(state), s.id) : null;
    if (r === null) {
      await openEditor(logText(), { ext: "log" });
      return;
    }
    await foldInteraction<Promise<unknown>>({
      onPlanReview: (p) => openEditor(p.plan, { ext: "md" }),
      onQuestion: (q) => openEditor([q.question, "", q.context ?? ""].join("\n"), { ext: "md" }),
      onUserQuestion: (u) => {
        const qs = parseAskUserQuestions(u.input);
        return qs.length > 0
          ? openEditor(formatQuestionsForEditor(qs), { ext: "md" })
          : openEditor(JSON.stringify({ tool: u.tool, input: u.input }, null, 2), { ext: "json" });
      },
      onPermission: (p) =>
        openEditor(JSON.stringify({ tool: p.tool, input: p.input }, null, 2), { ext: "json" }),
    })(r);
  };

  /** Command palette: the tail of both process logs in `$EDITOR` — daemon.log
   *  primary, tui.log alongside (read-only). */
  const viewLogs = async (): Promise<void> => {
    if (!logs) return note("logs aren't wired up in this session", "dim");
    log?.info("view logs");
    await openEditor(tailFileSync(logs.daemon, LOG_TAIL_BYTES), {
      ext: "log",
      aside: { name: "tui.log", body: tailFileSync(logs.tui, LOG_TAIL_BYTES) },
    });
  };

  /** Command palette: toggle the doctor overlay, refetching `daemon.doctor`
   *  each time it opens (the last snapshot stays painted until the reply lands). */
  const openDoctor = (): void => {
    const opening = state.overlay.t !== "doctor";
    show(opening ? { t: "doctor" } : browse);
    if (!opening) return;
    client
      .request<DoctorReport>("daemon.doctor")
      .then((report) => dispatch({ t: "doctorLoaded", report }))
      .catch((e: unknown) =>
        note(`couldn't load doctor: ${e instanceof Error ? e.message : String(e)}`, "bad"),
      );
  };

  const copyToClipboard = (text: string, label: string): void => {
    try {
      term.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
      note(`copied ${label}`, "good");
    } catch {
      note("clipboard copy failed", "bad");
    }
  };

  // ---- session actions ------------------------------------------
  const perform = (fn: () => Promise<string>): void => {
    fn()
      .then((m) => m && note(m, "good"))
      .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"));
  };

  /** Park `qnav` on question `idx` and open the answer prompt there. The prompt
   *  itself carries only the session + request it resolves; which question and
   *  the answers so far live in `qnav`, which survives the prompt closing. */
  const openQuestionPrompt = (
    sessionId: string,
    requestId: string,
    qs: AskUserQuestionItem[],
    answers: Record<string, string>,
    idx: number,
  ): void => {
    const { nav, prompt } = questionPromptFor(sessionId, requestId, qs, answers, idx);
    dispatch({ t: "qnavSet", nav });
    show({ t: "prompt", prompt });
  };

  const act = (name: DelegatedAct): void => {
    const s = selectedSession(state);
    const by = client.clientId;
    if (name === "new") {
      return void show({
        t: "prompt",
        prompt: newPrompt(newSettings(state, null, null, null), state.drafts.last),
      });
    }
    if (name === "filter") {
      return void dispatch({ t: "logFilter", value: cycleLogFilter(state.logFilter) });
    }
    if (name === "find") {
      // The fleet filter — an inline single-line query on the FLEET pane, not a
      // modal. `/` toggles it; esc clears; ⏎ accepts (keeping enter's meaning).
      return void dispatch({ t: state.find ? "closeFind" : "openFind" });
    }
    if (name === "help") return void show(state.overlay.t === "help" ? browse : { t: "help" });
    if (name === "quit") return quitTui();
    if (!s) return;
    if (name === "undo") {
      const sid = s.id;
      client
        .request<Array<{ turn: number; userText: string; rewindCostUsd: number }>>(
          "session.checkpoints",
          { id: sid },
        )
        .then((cps) => {
          const costToKeep = new Map(cps.map((c) => [c.turn, c.rewindCostUsd]));
          // One row per turn you can undo, oldest first. "Undo turn T" discards
          // turn T and everything after it, then reopens the prompt pre-filled
          // with turn T's message — so the re-prime cost shown is the cost of
          // keeping turn T-1 (nothing to re-prime when undoing turn 1).
          const items = cps.map((c) => {
            const snippet = truncate(c.userText.replace(/\s+/g, " ").trim(), 72) || "(no message)";
            const cost = c.turn > 1 ? (costToKeep.get(c.turn - 1) ?? 0) : 0;
            return {
              id: String(c.turn),
              label: `turn ${c.turn} · ${snippet}`,
              blob: c.userText,
              ...(cost > 0 ? { hint: `~$${cost.toFixed(2)} to re-prime` } : {}),
            };
          });
          if (items.length === 0) {
            return void dispatch({ t: "notice", text: "nothing to undo yet", tone: "dim" });
          }
          show({
            t: "picker",
            picker: makePicker({
              step: "undo",
              title: `undo · ${shortId(sid)}`,
              items,
              dest: { t: "undo", sessionId: sid },
            }),
          });
        })
        .catch((e: unknown) =>
          dispatch({ t: "notice", text: e instanceof Error ? e.message : String(e), tone: "bad" }),
        );
      return;
    }
    switch (name) {
      case "approve": {
        const r = activeRequest(fleetSessions(state), s.id);
        if (r === null || (r.kind !== "permission" && r.kind !== "user_question")) {
          return note("no permission request pending", "dim");
        }
        return perform(() => interactions.respond(s.id, r.id, { t: "allow" }));
      }
      case "deny": {
        const r = activeRequest(fleetSessions(state), s.id);
        if (r === null || (r.kind !== "permission" && r.kind !== "user_question")) {
          return note("no permission request pending", "dim");
        }
        return void show({
          t: "prompt",
          prompt: requestPrompt("deny", s.id, r.id, `deny ${r.id}`),
        });
      }
      case "answer": {
        const r = activeRequest(fleetSessions(state), s.id);
        if (r?.kind === "question") {
          return void show({ t: "prompt", prompt: requestPrompt("answer", s.id, r.id, "answer") });
        }
        if (r?.kind === "user_question") {
          const q = questionState(fleetSessions(state), state.qnav, s.id);
          if (!q) return note("malformed AskUserQuestion input — ⌃o to inspect", "bad");
          return void openQuestionPrompt(
            s.id,
            q.requestId,
            q.qs,
            q.nav?.answers ?? {},
            q.nav?.idx ?? 0,
          );
        }
        return note("no question pending", "dim");
      }
      case "send": {
        // A send held back because its reply never came is this session's text
        // and outranks the global cancelled-prompt draft. Opening the prompt is
        // the explicit action that releases it — it is editable from here, is
        // not re-sent unless the user submits it, and whatever was queued behind
        // it starts moving again.
        const held = release(outboxOf(state.outbox, s.id));
        if (held) dispatch({ t: "outbox", sessionId: s.id, box: held.box });
        const text = held?.text ?? state.drafts.last;
        return void show({ t: "prompt", prompt: sessionPrompt("send", s.id, "send", text) });
      }
      case "title":
        return void show({
          t: "prompt",
          prompt: sessionPrompt("title", s.id, "rename", s.title ?? ""),
        });
      case "comment":
        return void show({
          t: "prompt",
          prompt: sessionPrompt("comment", s.id, "comment", s.comment ?? ""),
        });
      case "planreview": {
        const plan = requestsFor(fleetSessions(state), s.id).find((r) => r.kind === "plan_review");
        if (!plan) return note("no plan pending", "dim");
        return void show({
          t: "plan",
          plan: {
            sessionId: s.id,
            requestId: plan.id,
            text: plan.plan,
            mode: "acceptEdits",
            impl: null,
          },
        });
      }
      case "interrupt":
        return perform(async () => {
          await client.request("session.interrupt", { id: s.id });
          return "interrupted";
        });
      case "compact":
        return void show({
          t: "prompt",
          prompt: sessionPrompt("compact", s.id, "compact — steer summary (blank = best effort)"),
        });
      case "keepwarm": {
        const on = !s.keepWarm;
        return perform(async () => {
          await client.request("session.setKeepWarm", { id: s.id, on, by });
          return on ? "keep-warm on — re-primes the cache before it lapses" : "keep-warm off";
        });
      }
      case "done": {
        // Archiving reclaims the worktree — a dirty tree would have its
        // uncommitted changes discarded, so make that an explicit confirm
        // (mirrors delete). Clean trees archive straight away.
        if (s.git?.dirty === true) {
          return void show({
            t: "confirm",
            confirm: {
              title: `Archive session ${shortId(s.id)}?`,
              body:
                "Its worktree has uncommitted changes — archiving discards them. " +
                "The branch and chat are kept; message it again to resume on a fresh tree.",
              danger: true,
              action: "archiveSession",
              sessionId: s.id,
            },
          });
        }
        return perform(async () => {
          await client.request("session.markDone", { id: s.id, by });
          return "archived — branch + chat kept";
        });
      }
      case "rebase":
        return perform(async () => {
          const r = await client.request<{
            outcome: string;
            base?: string;
            behind?: number;
            head?: string;
          }>("session.rebase", { id: s.id });
          switch (r.outcome) {
            case "updated":
              return `rebased onto ${r.base} (+${r.behind}) → ${r.head}`;
            case "current":
              note(`already current with ${r.base}`, "dim");
              return "";
            case "dirty":
              note("worktree has uncommitted changes — commit or stash, then retry", "bad");
              return "";
            case "conflict":
              note(
                `rebase hit conflicts — branch left unchanged; integrate ${r.base} by hand`,
                "bad",
              );
              return "";
            case "busy":
              note("a rebase/merge is already in progress in this worktree", "dim");
              return "";
            case "no-base":
              note("no base branch to rebase onto", "dim");
              return "";
            default:
              note("rebase failed — see the daemon log", "bad");
              return "";
          }
        });
      case "mode":
        return void cycleSessionMode(s.id);
      default:
        return absurd(name);
    }
  };

  // --- the provider → model → effort wizard ---------------------------------
  // One set of steps, three destinations: a `new` session being composed, a
  // live session (`⌥m` / `⌥p` / `⌥t`), or an open plan review's `f` retarget
  // (`⌥p` there). The destination travels inside the picker, so no step has to
  // ask where it came from, and unwinding restores exactly what it interrupted.

  /** Open `step` of the wizard. `pick` pre-selects an id in the new list. */
  const openStep = (
    step: WizardStep,
    dest: PickerDest,
    chosen: { provider: string | null; model: string | null },
    from: PickerStep,
    pick?: string | null,
  ): void => show(pickerStep(state, step, { dest, chosen, from, ...(pick ? { pick } : {}) }));

  /** The session an open plan review belongs to, for the retarget wizard's
   *  "current value" pre-selection. */
  const sessionOf = (id: string): SessionSnapshot | undefined =>
    fleetSessions(state).find((x) => x.id === id);

  /** `⌥p` from the plan review: retarget the `f` (implement fresh) run. Each
   *  step pre-selects what the review would use today — a staged choice if
   *  there is one, else the plan session's own. A staged provider that differs
   *  from the session's forks a fresh session when `f` fires. */
  const openPlanRetarget = (plan: PlanReview): void => {
    const ps = sessionOf(plan.sessionId);
    const dest: PickerDest = { t: "planImpl", plan };
    if (fleetProviders(state).length > 1) {
      return openStep(
        "provider",
        dest,
        { provider: null, model: null },
        "provider",
        plan.impl?.provider ?? ps?.provider,
      );
    }
    const provider = fleetProviders(state)[0]?.id ?? ps?.provider ?? "claude";
    openStep(
      "model",
      dest,
      { provider, model: null },
      "model",
      plan.impl?.model ?? (provider === ps?.provider ? ps?.model : null),
    );
  };

  /** Stage the wizard's choices onto the review it was opened over and put the
   *  review back up. Whatever isn't chosen the daemon fills from the target
   *  provider's defaults. */
  const stagePlanImpl = (
    plan: PlanReview,
    provider: string,
    model: string | null,
    effort: string | null,
  ): void => show({ t: "plan", plan: { ...plan, impl: { provider, model, effort } } });

  /**
   * Finalize a model (+ optional effort) chosen through the wizard: a live
   * switch on an existing session, or folding the choice into the `new`-session
   * prompt waiting behind it.
   */
  const finalizeModelChoice = (
    dest: PickerDest,
    chosen: { provider: string | null; model: string | null },
    model: string,
    effort?: string,
  ): void => {
    if (dest.t === "newSession") {
      return show({
        t: "prompt",
        prompt: newPrompt(
          newSettings(state, chosen.provider, model || null, effort ?? null),
          dest.draft,
        ),
      });
    }
    if (dest.t !== "session")
      return show(
        unwind({
          t: "picker",
          picker: state.overlay.t === "picker" ? state.overlay.picker : ({} as Picker),
        }),
      );
    const id = dest.sessionId;
    // Came from a `send` prompt (⌥m/⌥t mid-message) → drop the user back into
    // it with the half-typed text intact once the switch is away.
    show(
      dest.back !== null
        ? { t: "prompt", prompt: sessionPrompt("send", id, "send", dest.back) }
        : browse,
    );
    const sess = sessionOf(id);
    const toProvider =
      chosen.provider !== null && sess !== undefined && chosen.provider !== sess.provider
        ? chosen.provider
        : null;
    const req = toProvider
      ? client.request("session.setProvider", {
          id,
          provider: toProvider,
          model,
          ...(effort ? { effort } : {}),
          by: client.clientId,
        })
      : client.request("session.setModel", { id, model, by: client.clientId });
    req
      .then(() => {
        if (toProvider) {
          dispatch({
            t: "notice",
            text: `provider → ${toProvider} · ${model}${effort ? ` · ${effort}` : ""}`,
            tone: "good",
          });
          return undefined;
        }
        if (!effort) {
          dispatch({ t: "notice", text: `model → ${model} · next turn`, tone: "good" });
          return undefined;
        }
        return client.request("session.setEffort", { id, effort, by: client.clientId }).then(
          () =>
            void dispatch({
              t: "notice",
              text: `model → ${model} · effort → ${effort} · next turn`,
              tone: "good",
            }),
        );
      })
      .catch((e: unknown) =>
        dispatch({
          t: "notice",
          text: `${toProvider ? "provider" : "model"} switch failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          tone: "bad",
        }),
      );
  };

  /** Resolve the open picker's highlighted item by its step. */
  const choosePicked = (): void => {
    if (state.overlay.t !== "picker") return;
    const p = state.overlay.picker;
    if (overlayActed === p) return;
    overlayActed = p;
    const cur = pickerCurrent(p);
    const dest = p.dest;
    const provider = cur && p.step === "provider" ? cur.id : p.chosen.provider;
    const model = cur && p.step === "model" ? cur.id : p.chosen.model;

    // An empty model / effort step: Enter continues without picking one. The
    // daemon falls back to the target provider's defaults (a model with no
    // enumerated effort levels never reaches an empty effort step).
    if (!cur && p.step !== "undo" && p.step !== "command") {
      if (dest.t === "planImpl") {
        return provider === null
          ? show({ t: "plan", plan: dest.plan })
          : stagePlanImpl(dest.plan, provider, model, null);
      }
      if (p.step === "effort") return finalizeModelChoice(dest, p.chosen, p.chosen.model ?? "");
      if (dest.t === "newSession") {
        return show({
          t: "prompt",
          prompt: newPrompt(newSettings(state, provider, model, null), dest.draft),
        });
      }
      return show(unwind({ t: "picker", picker: p }));
    }

    switch (p.step) {
      case "provider":
        // Provider chosen → always a model step.
        return openStep("model", dest, { provider, model: null }, p.from);

      case "model": {
        const pid = provider ?? "claude";
        if (model !== null && modelSupportsEffort(state, pid, model)) {
          return openStep("effort", dest, { provider: pid, model }, p.from);
        }
        if (dest.t === "planImpl") return stagePlanImpl(dest.plan, pid, model, null);
        return finalizeModelChoice(dest, { provider: pid, model }, model ?? "");
      }

      case "effort": {
        const effort = cur?.id ?? null;
        if (dest.t === "planImpl") {
          return stagePlanImpl(dest.plan, provider ?? "claude", model, effort);
        }
        return finalizeModelChoice(dest, p.chosen, model ?? "", effort ?? undefined);
      }

      case "undo": {
        const undoTurn = Number(cur?.id);
        const prefill = cur?.blob ?? "";
        const id = dest.t === "undo" ? dest.sessionId : null;
        show(browse);
        if (!id || !Number.isInteger(undoTurn)) return;
        client
          // `toTurn` is turns-to-keep: undoing turn T keeps T-1.
          .request("session.rewind", { id, toTurn: undoTurn - 1, by: client.clientId })
          .then(() => {
            dispatch({ t: "notice", text: `undid turn ${undoTurn}`, tone: "good" });
            // Reopen the compose prompt with that turn's message pre-filled, as
            // if you'd pressed Enter on the session — edit and re-send, or Esc.
            show({ t: "prompt", prompt: sessionPrompt("send", id, "send", prefill) });
          })
          .catch((e: unknown) =>
            dispatch({
              t: "notice",
              text: `undo failed: ${e instanceof Error ? e.message : String(e)}`,
              tone: "bad",
            }),
          );
        return;
      }

      case "command":
        // The command palette resolves in handleKey before choosePicked runs.
        return;

      default:
        return absurd(p.step);
    }
  };

  /** `⌃P` in the new-session prompt: pick the provider (skipped when there's
   *  only one), then the model, then land back on the prompt. */
  const pickProviderModel = (settings: NewSessionSettings, draft: string): void => {
    const dest: PickerDest = { t: "newSession", settings, draft };
    const provs = fleetProviders(state);
    if (provs.length > 1) {
      return openStep(
        "provider",
        dest,
        { provider: null, model: null },
        "provider",
        settings.provider,
      );
    }
    const only = provs[0]?.id ?? settings.provider ?? "claude";
    openStep("model", dest, { provider: only, model: null }, "model", settings.model);
  };

  /** The session a live `⌥m` / `⌥p` / `⌥t` acts on: an explicit id, or the
   *  selected row. */
  const switchTarget = (sessionId?: string): SessionSnapshot | null => {
    const s = sessionId ? sessionOf(sessionId) : selectedSession(state);
    if (!s) note("no session selected", "dim");
    return s ?? null;
  };

  /** Open a live model switcher (`⌥m`). From a `send` prompt, pass `draft` so
   *  the picker drops you back into it with the message intact. */
  const switchModel = (sessionId?: string, draft?: string): void => {
    const s = switchTarget(sessionId);
    if (!s) return;
    // Mid-probe the list is empty but coming — open the picker anyway; the
    // settle push fills it in (see rederiveOpenPicker).
    if (
      modelPickItems(state, s.provider).length === 0 &&
      !providerInfo(state, s.provider)?.modelsLoading
    ) {
      return note(`${s.provider} has no alternate models`, "dim");
    }
    openStep(
      "model",
      { t: "session", sessionId: s.id, back: draft ?? null },
      { provider: s.provider, model: null },
      "model",
    );
  };

  /** Open the provider → model → effort wizard for a *live* session (`⌥p`
   *  mid-chat): pre-select its current provider, so the choice finalizes as a
   *  `session.setProvider`. Falls back to the model switcher when there's only
   *  one provider to pick from. */
  const pickProviderModelForSession = (sessionId?: string, draft?: string): void => {
    const s = switchTarget(sessionId);
    if (!s) return;
    if (
      s.status.kind === "running" ||
      s.status.kind === "starting" ||
      s.status.kind === "working_background" ||
      s.status.kind === "awaiting_input"
    ) {
      return note("interrupt the turn before switching provider", "dim");
    }
    if (fleetProviders(state).length <= 1) return switchModel(s.id, draft);
    openStep(
      "provider",
      { t: "session", sessionId: s.id, back: draft ?? null },
      { provider: null, model: null },
      "provider",
      s.provider,
    );
  };

  /** Open a live thinking-effort switcher (`⌥t`) — only when the session's
   *  current model takes an effort level. There is no model list behind it, so
   *  `Esc` unwinds rather than stepping back. */
  const switchEffort = (sessionId?: string, draft?: string): void => {
    const s = switchTarget(sessionId);
    if (!s) return;
    if (!s.model || !modelSupportsEffort(state, s.provider, s.model)) {
      return note(
        `${s.provider}${s.model ? `/${s.model}` : ""} has no thinking-effort control`,
        "dim",
      );
    }
    openStep(
      "effort",
      { t: "session", sessionId: s.id, back: draft ?? null },
      { provider: s.provider, model: s.model },
      "effort",
    );
  };

  /**
   * `⇧⇥` cycles a live session's permission mode — from the fleet row or from
   * inside a `send` prompt. The chip updates immediately on every press so
   * cycling feels responsive regardless of round-trip time, but it moves a
   * *local draft* beside the snapshot, never the snapshot itself: the draft is
   * dropped once the RPC settles, so a rejected change falls back to whatever
   * the daemon actually reports rather than leaving the chip lying.
   *
   * The `session.setMode` RPC is debounced behind the draft, so only the mode
   * the presses settle on reaches the connector. Without that, a fast cycle
   * through to `auto` would still briefly apply `plan` as an intermediate stop
   * — and unlike the other three modes, `plan` has real side effects once it's
   * actually live (it flips the SDK session into plan mode, tools and all),
   * not just a permission level.
   */
  const cycleSessionMode = (sessionId: string): void => {
    const s = fleetSessions(state).find((x) => x.id === sessionId);
    if (!s) return void dispatch({ t: "notice", text: "session is gone", tone: "dim" });
    const target = nextMode(sessionMode(state, s) as SessionMode);
    dispatch({ t: "modeDraft", sessionId, mode: target });
    dispatch({ t: "notice", text: `mode → ${modeLabel(target)}`, tone: "good" });
    const prevTimer = modeDebounce.get(sessionId);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      modeDebounce.delete(sessionId);
      // The session was removed while the debounce sat idle — nothing to apply.
      if (!fleetSessions(state).some((x) => x.id === sessionId)) {
        dispatch({ t: "modeDraft", sessionId, mode: null });
        return;
      }
      modeInFlight.set(sessionId, (modeInFlight.get(sessionId) ?? 0) + 1);
      client
        .request("session.setMode", { id: sessionId, mode: target, by: client.clientId })
        .catch((e: unknown) => {
          const code =
            e instanceof Error && "code" in e ? (e as { code?: unknown }).code : undefined;
          if (code === "plan_pending") {
            // The mode never actually left `plan` — a pending `ExitPlanMode`
            // review has to be resolved through the real plan-review UI, not
            // silently answered by the chip. Dropping the draft (below) already
            // snaps the chip back to the `plan` the snapshot still reports;
            // open the review so there's no impossible "chip says X, the live
            // session is still parked on a plan" state to land in.
            const review = planReviewFor(sessionId);
            if (review) show({ t: "plan", plan: review });
            dispatch({
              t: "notice",
              text: "a plan review is pending — resolve it first",
              tone: "bad",
            });
            return;
          }
          dispatch({
            t: "notice",
            text: `mode switch failed: ${e instanceof Error ? e.message : String(e)}`,
            tone: "bad",
          });
        })
        // Settled either way: once nothing is outstanding the snapshot is the
        // truth about this session's mode, so the local draft has done its job.
        .finally(() => {
          const left = (modeInFlight.get(sessionId) ?? 1) - 1;
          if (left > 0) return void modeInFlight.set(sessionId, left);
          modeInFlight.delete(sessionId);
          dispatch({ t: "modeDraft", sessionId, mode: null });
        });
    }, 300);
    modeDebounce.set(sessionId, timer);
  };

  const submitPrompt = (): void => {
    const p = openPrompt(state.overlay);
    if (!p) return;
    // Nothing typed is submitted while the connection is down — including text
    // an `$EDITOR` handoff started before the drop just handed back. The prompt
    // stays open with it, to be sent (or abandoned) once the daemon answers.
    if (!connected()) {
      return note("not connected — your message is kept, press enter again once it is", "dim");
    }
    const text = p.buffer.text.trim();
    const by = client.clientId;
    const kind = promptKind(p);
    // `deny` and `compact` both treat an empty submit as a valid choice
    // (no reason / best-effort compaction); `comment` empty clears the note.
    // Every other prompt needs text.
    if (kind !== "deny" && kind !== "compact" && kind !== "comment" && !text) return;

    // A send typed while the target session is compacting: the daemon holds the
    // op gate for the whole (multi-minute) summarise and would reject with
    // `code:"busy"`. Reuse the outgoing queue instead — `drainQueues` releases
    // it on the first update after the snapshot stops reporting a compaction.
    // (`code:"busy"` is still caught below for a race.)
    const sendTo = p.t === "session" && p.kind === "send" ? p.sessionId : null;
    if (sendTo !== null && text && compactingFor(state, sendTo)) {
      queueSend(sendTo, text, "queued until compaction finishes");
      return;
    }

    const reopen = (): void =>
      show({ t: "prompt", prompt: { ...p, buffer: buffer(p.buffer.text), histIdx: 0, draft: "" } });

    dispatch({ t: "closePrompt" });

    const runSession = async (k: SessionPromptKind, sessionId: string): Promise<string> => {
      switch (k) {
        case "send": {
          // No local echo — the daemon emits a `user_message` event that every
          // client (this one included) renders. The RPC tells us whether it
          // actually landed mid-turn.
          const r = await client.request<{ injected?: boolean }>("session.send", {
            id: sessionId,
            text,
          });
          dispatch({ t: "pushHistory", text });
          // Quote a preview: mid-turn sends are easy to fire twice in a row,
          // and "injected" alone says neither which message landed nor that
          // it's queued behind the running tool call rather than lost.
          return r.injected
            ? `injected “${truncate(text.replace(/\s+/g, " ").trim(), 40)}” — lands after the current tool call`
            : "sent";
        }
        case "title":
          await client.request("session.setTitle", { id: sessionId, title: text, by });
          return "renamed";
        case "comment":
          await client.request("session.setComment", { id: sessionId, comment: text, by });
          return text ? "comment saved" : "comment cleared";
        case "compact":
          await client.request("session.compact", {
            id: sessionId,
            ...(text ? { instructions: text } : {}),
          });
          return text ? "compacting — focused" : "compacting context";
        default:
          return absurd(k);
      }
    };

    const runRequest = (
      k: RequestPromptKind,
      sessionId: string,
      requestId: string,
    ): Promise<string> =>
      interactions.respond(
        sessionId,
        requestId,
        k === "answer" ? { t: "answer", text } : { t: "deny", message: text },
      );

    /** Record this answer, then either move to the next unanswered question or
     *  resolve the whole `AskUserQuestion`. The questions come from the request
     *  itself and the progress from `qnav` — the prompt holds neither, so there
     *  is no stale copy to reconcile. */
    const runQuestions = async (sessionId: string, requestId: string): Promise<string> => {
      const fleet = fleetSessions(state);
      const q = questionState(fleet, state.qnav, sessionId);
      if (!q || q.requestId !== requestId) return "";
      const idx = Math.min(q.nav?.idx ?? 0, q.qs.length - 1);
      const answers = { ...q.nav?.answers, [q.qs[idx]!.question]: text };
      const missing = nextUnanswered(q.qs, answers, idx);
      if (missing !== -1) {
        openQuestionPrompt(sessionId, requestId, q.qs, answers, missing);
        return "";
      }
      return interactions.respond(sessionId, requestId, {
        t: "answers",
        request: requestsFor(fleet, sessionId).find((r) => r.id === requestId),
        answers,
      });
    };

    const run = async (): Promise<string> => {
      switch (p.t) {
        case "new": {
          const r = await client.request<SessionSnapshot>("session.create", {
            prompt: text,
            by,
            ...(p.settings.mode !== "default" ? { mode: p.settings.mode } : {}),
            ...(p.settings.provider ? { provider: p.settings.provider } : {}),
            ...(p.settings.model ? { model: p.settings.model } : {}),
            ...(p.settings.effort ? { effort: p.settings.effort } : {}),
          });
          dispatch({ t: "select", id: r.id });
          dispatch({ t: "pushHistory", text });
          // No local echo — the daemon emits a `user_message` for the opening
          // prompt too, so it's in the log for every client and after a reopen.
          return `started ${shortId(r.id)}`;
        }
        case "session":
          return runSession(p.kind, p.sessionId);
        case "request":
          return runRequest(p.kind, p.sessionId, p.requestId);
        case "questions":
          return runQuestions(p.sessionId, p.requestId);
        case "discuss": {
          const r = await client.request<{ alreadyResolved: boolean }>("session.respondPlan", {
            id: p.plan.sessionId,
            requestId: p.plan.requestId,
            action: "discuss",
            message: text,
            by,
          });
          // Answered — the review the prompt was holding open goes with it.
          show(browse);
          return r.alreadyResolved ? "plan already resolved" : "sent to the agent";
        }
        default:
          return absurd(p);
      }
    };

    run()
      .then((m) => m && note(m, "good"))
      .catch((e: unknown) => {
        // Lost the race with a compaction that started between the pre-check
        // above and the RPC — queue rather than error.
        if (sendTo !== null && text && (e as { code?: unknown })?.code === "busy") {
          queueSend(sendTo, text, "queued until compaction finishes");
          return;
        }
        // The connection dropped mid-request — the daemon may have run it to
        // completion. Don't reopen the prompt and don't retry (either invites a
        // double submit); the snapshot that lands on reconnect says what
        // actually happened, whichever way it went.
        if ((e as { code?: unknown })?.code === "disconnected") {
          note("connection dropped — the action may still be running", "bad");
          return;
        }
        note(e instanceof Error ? e.message : String(e), "bad");
        reopen(); // retryable — the text comes back so it can be edited and re-sent
      });
  };

  // ⌥⏎ on a `send` prompt targeting a running/starting session: queue for
  // turn end instead of the normal bare-⏎ "send now" path. Also reused when a
  // send is typed during a compaction (`why` overrides the status line).
  const queueSend = (sessionId: string, text: string, why = "queued for turn end"): void => {
    dispatch({ t: "closePrompt" });
    dispatch({
      t: "outbox",
      sessionId,
      box: enqueue(outboxOf(state.outbox, sessionId), text),
    });
    dispatch({ t: "pushHistory", text });
    dispatch({
      t: "echo",
      line: {
        ...echoLine(sessionId, text),
        glyph: "▸",
        tone: "dim",
        text: `queued: ${text.replace(/\s+/g, " ").trim()}`,
      },
    });
    note(why, "dim");
  };

  /** Resolve `pl` with `params` (an `action` plus any payload). */
  const respondPlan = (pl: PlanReview, params: Record<string, unknown>, label: string): void => {
    if (overlayActed === pl) return;
    overlayActed = pl;
    show(browse);
    client
      .request<{ alreadyResolved: boolean }>("session.respondPlan", {
        id: pl.sessionId,
        requestId: pl.requestId,
        by: client.clientId,
        ...params,
      })
      .then((r) => note(r.alreadyResolved ? "plan already resolved" : label, "good"))
      .catch((e: unknown) => {
        note(`${e instanceof Error ? e.message : String(e)} — reopening the plan`, "bad");
        // The daemon is still blocked on the decision; put the overlay back
        // (fresh object, so the latch passes) so it can be retried.
        show({ t: "plan", plan: { ...pl } });
      });
  };

  /** `f` in the plan overlay — implement fresh, honouring an `⌥p` retarget.
   *  Same provider (or none staged): the model / effort ride on the decision.
   *  A different provider: the daemon forks a fresh session on it and hands
   *  back its snapshot; select that and don't reopen the overlay. */
  const implementFresh = (pl: PlanReview): void => {
    if (overlayActed === pl) return;
    const impl = pl.impl;
    const forking = impl !== null && impl.provider !== sessionOf(pl.sessionId)?.provider;
    const params: Record<string, unknown> = {
      action: "implement_fresh",
      mode: pl.mode,
      ...(impl?.model ? { model: impl.model } : {}),
      ...(impl?.effort ? { effort: impl.effort } : {}),
      ...(forking && impl ? { provider: impl.provider, plan: pl.text } : {}),
    };
    if (!forking) return respondPlan(pl, params, "compacting, then implementing");
    overlayActed = pl;
    show(browse);
    client
      .request<SessionSnapshot>("session.respondPlan", {
        id: pl.sessionId,
        requestId: pl.requestId,
        by: client.clientId,
        ...params,
      })
      .then((snap) => {
        dispatch({ t: "select", id: snap.id });
        note(`forked to ${snap.provider} — implementing the plan`, "good");
      })
      .catch((e: unknown) => {
        note(`${e instanceof Error ? e.message : String(e)} — reopening the plan`, "bad");
        show({ t: "plan", plan: { ...pl } });
      });
  };

  /** `e` in the plan overlay — edit the plan in $EDITOR, then implement it. */
  const editPlan = async (pl: PlanReview): Promise<void> => {
    const edited = await openEditor(pl.text, { ext: "md" });
    const plan = edited?.trim();
    // No save, or quit-without-changes (`:q`) — don't kick off an implement.
    if (!plan || plan === pl.text.trim()) return note("plan unchanged — nothing sent", "dim");
    respondPlan(pl, { action: "revise", plan, mode: pl.mode }, "implementing your edited plan");
  };

  // ---- daemon lifecycle ---------------------------------------
  const confirmFor = (action: "restart" | "quitAll"): Confirm => {
    const liveCount = fleetSessions(state).filter((s) => isLiveState(s.status)).length;
    return {
      title: action === "restart" ? "Restart the daemon?" : "Quit the UI and stop the daemon?",
      ...(liveCount > 0
        ? { body: `${liveCount} live session${liveCount === 1 ? "" : "s"} will be interrupted.` }
        : {}),
      danger: action === "quitAll" || liveCount > 0,
      action,
    };
  };

  const confirmForDelete = (s: SessionSnapshot): Confirm => {
    const name = `“${(s.title ?? "").split("\n")[0]?.trim() || "untitled"}”`;
    const canBranch = !s.inPlace && !!s.branch;
    const dirty = s.git?.dirty === true;
    const what = canBranch
      ? "its worktree, stored transcript, and branch"
      : "its worktree and stored transcript";
    return {
      title: `Delete session ${shortId(s.id)}?`,
      body:
        `${name} — ${what} go too${dirty ? ", including uncommitted changes" : ""}.` +
        (canBranch ? " Press b to keep the branch." : ""),
      danger: true,
      action: "deleteSession",
      sessionId: s.id,
      ...(dirty ? { force: true } : {}),
      ...(canBranch ? { branchName: s.branch as string, deleteBranch: true } : {}),
    };
  };

  const runConfirm = (): void => {
    if (state.overlay.t !== "confirm") return;
    const c = state.overlay.confirm;
    if (overlayActed === c) return;
    overlayActed = c;
    show(browse);
    if (c.action === "deleteSession" && c.sessionId) {
      const id = c.sessionId;
      const alsoBranch = c.deleteBranch === true;
      client
        .request<{ removed: string; branchDeleted?: boolean }>("session.remove", {
          id,
          by: client.clientId,
          ...(alsoBranch ? { deleteBranch: true } : {}),
          ...(c.force ? { force: true } : {}),
        })
        .then((r) =>
          note(
            r.branchDeleted ? `deleted ${shortId(id)} + branch` : `deleted ${shortId(id)}`,
            "good",
          ),
        )
        .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"));
      return;
    }
    if (c.action === "archiveSession" && c.sessionId) {
      const id = c.sessionId;
      perform(async () => {
        await client.request("session.markDone", { id, by: client.clientId, force: true });
        return "archived — branch + chat kept";
      });
      return;
    }
    if (c.action === "gc") {
      perform(async () => {
        const r = await client.request<{
          removed: string[];
          failed: Array<{ id: string; error: string }>;
        }>("session.gc", {});
        const done = `removed ${r.removed.length} worktree${r.removed.length === 1 ? "" : "s"}`;
        if (r.failed.length === 0) return done;
        // A dirty worktree (no `force` is sent) or a live one shows up here.
        note(`${done} — ${r.failed.map((f) => `${shortId(f.id)}: ${f.error}`).join("; ")}`, "bad");
        return ""; // the failure note above already told the story
      });
      return;
    }
    if (c.action === "restart") {
      restarting = true;
      note("restarting daemon…", "dim");
      client.request("daemon.shutdown").catch(() => {}); // reconnect+autospawn bring a fresh one up
    } else {
      void (async () => {
        try {
          await client.request("daemon.shutdown");
        } catch {
          /* going down regardless */
        }
        await client.close().catch(() => {});
        term.exit();
      })();
    }
  };

  /**
   * Run a named action — the single dispatch point shared by the browse keymap
   * and the `Space` command palette. Session verbs and the always-on globals go
   * through {@link act}; the app / view / structural commands are handled here.
   */
  const runAct = (name: ActName): void => {
    if (!connected() && !OFFLINE_ACTS.has(name)) {
      return note("not connected — nothing to act on until the daemon answers", "dim");
    }
    const sel = selectedSession(state);
    const allowed = allowedActs(sel);
    switch (name) {
      case "viewlog":
        return void viewInEditor();
      case "logs":
        return void viewLogs();
      case "doctor":
        return void openDoctor();
      case "model":
        return void switchModel();
      case "effort":
        return void switchEffort();
      case "provider":
        return void pickProviderModelForSession();
      case "theme":
        return void dispatch({ t: "toggleTheme" });
      case "restart":
        return void show({ t: "confirm", confirm: confirmFor("restart") });
      case "quitall":
        return void show({ t: "confirm", confirm: confirmFor("quitAll") });
      case "gc": {
        // A bulk sweep — every done session's worktree goes (branches and rows
        // stay). Behind a confirm like `X`, since it deletes directories.
        const targets = fleetSessions(state).filter((s) => s.status.kind === "done" && s.worktree);
        if (targets.length === 0)
          return void dispatch({
            t: "notice",
            text: "nothing to gc — no done sessions with worktrees",
            tone: "dim",
          });
        return void show({
          t: "confirm",
          confirm: {
            title: "Run gc?",
            body: `The worktrees of ${targets.length} done session${targets.length === 1 ? "" : "s"} go away — session rows and branches are kept.`,
            danger: true,
            action: "gc",
          },
        });
      }
      case "delete":
        return void (sel ? show({ t: "confirm", confirm: confirmForDelete(sel) }) : undefined);
      case "copybranch": {
        if (!sel) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
        const nm =
          sel.branch ?? (sel.worktree ? (sel.worktree.split("/").pop() ?? sel.worktree) : sel.id);
        return copyToClipboard(nm, nm);
      }
      case "clearqueue": {
        const box = sel && outboxOf(state.outbox, sel.id);
        if (!box || pending(box).length === 0) {
          return void dispatch({ t: "notice", text: "no queued messages to clear", tone: "dim" });
        }
        return void dispatch({ t: "outbox", sessionId: sel.id, box: cleared(box) });
      }
      case "fork": {
        if (!sel) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
        if (isClaudeId(sel.provider)) {
          return void dispatch({
            t: "notice",
            text: "hard fork isn't available for Claude sessions yet",
            tone: "dim",
          });
        }
        if (sel.inPlace) {
          return void dispatch({
            t: "notice",
            text: "hard fork needs a worktree — this session runs in-place",
            tone: "dim",
          });
        }
        if (sel.status.kind === "awaiting_input") {
          return void dispatch({
            t: "notice",
            text: "answer the pending request first",
            tone: "dim",
          });
        }
        client
          .request<SessionSnapshot>("session.fork", { id: sel.id, by: client.clientId })
          .then((r) => {
            dispatch({ t: "select", id: r.id });
            dispatch({ t: "notice", text: `forked → ${shortId(r.id)}`, tone: "good" });
          })
          .catch((e: unknown) =>
            dispatch({
              t: "notice",
              text: `fork failed: ${e instanceof Error ? e.message : String(e)}`,
              tone: "bad",
            }),
          );
        return;
      }
      case "approve":
      case "deny":
      case "answer":
      case "send":
      case "interrupt":
      case "done":
      case "compact":
      case "keepwarm":
      case "rebase":
      case "planreview":
      case "mode":
      case "undo":
      case "title":
      case "comment":
      case "new":
      case "find":
      case "filter":
      case "help":
      case "quit":
        // Globals are always allowed; session verbs are gated by the selected
        // session's state (the set the keymap / palette also check).
        if (GLOBAL_ACTS.has(name) || allowed.has(name)) act(name);
        return;
      default:
        return absurd(name);
    }
  };

  // ---- keymap -----------------------------------------------
  const handleKey = (input: string, key: Key): void => {
    const sel = selectedSession(state);
    const allowed = allowedActs(sel);
    const { logPage } = store.get();

    if (key.ctrl && input === "c") return quitTui();

    // A held readline motion whose repeats Ink coalesced into one chunk (see
    // REPEATABLE_CTRL): replay it as N discrete ⌃<letter> presses so the motion
    // repeats the way a held Backspace or arrow already does. Only where an
    // input line is actually taking the motions — the prompt, a picker filter,
    // the fleet filter. The replayed presses are length-1, so this never
    // re-enters.
    const onInputLine =
      state.overlay.t === "prompt" || state.overlay.t === "picker" || !!state.find;
    if (
      onInputLine &&
      input.length > 1 &&
      !key.ctrl &&
      !key.meta &&
      [...input].every((c) => REPEATABLE_CTRL.has(c.charCodeAt(0)))
    ) {
      for (const c of input) {
        handleKey(String.fromCharCode(c.charCodeAt(0) + 0x60), { ...key, ctrl: true });
      }
      return;
    }

    // SGR mouse reports arrive as raw `input` (`[<Cb;Cx;Cy(M|m)`, `run.tsx` turns
    // the reporting on) with every `key.*` flag false. The wheel scrolls the
    // plan-review body while that overlay owns the screen, otherwise the event
    // log; a left click hit-tests against the frame's `hits` map — FLEET rows and
    // the Detail `[mode]` chip (built in `deriveView`).
    const mouse = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(input);
    if (mouse) {
      const rawBtn = Number(mouse[1]);
      const col = Number(mouse[2]);
      const row = Number(mouse[3]);
      const base = rawBtn & ~(4 | 8 | 16); // strip shift/meta/ctrl bits
      if (state.overlay.t === "plan") {
        if (base === 64) return planScrollBy(-3); // wheel up → toward the top
        if (base === 65) return planScrollBy(3); // wheel down → toward the end
        return;
      }
      if (base === 64) {
        return scrollUp(3); // wheel up → back in history
      }
      if (base === 65) {
        logScroll = Math.max(0, logScroll - 3); // wheel down → toward live tail
        return publish();
      }
      // Left press (final `M`, not a release; bit 32 = drag) → click a FLEET row
      // or the mode chip. Only in browse — overlays own the screen.
      if (base === 0 && mouse[4] === "M" && (rawBtn & 32) === 0 && state.overlay.t === "browse") {
        const hit = store.get().hits.find((h) => row === h.y && col >= h.x0 && col <= h.x1);
        if (!hit) return;
        if (hit.kind === "session") return void dispatch({ t: "select", id: hit.id });
        if (hit.kind === "child")
          return void dispatch({ t: "selectChild", sessionId: hit.sessionId, key: hit.key });
        if (hit.kind === "childMore") {
          dispatch({ t: "select", id: hit.sessionId });
          return void dispatch({ t: "childEnter" });
        }
        if (hit.kind === "mode") return void runAct("mode");
        return;
      }
      return; // release / middle / right / drag / horizontal wheel — ignore
    }

    const openP = openPrompt(state.overlay);
    if (openP) {
      const p = openP;
      // The live session a `send` prompt is composing at — the only prompt whose
      // ⌥ actions retarget an existing session rather than the one being made.
      const sendTo = p.t === "session" && p.kind === "send" ? p.sessionId : null;
      // ⌥-prefixed prompt actions — "step out to a bigger tool" without losing
      // what's typed. Ctrl is reserved for readline motions (applyKey).
      if (key.meta && input === "e") return void editPrompt();
      if (key.meta && input === "o") {
        // A new-session prompt has no session and no log to open yet.
        return void (p.t === "new"
          ? dispatch({
              t: "notice",
              text: "no log yet — you're starting a new session",
              tone: "dim",
            })
          : viewInEditor());
      }
      // ⇧⇥ cycles the permission mode without leaving the prompt.
      if (key.tab && key.shift) {
        if (p.t === "new") return void dispatch({ t: "promptCycleMode" });
        if (sendTo) return void cycleSessionMode(sendTo);
        return;
      }
      // ⌥m swaps the model without leaving the prompt.
      if (key.meta && input === "m") {
        if (p.t === "new") {
          const pid = p.settings.provider ?? defaultProviderId(state);
          return void openStep(
            "model",
            { t: "newSession", settings: p.settings, draft: p.buffer.text },
            { provider: pid, model: null },
            "model",
            p.settings.model,
          );
        }
        if (sendTo) return void switchModel(sendTo, p.buffer.text);
        return;
      }
      // ⌥t swaps the thinking-effort level without leaving the prompt.
      if (key.meta && input === "t") {
        if (p.t === "new") {
          const pid = p.settings.provider ?? defaultProviderId(state);
          const mid = p.settings.model || defaultModelOf(state, pid);
          if (!mid || !modelSupportsEffort(state, pid, mid)) {
            return void note("this model has no thinking-effort control", "dim");
          }
          return void openStep(
            "effort",
            { t: "newSession", settings: p.settings, draft: p.buffer.text },
            { provider: pid, model: mid },
            "effort",
            p.settings.effort,
          );
        }
        if (sendTo) return void switchEffort(sendTo, p.buffer.text);
        return;
      }
      if (key.meta && input === "p") {
        if (p.t === "new") return void pickProviderModel(p.settings, p.buffer.text);
        if (sendTo) return void pickProviderModelForSession(sendTo, p.buffer.text);
        return;
      }
      if (key.meta && input === "x" && sendTo) {
        const box = outboxOf(state.outbox, sendTo);
        return void dispatch({ t: "outbox", sessionId: sendTo, box: cleared(box) });
      }
      // ⌥⏎ while the target is still working queues for turn end instead of its
      // usual "insert a newline" meaning; bare ⏎ below sends now regardless.
      if (key.meta && key.return && sendTo) {
        const target = fleetSessions(state).find((x) => x.id === sendTo);
        if (
          target &&
          (target.status.kind === "running" ||
            target.status.kind === "starting" ||
            target.status.kind === "working_background")
        ) {
          const text = p.buffer.text.trim();
          return void (text && queueSend(sendTo, text));
        }
      }
      const res = applyKey(p.buffer, input, key);
      switch (res.kind) {
        case "cancel":
          // Esc on an AskUserQuestion answer drops back to the request panel
          // (the daemon stays blocked) rather than abandoning the whole call:
          // answers gathered so far — including whatever is typed now — stay in
          // `qnav`, so ← / → can move to another question and `a` resumes where
          // you left off.
          if (p.t === "questions") {
            const q = questionState(fleetSessions(state), state.qnav, p.sessionId);
            if (q && q.requestId === p.requestId) {
              const idx = Math.min(q.nav?.idx ?? 0, q.qs.length - 1);
              const answers = { ...q.nav?.answers };
              if (p.buffer.text.trim() !== "") answers[q.qs[idx]!.question] = p.buffer.text;
              dispatch({
                t: "qnavSet",
                nav: { sessionId: p.sessionId, requestId: p.requestId, idx, answers },
              });
            }
            return void dispatch({ t: "closePrompt", saveDraft: false });
          }
          return void dispatch({ t: "closePrompt", saveDraft: true });
        case "submit":
          promptSubmittedAt = Date.now();
          return void submitPrompt();
        case "buffer":
          return void dispatch({ t: "promptSet", buffer: res.buffer });
        case "history":
          return void dispatch({ t: "promptHistoryNav", dir: res.dir });
        case "ignore":
          return;
        default:
          return absurd(res);
      }
    }
    if (state.overlay.t === "plan") {
      const pl = state.overlay.plan;
      // PgUp/PgDn scroll the plan body (a page ≈ the visible window less a row);
      // the mouse wheel is handled up top, `o` still opens it in $EDITOR.
      if (key.pageDown) return void planScrollBy(15);
      if (key.pageUp) return void planScrollBy(-15);
      // ⇧⇥ cycles the mode the implementation will run in.
      if (key.tab && key.shift) return void dispatch({ t: "cyclePlanMode" });
      // ⌥p retargets model / effort / provider for `f` (implement fresh).
      if (key.meta && input === "p") return void openPlanRetarget(pl);
      // i / f / e implement in the overlay's chosen mode; `d` (discuss) only
      // sends a note back, so it carries none.
      if (input === "i") {
        return respondPlan(pl, { action: "implement", mode: pl.mode }, "implementing the plan");
      }
      if (input === "f") return void implementFresh(pl);
      if (input === "e") return void editPlan(pl);
      // `o` / `⌥o` — view the plan in $EDITOR, read-only.
      if (input === "o" || (key.meta && input === "o")) {
        return void openEditor(pl.text, { ext: "md" });
      }
      // The discuss prompt carries the review, so Esc out of it puts this exact
      // overlay back — cycled mode and staged retarget included.
      if (input === "d") return void show({ t: "prompt", prompt: discussPrompt(pl) });
      // esc backs out to the fleet without answering — the daemon stays blocked
      // on the decision, the request panel keeps its prompt, and `a` re-opens.
      if (key.escape) return void show(browse);
      return; // everything else: a plan review must still be answered
    }

    if (state.overlay.t === "confirm") {
      if (key.return) return runConfirm();
      if (input === "b" && state.overlay.confirm.branchName) {
        return void dispatch({ t: "toggleConfirmBranch" });
      }
      if (key.escape || input === "q" || input === "n") return void show(browse);
      return;
    }

    if (state.overlay.t === "help") {
      if (input === "?" || input === "q" || key.escape) show(browse);
      return;
    }

    if (state.overlay.t === "doctor") {
      if (input === "q" || key.escape) show(browse);
      return;
    }

    if (state.overlay.t === "picker") {
      const p = state.overlay.picker;
      if (key.escape) return void show(escapePicker(p, state));
      if (key.upArrow) return void dispatch({ t: "pickerMove", delta: -1 });
      if (key.downArrow) return void dispatch({ t: "pickerMove", delta: 1 });
      if (key.return) {
        // The command palette runs an action through the shared dispatcher; the
        // provider / model / undo pickers resolve by step in choosePicked.
        if (p.step === "command") {
          if (overlayActed === p) return; // batched double-Enter guard
          overlayActed = p;
          const cur = pickerCurrent(p);
          show(browse);
          if (cur) runAct(cur.id as ActName);
          return;
        }
        return void choosePicked();
      }
      // The filter is an input line — the same readline motions as the prompt
      // (⌃a/⌃e/⌃b/⌃f/⌃u/⌃k/⌃w, ←/→, paste at the caret); esc / ⏎ / ↑ / ↓ were
      // resolved above, before the editor saw them.
      const res = applyKey(p.filter, input, key, { multiline: false });
      if (res.kind === "buffer") return void dispatch({ t: "pickerFilter", buffer: res.buffer });
      return; // submit / cancel / history / ignore — all resolved above
    }

    // ---- browse ----

    // The fleet filter is up: typing edits it (a single line, no history); ↑/↓,
    // PgUp/PgDn and Home/End fall through — the selection and the log keep
    // working. ⏎ accepts (and keeps ⏎'s fleet-row meaning below); esc clears.
    if (state.find) {
      if (key.escape) return void dispatch({ t: "closeFind" });
      if (key.return) dispatch({ t: "closeFind" });
      else if (
        !key.upArrow &&
        !key.downArrow &&
        !key.pageUp &&
        !key.pageDown &&
        !key.home &&
        !key.end
      ) {
        const res = applyKey(state.find.buffer, input, key, { multiline: false });
        if (res.kind === "buffer") return void dispatch({ t: "findSet", buffer: res.buffer });
        return; // unbound modified keys — ignore
      }
    }
    if (key.pageUp) {
      return scrollUp(Math.max(1, logPage - 1));
    }
    if (key.pageDown) {
      logScroll = Math.max(0, logScroll - Math.max(1, logPage - 1));
      return publish();
    }
    // Home → the oldest line held (scrollUp clamps at the top and prefetches the
    // next older history page as it lands there); End → back to the live tail.
    if (key.home) {
      return scrollUp(shownLogRows());
    }
    if (key.end) {
      logScroll = 0;
      // Paging back far enough evicts the newest end of the window, and live
      // entries stop being folded in while that is true. Jumping to the tail is
      // the action that undoes it: drop the older window and refetch the newest
      // page, which resumes following.
      if (sel && !transcriptFor(state, sel.id).following) {
        dispatch({ t: "transcriptFollow", sessionId: sel.id });
        loadHistory();
        return;
      }
      return publish();
    }
    // ← / → move between the questions of a pending AskUserQuestion (the panel
    // previews whichever is selected; `a` answers it). Only while parked on a
    // multi-question call — otherwise the arrows drill into children, below.
    if (key.leftArrow || key.rightArrow) {
      const q = questionState(fleetSessions(state), state.qnav, sel?.id);
      if (q && q.qs.length > 1) {
        const cur = Math.min(q.nav?.idx ?? 0, q.qs.length - 1);
        const idx = (cur + (key.leftArrow ? q.qs.length - 1 : 1)) % q.qs.length;
        return void dispatch({
          t: "qnavSet",
          nav: { sessionId: sel!.id, requestId: q.requestId, idx, answers: q.nav?.answers ?? {} },
        });
      }
    }
    // Fleet drill-down: → enters the selected session's child rows (its live
    // background tasks + sub-agents — the tree already rendered under the row);
    // ↑/↓ then pick among them and the event pane follows the focused child.
    // ← / esc steps back out to the fleet. Other keys keep acting on the
    // session — children carry no actions of their own. The fleet toggle is on
    // ⇥ (below), not the arrows, so this is unchanged at every width.
    if (key.rightArrow || input === "l") {
      if (sel) dispatch({ t: "childEnter" });
      return;
    }
    if (key.leftArrow || input === "h") {
      if (state.selectedChild != null) dispatch({ t: "childExit" });
      return;
    }
    if (state.selectedChild != null) {
      if (key.upArrow || input === "k") return void dispatch({ t: "childMove", delta: -1 });
      if (key.downArrow || input === "j") return void dispatch({ t: "childMove", delta: 1 });
    }
    if (key.upArrow || input === "k") return void dispatch({ t: "move", delta: -1 });
    if (key.downArrow || input === "j") return void dispatch({ t: "move", delta: 1 });
    // ⇧⇥ cycles the permission mode; plain ⇥ toggles the fleet list — the
    // overview split ↔ the session's detail + events (see {@link LayoutView}).
    if (key.tab && key.shift) return void (sel ? runAct("mode") : undefined);
    if (key.tab) {
      if (sel) {
        layoutView = layoutView === "session" ? "overview" : "session";
        publish();
      }
      return;
    }
    if (key.escape) {
      // A single step back: the session view → overview, then out of a drill-down.
      if (layoutView !== "overview") {
        layoutView = "overview";
        publish();
      } else if (state.selectedChild != null) {
        dispatch({ t: "childExit" });
      }
      return;
    }
    // Enter on a fleet row = act on it — unless a prompt submit just fired in
    // the same input chunk (U5).
    if (key.return) {
      if (Date.now() - promptSubmittedAt < 100) return;
      if (allowed.has("send")) return runAct("send");
      if (allowed.has("answer")) return runAct("answer");
      if (allowed.has("planreview")) return runAct("planreview");
      return;
    }
    // ⌥m switches the selected session's model, ⌥t its thinking-effort level —
    // the Alt keys that also act from the fleet view (their sibling ⇧⇥ does
    // the same for the mode).
    if (key.meta && input === "m") return void (sel ? runAct("model") : undefined);
    if (key.meta && input === "t") return void (sel ? runAct("effort") : undefined);
    if (key.meta && input === "p")
      return void (sel ? pickProviderModelForSession(sel.id) : undefined);
    if (key.ctrl || key.meta) return; // Ctrl / Alt otherwise do nothing outside the prompt

    // Space → the command palette.
    if (input === " ") {
      return void show({
        t: "picker",
        picker: makePicker({
          step: "command",
          title: "commands",
          items: commandsFor(state),
          dest: { t: "command" },
        }),
      });
    }

    // Shift = the heavier / structural sibling of its lowercase.
    if (input === "Q") return runAct("quitall");
    if (input === "R") return runAct("restart");
    if (input === "X") return runAct("delete");
    if (input === "F") return runAct("fork");

    if (input === "q") return quitTui();

    // `a` resolves to whichever request the session has parked on.
    let aKey: ActName = "approve";
    if (allowed.has("answer")) aKey = "answer";
    else if (allowed.has("planreview")) aKey = "planreview";

    const map: Record<string, ActName> = {
      a: aKey,
      d: "deny", // deny-only now — never delete (that's X)
      i: "interrupt",
      x: "done",
      c: "compact",
      r: "rebase", // any worktree session; a no-op "already current" when not behind
      u: "undo",
      e: "title",
      y: "copybranch",
      o: "viewlog",
      v: "filter",
      t: "theme",
      n: "new",
      "/": "find",
      "?": "help",
    };
    const chosen = map[input];
    if (chosen) return runAct(chosen);
  };

  const effectStart = (): (() => void) => {
    log?.info("start", {
      ui: LOOM_VERSION,
      daemon: client.daemonInfo?.version ?? null,
      pid: client.daemonInfo?.pid ?? null,
    });
    void reconcileVersion();

    const offs = [
      // Live entries first: `subscribe` fires synchronously with the current
      // state, which is what starts the selected session's head fetch. An entry
      // landing between that fetch going out and this listener being installed
      // would belong to neither source and simply be missing.
      client.onPush((frame) => dispatch({ t: "push", frame })),
      // The one authoritative feed: every fleet change arrives as a complete
      // snapshot, so there is nothing to reconcile, merge or refetch.
      client.subscribe((s) => dispatch({ t: "state", state: s })),
      client.on("reconnect", () => {
        log?.info("daemon reconnected");
        // The caches were cleared and the generation bumped when the connection
        // dropped (see `applyClientState`); the refetch of the selected
        // session's newest page and the scroll reset both follow from that in
        // `dispatch`, so there is nothing about history to do here.
        if (restarting) {
          restarting = false;
          dispatch({ t: "notice", text: "daemon restarted", tone: "good" });
        }
        void reconcileVersion();
      }),
      client.on("resync", () => {
        log?.info("resync");
        // The stream rolled past our seq without the connection dropping, so
        // nothing else resets the caches: entries in the gap never arrived and
        // the transcript would hold a hole it cannot see.
        dispatch({ t: "transcriptReset" });
      }),
      term.onResize(() => {
        dims = term.getSize();
        publish();
      }),
    ];

    const iv = setInterval(() => {
      // Only spend a frame when something is actually animating — a spinner
      // row, a live compaction, or a notice waiting to expire. An idle fleet
      // otherwise re-renders ~8×/s for nothing.
      const animating =
        state.notice !== null ||
        anyCompacting(state) ||
        fleetSessions(state).some(
          (s) =>
            s.status.kind === "running" ||
            s.status.kind === "starting" ||
            s.status.kind === "working_background",
        );
      if (!animating) return;
      if (transcriptFor(state, state.selectedId).lines.length > 3) tick = (tick + 1) % 100000;
      dispatch({ t: "expireNotice", now: Date.now() });
      publish(); // the tick bump alone needs a frame (spinner) even if nothing expired
    }, 120);

    return () => {
      clearInterval(iv);
      for (const off of offs) off();
    };
  };

  /**
   * The daemon should be invisible: if it's an older build than this UI, bounce
   * it once — `daemon.shutdown` + the client's reconnect/autospawn brings up a
   * fresh one. But a restart interrupts every attached client and running turn,
   * so when another client or a live session is present we ask first. A second
   * mismatch after that just nags.
   */
  const reconcileVersion = async (): Promise<void> => {
    const dv = client.daemonInfo?.version;
    if (restarting || !dv || dv === LOOM_VERSION) return;

    let otherClients = 0;
    let liveSessions = 0;
    try {
      const st = await client.request<{ connections?: number; runningSessions?: number }>(
        "daemon.status",
      );
      otherClients = Math.max(0, (st.connections ?? 1) - 1); // minus this UI's own socket
      liveSessions = st.runningSessions ?? 0;
    } catch {
      /* old daemon without these fields → treat as safe to bounce */
    }

    const action = versionMismatchAction({
      daemonVersion: dv,
      uiVersion: LOOM_VERSION,
      otherClients,
      liveSessions,
      alreadyHandled: versionRestartTried,
    });
    log?.info("version mismatch", {
      daemon: dv,
      ui: LOOM_VERSION,
      otherClients,
      liveSessions,
      action,
    });
    if (action === "ok") return;

    if (action === "nag") {
      dispatch({
        t: "notice",
        text: `daemon v${dv} ≠ ui v${LOOM_VERSION} — press R to restart it once the others are done`,
        tone: "bad",
      });
      return;
    }

    if (action === "prompt") {
      versionRestartTried = true;
      const who = [
        otherClients > 0 ? `${otherClients} other client${otherClients === 1 ? "" : "s"}` : "",
        liveSessions > 0 ? `${liveSessions} live session${liveSessions === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" and ");
      show({
        t: "confirm",
        confirm: {
          title: `Daemon is v${dv}, this UI is v${LOOM_VERSION}`,
          body: `${who} attached — restarting interrupts them. Esc keeps the old daemon (this UI may misbehave); press R to restart later.`,
          danger: true,
          action: "restart",
        },
      });
      return;
    }

    // action === "auto-restart"
    versionRestartTried = true;
    restarting = true;
    dispatch({
      t: "notice",
      text: `daemon v${dv} ≠ ui v${LOOM_VERSION} — respawning`,
      tone: "dim",
    });
    client.request("daemon.shutdown").catch(() => {});
  };

  return {
    subscribe: store.subscribe,
    getView: store.get,
    handleKey,
    effectStart,
  };
};
