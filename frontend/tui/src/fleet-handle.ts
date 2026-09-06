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
import type { LoomClient } from "@loom/client";
import { makeLogger } from "@loom/core/logger";
import type { DoctorReport, EventPush, SessionSnapshot } from "@loom/core/wire";
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
import {
  fleetProviders,
  fleetSessions,
  sessionMode,
  allowedActs,
  backfillAdds,
  commandsFor,
  cycleLogFilter,
  defaultModeOf,
  defaultModelOf,
  defaultProviderId,
  effortPickItems,
  escapeTarget,
  firstPerm,
  fleetHits,
  focusedPending,
  initialState,
  liveQNav,
  LOG_CAP,
  makePicker,
  makePrompt,
  modelPickEmptyText,
  modelPickItems,
  modelSupportsEffort,
  parseAskUserQuestions,
  pendingFor,
  pickerCurrent,
  promptOnPane,
  providerAccountOf,
  providerInfo,
  providerPickItems,
  queueFor,
  reduce,
  selectedSession,
  sessionLog,
  transcriptText,
  versionMismatchAction,
  type ActName,
  type Action,
  type AskUserQuestionItem,
  type ConfirmState,
  type FleetHit,
  type LogLine,
  type Pending,
  type PickerState,
  type PromptState,
  type QNav,
  type TuiState,
} from "./model.ts";

/** Footer label for the `answerQuestion` prompt: the current question's short
 *  `header` chip, plus `N/total` progress when the `AskUserQuestion` call asked
 *  more than one question. `idx` is the 0-based position in `all`. */
const questionPromptLabel = (all: AskUserQuestionItem[], idx: number): string => {
  const tag = all[idx]?.header || "answer";
  return all.length > 1 ? `answer ${idx + 1}/${all.length}: ${tag}` : `answer: ${tag}`;
};

/** The answer prompt for question `idx` of an `AskUserQuestion`, prefilled from
 *  whatever's been gathered so far (`answers`, keyed by question text). `idx` is
 *  clamped to the question count. */
const answerQuestionPrompt = (
  sessionId: string,
  requestId: string,
  qs: AskUserQuestionItem[],
  answers: Record<string, string>,
  idx: number,
): PromptState => {
  const at = Math.max(0, Math.min(qs.length - 1, idx));
  return makePrompt({
    kind: "answerQuestion",
    sessionId,
    requestId,
    label: questionPromptLabel(qs, at),
    text: answers[qs[at]!.question] ?? "",
    qaAll: qs,
    qaIdx: at,
    qaAnswers: answers,
  });
};

/** The `AskUserQuestion` a session is parked on, if any — its request id and
 *  parsed questions, plus the live {@link QNav} for it (answers gathered so
 *  far, which question is in view). */
const questionState = (
  state: TuiState,
  sessionId: string | null | undefined,
): { requestId: string; qs: AskUserQuestionItem[]; nav: QNav | null } | null => {
  if (!sessionId) return null;
  const fp = firstPerm(pendingFor(state, sessionId));
  if (fp?.tool !== "AskUserQuestion") return null;
  const qs = parseAskUserQuestions(fp.input);
  if (qs.length === 0) return null;
  return { requestId: fp.id, qs, nav: liveQNav(state.qnav, sessionId, fp.id) };
};

/** The whole `AskUserQuestion` call as a readable sheet for the `o` / `⌥o`
 *  editor view — each question numbered when there's more than one, its options
 *  lettered `a) … b) …` with descriptions, mirroring the request panel. Beats
 *  dumping the raw tool JSON. */
const formatQuestionsForEditor = (qs: AskUserQuestionItem[]): string =>
  qs
    .map((q, qi) => {
      const head = qs.length > 1 ? `${qi + 1}. ${q.question}` : q.question;
      const opts = q.options.map((o, oi) => {
        const letter = String.fromCharCode(97 + oi);
        return `   ${letter}) ${o.label}${o.description ? ` — ${o.description}` : ""}`;
      });
      return [head, ...opts].join("\n");
    })
    .join("\n\n")
    .concat("\n");

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

/** Modes that arm the batched-input latch ({@link overlayActed}). */
const OVERLAY_MODES = new Set<TuiState["mode"]>(["confirm", "plan", "picker"]);

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

/** Which body the layout draws — the overlay modes each own the screen.
 *  `fleetOnly` is the narrow `overview` (the fleet list alone); `sessionPane`
 *  is the `session` view at any width, and `split` the wide `overview`. */
export type BodyKind =
  | "help"
  | "doctor"
  | "confirm"
  | "plan"
  | "picker"
  | "split"
  | "fleetOnly"
  | "sessionPane";

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
  readonly pend: Pending;
  readonly allowed: ReadonlySet<ActName>;
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

export interface MkFleetHandleInput {
  readonly client: LoomClient;
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
  // The request panel shows what the turn is parked on. `pending` is
  // reconstructed from the event stream and can hold stale entries (a plan
  // approved elsewhere never emits a clearing event), so narrow it to the
  // daemon's own answer for what's outstanding.
  const pend = sel
    ? focusedPending(
        pendingFor(state, sel.id),
        sel.status.kind === "awaiting_input" ? sel.status.on : null,
      )
    : {};
  const allowed = allowedActs(sel);

  // The approve / answer / plan panel sits full-width just above the footer in
  // both layout views; every overlay owns the screen.
  const showRequest =
    (state.mode === "browse" || state.mode === "prompt") &&
    sel?.status.kind === "awaiting_input" &&
    (firstPerm(pend) !== undefined || pend.question !== undefined || pend.plan !== undefined);

  // Never floor these above the real terminal size: the whole frame is laid
  // out at exactly `cols` × `rows`, and a frame wider/taller than the terminal
  // soft-wraps or scrolls — Ink's repaints then drift and the top bar slides
  // off the alt screen. Tiny terminals degrade; they don't corrupt.
  const cols = Math.max(1, dims.cols);
  const rows = Math.max(1, dims.rows);
  const footerH = promptRows(state, cols);
  // Which question the request panel previews: the one the answer prompt is
  // collecting, else the one `qnav` last left the browse-mode selection on. The
  // panel sizes itself to fit it (see `requestPanelRows`), so this has to be
  // settled before the row budget.
  const questionIdx =
    state.mode === "prompt" && state.prompt?.kind === "answerQuestion"
      ? (state.prompt.qaIdx ?? 0)
      : (liveQNav(state.qnav, sel?.id, firstPerm(pend)?.id)?.idx ?? 0);
  const requestH = showRequest ? requestPanelRows(pend, cols, questionIdx) : 0;

  // Below this width the three-column split starves every column (~20 cols each
  // on a phone-sized SSH window), so `overview` is the fleet list alone — the
  // detail + events panes wait for `⇥`.
  const narrow = cols < NARROW_COLS;

