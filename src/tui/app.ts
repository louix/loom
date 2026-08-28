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
import type { LoomClient } from "../client/client.ts";
import type { SessionSnapshot } from "../protocol/wire.ts";
import { SESSION_MODES, type SessionMode } from "../provider/types.ts";
import type { EditorHandoff } from "./run.ts";
import { applyKey, buffer } from "./editor.ts";
import { C, clock, shortId } from "./theme.ts";
import {
  Confirm,
  Detail,
  EventLog,
  Fleet,
  FooterArea,
  Header,
  Help,
  promptRows,
  RequestPanel,
  REQUEST_PANEL_ROWS,
  SendChoice,
} from "./components.ts";
import {
  allowedActs,
  initialState,
  makePrompt,
  pendingFor,
  queueFor,
  reduce,
  selectedSession,
  visibleLog,
  type ActName,
  type ConfirmState,
  type LogLine,
} from "./model.ts";

const nextMode = (m: SessionMode): SessionMode =>
  SESSION_MODES[(SESSION_MODES.indexOf(m) + 1) % SESSION_MODES.length] ?? "default";

export function App({
  client,
  openEditor,
}: {
  client: LoomClient;
  openEditor?: EditorHandoff;
}): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const [tick, setTick] = useState(0);
  const [logScroll, setLogScroll] = useState(0);
  const [logFull, setLogFull] = useState(false);
  const [dims, setDims] = useState(() => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 }));
  const restarting = useRef(false);
  const echoSeq = useRef(0);

  // ---- client wiring --------------------------------------------------
  const refetch = useCallback(() => {
    void client
      .request<SessionSnapshot[]>("session.list")
      .then((sessions) => dispatch({ t: "sessions", sessions }))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    if (client.daemonInfo) dispatch({ t: "hello", daemon: client.daemonInfo, sessions: client.sessions });
    refetch();
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
  }, [client, refetch]);

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

  // ---- helpers ----------------------------------------------------
  const note = useCallback(
    (text: string, tone: "good" | "bad" | "dim" | "accent" = "good") => dispatch({ t: "notice", text, tone }),
    [],
  );
  const quitTui = useCallback(() => {
    void client.close();
    exit();
  }, [client, exit]);
  const echoLine = useCallback(
    (sessionId: string, text: string): LogLine => ({
      seq: --echoSeq.current,
      sessionId,
      glyph: "›",
      text: text.replace(/\s+/g, " ").trim(),
      tone: "accent",
      ts: Date.now(),
    }),
    [],
  );

  const logText = useCallback((): string => {
    const tagged = state.logFilter === "all";
    return (
      visibleLog(state)
        .map((l) => `${clock(l.ts)}  ${tagged ? `${shortId(l.sessionId)}  ` : ""}${l.glyph} ${l.text}`)
        .join("\n") || "(no events)"
    );
  }, [state]);

  /** `⌃e` — edit the open prompt's text in `$EDITOR`, with the event log alongside. */
  const editPrompt = useCallback(() => {
    if (state.mode !== "prompt" || !state.prompt) return note("open a prompt first — ⌃o views the log", "dim");
    if (!openEditor) return note("no $EDITOR available", "dim");
    const p = state.prompt;
    const next = openEditor(p.buffer.text, {
      ext: p.kind === "new" ? "md" : "txt",
      aside: { name: "events.log", body: logText() },
    });
    if (next != null) dispatch({ t: "promptSet", buffer: buffer(next.replace(/\s+$/, "")) });
    setTick((t) => t + 1); // force a repaint after the editor let go of the tty
  }, [state.mode, state.prompt, openEditor, note, logText]);

  /** `⌃o` — open the pending request, or the event log, in `$EDITOR` read-only. */
  const viewInEditor = useCallback(() => {
    if (!openEditor) return note("no $EDITOR available", "dim");
    const s = selectedSession(state);
    const pend = s ? pendingFor(state, s.id) : {};
    if (pend.permission !== undefined) {
      openEditor(JSON.stringify({ tool: pend.permTool, input: pend.permInput }, null, 2), { ext: "json" });
    } else if (pend.question !== undefined) {
      openEditor([pend.questionText ?? "", "", pend.questionContext ?? ""].join("\n"), { ext: "md" });
    } else {
      openEditor(logText(), { ext: "log" });
    }
    setTick((t) => t + 1);
  }, [openEditor, note, state, logText]);

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
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({ kind: "new", sessionId: null, label: "new session" }),
        });
      }
      if (name === "filter") {
        return void dispatch({ t: "logFilter", value: state.logFilter === "all" ? "selected" : "all" });
      }
      if (name === "help") return void dispatch({ t: "help", value: state.mode !== "help" });
      if (name === "quit") return quitTui();
      if (!s) return;
      switch (name) {
        case "approve": {
          const requestId = pendingFor(state, s.id).permission;
          if (!requestId) return note("no permission request pending", "dim");
          return perform(async () => {
            const r = await client.request<{ alreadyResolved: boolean }>("session.respondPermission", {
              id: s.id,
              requestId,
              decision: "allow",
              by,
            });
            return r.alreadyResolved ? `${requestId} already resolved` : `approved ${requestId}`;
          });
        }
        case "deny": {
          const requestId = pendingFor(state, s.id).permission;
          if (!requestId) return note("no permission request pending", "dim");
          return void dispatch({
            t: "openPrompt",
            prompt: makePrompt({ kind: "deny", sessionId: s.id, requestId, label: `deny ${requestId}` }),
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
            prompt: makePrompt({ kind: "send", sessionId: s.id, label: "send" }),
          });
        case "title":
          return void dispatch({
            t: "openPrompt",
            prompt: makePrompt({ kind: "title", sessionId: s.id, label: "rename", text: s.title ?? "" }),
          });
        case "budget":
          return void dispatch({
            t: "openPrompt",
            prompt: makePrompt({
              kind: "budget",
              sessionId: s.id,
              label: "budget $",
              text: s.budget.maxCostUsd != null ? String(s.budget.maxCostUsd) : "",
            }),
          });
        case "interrupt":
          return perform(async () => {
            await client.request("session.interrupt", { id: s.id });
            return "interrupted";
          });
        case "compact":
          return perform(async () => {
            await client.request("session.compact", { id: s.id });
            return "compacting context";
          });
        case "resume":
          return perform(async () => {
            await client.request("session.resume", { id: s.id, by });
            return "resuming";
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

  /** Fire `session.send` now, echoing into the log and history. */
  const deliver = useCallback(
    (sessionId: string, text: string, label = "sent") => {
      client
        .request("session.send", { id: sessionId, text })
        .then(() => {
          dispatch({ t: "pushHistory", text });
          dispatch({ t: "echo", line: echoLine(sessionId, text) });
          note(label, "good");
        })
        .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"));
    },
    [client, note, echoLine],
  );

  const submitPrompt = useCallback(() => {
    const p = state.prompt;
    if (!p) return;
    const text = p.buffer.text.trim();
    const by = client.clientId;
    if (p.kind !== "deny" && !text) return; // keep the prompt open on an empty submit
    const reopen = () =>
      dispatch({ t: "openPrompt", prompt: { ...p, buffer: buffer(p.buffer.text), histIdx: 0, draft: "" } });

    // A message composed while the agent is still working: ask asap vs. turn-end.
    if (p.kind === "send" && p.sessionId) {
      const target = state.sessions.find((x) => x.id === p.sessionId);
      if (target && (target.status === "running" || target.status === "starting")) {
        return void dispatch({ t: "openSendChoice", sessionId: p.sessionId, text });
      }
    }

    dispatch({ t: "closePrompt" });

    const run = async (): Promise<string> => {
      if (p.kind === "new") {
        const r = await client.request<SessionSnapshot>("session.create", {
          prompt: text,
          by,
          ...(p.mode && p.mode !== "default" ? { mode: p.mode } : {}),
        });
        dispatch({ t: "select", id: r.id });
        dispatch({ t: "pushHistory", text });
        dispatch({ t: "echo", line: echoLine(r.id, text) });
        return `started ${shortId(r.id)}`;
      }
      if (p.kind === "send" && p.sessionId) {
        await client.request("session.send", { id: p.sessionId, text });
        dispatch({ t: "pushHistory", text });
        dispatch({ t: "echo", line: echoLine(p.sessionId, text) });
        return "sent";
      }
      if (p.kind === "title" && p.sessionId) {
        await client.request("session.setTitle", { id: p.sessionId, title: text, by });
        return "renamed";
      }
      if (p.kind === "budget" && p.sessionId) {
        const usd = Number.parseFloat(text);
        if (!Number.isFinite(usd) || usd <= 0) throw new Error("budget must be a positive number");
        await client.request("session.setBudget", { id: p.sessionId, maxCostUsd: usd, by });
        return `budget → $${usd.toFixed(2)}`;
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

  const runSendChoice = useCallback(
    (choice: "asap" | "queue" | "back") => {
      const sc = state.sendChoice;
      if (!sc) return;
      if (choice === "back") {
        return void dispatch({
          t: "openPrompt",
          prompt: makePrompt({ kind: "send", sessionId: sc.sessionId, label: "send", text: sc.text }),
        });
      }
      dispatch({ t: "closeSendChoice" });
      if (choice === "asap") {
        deliver(sc.sessionId, sc.text, "sent (asap)");
      } else {
        dispatch({ t: "enqueue", sessionId: sc.sessionId, text: sc.text });
        dispatch({ t: "pushHistory", text: sc.text });
        dispatch({
          t: "echo",
          line: { ...echoLine(sc.sessionId, sc.text), glyph: "▸", tone: "dim", text: `queued: ${sc.text.replace(/\s+/g, " ").trim()}` },
        });
        note("queued for turn end", "dim");
      }
    },
    [state.sendChoice, deliver, echoLine, note],
  );

  // Drain a session's queued messages once it goes idle again.
  const draining = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of state.sessions) {
      const q = state.queue[s.id];
      if (s.status === "idle" && q && q.length > 0 && !draining.current.has(s.id)) {
        const head = q[0] as string;
        draining.current.add(s.id);
        client
          .request("session.send", { id: s.id, text: head })
          .then(() => {
            dispatch({ t: "dequeue", sessionId: s.id });
            dispatch({ t: "echo", line: echoLine(s.id, head) });
          })
          .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"))
          .finally(() => draining.current.delete(s.id));
      }
    }
  }, [state.sessions, state.queue, client, echoLine, note]);

  // ---- daemon lifecycle ---------------------------------------
  const liveCount = state.sessions.filter(
    (s) => s.status === "running" || s.status === "starting" || s.status === "awaiting_input",
  ).length;
  const confirmFor = (action: ConfirmState["action"]): ConfirmState => ({
    title: action === "restart" ? "Restart the daemon?" : "Quit the UI and stop the daemon?",
    ...(liveCount > 0 ? { body: `${liveCount} live session${liveCount === 1 ? "" : "s"} will be interrupted.` } : {}),
    danger: action === "quitAll" || liveCount > 0,
    action,
  });
  const runConfirm = useCallback(() => {
    const c = state.confirm;
    dispatch({ t: "closeConfirm" });
    if (!c) return;
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

  // ---- layout metrics (also needed by the keymap) ----------
  const cols = Math.max(60, dims.cols);
  const rows = Math.max(16, dims.rows);
  const footerH = promptRows(state);
  const bodyH = Math.max(6, rows - 1 - footerH);
  const leftW = Math.max(32, Math.min(52, Math.round(cols * 0.4)));
  const rightW = cols - leftW - 1;
  const splitLogH = Math.max(4, bodyH - 13);
  const logH = logFull ? bodyH : splitLogH;
  const logPage = Math.max(1, logH - 3);

  // ---- keymap -----------------------------------------------
  useInput((input, key) => {
    if (key.ctrl && input === "c") return quitTui();
    if (key.ctrl && input === "e") return void editPrompt();
    if (key.ctrl && input === "o") return void viewInEditor();

    if (state.mode === "prompt" && state.prompt) {
      const p = state.prompt;
      if (key.ctrl && input === "x" && p.kind === "send" && p.sessionId) {
        return void dispatch({ t: "clearQueue", sessionId: p.sessionId });
      }
      const res = applyKey(p.buffer, input, key);
      switch (res.kind) {
        case "cancel":
          return void dispatch({ t: "closePrompt" });
        case "submit":
          return void submitPrompt();
        case "buffer":
          return void dispatch({ t: "promptSet", buffer: res.buffer });
        case "mode":
          return void dispatch({ t: "promptCycleMode" });
        case "history":
          return void dispatch({ t: "promptHistoryNav", dir: res.dir });
        case "ignore":
          return;
      }
      return;
    }

    if (state.mode === "sendChoice") {
      if (input === "a") return runSendChoice("asap");
      if (input === "t" || key.return) return runSendChoice("queue");
      if (key.escape || input === "b") return runSendChoice("back");
      return;
    }

    if (state.mode === "confirm") {
      if (key.return) return runConfirm();
      if (key.escape || input === "q" || input === "n") return void dispatch({ t: "closeConfirm" });
      return;
    }

    if (state.mode === "help") {
      if (input === "?" || input === "q" || key.escape) dispatch({ t: "help", value: false });
      return;
    }

    // ---- browse ----
    if (key.pageUp) return setLogScroll((n) => n + Math.max(1, logPage - 1));
    if (key.pageDown) return setLogScroll((n) => Math.max(0, n - Math.max(1, logPage - 1)));
    if (key.upArrow || input === "k") return void dispatch({ t: "move", delta: -1 });
    if (key.downArrow || input === "j") return void dispatch({ t: "move", delta: 1 });
    if (key.tab && key.shift) return act("mode");
    if (key.tab) return void (selectedSession(state) ? setLogFull((v) => !v) : undefined);
    if (key.escape) return void (logFull ? setLogFull(false) : undefined);

    if (input === "q") return quitTui();
    if (input === "Q") return void dispatch({ t: "openConfirm", confirm: confirmFor("quitAll") });
    if (input === "R") return void dispatch({ t: "openConfirm", confirm: confirmFor("restart") });

    const sel = selectedSession(state);
    if (key.ctrl && input === "y") {
      if (!sel) return;
      const name = sel.branch ?? (sel.worktree ? sel.worktree.split("/").pop() ?? sel.worktree : sel.id);
      return copyToClipboard(name, name);
    }
    if (key.ctrl && input === "x") {
      return void (sel && queueFor(state, sel.id).length > 0
        ? dispatch({ t: "clearQueue", sessionId: sel.id })
        : undefined);
    }
    if (key.ctrl || key.meta) return; // unbound modified key — swallow, don't fall through as the bare key

    const allowed = allowedActs(sel);
    const map: Record<string, ActName> = {
      a: allowed.has("answer") ? "answer" : "approve",
      d: "deny",
      s: "send",
      i: "interrupt",
      r: "resume",
      x: "done",
      c: "compact",
      e: "title",
      b: "budget",
      n: "new",
      f: "filter",
      "?": "help",
    };
    const chosen = map[input];
    if (!chosen) return;
    if (chosen === "new" || chosen === "filter" || chosen === "help" || allowed.has(chosen)) act(chosen);
  });

  // ---- layout ----------------------------------------------
  const sel = selectedSession(state);
  const pend = sel ? pendingFor(state, sel.id) : {};
  const showRequest =
    !logFull && sel?.status === "awaiting_input" && (pend.permission !== undefined || pend.question !== undefined);
  const rightLogH = Math.max(3, splitLogH - (showRequest ? REQUEST_PANEL_ROWS : 0));

  let body: ReactNode;
  if (state.mode === "help") {
    body = h(Box, { paddingX: 1, paddingTop: 1 }, h(Help, { width: cols - 2 }));
  } else if (state.mode === "confirm" && state.confirm) {
    body = h(
      Box,
      { paddingX: 2, paddingTop: 1, alignItems: "flex-start" },
      h(Confirm, { confirm: state.confirm, width: Math.min(cols - 4, 64) }),
    );
  } else if (state.mode === "sendChoice" && state.sendChoice) {
    body = h(
      Box,
      { paddingX: 2, paddingTop: 1, alignItems: "flex-start" },
      h(SendChoice, { text: state.sendChoice.text, width: Math.min(cols - 4, 72) }),
    );
  } else if (logFull) {
    body = h(Box, { height: bodyH }, h(EventLog, { state, width: cols, height: bodyH, scroll: logScroll, full: true }));
  } else {
    body = h(
      Box,
      { height: bodyH, gap: 1 },
      h(Box, { width: leftW }, h(Fleet, { state, tick, width: leftW })),
      h(
        Box,
        { width: rightW, flexDirection: "column" },
        h(Detail, { session: sel, width: rightW, queued: sel ? queueFor(state, sel.id) : [] }),
        showRequest ? h(RequestPanel, { pending: pend, width: rightW }) : null,
        h(EventLog, { state, width: rightW, height: rightLogH, scroll: logScroll, full: false }),
      ),
    );
  }

  return h(
    Box,
    { flexDirection: "column", width: cols },
    h(Header, { state, width: cols }),
    body,
    h(FooterArea, { state, width: cols }),
  );
}
