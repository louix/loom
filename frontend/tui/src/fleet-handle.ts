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
import type { LoomClient } from "@loom/client";
import { makeLogger } from "@loom/core/logger";
import type { EventPush, ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { LOOM_VERSION } from "@loom/core/version";
import { spawnEditor, type EditorHandoff } from "./editor-handoff.ts";
import { applyKey, buffer } from "./editor.ts";
import { modeLabel, shortId } from "./theme.ts";
import { promptRows, REQUEST_PANEL_ROWS } from "./components.tsx";
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
  defaultModeOf,
  defaultModelOf,
  defaultProviderId,
  findPickItems,
  firstPerm,
  initialState,
  makePicker,
  makePrompt,
  modelPickEmptyText,
  modelPickItems,
  pendingFor,
  pickerCurrent,
  providerPickItems,
  queueFor,
  reduce,
  selectedSession,
  sessionLog,
  transcriptText,
  versionMismatchAction,
  type ActName,
  type Action,
  type ConfirmState,
  type LogLine,
  type Pending,
  type TuiState,
} from "./model.ts";

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
export type BodyKind = "help" | "confirm" | "plan" | "picker" | "logFull" | "split";

/** Everything `./app.tsx` needs for one frame. Pure projection of the state + UI bits. */
export interface FleetView {
  readonly state: TuiState;
  /** The initial `session.list` + `providers.list` reconcile — `error` once it
   *  has failed and not yet succeeded on a reconnect. */
  readonly boot: Loadable<string, void>;
  readonly tick: number;
  readonly logScroll: number;
  readonly logFull: boolean;
  readonly sel: SessionSnapshot | null;
  readonly pend: Pending;
  readonly allowed: ReadonlySet<ActName>;
  readonly showRequest: boolean;
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
  /** Test seam: stands in for the real `$EDITOR` handoff. */
  readonly openEditorOverride?: EditorHandoff;
}

