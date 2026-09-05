/**
 * Root Ink component. All logic — state, keymap, daemon round-trips — lives in
 * {@link mkFleetHandle}; this file gathers the terminal capabilities the handle
 * needs from Ink, starts it once, forwards key presses, and renders the view it
 * publishes. JSX with no bundler — `@oxc-node` transforms `.tsx` on the fly.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { absurd } from "@loom/core/absurd";
import type { LoomClient } from "@loom/client";
import type { EditorHandoff } from "./editor-handoff.ts";
import { mkFleetHandle, type FleetView } from "./fleet-handle.ts";
import {
  providerAccountOf,
  providerColorOf,
  providerInfo,
  promptOnPane,
  queueFor,
} from "./model.ts";
import { C } from "./theme.ts";
import {
  Confirm,
  Detail,
  Doctor,
  EventLog,
  Fleet,
  FooterArea,
  Header,
  Help,
  Picker,
  PromptPane,
  PlanReview,
  RequestPanel,
} from "./components.tsx";

export const App = ({
  client,
  logs,
  themeState,
  /** Test seam: override the real `$EDITOR` handoff. */
  openEditor: openEditorOverride,
  historyPageSize,
}: {
  client: LoomClient;
  /** Daemon + TUI log paths for the "view logs" palette command. */
  logs?: { daemon: string; tui: string };
  /** TUI preference file — the theme persists across restarts there. */
  themeState?: string;
  openEditor?: EditorHandoff;
  /** Test seam: rows per durable-history page (see {@link mkFleetHandle}). */
  historyPageSize?: number;
}): ReactNode => {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();

  const [handle] = useState(() =>
    mkFleetHandle({
      client,
      term: {
        exit,
        suspendTerminal,
        write: (s) => void stdout.write(s),
        isTTY: stdout.isTTY ?? false,
        getSize: () => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 }),
        onResize: (fn) => {
          stdout.on("resize", fn);
          return () => void stdout.off("resize", fn);
        },
      },
      ...(logs ? { logs } : {}),
      ...(themeState ? { themeState } : {}),
      ...(openEditorOverride ? { openEditorOverride } : {}),
      ...(historyPageSize !== undefined ? { historyPageSize } : {}),
    }),
  );

  useEffect(handle.effectStart, [handle]);
  useInput(handle.handleKey);
  const view = useSyncExternalStore(handle.subscribe, handle.getView);

  return <Layout view={view} />;
};

const Layout = ({ view }: { view: FleetView }): ReactNode => {
  const { state, sel, cols, bodyH, leftW, rightW, splitLogH } = view;

  let body: ReactNode;
  switch (view.body) {
    case "help":
      body = (
        <Box paddingX={1} paddingTop={1}>
          <Help width={cols - 2} />
        </Box>
      );
      break;
    case "doctor":
      body = (
        <Box paddingX={1} paddingTop={1}>
          <Doctor report={state.doctor} width={cols - 2} />
        </Box>
      );
      break;
    case "confirm":
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          {state.confirm ? (
            <Confirm confirm={state.confirm} width={Math.min(cols - 4, 64)} />
          ) : null}
        </Box>
      );
      break;
    case "plan": {
      const ps = state.plan
        ? state.sessions.find((s) => s.id === state.plan?.sessionId)
        : undefined;
      // The provider whose model an `f` (implement fresh) would run on: a staged
      // ⌥p retarget if any, else the plan session's own — resolved to its fleet
      // tag + colour so the overlay can paint it like the rest of the UI.
      const tgtProv = state.plan?.impl?.provider ?? ps?.provider;
      const tgt = tgtProv
        ? {
            tag: providerInfo(state, tgtProv)?.tag ?? tgtProv,
            color: providerColorOf(state, tgtProv),
          }
        : undefined;
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          {state.plan ? (
            <PlanReview
              plan={state.plan}
              width={Math.min(cols - 4, 96)}
              height={Math.max(8, bodyH - 2)}
              scroll={view.planScroll}
              {...(ps ? { ctx: { used: ps.contextUsed, limit: ps.contextLimit } } : {})}
              {...(state.plan.impl ? { impl: state.plan.impl } : {})}
              {...(ps
                ? { cur: { provider: ps.provider, model: ps.model, effort: ps.effort } }
                : {})}
              {...(tgt ? { target: tgt } : {})}
            />
          ) : null}
        </Box>
      );
      break;
    }
    case "picker":
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          {state.picker ? (
            <Picker
              picker={state.picker}
              width={Math.min(cols - 4, 64)}
              height={Math.max(6, bodyH - 2)}
            />
          ) : null}
        </Box>
      );
      break;
    case "split":
      body = (
        <Box height={bodyH} gap={1}>
          <Box width={leftW}>
            <Fleet state={state} tick={view.tick} width={leftW} height={bodyH} now={Date.now()} />
          </Box>
          <Box width={rightW} flexDirection="column">
            <Detail
              session={sel}
              width={rightW}
              queued={sel ? queueFor(state, sel.id) : []}
              now={Date.now()}
              engineColor={sel ? providerColorOf(state, sel.provider) : ""}
              account={sel ? providerAccountOf(state, sel.provider) : ""}
              compacting={sel ? (state.compacting[sel.id] ?? null) : null}
            />
            <EventLog
              state={state}
              width={rightW}
              height={splitLogH}
              scroll={view.logScroll}
              tick={view.tick}
            />
            {promptOnPane(state.prompt) ? <PromptPane state={state} width={rightW} /> : null}
          </Box>
        </Box>
      );
      break;
    case "fleetOnly":
      // Narrow `overview`: only the fleet fits — detail + events wait for `⇥`.
      body = (
        <Box height={bodyH}>
          <Fleet state={state} tick={view.tick} width={cols} height={bodyH} now={Date.now()} />
        </Box>
      );
      break;
    case "sessionPane":
      // The `session` view — Detail + events (+ reply pane) with the whole
      // terminal width, the fleet list toggled away.
      body = (
        <Box height={bodyH} width={cols} flexDirection="column">
          <Detail
            session={sel}
            width={cols}
            queued={sel ? queueFor(state, sel.id) : []}
            now={Date.now()}
            engineColor={sel ? providerColorOf(state, sel.provider) : ""}
            account={sel ? providerAccountOf(state, sel.provider) : ""}
            compacting={sel ? (state.compacting[sel.id] ?? null) : null}
          />
          <EventLog
            state={state}
            width={cols}
            height={splitLogH}
            scroll={view.logScroll}
            tick={view.tick}
          />
          {promptOnPane(state.prompt) ? <PromptPane state={state} width={cols} /> : null}
        </Box>
      );
      break;
    default:
      return absurd(view.body);
  }

  return (
    <Box flexDirection="column" width={cols} backgroundColor={C.bg}>
      <Header state={state} width={cols} />
      {body}
      {view.showRequest ? (
        <RequestPanel pending={view.pend} width={cols} questionIdx={view.questionIdx} />
      ) : null}
      <FooterArea state={state} width={cols} />
    </Box>
  );
};