  let body: BodyKind = "split"; // wide `overview`
  if (state.mode === "help") body = "help";
  else if (state.mode === "doctor") body = "doctor";
  else if (state.mode === "confirm" && state.confirm) body = "confirm";
  else if (state.mode === "plan" && state.plan) body = "plan";
  else if (state.mode === "picker" && state.picker) body = "picker";
  else if (layoutView === "session") body = "sessionPane";
  else if (narrow) body = "fleetOnly";

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
  const detailAccount = sel ? providerAccountOf(state, sel.provider) : "";
  const detailH = detailRows(sel, {
    account: detailAccount,
    compacting: sel ? (state.compacting[sel.id] ?? null) : null,
    queued: sel ? queueFor(state, sel.id) : [],
  });
  // The `session` view gives Detail + events the whole terminal; the wide
  // `overview` split confines them to the right column.
  const eventsW = body === "sessionPane" ? cols : rightW;
  // A session-targeted prompt draws its input group under the EVENTS log (its
  // label + editor rows) — budget them against the log's height.
  const paneH = promptOnPane(state.prompt) ? promptPaneRows(state, eventsW) : 0;
  const splitLogH = Math.max(4, bodyH - detailH - 1 - paneH);
  const logPage = Math.max(1, splitLogH - 3);

  // Clickable regions — screen coordinates the keymap's mouse branch hit-tests
  // against. The body starts at screen row 2 (Header is one row); Ink clips the
  // fleet list past `bodyH + 1`.
  const hits: FleetHit[] = [];
  const fleetGeom = { originX: 1, originY: 2, maxY: bodyH + 1 };
  if (body === "split") {
    hits.push(...fleetHits(state, { ...fleetGeom, listW: leftW }));
    const chip = modeChipHit(sel, {
      originX: leftW + 2,
      originY: 2,
      paneW: rightW,
      account: detailAccount,
    });
    if (chip) hits.push({ kind: "mode", ...chip });
  } else if (body === "fleetOnly") {
    hits.push(...fleetHits(state, { ...fleetGeom, listW: cols }));
  } else if (body === "sessionPane") {
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
    pend,
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
  let echoSeq = 0;
  // Synchronous latch: Ink invokes the key handler once per byte of a stdin
  // chunk before the view updates, so a batched "aa" would resolve an overlay
  // twice. Holds the overlay object already acted on — a fresh overlay has a
  // new identity and passes.
  let overlayActed: object | null = null;
  // Ink delivers a batched stdin chunk one byte at a time before the view
  // updates. A second `\r` right after `submitPrompt` closed the prompt would
  // otherwise be handled in `browse` mode and fire `runAct("send"|"answer")` on
  // the selection (U5). Suppress a fleet-row Enter for a beat after a submit.
  let promptSubmittedAt = 0;
  // Queue-drain bookkeeping: which sessions have an in-flight release, and the
  // `turns` value each last released at (so the next waits for a real turn).
  const draining = new Set<string>();
  const lastDrainTurn = new Map<string, number>();

  // `⇧⇥` mode cycling: the debounce window before `session.setMode` actually
  // reaches the daemon for a session (see `cycleSessionMode` below).
  const modeDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  // Both are keyed by session id and never shrank on their own — one dead
  // entry per session ever seen. Prune to the live fleet on any list change.
  const forgetDeadSessions = (): void => {
    const live = new Set(fleetSessions(state).map((s) => s.id));
    for (const id of draining) if (!live.has(id)) draining.delete(id);
    for (const id of lastDrainTurn.keys()) if (!live.has(id)) lastDrainTurn.delete(id);
  };

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
    return v.body === "split" ? v.rightW : v.cols;
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

  // Per-session scroll-back cursor into the daemon's durable history. `oldest`
  // is the (epoch, seq) of the earliest frame we hold; the next page asks for
  // everything strictly older. `done` latches when paging on cannot make
  // progress: a short page (nothing older), a page that doesn't move the cursor
  // older (an old daemon ignoring `before`), or a page the LOG_CAP-trimmed log
  // cannot absorb (it would evict the fold-in as fast as it lands). A resync /
  // reconnect clears the map (the epoch, and thus history identity, may differ
  // across the gap), which also lets a capped session try again.
  interface HistoryCursor {
    oldest?: { epoch: string; seq: number };
    done: boolean;
    loading: boolean;
  }
  const history = new Map<string, HistoryCursor>();

  // Rows per page. The first pull matches the daemon's own default so a session
  // that fits in one page behaves exactly as before; scroll-back adds more.
  const HISTORY_PAGE = historyPageSize ?? 500;

  // The RPC returns frames oldest-first, so `frames[0]` is the earliest.
  const earliestCursor = (frames: readonly EventPush[]): HistoryCursor["oldest"] => {
    const f = frames[0];
    return f ? { epoch: f.epoch ?? "", seq: f.seq } : undefined;
  };

  const backfillHistory = (): void => {
    const id = state.selectedId;
    if (!id || history.has(id)) return;
    const cursor: HistoryCursor = { done: false, loading: true };
    history.set(id, cursor);
    client
      .request<EventPush[]>("session.events", { id, limit: HISTORY_PAGE })
      .then((frames) => {
        // The reducer dedupes by (epoch, seq) against the log and re-sorts by
        // `ts`, so the durable history (every epoch) interleaves correctly with
        // whatever the `hello` ring replay already seeded (current epoch only) —
        // rather than a pre-daemon-restart turn landing below the newer frames.
        // Transcript, not live state: no notice flashes (U2).
        dispatch({ t: "backfill", frames });
        cursor.loading = false;
        if (frames.length < HISTORY_PAGE) cursor.done = true;
        const oldest = earliestCursor(frames);
        if (oldest) cursor.oldest = oldest;
      })
      .catch(() => {
        history.delete(id); // an error / older daemon — allow a retry
      });
  };

  // Pull the next older page when the log is scrolled near its top. The reducer
  // folds the page in by (epoch, seq) and re-sorts, so this is idempotent —
  // overlapping the ring replay or a double fire both collapse to the same log.
  // No-op once `done` latches or a fetch is already in flight.
  const loadOlderHistory = (): void => {
    const id = state.selectedId;
    if (!id) return;
    const cursor = history.get(id);
    if (!cursor || cursor.done || cursor.loading || !cursor.oldest) return;
    cursor.loading = true;
    client
      .request<EventPush[]>("session.events", { id, limit: HISTORY_PAGE, before: cursor.oldest })
      .then((frames) => {
        const onSame = state.selectedId === id;
        const page = store.get().logPage;
        // Was the viewport showing the top of the log before the fold-in? Only
        // then does `logScroll` need touching: rows land above the viewport and
        // the render's `end = rows.length - off` grows by the same amount, so
        // any other view stays anchored on its own rows. A top-pinned view must
        // follow the new top — otherwise the older page lands above it unseen.
        const beforeRows = onSame ? shownLogRows() : 0;
        const wasPinnedTop = onSame && logScroll >= Math.max(0, beforeRows - page);
        const sent = cursor.oldest;
        // What the fold-in actually adds (transcript kinds not already held): a
        // full page of ring-replayed duplicates still moves the cursor toward
        // older rows, so it must not read as "nothing older" below.
        const fresh = backfillAdds(state.log, frames).length;
        const logBefore = state.log.length;
        dispatch({ t: "backfill", frames });
        cursor.loading = false;
        const next = earliestCursor(frames);
        const moved =
          next !== undefined &&
          sent !== undefined &&
          (next.epoch !== sent.epoch || next.seq < sent.seq);
        if (
          frames.length < HISTORY_PAGE || // the daemon holds nothing older
          !moved || // the cursor didn't move — an old daemon ignoring `before`
          logBefore + fresh > LOG_CAP // the cap trimmed the fold-in as it landed
        ) {
          cursor.done = true;
        } else if (next) {
          cursor.oldest = next;
        }
        const grew = onSame ? shownLogRows() - beforeRows : 0;
        if (grew > 0) {
          if (wasPinnedTop) {
            logScroll = Math.max(0, shownLogRows() - page); // stay pinned at the new top
          }
          // Publish even when the view wasn't pinned: the fold changed the log
          // (the "↑N more" indicator included), and an anchored view renders the
          // same rows either way — the re-render is free. Without this the fold
          // sits invisible until the next keypress republishes.
          publish();
        }
      })
      .catch(() => {
        cursor.loading = false; // allow a retry on the next scroll
      });
  };

  const drainQueues = (): void => {
    // A queue on a session that won't return to idle (done / error / gone) is
    // stranded — say so and drop it. An `interrupted` session is left alone
    // until the next `send` revives it.
    for (const [id, q] of Object.entries(state.queue)) {
      if (!q || q.length === 0) continue;
      const s = fleetSessions(state).find((x) => x.id === id);
      if (!s || s.status.kind === "done" || s.status.kind === "error") {
        note(
          `${q.length} queued message${q.length === 1 ? "" : "s"} not sent — session ${s ? s.status.kind : "gone"}`,
          "bad",
        );
        dispatch({ t: "clearQueue", sessionId: id });
        lastDrainTurn.delete(id);
      }
    }
    for (const s of fleetSessions(state)) {
      const q = state.queue[s.id];
      if (
        s.status.kind === "idle" &&
        // A session compacting while otherwise idle would have its queue
        // drained straight into the daemon's `busy` gate. Hold until the
        // `compact` boundary clears `state.compacting[id]`.
        !state.compacting[s.id] &&
        q &&
        q.length > 0 &&
        !draining.has(s.id) &&
        s.turns > (lastDrainTurn.get(s.id) ?? -1)
      ) {
        const head = q[0] as string;
        draining.add(s.id);
        client
          .request("session.send", { id: s.id, text: head })
          .then(() => {
            // Re-read `turns` now, not the closure's pre-send snapshot (U11) —
            // a manual send that interleaved could otherwise leave the gate
            // below its true value and drain the next queued message mid-turn.
            const fresh = fleetSessions(state).find((x) => x.id === s.id)?.turns ?? s.turns;
            lastDrainTurn.set(s.id, fresh); // only gate the next one after a success
            dispatch({ t: "dequeue", sessionId: s.id }); // daemon emits the user_message echo
          })
          .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad")) // no gate update → retries
          .finally(() => draining.delete(s.id));
      }
    }
  };

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
      state.selectedChild !== prev.selectedChild
    ) {
      logScroll = 0;
    } else if (a.t === "push" && logScroll > 0 && state.log !== prev.log) {
      // Scrolled back through history (the pane border shows the accent) and a
      // live frame just landed at the tail: pin the viewport to the lines
      // you're reading instead of letting the new rows shove your view older.
      // `logScroll` counts physical rows up from the live tail, so grow it by
      // however many rows the log gained — `end = total - logScroll` (see
      // EventLog) then holds still and the same window renders. Clamp to the
      // top the way `scrollUp` does; a LOG_CAP trim (net rows <= 0) is a no-op.
      // Only `push` (tail append): `backfill` rows land *above* the viewport,
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
    if (state.plan?.requestId !== prev.plan?.requestId) planScroll = 0;
    // Narrow layout: opening a reply to a session pulls the events pane into
    // view (its input renders there) — from `overview` there's no room for it.
    if (
      promptOnPane(state.prompt) &&
      !promptOnPane(prev.prompt) &&
      layoutView === "overview" &&
      dims.cols < NARROW_COLS
    )
      layoutView = "session";
    // Was `useEffect(() => { if (!overlay) overlayActed.current = null }, [mode])`.
    if (!OVERLAY_MODES.has(state.mode)) overlayActed = null;
    if (state.theme !== prev.theme) {
      setThemeMode(state.theme);
      // Remember the choice for the next launch — best-effort, like the log.
      if (themeState) persistTheme(themeState, state.theme);
    }
    publish();
    if (state.selectedId !== prev.selectedId) backfillHistory();
    if (fleetSessions(state) !== fleetSessions(prev)) forgetDeadSessions();
    if (
      fleetSessions(state) !== fleetSessions(prev) ||
      state.queue !== prev.queue ||
      // A compaction finishing (or being cancelled) lifts the drain hold added
      // for compacting sessions — it may not touch `sessions` (an aisdk manual
      // compact emits no `result`).
      state.compacting !== prev.compacting
    )
      drainQueues();
  };

