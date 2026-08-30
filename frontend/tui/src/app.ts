/**
 * Root Ink component: binds a {@link LoomClient} to the TUI model, owns the
 * keymap, and turns key presses into daemon RPCs. Rendering delegates to the
 * pure components in `./components.ts`; state logic lives in `./model.ts`;
 * single-key text editing lives in `./editor.ts`. Written with `createElement`
 * (no JSX) to keep the no-build-step constraint.
 */
import {
  createElement as h,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { LoomClient } from "@loom/client";
import type { EventPush, ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { SESSION_MODES, type SessionMode } from "@loom/core/types";
import { LOOM_VERSION } from "@loom/core/version";
import { spawnEditor, type EditorHandoff } from "./editor-handoff.ts";
import { applyKey, buffer } from "./editor.ts";
import { C, modeLabel, shortId } from "./theme.ts";
import {
  Confirm,
  Detail,
  EventLog,
  Fleet,
  FooterArea,
  Header,
  Help,
  Picker,
  PlanReview,
  promptRows,
  RequestPanel,
  REQUEST_PANEL_ROWS,
} from "./components.ts";
import {
  allowedActs,
  commandsFor,
  defaultModeOf,
  defaultModelOf,
  defaultProviderId,
  findPickItems,
  initialState,
  makePicker,
  firstPerm,
  makePrompt,
  modelPickEmptyText,
  modelPickItems,
  pendingFor,
  pickerCurrent,
  providerColorOf,
  providerPickItems,
  queueFor,
  reduce,
  selectedSession,
  sessionLog,
  transcriptText,
  versionMismatchAction,
  type ActName,
  type ConfirmState,
  type LogLine,
} from "./model.ts";

const nextMode = (m: SessionMode): SessionMode =>
  SESSION_MODES[(SESSION_MODES.indexOf(m) + 1) % SESSION_MODES.length] ?? "default";

export function App({
  client,
  /** Test seam: override the real `$EDITOR` handoff. */
  openEditor: openEditorOverride,
}: {
  client: LoomClient;
  openEditor?: EditorHandoff;
}): ReactNode {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const [tick, setTick] = useState(0);
  const [logScroll, setLogScroll] = useState(0);
  const [logFull, setLogFull] = useState(false);
  const [dims, setDims] = useState(() => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 }));
  const restarting = useRef(false);
  const versionRestartTried = useRef(false);
  const echoSeq = useRef(0);
  // Synchronous latch: Ink invokes the key handler once per byte of a stdin
  // chunk before React re-renders, so a batched "aa" would resolve an overlay
  // twice (double send / double shutdown). Holds the overlay object we already
  // acted on — a fresh overlay (e.g. provider picker → model picker) has a new
  // identity and passes.
  const overlayActed = useRef<object | null>(null);
  // Sessions already backfilled from `session.events` this attach — a session
  // switch shouldn't re-fetch what's already in `state.log`.
  const historyBackfilled = useRef(new Set<string>());

  // ---- client wiring --------------------------------------------------
  const refetch = useCallback(() => {
    void client
      .request<SessionSnapshot[]>("session.list")
      .then((sessions) => dispatch({ t: "sessions", sessions }))
      .catch(() => {});
    void client
      .request<ProviderInfo[]>("providers.list")
      .then((list) => dispatch({ t: "providers", list }))
      .catch(() => {});
  }, [client]);

  /**
   * The daemon should be invisible: if it's an older build than this UI (usually
   * a rebuild while the old daemon kept running), bounce it once —
   * `daemon.shutdown` + the client's reconnect/autospawn brings up a fresh one
   * and sessions resume. But a restart interrupts *every* attached client and
   * every running turn, so when another client or a live session is present we
   * ask first instead. A second mismatch after that just nags.
   */
  const reconcileVersion = useCallback(async () => {
    const dv = client.daemonInfo?.version;
    if (restarting.current || !dv || dv === LOOM_VERSION) return;

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
      alreadyHandled: versionRestartTried.current,
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
      versionRestartTried.current = true;
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
    versionRestartTried.current = true;
    restarting.current = true;
    dispatch({ t: "connection", value: "reconnecting" });
    dispatch({ t: "notice", text: `daemon v${dv} ≠ ui v${LOOM_VERSION} — respawning`, tone: "dim" });
    client.request("daemon.shutdown").catch(() => {});
  }, [client]);

  useEffect(() => {
    if (client.daemonInfo) dispatch({ t: "hello", daemon: client.daemonInfo, sessions: client.sessions });
    refetch();
    void reconcileVersion();
    const offs = [
      client.onPush((frame) => dispatch({ t: "push", frame })),
      client.on("disconnect", () => dispatch({ t: "connection", value: "reconnecting" })),
      client.on("reconnect", () => {
        dispatch({ t: "connection", value: "live" });
        refetch();
        if (restarting.current) {
          restarting.current = false;
          dispatch({ t: "notice", text: "daemon restarted", tone: "good" });
        }
        void reconcileVersion();
      }),
      client.on("resync", () => refetch()),
      client.on("close", () => dispatch({ t: "connection", value: "closed" })),
    ];
    // Backfill the log from history the daemon replayed before this component
    // mounted (re-opening the TUI against a live daemon); live frames that also
    // land in this list de-dupe against it by seq.
    for (const frame of client.bufferedEvents) dispatch({ t: "push", frame });
    return () => {
      for (const off of offs) off();
    };
  }, [client, refetch, reconcileVersion]);

  // ---- tickers ------------------------------------------------------
  useEffect(() => {
    const iv = setInterval(() => {
      setTick((t) => (t + 1) % 100000);
      dispatch({ t: "expireNotice", now: Date.now() });
    }, 120);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const onResize = () => setDims({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  // snap the log back to the live tail when the view changes underneath it
  useEffect(() => setLogScroll(0), [state.selectedId, state.logFilter]);

  // The first time a session is selected this attach, backfill its durable
  // history — the live/replayed push ring is cross-session and bounded, so a
  // quiet session's events can be long gone from it even though the daemon
  // still has them on disk (`session.events`). Frames carry the same global
  // seq the ring uses, so dispatching them as ordinary pushes de-dupes for
  // free against anything the ring already delivered.
  useEffect(() => {
    const id = state.selectedId;
    if (!id || historyBackfilled.current.has(id)) return;
    historyBackfilled.current.add(id);
    client
      .request<EventPush[]>("session.events", { id })
      .then((frames) => {
        for (const frame of frames) dispatch({ t: "push", frame });
      })
      .catch(() => {}); // an older daemon without this RPC just backfills nothing
  }, [state.selectedId, client]);

  // ---- helpers ----------------------------------------------------
  const note = useCallback(
    (text: string, tone: "good" | "bad" | "dim" | "accent" = "good") => dispatch({ t: "notice", text, tone }),
    [],
  );
  const quitTui = useCallback(() => {
    client.close().catch(() => {});
    exit();
  }, [client, exit]);
  const echoLine = useCallback(
    (sessionId: string, text: string): LogLine => ({
      seq: --echoSeq.current,
      sessionId,
      kind: "echo",
      glyph: "›",
      text: text.replace(/\s+/g, " ").trim(),
      tone: "accent",
      ts: Date.now(),
    }),
    [],
  );

  /** `⌃o` dump: the selected session's whole log as a readable transcript. */
  const logText = useCallback((): string => transcriptText(sessionLog(state)), [state]);

  /**
   * Hand the terminal to `$EDITOR` and hand it back. `suspendTerminal` (Ink 7.1)
   * flushes the current frame, pauses input, runs the child, then resets Ink's
   * diff state and forces a full redraw — the thing the old manual
   * `clear()` + `rerender()` missed, which left the screen blank until the next
   * keypress. Bracketed paste is ours (set outside Ink in `run.ts`), so Ink's
   * `resumeInput` won't restore it — re-assert it here.
   */
  const openEditor = useCallback<EditorHandoff>(
    async (text, opts) => {
      if (openEditorOverride) return openEditorOverride(text, opts);
      let saved: string | null = null;
      try {
        await suspendTerminal(async () => {
          saved = spawnEditor(text, opts);
        });
      } catch (e) {
        saved = null;
        note(e instanceof Error ? e.message : String(e), "bad");
      }
      if (stdout.isTTY) stdout.write("\x1b[?2004h\x1b[?1000h\x1b[?1006h");
      return saved;
    },
    [openEditorOverride, suspendTerminal, stdout, note],
  );

  /** `⌃e` — edit the open prompt's text in `$EDITOR`, with the event log alongside. */
  const editPrompt = useCallback(async () => {
    if (state.mode !== "prompt" || !state.prompt) return note("open a prompt first — ⌃o views the log", "dim");
    const p = state.prompt;
    const next = await openEditor(p.buffer.text, {
      ext: p.kind === "new" ? "md" : "txt",
      aside: { name: "events.log", body: logText() },
    });
    if (next != null) dispatch({ t: "promptSet", buffer: buffer(next.replace(/\s+$/, "")) });
  }, [state.mode, state.prompt, openEditor, note, logText]);

  /** `⌃o` — open the pending request, or the event log, in `$EDITOR` read-only. */
  const viewInEditor = useCallback(async () => {
    const s = selectedSession(state);
    const pend = s ? pendingFor(state, s.id) : {};
    const fp = firstPerm(pend);
    if (pend.plan !== undefined) {
      await openEditor(pend.planText ?? "", { ext: "md" });
    } else if (fp) {
      await openEditor(JSON.stringify({ tool: fp.tool, input: fp.input }, null, 2), { ext: "json" });
    } else if (pend.question !== undefined) {
      await openEditor([pend.questionText ?? "", "", pend.questionContext ?? ""].join("\n"), { ext: "md" });
    } else {
      await openEditor(logText(), { ext: "log" });
    }
  }, [openEditor, state, logText]);

  const copyToClipboard = useCallback(
    (text: string, label: string) => {
      try {
        stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
        note(`copied ${label}`, "good");
      } catch {
        note("clipboard copy failed", "bad");
      }
    },
    [stdout, note],
  );

  // ---- session actions ------------------------------------------
  const perform = useCallback(
    (fn: () => Promise<string>) => {
      fn()
        .then((m) => m && note(m, "good"))
        .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"));
    },
    [note],
  );

  const act = useCallback(
    (name: ActName) => {
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
                ...(c.rewindCostUsd > 0 ? { hint: `~$${c.rewindCostUsd.toFixed(2)} to re-prime` } : {}),
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
            const r = await client.request<{ alreadyResolved: boolean }>("session.respondPermission", {
              id: s.id,
              requestId,
              decision: "allow",
              by,
            });
            dispatch({ t: "resolvePerm", sessionId: s.id, id: requestId });
            return r.alreadyResolved ? `${requestId} already resolved` : `approved ${requestId}`;
          });
        }
        case "deny": {
          const fp = firstPerm(pendingFor(state, s.id));
          if (!fp) return note("no permission request pending", "dim");
          return void dispatch({
            t: "openPrompt",
            prompt: makePrompt({ kind: "deny", sessionId: s.id, requestId: fp.id, label: `deny ${fp.id}` }),
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
            prompt: makePrompt({ kind: "title", sessionId: s.id, label: "rename", text: s.title ?? "" }),
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
      }
    },
    [state, client, note, perform, quitTui],
  );

  /** Provider chosen → always show a model step (empty state and all).
   *  `draft` carries a half-typed `new` prompt through the detour. */
  const openModelStep = useCallback(
    (providerId: string, label: string, draft?: string) =>
      dispatch({
        t: "openPicker",
        picker: makePicker({
          kind: "model",
          title: `model · ${label}`,
          items: modelPickItems(state, providerId),
          emptyText: modelPickEmptyText(providerId),
          ctx: { provider: providerId, ...(draft !== undefined ? { draft } : {}) },
        }),
      }),
    [state],
  );

  /** Resolve the open picker's highlighted item by its kind. */
  const choosePicked = useCallback(() => {
    const p = state.picker;
    if (!p || overlayActed.current === p) return;
    overlayActed.current = p;
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

    if (p.kind === "provider") {
      return void openModelStep(cur.id, cur.label, p.ctx?.draft);
    }

    if (p.kind === "model") {
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
            prompt: makePrompt({ kind: "send", sessionId: back, label: "send", ...(draft !== undefined ? { text: draft } : {}) }),
          });
        }
        client
          .request("session.setModel", { id, model: cur.id, by: client.clientId })
          .then(() => dispatch({ t: "notice", text: `model → ${cur.id} · next turn`, tone: "good" }))
          .catch((e: unknown) =>
            dispatch({ t: "notice", text: `model switch failed: ${e instanceof Error ? e.message : String(e)}`, tone: "bad" }),
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

    if (p.kind === "undo") {
      const id = p.ctx?.liveSessionId;
      const toTurn = Number(cur.id);
      dispatch({ t: "closePicker" });
      if (!id) return;
      client
        .request("session.rewind", { id, toTurn, by: client.clientId })
        .then(() => dispatch({ t: "notice", text: `rewound to turn ${toTurn}`, tone: "good" }))
        .catch((e: unknown) =>
          dispatch({ t: "notice", text: `rewind failed: ${e instanceof Error ? e.message : String(e)}`, tone: "bad" }),
        );
      return;
    }

    // find
    dispatch({ t: "select", id: cur.id });
    dispatch({ t: "closePicker" });
  }, [state, client, openModelStep]);

  /** `⌃P` in the new-session prompt: pick the provider (skipped when there's
   *  only one), then the model, then land back on the prompt with `draft`
   *  restored and the choice applied. */
  const pickProviderModel = useCallback(
    (draft: string) => {
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
    },
    [state, openModelStep],
  );

  /** Open a live model switcher (`⌥m`): the selected session, or an explicit
   *  one. From a `send` prompt, pass `draft` so the picker drops you back into
   *  the half-typed message afterwards. */
  const switchModel = useCallback(
    (sessionId?: string, draft?: string) => {
      const s = sessionId ? state.sessions.find((x) => x.id === sessionId) : selectedSession(state);
      if (!s) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
      const models = modelPickItems(state, s.provider);
      if (models.length === 0) {
        return void dispatch({ t: "notice", text: `${s.provider} has no alternate models`, tone: "dim" });
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
    },
    [state],
  );

  /** `⇧⇥` inside a `send` prompt: cycle the target session's permission mode on
   *  the daemon, leaving the half-typed message untouched. */
  const cyclePromptSessionMode = useCallback(
    (sessionId: string) => {
      const s = state.sessions.find((x) => x.id === sessionId);
      if (!s) return void dispatch({ t: "notice", text: "session is gone", tone: "dim" });
      const target = nextMode(s.mode as SessionMode);
      client
        .request("session.setMode", { id: sessionId, mode: target, by: client.clientId })
        .then(() => dispatch({ t: "notice", text: `mode → ${modeLabel(target)}`, tone: "good" }))
        .catch((e: unknown) =>
          dispatch({ t: "notice", text: `mode switch failed: ${e instanceof Error ? e.message : String(e)}`, tone: "bad" }),
        );
    },
    [state.sessions, client],
  );

  const submitPrompt = useCallback(() => {
    const p = state.prompt;
    if (!p) return;
    const text = p.buffer.text.trim();
    const by = client.clientId;
    // `deny` and `compact` both treat an empty submit as a valid choice
    // (no reason / compact the whole history); every other prompt needs text.
    if (p.kind !== "deny" && p.kind !== "compact" && !text) return;
    const reopen = () =>
      dispatch({ t: "openPrompt", prompt: { ...p, buffer: buffer(p.buffer.text), histIdx: 0, draft: "" } });

    dispatch({ t: "closePrompt" });

    const run = async (): Promise<string> => {
      if (p.kind === "new") {
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
      if (p.kind === "send" && p.sessionId) {
        // No local echo — the daemon emits a `user_message` event that every
        // client (this one included) renders, so there's one source of truth.
        // The RPC tells us whether it actually landed mid-turn.
        const r = await client.request<{ injected?: boolean }>("session.send", { id: p.sessionId, text });
        dispatch({ t: "pushHistory", text });
        return r.injected ? "injected — lands after the current tool call" : "sent";
      }
      if (p.kind === "title" && p.sessionId) {
        await client.request("session.setTitle", { id: p.sessionId, title: text, by });
        return "renamed";
      }
      if (p.kind === "compact" && p.sessionId) {
        await client.request("session.compact", {
          id: p.sessionId,
          ...(text ? { instructions: text } : {}),
        });
        return text ? "compacting — focused" : "compacting context";
      }
      if (p.kind === "discuss" && p.sessionId && p.requestId) {
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
      if (p.kind === "answer" && p.sessionId && p.requestId) {
        const r = await client.request<{ alreadyResolved: boolean }>("session.answer", {
          id: p.sessionId,
          requestId: p.requestId,
          text,
          by,
        });
        return r.alreadyResolved ? "already answered" : "answered";
      }
      if (p.kind === "deny" && p.sessionId && p.requestId) {
        const r = await client.request<{ alreadyResolved: boolean }>("session.respondPermission", {
          id: p.sessionId,
          requestId: p.requestId,
          decision: "deny",
          by,
          ...(text ? { message: text } : {}),
        });
        dispatch({ t: "resolvePerm", sessionId: p.sessionId, id: p.requestId });
        return r.alreadyResolved ? `${p.requestId} already resolved` : `denied ${p.requestId}`;
      }
      return "";
    };

    run()
      .then((m) => m && note(m, "good"))
      .catch((e: unknown) => {
        note(e instanceof Error ? e.message : String(e), "bad");
        reopen(); // retryable — the text comes back so it can be edited and re-sent
      });
  }, [state.prompt, state.promptHistory, state.sessions, client, note, echoLine]);

  // ⌥⏎ on a `send` prompt targeting a running/starting session: queue for
  // turn end instead of the normal bare-⏎ "send now" path.
  const queueSend = useCallback(
    (sessionId: string, text: string) => {
      dispatch({ t: "closePrompt" });
      dispatch({ t: "enqueue", sessionId, text });
      dispatch({ t: "pushHistory", text });
      dispatch({
        t: "echo",
        line: { ...echoLine(sessionId, text), glyph: "▸", tone: "dim", text: `queued: ${text.replace(/\s+/g, " ").trim()}` },
      });
      note("queued for turn end", "dim");
    },
    [echoLine, note],
  );

  /** Resolve the open plan review with `params` (an `action` plus any payload). */
  const respondPlan = useCallback(
    (params: Record<string, unknown>, label: string) => {
      const pl = state.plan;
      if (!pl || overlayActed.current === pl) return;
      overlayActed.current = pl;
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
          dispatch({ t: "openPlan", sessionId: pl.sessionId, requestId: pl.requestId, text: pl.text });
        });
    },
    [state.plan, client, note],
  );

  /** `e` in the plan overlay — edit the plan in $EDITOR, then implement what was saved. */
  const editPlan = useCallback(async () => {
    const pl = state.plan;
    if (!pl) return;
    const edited = await openEditor(pl.text, { ext: "md" });
    const plan = edited?.trim();
    if (!plan) return note("plan unchanged — nothing sent", "dim");
    respondPlan({ action: "revise", plan }, "implementing your edited plan");
  }, [state.plan, openEditor, note, respondPlan]);

  // Release the overlay latch once we're no longer in an overlay mode.
  useEffect(() => {
    if (!["confirm", "plan", "picker"].includes(state.mode)) {
      overlayActed.current = null;
    }
  }, [state.mode]);

  // Drain a session's queued messages — one per completed turn, while idle.
  const draining = useRef<Set<string>>(new Set());
  // id → the `turns` value at which we last released a queued item, so the
  // next release waits for a real turn to complete (not a burst, and robust to
  // React batching an idle→running→idle cycle into one render).
  const lastDrainTurn = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    // A queue on a session that won't return to idle (done / error / gone) is
    // stranded — say so and drop it rather than showing "N queued" forever.
    // An `interrupted` session is left alone until the next `send` revives it.
    for (const [id, q] of Object.entries(state.queue)) {
      if (!q || q.length === 0) continue;
      const s = state.sessions.find((x) => x.id === id);
      if (!s || s.status === "done" || s.status === "error") {
        note(`${q.length} queued message${q.length === 1 ? "" : "s"} not sent — session ${s ? s.status : "gone"}`, "bad");
        dispatch({ t: "clearQueue", sessionId: id });
        lastDrainTurn.current.delete(id);
      }
    }
    for (const s of state.sessions) {
      const q = state.queue[s.id];
      if (
        s.status === "idle" &&
        q &&
        q.length > 0 &&
        !draining.current.has(s.id) &&
        s.turns > (lastDrainTurn.current.get(s.id) ?? -1)
      ) {
        const head = q[0] as string;
        draining.current.add(s.id);
        client
          .request("session.send", { id: s.id, text: head })
          .then(() => {
            lastDrainTurn.current.set(s.id, s.turns); // only gate the next one after a success
            dispatch({ t: "dequeue", sessionId: s.id }); // daemon emits the user_message echo
          })
          .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad")) // no gate update → retries
          .finally(() => draining.current.delete(s.id));
      }
    }
  }, [state.sessions, state.queue, client, note]);

  // ---- daemon lifecycle ---------------------------------------
  const liveCount = state.sessions.filter(
    (s) => s.status === "running" || s.status === "starting" || s.status === "awaiting_input",
  ).length;
  const confirmFor = (action: "restart" | "quitAll"): ConfirmState => ({
    title: action === "restart" ? "Restart the daemon?" : "Quit the UI and stop the daemon?",
    ...(liveCount > 0 ? { body: `${liveCount} live session${liveCount === 1 ? "" : "s"} will be interrupted.` } : {}),
    danger: action === "quitAll" || liveCount > 0,
    action,
  });
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
  const runConfirm = useCallback(() => {
    const c = state.confirm;
    if (!c || overlayActed.current === c) return;
    overlayActed.current = c;
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
          note(r.branchDeleted ? `deleted ${shortId(id)} + branch` : `deleted ${shortId(id)}`, "good"),
        )
        .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"));
      return;
    }
    if (c.action === "restart") {
      restarting.current = true;
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
        exit();
      })();
    }
  }, [state.confirm, client, note, exit]);

  // ---- current selection + pending round-trip (keymap + layout both read it) ----
  const sel = selectedSession(state);
  const pend = sel ? pendingFor(state, sel.id) : {};
  const allowed = allowedActs(sel);
  // The approve / answer / plan panel sits full-width just above the footer —
  // where the eye already is for the keybinds — in the two modes whose body is
  // the fleet split. Fullscreen log and every overlay each own the screen.
  const showRequest =
    (state.mode === "browse" || state.mode === "prompt") &&
    !logFull &&
    sel?.status === "awaiting_input" &&
    (firstPerm(pend) !== undefined || pend.question !== undefined || pend.plan !== undefined);

  // ---- layout metrics (also needed by the keymap) ----------
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

  /**
   * Run a named action — the single dispatch point shared by the browse keymap
   * and the `Space` command palette. Session verbs and the always-on globals go
   * through {@link act} (gated by {@link allowed}); the app / view / structural
   * commands are handled here.
   */
  const runAct = (name: ActName): void => {
    switch (name) {
      case "viewlog":
        return void viewInEditor();
      case "model":
        return void switchModel();
      case "fullscreen":
        return void (sel ? setLogFull((v) => !v) : undefined);
      case "restart":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("restart") });
      case "quitall":
        return void dispatch({ t: "openConfirm", confirm: confirmFor("quitAll") });
      case "delete":
        return void (sel ? dispatch({ t: "openConfirm", confirm: confirmForDelete(sel) }) : undefined);
      case "copybranch": {
        if (!sel) return void dispatch({ t: "notice", text: "no session selected", tone: "dim" });
        const nm = sel.branch ?? (sel.worktree ? sel.worktree.split("/").pop() ?? sel.worktree : sel.id);
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
          return void dispatch({ t: "notice", text: "hard fork isn't available for Claude sessions yet", tone: "dim" });
        }
        if (sel.inPlace) {
          return void dispatch({ t: "notice", text: "hard fork needs a worktree — this session runs in-place", tone: "dim" });
        }
        if (sel.status === "awaiting_input") {
          return void dispatch({ t: "notice", text: "answer the pending request first", tone: "dim" });
        }
        client
          .request<SessionSnapshot>("session.fork", { id: sel.id, by: client.clientId })
          .then((r) => {
            dispatch({ t: "select", id: r.id });
            dispatch({ t: "notice", text: `forked → ${shortId(r.id)}`, tone: "good" });
          })
          .catch((e: unknown) =>
            dispatch({ t: "notice", text: `fork failed: ${e instanceof Error ? e.message : String(e)}`, tone: "bad" }),
          );
        return;
      }
      default:
        // new / find / help / quit / filter are always allowed; the rest are
        // session verbs gated by the selected session's state.
        if (["new", "find", "help", "quit", "filter"].includes(name) || allowed.has(name)) {
          return void act(name);
        }
    }
  };

  // ---- keymap -----------------------------------------------
  useInput((input, key) => {
    if (key.ctrl && input === "c") return quitTui();

    // Mouse wheel → always scrolls the event log, never the fleet list.
    // `run.ts` turns on SGR mouse reporting (`\x1b[?1000h\x1b[?1006h`) so the
    // wheel arrives as its own `[<Cb;Cx;Cy(M|m)` sequence — Ink's keypress
    // parser doesn't recognize it as any named key, so it passes it through
    // as raw `input` with every `key.*` flag false. Without mouse reporting,
    // terminals translate the wheel into Up/Down arrow keys on the alt
    // screen, which the browse keymap below reads as fleet navigation.
    const wheel = /^\[<(\d+);\d+;\d+[Mm]/.exec(input);
    if (wheel) {
      const base = Number(wheel[1]) & ~(4 | 8 | 16); // strip shift/meta/ctrl bits
      if (base === 64) return setLogScroll((n) => n + 3); // wheel up → back in history
      if (base === 65) return setLogScroll((n) => Math.max(0, n - 3)); // wheel down → toward live tail
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
          ? dispatch({ t: "notice", text: "no log yet — you're starting a new session", tone: "dim" })
          : viewInEditor());
      }
      // ⇧⇥ cycles the permission mode without leaving the prompt: the
      // not-yet-created session's, or the live session you're messaging.
      if (key.tab && key.shift) {
        if (p.kind === "new") return void dispatch({ t: "promptCycleMode" });
        if (p.kind === "send" && p.sessionId) return void cyclePromptSessionMode(p.sessionId);
        return;
      }
      // ⌥m swaps the model without leaving the prompt: a model step for the
      // not-yet-created session, or a live switch on the one you're messaging.
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
      // ⌥⏎ while the target is still working queues for turn end instead of
      // its usual "insert a newline" meaning; bare ⏎ below (via `applyKey` →
      // "submit" → `submitPrompt`) sends now regardless of session status.
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
          // overlay — the daemon is still blocked on the decision, so we must
          // not drop the user into browse with the overlay gone.
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
      }
      return;
    }

    if (state.mode === "plan") {
      if (input === "i") return respondPlan({ action: "implement" }, "implementing the plan");
      if (input === "f") return respondPlan({ action: "implement_fresh" }, "compacting, then implementing");
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
          if (overlayActed.current === p) return; // batched double-Enter guard
          overlayActed.current = p;
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
    if (key.pageUp) return setLogScroll((n) => n + Math.max(1, logPage - 1));
    if (key.pageDown) return setLogScroll((n) => Math.max(0, n - Math.max(1, logPage - 1)));
    if (key.upArrow || input === "k") return void dispatch({ t: "move", delta: -1 });
    if (key.downArrow || input === "j") return void dispatch({ t: "move", delta: 1 });
    // ⇧⇥ cycles the permission mode; plain Tab fullscreens the event log.
    if (key.tab && key.shift) return void (sel ? runAct("mode") : undefined);
    if (key.tab) return void (sel ? setLogFull((v) => !v) : undefined);
    if (key.escape) return void (logFull ? setLogFull(false) : undefined);
    // Enter on a fleet row = act on it: compose a message (running / idle /
    // stopped), or take up a pending question / plan. A pending *permission*
    // still wants the explicit `a` / `d`.
    if (key.return) {
      if (allowed.has("send")) return runAct("send");
      if (allowed.has("answer")) return runAct("answer");
      if (allowed.has("planreview")) return runAct("planreview");
      return;
    }
    // ⌥m switches the selected session's model — the one Alt key that also acts
    // from the fleet view (its sibling ⇧⇥ does the same for the mode).
    if (key.meta && input === "m") return void (sel ? runAct("model") : undefined);
    if (key.ctrl || key.meta) return; // Ctrl / Alt otherwise do nothing outside the prompt — swallow

    // Space → the command palette: every action valid right now, fuzzy, with its key.
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

    const map: Record<string, ActName> = {
      a: allowed.has("answer") ? "answer" : allowed.has("planreview") ? "planreview" : "approve",
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
  });

  // ---- layout ----------------------------------------------
  let body: ReactNode;
  if (state.mode === "help") {
    body = h(Box, { paddingX: 1, paddingTop: 1 }, h(Help, { width: cols - 2 }));
  } else if (state.mode === "confirm" && state.confirm) {
    body = h(
      Box,
      { paddingX: 2, paddingTop: 1, alignItems: "flex-start" },
      h(Confirm, { confirm: state.confirm, width: Math.min(cols - 4, 64) }),
    );
  } else if (state.mode === "plan" && state.plan) {
    body = h(
      Box,
      { paddingX: 2, paddingTop: 1, alignItems: "flex-start" },
      h(PlanReview, { text: state.plan.text, width: Math.min(cols - 4, 96) }),
    );
  } else if (state.mode === "picker" && state.picker) {
    body = h(
      Box,
      { paddingX: 2, paddingTop: 1, alignItems: "flex-start" },
      h(Picker, { picker: state.picker, width: Math.min(cols - 4, 64), height: Math.max(6, bodyH - 2) }),
    );
  } else if (logFull) {
    body = h(Box, { height: bodyH }, h(EventLog, { state, width: cols, height: bodyH, scroll: logScroll, full: true }));
  } else {
    body = h(
      Box,
      { height: bodyH, gap: 1 },
      h(Box, { width: leftW }, h(Fleet, { state, tick, width: leftW, now: Date.now() })),
      h(
        Box,
        { width: rightW, flexDirection: "column" },
        h(Detail, {
          session: sel,
          width: rightW,
          queued: sel ? queueFor(state, sel.id) : [],
          now: Date.now(),
          engineColor: sel ? providerColorOf(state, sel.provider) : "",
          compacting: sel ? (state.compacting[sel.id] ?? null) : null,
        }),
        h(EventLog, { state, width: rightW, height: splitLogH, scroll: logScroll, full: false }),
      ),
    );
  }

  return h(
    Box,
    { flexDirection: "column", width: cols },
    h(Header, { state, width: cols }),
    body,
    showRequest ? h(RequestPanel, { pending: pend, width: cols }) : null,
    h(FooterArea, { state, width: cols }),
  );
}
