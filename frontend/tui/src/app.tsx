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
import { providerColorOf, queueFor } from "./model.ts";
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
  RequestPanel,
} from "./components.tsx";

export const App = ({
  client,
  logs,
  /** Test seam: override the real `$EDITOR` handoff. */
  openEditor: openEditorOverride,
}: {
  client: LoomClient;
  /** Daemon + TUI log paths for the "view logs" palette command. */
  logs?: { daemon: string; tui: string };
  openEditor?: EditorHandoff;
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
      ...(openEditorOverride ? { openEditorOverride } : {}),
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
    case "confirm":
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          {state.confirm ? (
            <Confirm confirm={state.confirm} width={Math.min(cols - 4, 64)} />
          ) : null}
        </Box>
      );
      break;
    case "plan":
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          {state.plan ? <PlanReview text={state.plan.text} width={Math.min(cols - 4, 96)} /> : null}
        </Box>
      );
      break;
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
    case "logFull":
      body = (
        <Box height={bodyH}>
          <EventLog state={state} width={cols} height={bodyH} scroll={view.logScroll} full />
        </Box>
      );
      break;
    case "split":
      body = (
        <Box height={bodyH} gap={1}>
          <Box width={leftW}>
            <Fleet state={state} tick={view.tick} width={leftW} now={Date.now()} />
          </Box>
          <Box width={rightW} flexDirection="column">
            <Detail
              session={sel}
              width={rightW}
              queued={sel ? queueFor(state, sel.id) : []}
              now={Date.now()}
              engineColor={sel ? providerColorOf(state, sel.provider) : ""}
              compacting={sel ? (state.compacting[sel.id] ?? null) : null}
            />
            <EventLog
              state={state}
              width={rightW}
              height={splitLogH}
              scroll={view.logScroll}
              full={false}
            />
          </Box>
        </Box>
      );
      break;
    default:
      return absurd(view.body);
  }

  return (
    <Box flexDirection="column" width={cols}>
      <Header state={state} width={cols} />
      {body}
      {view.showRequest ? <RequestPanel pending={view.pend} width={cols} /> : null}
      <FooterArea state={state} width={cols} />
    </Box>
  );
};