  // ---- helpers ----------------------------------------------------
  const note = (text: string, tone: "good" | "bad" | "dim" | "accent" = "good"): void =>
    dispatch({ t: "notice", text, tone });

  const quitTui = (): void => {
    client.close().catch(() => {});
    term.exit();
  };

  const echoLine = (sessionId: string, text: string): LogLine => ({
    seq: (echoSeq -= 1),
    epoch: "", // locally synthesised — daemon epochs are UUIDs, never ""
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
    if (state.mode !== "prompt" || !state.prompt)
      return note("open a prompt first — press o to view the log", "dim");
    const p = state.prompt;
    const next = await openEditor(p.buffer.text, {
      ext: p.kind === "new" ? "md" : "txt",
      aside: { name: "events.log", body: logText() },
    });
    if (next != null) dispatch({ t: "promptSet", buffer: buffer(next.replace(/\s+$/, "")) });
  };

  /** `o` / `⌥o` — open the pending request, or the event log, in `$EDITOR` read-only. */
  const viewInEditor = async (): Promise<void> => {
    const s = selectedSession(state);
    const pend = s ? pendingFor(state, s.id) : {};
    const fp = firstPerm(pend);
    if (pend.plan !== undefined) {
      await openEditor(pend.planText ?? "", { ext: "md" });
    } else if (fp) {
      const qs = fp.tool === "AskUserQuestion" ? parseAskUserQuestions(fp.input) : [];
      await (qs.length > 0
        ? openEditor(formatQuestionsForEditor(qs), { ext: "md" })
        : openEditor(JSON.stringify({ tool: fp.tool, input: fp.input }, null, 2), {
            ext: "json",
          }));
    } else if (pend.question !== undefined) {
      await openEditor([pend.questionText ?? "", "", pend.questionContext ?? ""].join("\n"), {
        ext: "md",
      });
    } else {
      await openEditor(logText(), { ext: "log" });
    }
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
    const opening = state.mode !== "doctor";
    dispatch({ t: "doctor", value: opening });
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

  const act = (name: DelegatedAct): void => {
    const s = selectedSession(state);
    const by = client.clientId;
    if (name === "new") {
      const pid = defaultProviderId(state);
      const dm = defaultModelOf(state, pid);
      const mode = defaultModeOf(state);
      return void dispatch({
        t: "openPrompt",
        prompt: makePrompt({
          kind: "new",
          sessionId: null,
          label: "new session",
          provider: pid,
          mode,
          ...(dm ? { model: dm } : {}),
          ...(state.lastDraft ? { text: state.lastDraft } : {}),
        }),
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
    if (name === "help") return void dispatch({ t: "help", value: state.mode !== "help" });
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
          dispatch({
            t: "openPicker",
            picker: makePicker({
              kind: "undo",
              title: `undo · ${shortId(sid)}`,
              items,
              ctx: { liveSessionId: sid },
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
        const fp = firstPerm(pendingFor(state, s.id));
        if (!fp) return note("no permission request pending", "dim");
        const requestId = fp.id;
        return perform(async () => {
          const r = await client.request<{ alreadyResolved: boolean }>(
            "session.respondPermission",
            {
              id: s.id,
              requestId,
              decision: "allow",
              by,
            },
          );
          dispatch({ t: "resolvePerm", sessionId: s.id, id: requestId });
          return r.alreadyResolved ? `${requestId} already resolved` : `approved ${requestId}`;
        });
      }
      case "deny": {
        const fp = firstPerm(pendingFor(state, s.id));
        if (!fp) return note("no permission request pending", "dim");
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "deny",
            sessionId: s.id,
            requestId: fp.id,
            label: `deny ${fp.id}`,
          }),
        });
      }
      case "answer": {
        const pend = pendingFor(state, s.id);
        if (pend.question !== undefined) {
          return void dispatch({
            t: "openPrompt",
            prompt: makePrompt({
              kind: "answer",
              sessionId: s.id,
              requestId: pend.question,
              label: "answer",
            }),
          });
        }
        if (firstPerm(pend)?.tool === "AskUserQuestion") {
          const q = questionState(state, s.id);
          if (!q) return note("malformed AskUserQuestion input — ⌃o to inspect", "bad");
          return void dispatch({
            t: "openPrompt",
            prompt: answerQuestionPrompt(
              s.id,
              q.requestId,
              q.qs,
              q.nav?.answers ?? {},
              q.nav?.idx ?? 0,
            ),
          });
        }
        return note("no question pending", "dim");
      }
      case "send":
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "send",
            sessionId: s.id,
            label: "send",
            ...(state.lastDraft ? { text: state.lastDraft } : {}),
          }),
        });
      case "title":
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "title",
            sessionId: s.id,
            label: "rename",
            text: s.title ?? "",
          }),
        });
      case "comment":
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "comment",
            sessionId: s.id,
            label: "comment",
            text: s.comment ?? "",
          }),
        });
      case "planreview": {
        const pend2 = pendingFor(state, s.id);
        if (!pend2.plan) return note("no plan pending", "dim");
        return void dispatch({
          t: "openPlan",
          sessionId: s.id,
          requestId: pend2.plan,
          text: pend2.planText ?? "",
        });
      }
      case "interrupt":
        return perform(async () => {
          await client.request("session.interrupt", { id: s.id });
          return "interrupted";
        });
      case "compact":
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "compact",
            sessionId: s.id,
            label: "compact — steer summary (blank = best effort)",
          }),
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
          return void dispatch({
            t: "openConfirm",
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

  /** Provider chosen → always show a model step. `carry` threads the wizard's
   *  context — a half-typed `new`-prompt `draft`, or a live switch's
   *  `liveSessionId` / `reopenSend` / `draft` / `viaProviderStep` — through the
   *  detour unchanged. (`model` is never set this early, so it isn't carried.) */
  const openModelStep = (providerId: string, label: string, carry: PickerState["ctx"] = {}): void =>
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "model",
        title: `model · ${label}`,
        items: modelPickItems(state, providerId),
        emptyText: modelPickEmptyText(state, providerId),
        ctx: { ...carry, provider: providerId },
      }),
    });

  /** Model chosen, and it takes a thinking-effort level → one more step before
   *  the wizard resolves. Carries the rest of `ctx` (live session / draft /
   *  reopenSend) through unchanged. */
  const openEffortStep = (
    providerId: string,
    modelId: string,
    label: string,
    ctx: PickerState["ctx"] = {},
  ): void =>
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "effort",
        title: `effort · ${label}`,
        items: effortPickItems(state, providerId, modelId),
        ctx: { ...ctx, provider: providerId, model: modelId },
      }),
    });

  // --- `⌥p` from the plan review: retarget the `f` (implement fresh) run ------
  // A self-contained provider → model → (effort) wizard that resolves by
  // staging onto `state.plan.impl` (not a live switch or a `new` prompt). Each
  // step pre-selects the session's current value; a staged provider that
  // differs from the session's forks a fresh session when `f` fires.

  const planSession = (): SessionSnapshot | undefined => {
    const pl = state.plan;
    return pl ? fleetSessions(state).find((x) => x.id === pl.sessionId) : undefined;
  };

  const openPlanModelStep = (provider: string): void => {
    const items = modelPickItems(state, provider);
    const ps = planSession();
    const cur = state.plan?.impl?.model ?? (provider === ps?.provider ? ps?.model : undefined);
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "model",
        title: `retarget · model · ${provider}`,
        items,
        emptyText: modelPickEmptyText(state, provider),
        ctx: { planStage: true, provider },
        index: cur ? items.findIndex((i) => i.id === cur) : 0,
      }),
    });
  };

  const openPlanEffortStep = (provider: string, model: string): void => {
    const items = effortPickItems(state, provider, model);
    const ps = planSession();
    const cur =
      state.plan?.impl?.effort ??
      (provider === ps?.provider && model === ps?.model ? ps?.effort : undefined);
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "effort",
        title: `retarget · effort · ${provider}`,
        items,
        ctx: { planStage: true, provider, model },
        index: cur ? items.findIndex((i) => i.id === cur) : 0,
      }),
    });
  };

  const openPlanRetarget = (): void => {
    if (!state.plan) return;
    const ps = planSession();
    if (fleetProviders(state).length > 1) {
      const items = providerPickItems(state);
      const cur = state.plan.impl?.provider ?? ps?.provider;
      return void dispatch({
        t: "openPicker",
        picker: makePicker({
          kind: "provider",
          title: "retarget · provider",
          items,
          ctx: { planStage: true },
          index: cur ? items.findIndex((i) => i.id === cur) : 0,
        }),
      });
    }
    openPlanModelStep(fleetProviders(state)[0]?.id ?? ps?.provider ?? "claude");
  };

  /** Finalize a model (+ optional effort) chosen through the wizard: either a
   *  live switch on an existing session, or folding the choice into the
   *  `new`-session prompt. */
  const finalizeModelChoice = (ctx: PickerState["ctx"], model: string, effort?: string): void => {
    if (ctx?.liveSessionId) {
      const id = ctx.liveSessionId;
      const back = ctx.reopenSend;
      const draft = ctx.draft;
      dispatch({ t: "closePicker" });
      // Came from a `send` prompt (⌥m/⌥t mid-message) → drop the user back into
      // it with the half-typed text intact once the switch is away.
      if (back !== undefined) {
        dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "send",
            sessionId: back,
            label: "send",
            ...(draft !== undefined ? { text: draft } : {}),
          }),
        });
      }
      const sess = fleetSessions(state).find((x) => x.id === id);
      const toProvider =
        ctx.provider !== undefined && sess !== undefined && ctx.provider !== sess.provider
          ? ctx.provider
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
      return;
    }
    dispatch({
      t: "openPrompt",
      prompt: makePrompt({
        kind: "new",
        sessionId: null,
        label: "new session",
        ...(ctx?.provider ? { provider: ctx.provider } : {}),
        ...(ctx?.draft !== undefined ? { text: ctx.draft } : {}),
        model,
        ...(effort ? { effort } : {}),
      }),
    });
  };

  /** Resolve the open picker's highlighted item by its kind. */
  const choosePicked = (): void => {
    const p = state.picker;
    if (!p || overlayActed === p) return;
    overlayActed = p;
    const cur = pickerCurrent(p);

    // Empty model / effort step: enter continues without picking one (the
    // daemon falls back to the provider's default model; a model with no
    // enumerated effort levels never reaches an empty effort step).
    if (!cur) {
      if (p.ctx?.planStage) {
        // Stage what's chosen so far; the daemon fills the rest from the target
        // provider's defaults.
        const provider = p.ctx.provider ?? planSession()?.provider ?? "claude";
        if (p.kind === "effort") {
          return void dispatch({
            t: "stagePlanImpl",
            provider,
            ...(p.ctx.model ? { model: p.ctx.model } : {}),
          });
        }
        if (p.kind === "model") return void dispatch({ t: "stagePlanImpl", provider });
        return void dispatch({ t: "closePicker" });
      }
      if (p.kind === "model" && !p.ctx?.liveSessionId) {
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "new",
            sessionId: null,
            label: "new session",
            ...(p.ctx?.provider ? { provider: p.ctx.provider } : {}),
            ...(p.ctx?.draft !== undefined ? { text: p.ctx.draft } : {}),
          }),
        });
      }
      if (p.kind === "effort") {
        return void finalizeModelChoice(p.ctx, p.ctx?.model ?? "");
      }
      return void dispatch({ t: "closePicker" });
    }

    // The `⌥p` retarget wizard resolves onto `state.plan.impl`, not a live
    // switch or a `new` prompt.
    if (p.ctx?.planStage) {
      if (p.kind === "provider") return void openPlanModelStep(cur.id);
      if (p.kind === "model") {
        const provider = p.ctx.provider ?? planSession()?.provider ?? "claude";
        if (modelSupportsEffort(state, provider, cur.id)) {
          return void openPlanEffortStep(provider, cur.id);
        }
        return void dispatch({ t: "stagePlanImpl", provider, model: cur.id });
      }
      if (p.kind === "effort") {
        return void dispatch({
          t: "stagePlanImpl",
          provider: p.ctx.provider ?? planSession()?.provider ?? "claude",
          ...(p.ctx.model ? { model: p.ctx.model } : {}),
          effort: cur.id,
        });
      }
    }

    switch (p.kind) {
      case "provider":
        return void openModelStep(
          cur.id,
          cur.label,
          p.ctx?.liveSessionId ? { ...p.ctx, viaProviderStep: true } : p.ctx,
        );

      case "model": {
        const providerId = p.ctx?.provider ?? "claude";
        if (modelSupportsEffort(state, providerId, cur.id)) {
          const label = providerInfo(state, providerId)?.tag ?? providerId;
          return void openEffortStep(providerId, cur.id, label, { ...p.ctx, viaModelStep: true });
        }
        return void finalizeModelChoice(p.ctx, cur.id);
      }

      case "effort":
        return void finalizeModelChoice(p.ctx, p.ctx?.model ?? "", cur.id);

      case "undo": {
        const id = p.ctx?.liveSessionId;
        const undoTurn = Number(cur.id);
        const prefill = cur.blob ?? "";
        dispatch({ t: "closePicker" });
        if (!id || !Number.isInteger(undoTurn)) return;
        client
          // `toTurn` is turns-to-keep: undoing turn T keeps T-1.
          .request("session.rewind", { id, toTurn: undoTurn - 1, by: client.clientId })
          .then(() => {
            dispatch({ t: "notice", text: `undid turn ${undoTurn}`, tone: "good" });
            // Reopen the compose prompt with that turn's message pre-filled, as
            // if you'd pressed Enter on the session — edit and re-send, or Esc.
            dispatch({
              t: "openPrompt",
              prompt: makePrompt({
                kind: "send",
                sessionId: id,
                label: "send",
                ...(prefill ? { text: prefill } : {}),
              }),
            });
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
        return absurd(p.kind);
    }
  };

  /** `⌃P` in the new-session prompt: pick the provider (skipped when there's
   *  only one), then the model, then land back on the prompt. */
  const pickProviderModel = (draft: string): void => {
    const provs = fleetProviders(state);
    if (provs.length > 1) {
      return void dispatch({
        t: "openPicker",
        picker: makePicker({
          kind: "provider",
          title: "provider",
          items: providerPickItems(state),
          ctx: { draft },
        }),
      });
    }
    const only = provs[0]?.id ?? "claude";
    openModelStep(only, provs[0]?.tag || only, { draft });
  };

  /** `Esc` inside a picker — the step-back logic is pure (see
   *  {@link escapeTarget}); this just dispatches its result. */
  const escapePicker = (p: PickerState): void => dispatch(escapeTarget(p, state));

  /** Open a live model switcher (`⌥m`): the selected session, or an explicit
   *  one. From a `send` prompt, pass `draft` so the picker drops you back. */
  const switchModel = (sessionId?: string, draft?: string): void => {
    const s = sessionId
      ? fleetSessions(state).find((x) => x.id === sessionId)
      : selectedSession(state);
    if (!s) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
    const models = modelPickItems(state, s.provider);
    // Mid-probe the list is empty but coming — open the picker anyway; the
    // settle push fills it in (see rederiveOpenPicker).
    if (models.length === 0 && !providerInfo(state, s.provider)?.modelsLoading) {
      return void dispatch({
        t: "notice",
        text: `${s.provider} has no alternate models`,
        tone: "dim",
      });
    }
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "model",
        title: `model · ${s.provider}`,
        items: models,
        ctx: {
          provider: s.provider,
          liveSessionId: s.id,
          ...(draft !== undefined ? { reopenSend: s.id, draft } : {}),
        },
      }),
    });
  };

  /** Open the provider → model → effort wizard for a *live* session (`⌥p`
   *  mid-chat): pre-select its current provider, thread `liveSessionId`
   *  (+ `reopenSend` / `draft` from a send prompt) so the choice finalizes as a
   *  `session.setProvider`. Falls back to the model switcher when there's only
   *  one provider to pick from. */
  const pickProviderModelForSession = (sessionId?: string, draft?: string): void => {
    const s = sessionId
      ? fleetSessions(state).find((x) => x.id === sessionId)
      : selectedSession(state);
    if (!s) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
    if (
      s.status.kind === "running" ||
      s.status.kind === "starting" ||
      s.status.kind === "working_background" ||
      s.status.kind === "awaiting_input"
    ) {
      return void dispatch({
        t: "notice",
        text: "interrupt the turn before switching provider",
        tone: "dim",
      });
    }
    if (fleetProviders(state).length <= 1) return void switchModel(s.id, draft);
    const items = providerPickItems(state);
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "provider",
        title: "provider",
        items,
        ctx: {
          liveSessionId: s.id,
          ...(draft !== undefined ? { reopenSend: s.id, draft } : {}),
        },
        index: Math.max(
          0,
          items.findIndex((x) => x.id === s.provider),
        ),
      }),
    });
  };

  /** Open a live thinking-effort switcher (`⌥t`): the selected session, or an
   *  explicit one. Only offered when its current model takes an effort level. */
  const switchEffort = (sessionId?: string, draft?: string): void => {
    const s = sessionId
      ? fleetSessions(state).find((x) => x.id === sessionId)
      : selectedSession(state);
    if (!s) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
    if (!s.model || !modelSupportsEffort(state, s.provider, s.model)) {
      return void dispatch({
        t: "notice",
        text: `${s.provider}${s.model ? `/${s.model}` : ""} has no thinking-effort control`,
        tone: "dim",
      });
    }
    openEffortStep(s.provider, s.model, s.provider, {
      liveSessionId: s.id,
      ...(draft !== undefined ? { reopenSend: s.id, draft } : {}),
    });
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
      if (!fleetSessions(state).some((x) => x.id === sessionId)) return;
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
            const pend = pendingFor(state, sessionId);
            if (pend.plan) {
              dispatch({
                t: "openPlan",
                sessionId,
                requestId: pend.plan,
                text: pend.planText ?? "",
              });
            }
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
        // Settled either way: the snapshot is now the truth about this
        // session's mode, so the local draft has done its job.
        .finally(() => dispatch({ t: "modeDraft", sessionId, mode: null }));
    }, 300);
    modeDebounce.set(sessionId, timer);
  };

  const submitPrompt = (): void => {
    const p = state.prompt;
    if (!p) return;
    const text = p.buffer.text.trim();
    const by = client.clientId;
    // `deny` and `compact` both treat an empty submit as a valid choice
    // (no reason / best-effort compaction); `comment` empty clears the note.
    // Every other prompt needs text.
    if (p.kind !== "deny" && p.kind !== "compact" && p.kind !== "comment" && !text) return;

    // A send typed while the target session is compacting: the daemon holds the
    // op gate for the whole (multi-minute) summarise and would reject with
    // `code:"busy"`. Reuse the outgoing queue instead — `drainQueues` releases
    // it on the first update after the `compact` boundary clears
    // `state.compacting[id]`. (`code:"busy"` is still caught below for a race.)
    if (p.kind === "send" && p.sessionId && text && state.compacting[p.sessionId]) {
      queueSend(p.sessionId, text, "queued until compaction finishes");
      return;
    }

    const reopen = (): void =>
      dispatch({
        t: "openPrompt",
        prompt: { ...p, buffer: buffer(p.buffer.text), histIdx: 0, draft: "" },
      });

    dispatch({ t: "closePrompt" });

    const run = async (): Promise<string> => {
      switch (p.kind) {
        case "new": {
          const r = await client.request<SessionSnapshot>("session.create", {
            prompt: text,
            by,
            ...(p.mode && p.mode !== "default" ? { mode: p.mode } : {}),
            ...(p.provider ? { provider: p.provider } : {}),
            ...(p.model ? { model: p.model } : {}),
            ...(p.effort ? { effort: p.effort } : {}),
          });
          dispatch({ t: "select", id: r.id });
          dispatch({ t: "pushHistory", text });
          // No local echo — the daemon emits a `user_message` for the opening
          // prompt too, so it's in the log for every client and after a reopen.
          return `started ${shortId(r.id)}`;
        }
        case "send": {
          if (!p.sessionId) return "";
          // No local echo — the daemon emits a `user_message` event that every
          // client (this one included) renders. The RPC tells us whether it
          // actually landed mid-turn.
          const r = await client.request<{ injected?: boolean }>("session.send", {
            id: p.sessionId,
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
        case "title": {
          if (!p.sessionId) return "";
          await client.request("session.setTitle", { id: p.sessionId, title: text, by });
          return "renamed";
        }
        case "comment": {
          if (!p.sessionId) return "";
          await client.request("session.setComment", { id: p.sessionId, comment: text, by });
          return text ? "comment saved" : "comment cleared";
        }
        case "compact": {
          if (!p.sessionId) return "";
          await client.request("session.compact", {
            id: p.sessionId,
            ...(text ? { instructions: text } : {}),
          });
          return text ? "compacting — focused" : "compacting context";
        }
        case "discuss": {
          if (!p.sessionId || !p.requestId) return "";
          const r = await client.request<{ alreadyResolved: boolean }>("session.respondPlan", {
            id: p.sessionId,
            requestId: p.requestId,
            action: "discuss",
            message: text,
            by,
          });
          dispatch({ t: "closePlan" });
          return r.alreadyResolved ? "plan already resolved" : "sent to the agent";
        }
        case "answer": {
          if (!p.sessionId || !p.requestId) return "";
          const r = await client.request<{ alreadyResolved: boolean }>("session.answer", {
            id: p.sessionId,
            requestId: p.requestId,
            text,
            by,
          });
          return r.alreadyResolved ? "already answered" : "answered";
        }
        case "answerQuestion": {
          if (!p.sessionId || !p.requestId || !p.qaAll || p.qaAll.length === 0) return "";
          const idx = Math.min(p.qaIdx ?? 0, p.qaAll.length - 1);
          const answers = { ...p.qaAnswers, [p.qaAll[idx]!.question]: text };
          // Every question needs a non-blank answer before the permission
          // resolves. Jump to the next one still missing (wrapping past the
          // end); if the only gap is the current question, say so and wait.
          let missing = -1;
          for (let k = 1; k <= p.qaAll.length; k++) {
            const j = (idx + k) % p.qaAll.length;
            if ((answers[p.qaAll[j]!.question] ?? "").trim() === "") {
              missing = j;
              break;
            }
          }
          // Keep the running answers in `qnav` so an Esc from here (or the next
          // question) still has them.
          const stash = (at: number): void =>
            void dispatch({
              t: "qnavSet",
              nav: { sessionId: p.sessionId!, requestId: p.requestId!, idx: at, answers },
            });
          if (missing === idx) {
            stash(idx);
            return "answer this question before submitting";
          }
          if (missing !== -1) {
            stash(missing);
            dispatch({
              t: "openPrompt",
              prompt: answerQuestionPrompt(p.sessionId, p.requestId, p.qaAll, answers, missing),
            });
            return "";
          }
          const fp = firstPerm(pendingFor(state, p.sessionId));
          const baseInput =
            fp && fp.input && typeof fp.input === "object"
              ? (fp.input as Record<string, unknown>)
              : {};
          const r = await client.request<{ alreadyResolved: boolean }>(
            "session.respondPermission",
            {
              id: p.sessionId,
              requestId: p.requestId,
              decision: "allow",
              updatedInput: { ...baseInput, answers },
              by,
            },
          );
          dispatch({ t: "resolvePerm", sessionId: p.sessionId, id: p.requestId });
          return r.alreadyResolved ? `${p.requestId} already resolved` : "answered";
        }
        case "deny": {
          if (!p.sessionId || !p.requestId) return "";
          const r = await client.request<{ alreadyResolved: boolean }>(
            "session.respondPermission",
            {
              id: p.sessionId,
              requestId: p.requestId,
              decision: "deny",
              by,
              ...(text ? { message: text } : {}),
            },
          );
          dispatch({ t: "resolvePerm", sessionId: p.sessionId, id: p.requestId });
          return r.alreadyResolved ? `${p.requestId} already resolved` : `denied ${p.requestId}`;
        }
        default:
          return absurd(p.kind);
      }
    };

    run()
      .then((m) => m && note(m, "good"))
      .catch((e: unknown) => {
        // Lost the race with a compaction that started between the pre-check
        // above and the RPC — queue rather than error.
        if (
          p.kind === "send" &&
          p.sessionId &&
          text &&
          (e as { code?: unknown })?.code === "busy"
        ) {
          queueSend(p.sessionId, text, "queued until compaction finishes");
          return;
        }
        // The connection dropped mid-request — the daemon may have run it to
        // completion. Don't reopen the prompt (that invites a double submit);
        // the replayed `session_updated` / events reconcile the view.
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
    dispatch({ t: "enqueue", sessionId, text });
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

  /** Resolve the open plan review with `params` (an `action` plus any payload). */
  const respondPlan = (params: Record<string, unknown>, label: string): void => {
    const pl = state.plan;
    if (!pl || overlayActed === pl) return;
    overlayActed = pl;
    dispatch({ t: "closePlan" });
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
        dispatch({
          t: "openPlan",
          sessionId: pl.sessionId,
          requestId: pl.requestId,
          text: pl.text,
        });
      });
  };

  /** `f` in the plan overlay — implement fresh, honouring an `⌥p` retarget.
   *  Same provider (or none staged): the model / effort ride on the decision.
   *  A different provider: the daemon forks a fresh session on it and hands
   *  back its snapshot; select that and don't reopen the overlay. */
  const implementFresh = (): void => {
    const pl = state.plan;
    if (!pl || overlayActed === pl) return;
    const impl = pl.impl;
    const forking = impl !== undefined && impl.provider !== planSession()?.provider;
    const params: Record<string, unknown> = {
      action: "implement_fresh",
      mode: pl.mode,
      ...(impl?.model ? { model: impl.model } : {}),
      ...(impl?.effort ? { effort: impl.effort } : {}),
      ...(forking ? { provider: impl.provider, plan: pl.text } : {}),
    };
    if (!forking) return respondPlan(params, "compacting, then implementing");
    overlayActed = pl;
    dispatch({ t: "closePlan" });
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
        dispatch({
          t: "openPlan",
          sessionId: pl.sessionId,
          requestId: pl.requestId,
          text: pl.text,
        });
      });
  };

  /** `e` in the plan overlay — edit the plan in $EDITOR, then implement it. */
  const editPlan = async (): Promise<void> => {
    const pl = state.plan;
    if (!pl) return;
    const edited = await openEditor(pl.text, { ext: "md" });
    const plan = edited?.trim();
    // No save, or quit-without-changes (`:q`) — don't kick off an implement.
    if (!plan || plan === pl.text.trim()) return note("plan unchanged — nothing sent", "dim");
    respondPlan({ action: "revise", plan, mode: pl.mode }, "implementing your edited plan");
  };

  /** `o` / `⌥o` in the plan overlay — view the plan in $EDITOR, read-only. */
  const viewPlan = async (): Promise<void> => {
    const pl = state.plan;
    if (!pl) return;
    await openEditor(pl.text, { ext: "md" });
  };

  // ---- daemon lifecycle ---------------------------------------
  const confirmFor = (action: "restart" | "quitAll"): ConfirmState => {
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

  const confirmForDelete = (s: SessionSnapshot): ConfirmState => {
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
    const c = state.confirm;
    if (!c || overlayActed === c) return;
    overlayActed = c;
    dispatch({ t: "closeConfirm" });
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
        return void dispatch({ t: "openConfirm", confirm: confirmFor("restart") });
      case "quitall":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("quitAll") });
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
        return void dispatch({
          t: "openConfirm",
          confirm: {
            title: "Run gc?",
            body: `The worktrees of ${targets.length} done session${targets.length === 1 ? "" : "s"} go away — session rows and branches are kept.`,
            danger: true,
            action: "gc",
          },
        });
      }
      case "delete":
        return void (sel
          ? dispatch({ t: "openConfirm", confirm: confirmForDelete(sel) })
          : undefined);
      case "copybranch": {
        if (!sel) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
        const nm =
          sel.branch ?? (sel.worktree ? (sel.worktree.split("/").pop() ?? sel.worktree) : sel.id);
        return copyToClipboard(nm, nm);
      }
      case "clearqueue":
        if (sel && queueFor(state, sel.id).length > 0) {
          return void dispatch({ t: "clearQueue", sessionId: sel.id });
        }
        return void dispatch({ t: "notice", text: "no queued messages to clear", tone: "dim" });
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
    const onInputLine = state.mode === "prompt" || state.mode === "picker" || !!state.find;
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
      if (state.mode === "plan") {
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
      if (base === 0 && mouse[4] === "M" && (rawBtn & 32) === 0 && state.mode === "browse") {
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

    if (state.mode === "prompt" && state.prompt) {
      const p = state.prompt;
      // ⌥-prefixed prompt actions — "step out to a bigger tool" without losing
      // what's typed. Ctrl is reserved for readline motions (applyKey).
      if (key.meta && input === "e") return void editPrompt();
      if (key.meta && input === "o") {
        // A new-session prompt has no session and no log to open yet.
        return void (p.kind === "new"
          ? dispatch({
              t: "notice",
              text: "no log yet — you're starting a new session",
              tone: "dim",
            })
          : viewInEditor());
      }
      // ⇧⇥ cycles the permission mode without leaving the prompt.
      if (key.tab && key.shift) {
        if (p.kind === "new") return void dispatch({ t: "promptCycleMode" });
        if (p.kind === "send" && p.sessionId) return void cycleSessionMode(p.sessionId);
        return;
      }
      // ⌥m swaps the model without leaving the prompt.
      if (key.meta && input === "m") {
        if (p.kind === "new") {
          const pid = p.provider ?? defaultProviderId(state);
          const tag = fleetProviders(state).find((x) => x.id === pid)?.tag ?? pid;
          return void openModelStep(pid, tag, { draft: p.buffer.text });
        }
        if (p.kind === "send" && p.sessionId) return void switchModel(p.sessionId, p.buffer.text);
        return;
      }
      // ⌥t swaps the thinking-effort level without leaving the prompt.
      if (key.meta && input === "t") {
        if (p.kind === "new") {
          const pid = p.provider ?? defaultProviderId(state);
          const mid = p.model || defaultModelOf(state, pid);
          if (!mid || !modelSupportsEffort(state, pid, mid)) {
            return void dispatch({
              t: "notice",
              text: "this model has no thinking-effort control",
              tone: "dim",
            });
          }
          const tag = fleetProviders(state).find((x) => x.id === pid)?.tag ?? pid;
          return void openEffortStep(pid, mid, tag, { draft: p.buffer.text });
        }
        if (p.kind === "send" && p.sessionId) return void switchEffort(p.sessionId, p.buffer.text);
        return;
      }
      if (key.meta && input === "p") {
        if (p.kind === "new") return void pickProviderModel(p.buffer.text);
        if (p.kind === "send" && p.sessionId)
          return void pickProviderModelForSession(p.sessionId, p.buffer.text);
        return;
      }
      if (key.meta && input === "x" && p.kind === "send" && p.sessionId) {
        return void dispatch({ t: "clearQueue", sessionId: p.sessionId });
      }
      // ⌥⏎ while the target is still working queues for turn end instead of its
      // usual "insert a newline" meaning; bare ⏎ below sends now regardless.
      if (key.meta && key.return && p.kind === "send" && p.sessionId) {
        const target = fleetSessions(state).find((x) => x.id === p.sessionId);
        if (
          target &&
          (target.status.kind === "running" ||
            target.status.kind === "starting" ||
            target.status.kind === "working_background")
        ) {
          const text = p.buffer.text.trim();
          return void (text && queueSend(p.sessionId, text));
        }
      }
      const res = applyKey(p.buffer, input, key);
      switch (res.kind) {
        case "cancel":
          // Backing out of the plan "discuss" sub-prompt returns to the plan
          // overlay — the daemon is still blocked on the decision.
          if (p.kind === "discuss" && p.sessionId && p.requestId && state.plan) {
            return void dispatch({
              t: "openPlan",
              sessionId: p.sessionId,
              requestId: p.requestId,
              text: state.plan.text,
            });
          }
          // Esc on an AskUserQuestion answer drops back to the request panel
          // (the daemon stays blocked) rather than abandoning the whole call:
          // answers gathered so far — including whatever is typed now — are
          // stashed in `qnav`, so ← / → can move to another question and `a`
          // resumes where you left off.
          if (p.kind === "answerQuestion" && p.qaAll && p.sessionId && p.requestId) {
            const idx = Math.min(p.qaIdx ?? 0, p.qaAll.length - 1);
            const answers = { ...p.qaAnswers };
            if (p.buffer.text.trim() !== "") answers[p.qaAll[idx]!.question] = p.buffer.text;
            dispatch({
              t: "qnavSet",
              nav: { sessionId: p.sessionId, requestId: p.requestId, idx, answers },
            });
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

    if (state.mode === "plan") {
      // PgUp/PgDn scroll the plan body (a page ≈ the visible window less a row);
      // the mouse wheel is handled up top, `o` still opens it in $EDITOR.
      if (key.pageDown) return void planScrollBy(15);
      if (key.pageUp) return void planScrollBy(-15);
      // ⇧⇥ cycles the mode the implementation will run in.
      if (key.tab && key.shift) return void dispatch({ t: "cyclePlanMode" });
      // ⌥p retargets model / effort / provider for `f` (implement fresh).
      if (key.meta && input === "p") return void openPlanRetarget();
      // i / f / e implement in the overlay's chosen mode; `d` (discuss) only
      // sends a note back, so it carries none.
      const pl = state.plan;
      const withMode = (params: Record<string, unknown>): Record<string, unknown> =>
        pl ? { ...params, mode: pl.mode } : params;
      if (input === "i")
        return respondPlan(withMode({ action: "implement" }), "implementing the plan");
      if (input === "f") return void implementFresh();
      if (input === "e") return void editPlan();
      if (input === "o" || (key.meta && input === "o")) return void viewPlan();
      if (input === "d") {
        const pl = state.plan;
        if (!pl) return;
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "discuss",
            sessionId: pl.sessionId,
            requestId: pl.requestId,
            label: "discuss plan",
          }),
        });
      }
      // esc backs out to the fleet without answering — the daemon stays blocked
      // on the decision, `pend.plan` keeps the request panel's prompt, and `a`
      // re-opens the overlay.
      if (key.escape) return void dispatch({ t: "closePlan" });
      return; // everything else: a plan review must still be answered
    }

    if (state.mode === "confirm") {
      if (key.return) return runConfirm();
      if (input === "b" && state.confirm?.branchName) {
        return void dispatch({ t: "toggleConfirmBranch" });
      }
      if (key.escape || input === "q" || input === "n") return void dispatch({ t: "closeConfirm" });
      return;
    }

    if (state.mode === "help") {
      if (input === "?" || input === "q" || key.escape) dispatch({ t: "help", value: false });
      return;
    }

    if (state.mode === "doctor") {
      if (input === "q" || key.escape) dispatch({ t: "doctor", value: false });
      return;
    }

    if (state.mode === "picker" && state.picker) {
      const p = state.picker;
      if (key.escape) return void escapePicker(p);
      if (key.upArrow) return void dispatch({ t: "pickerMove", delta: -1 });
      if (key.downArrow) return void dispatch({ t: "pickerMove", delta: 1 });
      if (key.return) {
        // The command palette runs an action through the shared dispatcher; the
        // provider / model / undo pickers resolve by kind in choosePicked.
        if (p.kind === "command") {
          if (overlayActed === p) return; // batched double-Enter guard
          overlayActed = p;
          const cur = pickerCurrent(p);
          dispatch({ t: "closePicker" });
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
      return publish();
    }
    // ← / → move between the questions of a pending AskUserQuestion (the panel
    // previews whichever is selected; `a` answers it). Only while parked on a
    // multi-question call — otherwise the arrows drill into children, below.
    if (key.leftArrow || key.rightArrow) {
      const q = questionState(state, sel?.id);
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
      return void dispatch({
        t: "openPicker",
        picker: makePicker({ kind: "command", title: "commands", items: commandsFor(state) }),
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
      // The one authoritative feed: every fleet change arrives as a complete
      // snapshot, so there is nothing to reconcile, merge or refetch.
      client.subscribe((s) => dispatch({ t: "state", state: s })),
      client.onPush((frame) => dispatch({ t: "push", frame })),
      client.on("reconnect", () => {
        log?.info("daemon reconnected");
        // Transcript history is a separate resource and the epoch may have
        // changed across the gap; the snapshot says nothing about it, so
        // re-pull it here. The reducer folds durable history back in by
        // (epoch, seq) and re-sorts, so this is idempotent.
        history.clear();
        backfillHistory();
        if (restarting) {
          restarting = false;
          dispatch({ t: "notice", text: "daemon restarted", tone: "good" });
        }
        void reconcileVersion();
      }),
      client.on("resync", () => {
        log?.info("resync");
        history.clear();
        backfillHistory();
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
        Object.keys(state.compacting).length > 0 ||
        fleetSessions(state).some(
          (s) =>
            s.status.kind === "running" ||
            s.status.kind === "starting" ||
            s.status.kind === "working_background",
        );
      if (!animating) return;
      if (state.log.length > 3) tick = (tick + 1) % 100000;
      dispatch({ t: "expireNotice", now: Date.now() });
      publish(); // the tick bump alone needs a frame (spinner) even if nothing expired
    }, 120);

    // Backfill the log from history the daemon replayed before mount (re-opening
    // the TUI against a live daemon); live frames de-dupe against it by seq.
    // `replay` so a long-settled permission / error in that history doesn't
    // flash a stale notice or re-open the request panel (U2).
    for (const frame of client.bufferedEvents) dispatch({ t: "push", frame, replay: true });

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
      dispatch({
        t: "openConfirm",
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
