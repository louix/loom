/**
 * Root Ink component: binds a {@link LoomClient} to the TUI model, owns the
 * keymap, and turns key presses into daemon RPCs. All rendering delegates to
 * the pure components in `./components.ts`; all state logic lives in
 * `./model.ts`. Written with `createElement` (no JSX) to keep the no-build-step
 * constraint.
 */
import { createElement as h, useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { LoomClient } from "../client/client.ts";
import type { SessionSnapshot } from "../protocol/wire.ts";
import { C } from "./theme.ts";
import { Detail, EventLog, Fleet, Footer, Header, Help } from "./components.ts";
import {
  allowedActs,
  initialState,
  pendingFor,
  reduce,
  selectedSession,
  type ActName,
  type PromptState,
  type TuiState,
} from "./model.ts";

export function App({ client }: { client: LoomClient }): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const [tick, setTick] = useState(0);
  const [dims, setDims] = useState(() => ({
    cols: stdout.columns || 100,
    rows: stdout.rows || 30,
  }));

  // ---- client wiring ----------------------------------------------------
  const refetch = useCallback(() => {
    void client
      .request<SessionSnapshot[]>("session.list")
      .then((sessions) => dispatch({ t: "sessions", sessions }))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    if (client.daemonInfo) {
      dispatch({ t: "hello", daemon: client.daemonInfo, sessions: client.sessions });
    }
    refetch();
    const offs = [
      client.onPush((frame) => dispatch({ t: "push", frame })),
      client.on("disconnect", () => dispatch({ t: "connection", value: "reconnecting" })),
      client.on("reconnect", () => {
        dispatch({ t: "connection", value: "live" });
        refetch();
      }),
      client.on("resync", () => refetch()),
      client.on("close", () => dispatch({ t: "connection", value: "closed" })),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, refetch]);

  // ---- ticker: spinner + notice expiry --------------------------------
  useEffect(() => {
    const iv = setInterval(() => {
      setTick((t) => (t + 1) % 100000);
      dispatch({ t: "expireNotice", now: Date.now() });
    }, 120);
    return () => clearInterval(iv);
  }, []);

  // ---- terminal resize ----------------------------------------------
  useEffect(() => {
    const onResize = () =>
      setDims({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // ---- actions --------------------------------------------------------
  const quit = useCallback(() => {
    void client.close();
    exit();
  }, [client, exit]);

  const note = useCallback((text: string, tone: "good" | "bad" | "dim" | "accent" = "good") => {
    dispatch({ t: "notice", text, tone });
  }, []);

  const perform = useCallback(
    (fn: () => Promise<string>) => {
      fn()
        .then((msg) => msg && note(msg, "good"))
        .catch((e: unknown) => note(e instanceof Error ? e.message : String(e), "bad"));
    },
    [note],
  );

  const openPrompt = useCallback((p: PromptState) => dispatch({ t: "openPrompt", prompt: p }), []);

  const act = useCallback(
    (name: ActName) => {
      const s = selectedSession(state);
      const by = client.clientId;
      switch (name) {
        case "new":
          openPrompt({ kind: "new", sessionId: null, label: "new session ›", value: "" });
          return;
        case "filter":
          dispatch({ t: "logFilter", value: state.logFilter === "all" ? "selected" : "all" });
          return;
        case "help":
          dispatch({ t: "help", value: state.mode !== "help" });
          return;
        case "quit":
          quit();
          return;
      }
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
          return openPrompt({
            kind: "deny",
            sessionId: s.id,
            requestId,
            label: `deny ${requestId} — reason (optional) ›`,
            value: "",
          });
        }
        case "answer": {
          const requestId = pendingFor(state, s.id).question;
          if (!requestId) return note("no question pending", "dim");
          return openPrompt({
            kind: "answer",
            sessionId: s.id,
            requestId,
            label: "answer ›",
            value: "",
          });
        }
        case "send":
          return openPrompt({ kind: "send", sessionId: s.id, label: "send ›", value: "" });
        case "interrupt":
          return perform(async () => {
            await client.request("session.interrupt", { id: s.id });
            return "interrupted";
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
      }
    },
    [state, client, note, perform, openPrompt, quit],
  );

  const submitPrompt = useCallback(() => {
    const p = state.prompt;
    if (!p) return;
    const text = p.value.trim();
    dispatch({ t: "closePrompt" });
    const by = client.clientId;
    if (p.kind === "new") {
      if (!text) return;
      return perform(async () => {
        const r = await client.request<SessionSnapshot>("session.create", { prompt: text, by });
        dispatch({ t: "select", id: r.id });
        return `started ${r.id.slice(0, 8)}`;
      });
    }
    if (p.kind === "send" && p.sessionId) {
      if (!text) return;
      return perform(async () => {
        await client.request("session.send", { id: p.sessionId, text });
        return "sent";
      });
    }
    if (p.kind === "answer" && p.sessionId && p.requestId) {
      if (!text) return;
      return perform(async () => {
        const r = await client.request<{ alreadyResolved: boolean }>("session.answer", {
          id: p.sessionId,
          requestId: p.requestId,
          text,
          by,
        });
        return r.alreadyResolved ? "already answered" : "answered";
      });
    }
    if (p.kind === "deny" && p.sessionId && p.requestId) {
      return perform(async () => {
        const r = await client.request<{ alreadyResolved: boolean }>("session.respondPermission", {
          id: p.sessionId,
          requestId: p.requestId,
          decision: "deny",
          by,
          ...(text ? { message: text } : {}),
        });
        return r.alreadyResolved ? `${p.requestId} already resolved` : `denied ${p.requestId}`;
      });
    }
  }, [state.prompt, client, perform]);

  // ---- keymap -------------------------------------------------------
  useInput((input, key) => {
    if (state.mode === "prompt" && state.prompt) {
      if (key.escape) return void dispatch({ t: "closePrompt" });
      if (key.return) return void submitPrompt();
      if (key.backspace || key.delete) {
        return void dispatch({ t: "promptInput", value: state.prompt.value.slice(0, -1) });
      }
      if (input && !key.ctrl && !key.meta) {
        return void dispatch({ t: "promptInput", value: state.prompt.value + input });
      }
      return;
    }

    if (key.ctrl && input === "c") return quit();

    if (state.mode === "help") {
      if (input === "?" || input === "q" || key.escape) dispatch({ t: "help", value: false });
      return;
    }

    if (key.upArrow || input === "k") return void dispatch({ t: "move", delta: -1 });
    if (key.downArrow || input === "j") return void dispatch({ t: "move", delta: 1 });
    if (input === "q" || key.escape) return quit();

    const allowed = allowedActs(selectedSession(state));
    const map: Record<string, ActName> = {
      a: allowed.has("answer") ? "answer" : "approve",
      d: "deny",
      s: "send",
      i: "interrupt",
      r: "resume",
      x: "done",
      n: "new",
      f: "filter",
      "?": "help",
    };
    const chosen = map[input];
    if (chosen && (allowed.has(chosen) || chosen === "new" || chosen === "filter" || chosen === "help")) {
      act(chosen);
    }
  });

  // ---- layout ------------------------------------------------------
  const cols = Math.max(60, dims.cols);
  const rows = Math.max(16, dims.rows);
  const bodyH = rows - 3; // 1 header row + 2 footer rows (rule + hints)
  const leftW = Math.max(32, Math.min(52, Math.round(cols * 0.4)));
  const rightW = cols - leftW - 1;
  const detailH = 13;
  const logH = Math.max(4, bodyH - detailH);

  const body =
    state.mode === "help"
      ? h(Box, { paddingX: 1, paddingTop: 1 }, h(Help, { width: cols - 2 }))
      : h(
          Box,
          { height: bodyH, gap: 1 },
          h(Box, { width: leftW }, h(Fleet, { state, tick, width: leftW })),
          h(
            Box,
            { width: rightW, flexDirection: "column", gap: 0 },
            h(Detail, { session: selectedSession(state), width: rightW }),
            h(EventLog, { state, width: rightW, height: logH }),
          ),
        );

  return h(
    Box,
    { flexDirection: "column", width: cols },
    h(Header, { state, width: cols }),
    body,
    h(RuleOrFooter, { state, width: cols }),
  );
}

function RuleOrFooter({ state, width }: { state: TuiState; width: number }): ReactNode {
  return h(
    Box,
    { flexDirection: "column", width },
    h(Text, { color: C.faint }, "─".repeat(width)),
    h(Footer, { state, width }),
  );
}