const deriveView = (
  state: TuiState,
  boot: Loadable<string, void>,
  tick: number,
  logScroll: number,
  logFull: boolean,
  dims: { cols: number; rows: number },
): FleetView => {
  const sel = selectedSession(state);
  const pend = sel ? pendingFor(state, sel.id) : {};
  const allowed = allowedActs(sel);
  // The approve / answer / plan panel sits full-width just above the footer in
  // the two modes whose body is the fleet split; fullscreen log and every
  // overlay each own the screen.
  const showRequest =
    (state.mode === "browse" || state.mode === "prompt") &&
    !logFull &&
    sel?.status === "awaiting_input" &&
    (firstPerm(pend) !== undefined || pend.question !== undefined || pend.plan !== undefined);

  const cols = Math.max(60, dims.cols);
  const rows = Math.max(16, dims.rows);
  const footerH = promptRows(state);
  const requestH = showRequest ? REQUEST_PANEL_ROWS : 0;
  const bodyH = Math.max(6, rows - 1 - footerH - requestH);
  const leftW = Math.max(32, Math.min(52, Math.round(cols * 0.4)));
  const rightW = cols - leftW - 1;
  const splitLogH = Math.max(4, bodyH - 13);
  const logH = logFull ? bodyH : splitLogH;
  const logPage = Math.max(1, logH - 3);

  let body: BodyKind = "split";
  if (state.mode === "help") body = "help";
  else if (state.mode === "confirm" && state.confirm) body = "confirm";
  else if (state.mode === "plan" && state.plan) body = "plan";
  else if (state.mode === "picker" && state.picker) body = "picker";
  else if (logFull) body = "logFull";

  return {
    state,
    boot,
    tick,
    logScroll,
    logFull,
    sel,
    pend,
    allowed,
    showRequest: showRequest === true,
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
  openEditorOverride,
}: MkFleetHandleInput): FleetHandle => {
  // File-only (stderr is silenced upstream); absent in tests, where nothing logs.
  const log = logs ? makeLogger("tui") : null;
  let state = initialState();
  let boot: Loadable<string, void> = loadableIdle;
  let tick = 0;
  let logScroll = 0;
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
  // Sessions already backfilled from `session.events` this attach.
  const historyBackfilled = new Set<string>();
  // Queue-drain bookkeeping: which sessions have an in-flight release, and the
  // `turns` value each last released at (so the next waits for a real turn).
  const draining = new Set<string>();
  const lastDrainTurn = new Map<string, number>();

  // All three are keyed by session id and never shrank on their own — one dead
  // entry per session ever seen. Prune to the live fleet on any list change.
  const forgetDeadSessions = (): void => {
    const live = new Set(state.sessions.map((s) => s.id));
    for (const id of historyBackfilled) if (!live.has(id)) historyBackfilled.delete(id);
    for (const id of draining) if (!live.has(id)) draining.delete(id);
    for (const id of lastDrainTurn.keys()) if (!live.has(id)) lastDrainTurn.delete(id);
  };

  const store = mkStore<FleetView>(deriveView(state, boot, tick, logScroll, logFull, dims));
  const publish = (): void => store.set(deriveView(state, boot, tick, logScroll, logFull, dims));

  const backfillHistory = (): void => {
    const id = state.selectedId;
    // The live/replayed push ring is cross-session and bounded, so a quiet
    // session's events can be long gone from it even though the daemon still
    // has them on disk. Frames carry the same global seq the ring uses, so
    // dispatching them as ordinary pushes de-dupes for free.
    if (!id || historyBackfilled.has(id)) return;
    historyBackfilled.add(id);
    client
      .request<EventPush[]>("session.events", { id })
      .then((frames) => {
        for (const frame of frames) dispatch({ t: "push", frame });
      })
      .catch(() => {}); // an older daemon without this RPC just backfills nothing
  };

  const drainQueues = (): void => {
    // A queue on a session that won't return to idle (done / error / gone) is
    // stranded — say so and drop it. An `interrupted` session is left alone
    // until the next `send` revives it.
    for (const [id, q] of Object.entries(state.queue)) {
      if (!q || q.length === 0) continue;
      const s = state.sessions.find((x) => x.id === id);
      if (!s || s.status === "done" || s.status === "error") {
        note(
          `${q.length} queued message${q.length === 1 ? "" : "s"} not sent — session ${s ? s.status : "gone"}`,
          "bad",
        );
        dispatch({ t: "clearQueue", sessionId: id });
        lastDrainTurn.delete(id);
      }
    }
    for (const s of state.sessions) {
      const q = state.queue[s.id];
      if (
        s.status === "idle" &&
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
            lastDrainTurn.set(s.id, s.turns); // only gate the next one after a success
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
    // Was `useEffect(() => setLogScroll(0), [selectedId, logFilter])`.
    if (state.selectedId !== prev.selectedId || state.logFilter !== prev.logFilter) logScroll = 0;
    // Was `useEffect(() => { if (!overlay) overlayActed.current = null }, [mode])`.
    if (!OVERLAY_MODES.has(state.mode)) overlayActed = null;
    publish();
    if (state.selectedId !== prev.selectedId) backfillHistory();
    if (state.sessions !== prev.sessions) forgetDeadSessions();
    if (state.sessions !== prev.sessions || state.queue !== prev.queue) drainQueues();
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
    sessionId,
    kind: "echo",
    glyph: "›",
    text: text.replace(/\s+/g, " ").trim(),
    tone: "accent",
    ts: Date.now(),
  });

  /** `⌃o` dump: the selected session's whole log as a readable transcript. */
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
      return note("open a prompt first — ⌃o views the log", "dim");
    const p = state.prompt;
    const next = await openEditor(p.buffer.text, {
      ext: p.kind === "new" ? "md" : "txt",
      aside: { name: "events.log", body: logText() },
    });
    if (next != null) dispatch({ t: "promptSet", buffer: buffer(next.replace(/\s+$/, "")) });
  };

  /** `⌃o` — open the pending request, or the event log, in `$EDITOR` read-only. */
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
      return void dispatch({ t: "logFilter", value: state.logFilter === "chat" ? "full" : "chat" });
    }
    if (name === "find") {
      return void dispatch({
        t: "openPicker",
        picker: makePicker({ kind: "find", title: "find session", items: findPickItems(state) }),
      });
    }
    if (name === "help") return void dispatch({ t: "help", value: state.mode !== "help" });
    if (name === "quit") return quitTui();
    if (!s) return;
    if (name === "undo") {
      const sid = s.id;
      const turns = s.turns;
      client
        .request<Array<{ turn: number; userText: string; rewindCostUsd: number }>>(
          "session.checkpoints",
          { id: sid },
        )
        .then((cps) => {
          const items = cps
            .filter((c) => c.turn < turns)
            .map((c) => ({
              id: String(c.turn),
              label: `turn ${c.turn} · ${c.userText || "(no message)"}`,
              ...(c.rewindCostUsd > 0
                ? { hint: `~$${c.rewindCostUsd.toFixed(2)} to re-prime` }
                : {}),
            }));
          if (items.length === 0) {
            return void dispatch({ t: "notice", text: "no earlier turn to undo to", tone: "dim" });
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
        const requestId = pendingFor(state, s.id).question;
        if (!requestId) return note("no question pending", "dim");
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({ kind: "answer", sessionId: s.id, requestId, label: "answer" }),
        });
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
            label: "compact — focus (blank = full)",
          }),
        });
      case "done":
        return perform(async () => {
          await client.request("session.markDone", { id: s.id, by });
          return "marked done";
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
        emptyText: modelPickEmptyText(providerId),
        ctx: { provider: providerId, ...(draft !== undefined ? { draft } : {}) },
      }),
    });

  /** Resolve the open picker's highlighted item by its kind. */
  const choosePicked = (): void => {
    const p = state.picker;
    if (!p || overlayActed === p) return;
    overlayActed = p;
    const cur = pickerCurrent(p);

    // Empty model step: enter continues to the prompt with just the provider
    // (the daemon falls back to that provider's default model).
    if (!cur) {
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
      return void dispatch({ t: "closePicker" });
    }

    switch (p.kind) {
      case "provider":
        return void openModelStep(cur.id, cur.label, p.ctx?.draft);

      case "model": {
        if (p.ctx?.liveSessionId) {
          const id = p.ctx.liveSessionId;
          const back = p.ctx.reopenSend;
          const draft = p.ctx.draft;
          dispatch({ t: "closePicker" });
          // Came from a `send` prompt (⌥m mid-message) → drop the user back into
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
            .request("session.setModel", { id, model: cur.id, by: client.clientId })
            .then(() =>
              dispatch({ t: "notice", text: `model → ${cur.id} · next turn`, tone: "good" }),
            )
            .catch((e: unknown) =>
              dispatch({
                t: "notice",
                text: `model switch failed: ${e instanceof Error ? e.message : String(e)}`,
                tone: "bad",
              }),
            );
          return;
        }
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({
            kind: "new",
            sessionId: null,
            label: "new session",
            ...(p.ctx?.provider ? { provider: p.ctx.provider } : {}),
            ...(p.ctx?.draft !== undefined ? { text: p.ctx.draft } : {}),
            model: cur.id,
          }),
        });
      }

      case "undo": {
        const id = p.ctx?.liveSessionId;
        const toTurn = Number(cur.id);
        dispatch({ t: "closePicker" });
        if (!id) return;
        client
          .request("session.rewind", { id, toTurn, by: client.clientId })
          .then(() => dispatch({ t: "notice", text: `rewound to turn ${toTurn}`, tone: "good" }))
          .catch((e: unknown) =>
            dispatch({
              t: "notice",
              text: `rewind failed: ${e instanceof Error ? e.message : String(e)}`,
              tone: "bad",
            }),
          );
        return;
      }

      case "find":
        dispatch({ t: "select", id: cur.id });
        dispatch({ t: "closePicker" });
        return;

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

  /** Open a live model switcher (`⌥m`): the selected session, or an explicit
   *  one. From a `send` prompt, pass `draft` so the picker drops you back. */
  const switchModel = (sessionId?: string, draft?: string): void => {
    const s = sessionId ? state.sessions.find((x) => x.id === sessionId) : selectedSession(state);
    if (!s) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
    const models = modelPickItems(state, s.provider);
    if (models.length === 0) {
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
    // (no reason / compact the whole history); every other prompt needs text.
    if (p.kind !== "deny" && p.kind !== "compact" && !text) return;
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
          return r.injected ? "injected — lands after the current tool call" : "sent";
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
        note(e instanceof Error ? e.message : String(e), "bad");
        reopen(); // retryable — the text comes back so it can be edited and re-sent
      });
  };

  // ⌥⏎ on a `send` prompt targeting a running/starting session: queue for
  // turn end instead of the normal bare-⏎ "send now" path.
  const queueSend = (sessionId: string, text: string): void => {
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
    note("queued for turn end", "dim");
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

  /** `e` in the plan overlay — edit the plan in $EDITOR, then implement it. */
  const editPlan = async (): Promise<void> => {
    const pl = state.plan;
    if (!pl) return;
    const edited = await openEditor(pl.text, { ext: "md" });
    const plan = edited?.trim();
    if (!plan) return note("plan unchanged — nothing sent", "dim");
    respondPlan({ action: "revise", plan }, "implementing your edited plan");
  };

  // ---- daemon lifecycle ---------------------------------------
  const confirmFor = (action: "restart" | "quitAll"): ConfirmState => {
    const liveCount = state.sessions.filter(
      (s) => s.status === "running" || s.status === "starting" || s.status === "awaiting_input",
    ).length;
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
    return {
      title: `Delete session ${shortId(s.id)}?`,
      body: canBranch
        ? `${name} — its worktree, stored transcript, and branch go too. Press b to keep the branch.`
        : `${name} — its worktree and stored transcript go too.`,
      danger: true,
      action: "deleteSession",
      sessionId: s.id,
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
        await client.close();
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
      case "model":
        return void switchModel();
      case "fullscreen":
        if (sel) {
          logFull = !logFull;
          publish();
        }
        return;
      case "restart":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("restart") });
      case "quitall":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("quitAll") });
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
        if (sel.provider === "claude") {
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
        if (sel.status === "awaiting_input") {
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

    // Mouse wheel → always scrolls the event log. `run.tsx` turns on SGR mouse
    // reporting so the wheel arrives as its own `[<Cb;Cx;Cy(M|m)` sequence —
    // Ink passes it through as raw `input` with every `key.*` flag false.
    const wheel = /^\[<(\d+);\d+;\d+[Mm]/.exec(input);
    if (wheel) {
      const base = Number(wheel[1]) & ~(4 | 8 | 16); // strip shift/meta/ctrl bits
      if (base === 64) {
        logScroll = logScroll + 3; // wheel up → back in history
        return publish();
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
          const pid = p.provider ?? state.providers[0]?.id ?? "claude";
          const tag = state.providers.find((x) => x.id === pid)?.tag ?? pid;
          return void openModelStep(pid, tag, p.buffer.text);
        }
        if (p.kind === "send" && p.sessionId) return void switchModel(p.sessionId, p.buffer.text);
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
        if (target && (target.status === "running" || target.status === "starting")) {
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
          return void dispatch({ t: "closePrompt", saveDraft: true });
        case "submit":
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
      if (input === "i") return respondPlan({ action: "implement" }, "implementing the plan");
      if (input === "f")
        return respondPlan({ action: "implement_fresh" }, "compacting, then implementing");
      if (input === "e") return void editPlan();
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
      return; // esc / everything else: a plan review must be answered
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

    if (state.mode === "picker" && state.picker) {
      const p = state.picker;
      if (key.escape) return void dispatch({ t: "closePicker" });
      if (key.upArrow) return void dispatch({ t: "pickerMove", delta: -1 });
      if (key.downArrow) return void dispatch({ t: "pickerMove", delta: 1 });
      if (key.return) {
        // The command palette runs an action through the shared dispatcher; the
        // provider / model / find / undo pickers resolve by kind in choosePicked.
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
      if (key.backspace || key.delete) {
        return void dispatch({ t: "pickerFilter", value: p.filter.slice(0, -1) });
      }
      // append printable input (single keys and fast/pasted runs alike)
      if (input && !key.ctrl && !key.meta && !key.tab && /^[\x20-\x7e]+$/.test(input)) {
        return void dispatch({ t: "pickerFilter", value: p.filter + input });
      }
      return;
    }

    // ---- browse ----
    if (key.pageUp) {
      logScroll = logScroll + Math.max(1, logPage - 1);
      return publish();
    }
    if (key.pageDown) {
      logScroll = Math.max(0, logScroll - Math.max(1, logPage - 1));
      return publish();
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
      }
      return;
    }
    // Enter on a fleet row = act on it.
    if (key.return) {
      if (allowed.has("send")) return runAct("send");
      if (allowed.has("answer")) return runAct("answer");
      if (allowed.has("planreview")) return runAct("planreview");
      return;
    }
    // ⌥m switches the selected session's model — the one Alt key that also acts
    // from the fleet view (its sibling ⇧⇥ does the same for the mode).
    if (key.meta && input === "m") return void (sel ? runAct("model") : undefined);
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
      u: "undo",
      e: "title",
      y: "copybranch",
      o: "viewlog",
      v: "filter",
      n: "new",
      f: "find",
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
        refetch();
        if (restarting) {
          restarting = false;
          dispatch({ t: "notice", text: "daemon restarted", tone: "good" });
        }
        void reconcileVersion();
      }),
      client.on("resync", () => {
        log?.info("resync");
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
      tick = (tick + 1) % 100000;
      dispatch({ t: "expireNotice", now: Date.now() });
      publish(); // the tick bump alone needs a frame (spinner) even if nothing expired
    }, 120);

    // Backfill the log from history the daemon replayed before mount (re-opening
    // the TUI against a live daemon); live frames de-dupe against it by seq.
    for (const frame of client.bufferedEvents) dispatch({ t: "push", frame });

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
