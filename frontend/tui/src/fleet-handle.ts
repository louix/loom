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
import type { DoctorReport, EventPush, ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { LOOM_VERSION } from "@loom/core/version";
import { spawnEditor, type EditorHandoff } from "./editor-handoff.ts";
import { applyKey, buffer } from "./editor.ts";
import { modeLabel, setThemeMode, shortId, truncate } from "./theme.ts";
import { loadPersistedTheme, persistTheme } from "./theme-store.ts";
import { detailRows, promptPaneRows, promptRows, REQUEST_PANEL_ROWS } from "./components.tsx";
import { mkStore } from "./store.ts";
import {
  loadableFailed,
  loadableIdle,
  loadableLoaded,
  loadablePending,
  type Loadable,
} from "./loadable.ts";
import {
  allowedActs,
  commandsFor,
  cycleLogFilter,
  defaultModeOf,
  defaultModelOf,
  defaultProviderId,
  effortPickItems,
  escapeTarget,
  firstPerm,
  focusedPending,
  initialState,
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
  visibleLog,
  versionMismatchAction,
  type ActName,
  type Action,
  type AskUserQuestionItem,
  type ConfirmState,
  type LogLine,
  type Pending,
  type PickerState,
  type TuiState,
} from "./model.ts";

/** Footer label for the `answerQuestion` prompt: the current question's short
 *  `header` chip, plus `N/total` progress when the `AskUserQuestion` call asked
 *  more than one question. `idx` is the 0-based position in `all`. */
const questionPromptLabel = (all: AskUserQuestionItem[], idx: number): string => {
  const tag = all[idx]?.header || "answer";
  return all.length > 1 ? `answer ${idx + 1}/${all.length}: ${tag}` : `answer: ${tag}`;
};

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

/** Which body the layout draws — the overlay modes each own the screen. */
export type BodyKind = "help" | "doctor" | "confirm" | "plan" | "picker" | "logFull" | "split";

/** Everything `./app.tsx` needs for one frame. Pure projection of the state + UI bits. */
export interface FleetView {
  readonly state: TuiState;
  /** The initial `session.list` + `providers.list` reconcile — `error` once it
   *  has failed and not yet succeeded on a reconnect. */
  readonly boot: Loadable<string, void>;
  readonly tick: number;
  readonly logScroll: number;
  /** Top-anchored offset into the plan-review body (PgUp/PgDn/wheel). */
  readonly planScroll: number;
  readonly logFull: boolean;
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
}

const deriveView = (
  state: TuiState,
  boot: Loadable<string, void>,
  tick: number,
  logScroll: number,
  planScroll: number,
  logFull: boolean,
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
  // the two modes whose body is the fleet split; fullscreen log and every
  // overlay each own the screen.
  const showRequest =
    (state.mode === "browse" || state.mode === "prompt") &&
    !logFull &&
    sel?.status.kind === "awaiting_input" &&
    (firstPerm(pend) !== undefined || pend.question !== undefined || pend.plan !== undefined);

  // Never floor these above the real terminal size: the whole frame is laid
  // out at exactly `cols` × `rows`, and a frame wider/taller than the terminal
  // soft-wraps or scrolls — Ink's repaints then drift and the top bar slides
  // off the alt screen. Tiny terminals degrade; they don't corrupt.
  const cols = Math.max(1, dims.cols);
  const rows = Math.max(1, dims.rows);
  const footerH = promptRows(state, cols);
  const requestH = showRequest ? REQUEST_PANEL_ROWS : 0;
  const bodyH = Math.max(1, rows - 1 - footerH - requestH);
  // Fleet column: 32-col floor where the terminal affords it, yielding below
  // ~53 cols so `leftW + 1 + rightW` always sums to `cols`.
  const leftW = Math.min(Math.max(32, Math.round(cols * 0.4)), Math.max(8, cols - 21));
  const rightW = Math.max(1, cols - leftW - 1);
  // The right column is Detail (natural height) + gap 1 + the log, and must
  // sum to exactly bodyH — size the log against Detail's real row count
  // (detailRows), not a hardcoded guess, or a rich claude session overflows
  // the body and pushes the top of the UI off screen.
  const detailH = detailRows(sel, {
    account: sel ? providerAccountOf(state, sel.provider) : "",
    compacting: sel ? (state.compacting[sel.id] ?? null) : null,
    queued: sel ? queueFor(state, sel.id) : [],
  });
  // A session-targeted prompt draws its input group under the EVENTS log (its
  // label + editor rows) — budget them against the log's height.
  const paneH = promptOnPane(state.prompt) ? promptPaneRows(state, rightW) : 0;
  const splitLogH = Math.max(4, bodyH - detailH - 1 - paneH);
  const logH = logFull ? bodyH : splitLogH;
  const logPage = Math.max(1, logH - 3);

  const questionIdx =
    state.mode === "prompt" && state.prompt?.kind === "answerQuestion"
      ? (state.prompt.qaIdx ?? 0)
      : 0;

  let body: BodyKind = "split";
  if (state.mode === "help") body = "help";
  else if (state.mode === "doctor") body = "doctor";
  else if (state.mode === "confirm" && state.confirm) body = "confirm";
  else if (state.mode === "plan" && state.plan) body = "plan";
  else if (state.mode === "picker" && state.picker) body = "picker";
  // logFull yields to a reply prompt — its input draws on the EVENTS pane.
  else if (logFull && !promptOnPane(state.prompt)) body = "logFull";

  return {
    state,
    boot,
    tick,
    logScroll,
    planScroll,
    logFull,
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
  };
};

export const mkFleetHandle = ({
  client,
  term,
  logs,
  themeState,
  openEditorOverride,
}: MkFleetHandleInput): FleetHandle => {
  // File-only (stderr is silenced upstream); absent in tests, where nothing logs.
  const log = logs ? makeLogger("tui") : null;
  // Restore the persisted theme before building state: `setThemeMode` swaps C
  // in place and `initialState()` reports the active mode, so state and
  // palette already agree on the first frame.
  const savedTheme = themeState ? loadPersistedTheme(themeState) : null;
  if (savedTheme) setThemeMode(savedTheme);
  let state = initialState();
  let boot: Loadable<string, void> = loadableIdle;
  let tick = 0;
  let logScroll = 0;
  let planScroll = 0;
  let logFull = false;
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

  // Both are keyed by session id and never shrank on their own — one dead
  // entry per session ever seen. Prune to the live fleet on any list change.
  const forgetDeadSessions = (): void => {
    const live = new Set(state.sessions.map((s) => s.id));
    for (const id of draining) if (!live.has(id)) draining.delete(id);
    for (const id of lastDrainTurn.keys()) if (!live.has(id)) lastDrainTurn.delete(id);
  };

  const store = mkStore<FleetView>(
    deriveView(state, boot, tick, logScroll, planScroll, logFull, dims),
  );
  const publish = (): void =>
    store.set(deriveView(state, boot, tick, logScroll, planScroll, logFull, dims));

  // Ceiling for `logScroll` so scrolling up past the top of the log doesn't run
  // the counter away (leaving you to scroll back down the same distance before
  // the viewport moves). Wrapped rows ≥ line count; the extra page covers wrap.
  const scrollUp = (by: number): void => {
    const ceiling = visibleLog(state).length + store.get().logPage;
    logScroll = Math.min(ceiling, logScroll + by);
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

  // Sessions whose durable history has been pulled once this connection. A
  // resync / reconnect clears it — the epoch (and thus the history) may differ.
  const backfilledIds = new Set<string>();

  const backfillHistory = (): void => {
    const id = state.selectedId;
    if (!id || backfilledIds.has(id)) return;
    backfilledIds.add(id);
    client
      .request<EventPush[]>("session.events", { id })
      .then((frames) => {
        // De-dupe client-side against what's already in the log (O(n+m), not an
        // O(n) `log.some` scan per frame — U1), and mark the survivors `replay`
        // so `applyPush` treats them as transcript, not live state (U2).
        const have = new Set<string>();
        for (const l of state.log) have.add(`${l.epoch}:${l.seq}`);
        for (const frame of frames) {
          if (have.has(`${frame.epoch ?? ""}:${frame.seq}`)) continue;
          dispatch({ t: "push", frame, replay: true });
        }
      })
      .catch(() => {
        backfilledIds.delete(id); // an error / older daemon — allow a retry
      });
  };

  const drainQueues = (): void => {
    // A queue on a session that won't return to idle (done / error / gone) is
    // stranded — say so and drop it. An `interrupted` session is left alone
    // until the next `send` revives it.
    for (const [id, q] of Object.entries(state.queue)) {
      if (!q || q.length === 0) continue;
      const s = state.sessions.find((x) => x.id === id);
      if (!s || s.status.kind === "done" || s.status.kind === "error") {
        note(
          `${q.length} queued message${q.length === 1 ? "" : "s"} not sent — session ${s ? s.status.kind : "gone"}`,
          "bad",
        );
        dispatch({ t: "clearQueue", sessionId: id });
        lastDrainTurn.delete(id);
      }
    }
    for (const s of state.sessions) {
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
            const fresh = state.sessions.find((x) => x.id === s.id)?.turns ?? s.turns;
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
    )
      logScroll = 0;
    // A different plan review (or the overlay opening / closing) re-anchors the
    // plan body at its top.
    if (state.plan?.requestId !== prev.plan?.requestId) planScroll = 0;
    // Was `useEffect(() => { if (!overlay) overlayActed.current = null }, [mode])`.
    if (!OVERLAY_MODES.has(state.mode)) overlayActed = null;
    if (state.theme !== prev.theme) {
      setThemeMode(state.theme);
      // Remember the choice for the next launch — best-effort, like the log.
      if (themeState) persistTheme(themeState, state.theme);
    }
    publish();
    if (state.selectedId !== prev.selectedId) backfillHistory();
    if (state.sessions !== prev.sessions) forgetDeadSessions();
    if (
      state.sessions !== prev.sessions ||
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
      await openEditor(JSON.stringify({ tool: fp.tool, input: fp.input }, null, 2), {
        ext: "json",
      });
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
        const fp = firstPerm(pend);
        if (fp?.tool === "AskUserQuestion") {
          const qs = parseAskUserQuestions(fp.input);
          if (qs.length === 0)
            return note("malformed AskUserQuestion input — ⌃o to inspect", "bad");
          return void dispatch({
            t: "openPrompt",
            prompt: makePrompt({
              kind: "answerQuestion",
              sessionId: s.id,
              requestId: fp.id,
              label: questionPromptLabel(qs, 0),
              qaAll: qs,
              qaIdx: 0,
              qaAnswers: {},
            }),
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
      case "done":
        return perform(async () => {
          await client.request("session.markDone", { id: s.id, by });
          return "marked done";
        });
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
      case "mode": {
        const target = nextMode(s.mode as SessionMode);
        return perform(async () => {
          await client.request("session.setMode", { id: s.id, mode: target, by });
          return `mode → ${target}`;
        });
      }
      default:
        return absurd(name);
    }
  };

  /** Provider chosen → always show a model step. `draft` carries a half-typed
   *  `new` prompt through the detour. */
  const openModelStep = (providerId: string, label: string, draft?: string): void =>
    dispatch({
      t: "openPicker",
      picker: makePicker({
        kind: "model",
        title: `model · ${label}`,
        items: modelPickItems(state, providerId),
        emptyText: modelPickEmptyText(state, providerId),
        ctx: { provider: providerId, ...(draft !== undefined ? { draft } : {}) },
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
    return pl ? state.sessions.find((x) => x.id === pl.sessionId) : undefined;
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
    if (state.providers.length > 1) {
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
    openPlanModelStep(state.providers[0]?.id ?? ps?.provider ?? "claude");
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
      client
        .request("session.setModel", { id, model, by: client.clientId })
        .then(() => {
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
            text: `model switch failed: ${e instanceof Error ? e.message : String(e)}`,
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
        return void openModelStep(cur.id, cur.label, p.ctx?.draft);

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
    const provs = state.providers;
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
    openModelStep(only, provs[0]?.tag || only, draft);
  };

  /** `Esc` inside a picker — the step-back logic is pure (see
   *  {@link escapeTarget}); this just dispatches its result. */
  const escapePicker = (p: PickerState): void => dispatch(escapeTarget(p, state));

  /** Open a live model switcher (`⌥m`): the selected session, or an explicit
   *  one. From a `send` prompt, pass `draft` so the picker drops you back. */
  const switchModel = (sessionId?: string, draft?: string): void => {
    const s = sessionId ? state.sessions.find((x) => x.id === sessionId) : selectedSession(state);
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

  /** Open a live thinking-effort switcher (`⌥t`): the selected session, or an
   *  explicit one. Only offered when its current model takes an effort level. */
  const switchEffort = (sessionId?: string, draft?: string): void => {
    const s = sessionId ? state.sessions.find((x) => x.id === sessionId) : selectedSession(state);
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

  /** `⇧⇥` inside a `send` prompt: cycle the target session's permission mode on
   *  the daemon, leaving the half-typed message untouched. */
  const cyclePromptSessionMode = (sessionId: string): void => {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (!s) return void dispatch({ t: "notice", text: "session is gone", tone: "dim" });
    const target = nextMode(s.mode as SessionMode);
    client
      .request("session.setMode", { id: sessionId, mode: target, by: client.clientId })
      .then(() => dispatch({ t: "notice", text: `mode → ${modeLabel(target)}`, tone: "good" }))
      .catch((e: unknown) =>
        dispatch({
          t: "notice",
          text: `mode switch failed: ${e instanceof Error ? e.message : String(e)}`,
          tone: "bad",
        }),
      );
  };

  const submitPrompt = (): void => {
    const p = state.prompt;
    if (!p) return;
    const text = p.buffer.text.trim();
    const by = client.clientId;
    // `deny` and `compact` both treat an empty submit as a valid choice
    // (no reason / best-effort compaction); every other prompt needs text.
    if (p.kind !== "deny" && p.kind !== "compact" && !text) return;

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
          if (idx + 1 < p.qaAll.length) {
            const next = p.qaAll[idx + 1]!;
            dispatch({
              t: "openPrompt",
              prompt: makePrompt({
                kind: "answerQuestion",
                sessionId: p.sessionId,
                requestId: p.requestId,
                label: questionPromptLabel(p.qaAll, idx + 1),
                // pre-fill any answer already given for the next question, so
                // walking forward after a step-back doesn't lose it
                text: answers[next.question] ?? "",
                qaAll: p.qaAll,
                qaIdx: idx + 1,
                qaAnswers: answers,
              }),
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
    const liveCount = state.sessions.filter((s) => isLiveState(s.status)).length;
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
      dispatch({ t: "connection", value: "reconnecting" });
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
      case "fullscreen":
        if (sel) {
          logFull = !logFull;
          publish();
        }
        return;
      case "theme":
        return void dispatch({ t: "toggleTheme" });
      case "restart":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("restart") });
      case "quitall":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("quitAll") });
      case "gc": {
        // A bulk sweep — every done session's worktree goes (branches and rows
        // stay). Behind a confirm like `X`, since it deletes directories.
        const targets = state.sessions.filter((s) => s.status.kind === "done" && s.worktree);
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

    // Mouse wheel → scrolls the plan-review body while that overlay owns the
    // screen, otherwise the event log. `run.tsx` turns on SGR mouse reporting so
    // the wheel arrives as its own `[<Cb;Cx;Cy(M|m)` sequence — Ink passes it
    // through as raw `input` with every `key.*` flag false.
    const wheel = /^\[<(\d+);\d+;\d+[Mm]/.exec(input);
    if (wheel) {
      const base = Number(wheel[1]) & ~(4 | 8 | 16); // strip shift/meta/ctrl bits
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
      return; // horizontal wheel / click / drag — ignore
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
        if (p.kind === "send" && p.sessionId) return void cyclePromptSessionMode(p.sessionId);
        return;
      }
      // ⌥m swaps the model without leaving the prompt.
      if (key.meta && input === "m") {
        if (p.kind === "new") {
          const pid = p.provider ?? defaultProviderId(state);
          const tag = state.providers.find((x) => x.id === pid)?.tag ?? pid;
          return void openModelStep(pid, tag, p.buffer.text);
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
          const tag = state.providers.find((x) => x.id === pid)?.tag ?? pid;
          return void openEffortStep(pid, mid, tag, { draft: p.buffer.text });
        }
        if (p.kind === "send" && p.sessionId) return void switchEffort(p.sessionId, p.buffer.text);
        return;
      }
      if (key.meta && input === "p" && p.kind === "new") {
        return void pickProviderModel(p.buffer.text);
      }
      if (key.meta && input === "x" && p.kind === "send" && p.sessionId) {
        return void dispatch({ t: "clearQueue", sessionId: p.sessionId });
      }
      // ⌥⏎ while the target is still working queues for turn end instead of its
      // usual "insert a newline" meaning; bare ⏎ below sends now regardless.
      if (key.meta && key.return && p.kind === "send" && p.sessionId) {
        const target = state.sessions.find((x) => x.id === p.sessionId);
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
          // Esc within a multi-question AskUserQuestion steps back to the
          // previous question (its answer still filled in) rather than
          // abandoning the whole prompt; Esc on the first question cancels.
          if (p.kind === "answerQuestion" && p.qaAll && p.requestId && (p.qaIdx ?? 0) > 0) {
            const idx = p.qaIdx ?? 0;
            const prev = idx - 1;
            // Keep whatever is typed for the current question — the doc promises
            // "nothing typed is lost" across stepping back and forth, but only
            // submitted answers were being saved (U15).
            const answers = { ...p.qaAnswers, [p.qaAll[idx]!.question]: p.buffer.text };
            return void dispatch({
              t: "openPrompt",
              prompt: makePrompt({
                kind: "answerQuestion",
                sessionId: p.sessionId,
                requestId: p.requestId,
                label: questionPromptLabel(p.qaAll, prev),
                text: answers[p.qaAll[prev]!.question] ?? "",
                qaAll: p.qaAll,
                qaIdx: prev,
                qaAnswers: answers,
              }),
            });
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

    // The fleet filter is up: typing edits it (a single line, no history); ↑/↓
    // and PgUp/PgDn fall through — the selection and the log keep working. ⏎
    // accepts (and keeps ⏎'s fleet-row meaning below); esc clears.
    if (state.find) {
      if (key.escape) return void dispatch({ t: "closeFind" });
      if (key.return) dispatch({ t: "closeFind" });
      else if (!key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) {
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
    // Fleet drill-down: → enters the selected session's child rows (its live
    // background tasks + sub-agents — the tree already rendered under the row);
    // ↑/↓ then pick among them and the event pane follows the focused child.
    // ← / esc steps back out to the fleet. Other keys keep acting on the
    // session — children carry no actions of their own.
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
    // ⇧⇥ cycles the permission mode; plain Tab fullscreens the event log.
    if (key.tab && key.shift) return void (sel ? runAct("mode") : undefined);
    if (key.tab) {
      if (sel) {
        logFull = !logFull;
        publish();
      }
      return;
    }
    if (key.escape) {
      if (logFull) {
        logFull = false;
        publish();
      } else if (state.selectedChild != null) {
        dispatch({ t: "childExit" }); // back out of the drill-down
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
      r: "rebase", // inert unless the branch is behind its base (see allowedActs)
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
    if (client.daemonInfo)
      dispatch({ t: "hello", daemon: client.daemonInfo, sessions: client.sessions });
    refetch();
    void reconcileVersion();

    const offs = [
      client.onPush((frame) => dispatch({ t: "push", frame })),
      client.on("disconnect", () => {
        log?.warn("daemon disconnected");
        dispatch({ t: "connection", value: "reconnecting" });
      }),
      client.on("reconnect", () => {
        log?.info("daemon reconnected");
        dispatch({ t: "connection", value: "live" });
        backfilledIds.clear(); // epoch / history may differ — allow a re-pull
        refetch();
        if (restarting) {
          restarting = false;
          dispatch({ t: "notice", text: "daemon restarted", tone: "good" });
        }
        void reconcileVersion();
      }),
      client.on("resync", () => {
        log?.info("resync");
        backfilledIds.clear();
        refetch();
      }),
      client.on("close", () => {
        log?.warn("connection closed");
        dispatch({ t: "connection", value: "closed" });
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
        state.sessions.some((s) => s.status.kind === "running" || s.status.kind === "starting");
      if (!animating) return;
      tick = (tick + 1) % 100000;
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

  const refetch = (): void => {
    if (boot.tag !== "data") {
      boot = loadablePending;
      publish();
    }
    Promise.all([
      client
        .request<SessionSnapshot[]>("session.list")
        .then((sessions) => dispatch({ t: "sessions", sessions })),
      client
        .request<ProviderInfo[]>("providers.list")
        .then((list) => dispatch({ t: "providers", list })),
    ]).then(
      () => {
        boot = loadableLoaded(undefined);
        publish();
      },
      (e: unknown) => {
        // Was a silent `.catch(() => {})` per request. A reconnect re-runs this;
        // `boot` flips back to `data` if the retry lands.
        const msg = e instanceof Error ? e.message : String(e);
        log?.error("boot reconcile failed", { err: msg });
        boot = loadableFailed(msg);
        note("couldn't reach the daemon — will retry on reconnect", "bad");
        publish();
      },
    );
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
    dispatch({ t: "connection", value: "reconnecting" });
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
