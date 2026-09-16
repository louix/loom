/**
 * Root Ink component. All logic — state, keymap, daemon round-trips — lives in
 * {@link mkFleetHandle}; this file gathers the terminal capabilities the handle
 * needs from Ink, starts it once, forwards key presses, and renders the view it
 * publishes. JSX with no bundler — `@oxc-node` transforms `.tsx` on the fly.
 */
import { useEffect, useState, useSyncExternalStore, useMemo, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { PaletteContext, useTheme } from "./ui.tsx";
import { absurd } from "@loom/core/absurd";
import { showConnectionError } from "@loom/client";
import type { EditorHandoff } from "./editor-handoff.ts";
import {
  mkFleetHandle,
  type FleetView,
  type FleetHandle,
  type FleetClient,
} from "./fleet-handle.ts";
import { openPrompt, promptOnPane } from "./overlay.ts";
import {
  fleetSessions,
  providerColorOf,
  providerInfo,
  focusedChildOf,
  childrenOf,
  fleetLayout,
  fleetRowBudget,
} from "./model.ts";

import { outboxOf } from "./composer.ts";
import { headerView, fleetPaneView, logView } from "./views.ts";
import { PALETTES, spinnerFrame } from "./theme.ts";
import {
  Confirm,
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
  includeEventLogInEditor = false,
  openShell,
  prepareEnvironment,
  environmentWarning,
  checkEnvironment,
  /** Test seam: override the real `$EDITOR` handoff. */
  openEditor: openEditorOverride,
  historyPageSize,
}: {
  client: FleetClient;
  /** Daemon + TUI log paths for the "view logs" palette command. */
  logs?: { daemon: string; tui: string };
  /** TUI preference file — the theme persists across restarts there. */
  themeState?: string;
  includeEventLogInEditor?: boolean;
  openShell?: (id: string) => Promise<number>;
  prepareEnvironment?: () => Promise<number>;
  environmentWarning?: string | null;
  checkEnvironment?: () => Promise<string | null>;
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
      includeEventLogInEditor,
      ...(logs ? { logs } : {}),
      ...(openShell ? { openShell } : {}),
      ...(prepareEnvironment ? { prepareEnvironment } : {}),
      ...(environmentWarning ? { environmentWarning } : {}),
      ...(checkEnvironment ? { checkEnvironment } : {}),
      ...(themeState ? { themeState } : {}),
      ...(openEditorOverride ? { openEditorOverride } : {}),
      ...(historyPageSize !== undefined ? { historyPageSize } : {}),
    }),
  );

  useEffect(handle.effectStart, [handle]);
  useInput(handle.handleKey);
  const view = useSyncExternalStore(handle.subscribe, handle.getView);

  return (
    <PaletteContext.Provider value={PALETTES[view.ui.theme]}>
      <Layout view={view} handle={handle} />
    </PaletteContext.Provider>
  );
};

type PaneProps = { view: FleetView; handle: FleetHandle; width: number };

const Layout = ({ view, handle }: Omit<PaneProps, "width">): ReactNode => {
  const C = useTheme();
  const { ui: state, cols, bodyH, leftW, rightW } = view;
  const header = useMemo(() => headerView(state.fleet), [state.fleet]);

  if (state.fleet.tag !== "data")
    return (
      <Box width={cols} height={view.rows} flexDirection="column">
        <Text>
          {state.fleet.tag === "error"
            ? showConnectionError(state.fleet.error)
            : "Connecting to daemon…"}
        </Text>
        <Text>q quit</Text>
      </Box>
    );

  let body: ReactNode;
  switch (view.body.t) {
    case "help":
      body = (
        <Box paddingX={1}>
          <Help width={Math.max(1, cols - 2)} height={bodyH} scroll={view.planScroll} />
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
          <Confirm confirm={view.body.confirm} width={cols - 4} />
        </Box>
      );
      break;
    case "plan": {
      const plan = view.body.plan;
      const ps = fleetSessions(state).find((s) => s.id === plan.sessionId);
      // The provider whose model an `f` (implement fresh) would run on: a staged
      // ⌥p retarget if any, else the plan session's own — resolved to its fleet
      // tag + colour so the overlay can paint it like the rest of the UI.
      const tgtProv = plan.impl?.provider ?? ps?.provider;
      const tgt = tgtProv
        ? {
            tag: providerInfo(state, tgtProv)?.tag ?? tgtProv,
            color: providerColorOf(state, tgtProv),
          }
        : undefined;
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          <PlanReview
            plan={plan}
            width={cols - 4}
            height={Math.max(8, bodyH - 2)}
            scroll={view.planScroll}
            {...(ps ? { ctx: { used: ps.contextUsed, limit: ps.contextLimit } } : {})}
            {...(plan.impl
              ? {
                  impl: {
                    provider: plan.impl.provider,
                    ...(plan.impl.model ? { model: plan.impl.model } : {}),
                    ...(plan.impl.effort ? { effort: plan.impl.effort } : {}),
                  },
                }
              : {})}
            {...(ps ? { cur: { provider: ps.provider, model: ps.model, effort: ps.effort } } : {})}
            {...(tgt ? { target: tgt } : {})}
          />
        </Box>
      );
      break;
    }
    case "picker":
      body = (
        <Box paddingX={2} paddingTop={1} alignItems="flex-start">
          <Picker picker={view.body.picker} width={cols - 4} height={Math.max(6, bodyH - 2)} />
        </Box>
      );
      break;
    case "split":
      body = (
        <Box height={bodyH} flexShrink={0} overflow="hidden" gap={1}>
          <Box width={leftW}>
            <FleetArea view={view} handle={handle} width={leftW} />
          </Box>
          <Box width={rightW} flexDirection="column">
            <DetailArea view={view} handle={handle} width={rightW} />
            <LogArea view={view} handle={handle} width={rightW} />
            {promptOnPane(openPrompt(state.overlay)) ? (
              <InputArea view={view} handle={handle} width={rightW} pane />
            ) : null}
          </Box>
        </Box>
      );
      break;
    case "fleetOnly":
      // Narrow `overview`: only the fleet fits — detail + events wait for `⇥`.
      body = (
        <Box height={bodyH} flexShrink={0} overflow="hidden">
          <FleetArea view={view} handle={handle} width={cols} />
        </Box>
      );
      break;
    case "sessionPane":
      // The `session` view — Detail + events (+ reply pane) with the whole
      // terminal width, the fleet list toggled away.
      body = (
        <Box height={bodyH} flexShrink={0} overflow="hidden" width={cols} flexDirection="column">
          <DetailArea view={view} handle={handle} width={cols} />
          <LogArea view={view} handle={handle} width={cols} />
          {promptOnPane(openPrompt(state.overlay)) ? (
            <InputArea view={view} handle={handle} width={cols} pane />
          ) : null}
        </Box>
      );
      break;
    default:
      return absurd(view.body);
  }

  return (
    <Box
      flexDirection="column"
      width={cols}
      height={view.rows + (view.environmentWarning ? 2 : 0)}
      overflow="hidden"
      backgroundColor={C.bg}
    >
      <Header view={header} width={cols} />
      {body}
      {view.showRequest ? (
        <RequestPanel
          request={view.request}
          queued={view.requestCount}
          width={cols}
          questionIdx={view.questionIdx}
        />
      ) : null}
      <InputArea view={view} handle={handle} width={cols} />
      {view.environmentWarning && (
        <Box height={2} flexShrink={0} flexDirection="column">
          <Text color={C.warn} wrap="truncate">
            {view.environmentWarning}
          </Text>
          <Text color={C.warn} wrap="truncate">
            Space → Prepare repo environment · loom environment prepare
          </Text>
        </Box>
      )}
    </Box>
  );
};

const FleetArea = ({ view, handle, width }: PaneProps): ReactNode => {
  const find = useSyncExternalStore(handle.searches.subscribe, handle.searches.get);
  const frame = useSyncExternalStore(handle.animation.subscribe, handle.animation.get);
  const { fleet, selectedId, selectedChild } = view.ui;
  const budget = fleetRowBudget(view.bodyH, find !== null);
  const pane = useMemo(() => {
    const state = { fleet, selectedId, selectedChild, find };
    return fleetPaneView(
      fleet,
      fleetLayout(state, budget),
      selectedId,
      focusedChildOf(state),
      find,
    );
  }, [fleet, selectedId, selectedChild, find, budget]);
  return (
    <Fleet
      view={pane}
      find={find?.buffer ?? null}
      archiving={view.ui.archiving}
      width={width}
      tick={frame.tick}
      now={frame.now}
    />
  );
};

const DetailArea = ({ view, handle }: PaneProps): ReactNode => {
  const now = useSyncExternalStore(handle.animation.subscribe, handle.animation.getNow);
  return view.detail.render(now);
};

const Working = ({ handle, starting }: { handle: FleetHandle; starting: boolean }): ReactNode => {
  const { tick } = useSyncExternalStore(handle.animation.subscribe, handle.animation.get);
  const palette = useTheme();
  return (
    <Text
      color={palette.accentDim}
    >{`  ${spinnerFrame(tick)} ${starting ? "starting session…" : "working…"}`}</Text>
  );
};

const LogArea = ({ view, handle, width }: PaneProps): ReactNode => {
  const tr = useSyncExternalStore(handle.transcript.subscribe, handle.transcript.get);
  const boxes = useSyncExternalStore(handle.composer.subscribe, handle.composer.get);
  const box = outboxOf(boxes, view.sel?.id ?? null);
  const { selectedChild, logFilter } = view.ui;
  const child = useMemo(
    () => (view.sel ? (childrenOf(view.sel).find((c) => c.key === selectedChild) ?? null) : null),
    [view.sel, selectedChild],
  );
  const id = view.sel?.id ?? null;
  const spinning =
    child !== null ||
    (view.sel !== null &&
      ["running", "starting", "working_background"].includes(view.sel.status.kind));
  const pane = useMemo(
    () =>
      logView(tr.transcript, box, id, logFilter, child, spinning, width, view.splitLogH, tr.scroll),
    [tr, box, id, logFilter, child, spinning, width, view.splitLogH],
  );
  const starting = !child && view.sel?.status.kind === "starting";
  const spinner = useMemo(
    () => <Working handle={handle} starting={starting} />,
    [handle, starting],
  );
  return <EventLog view={pane} width={width} spinner={spinner} />;
};

const InputArea = ({
  view,
  handle,
  width,
  pane = false,
}: PaneProps & { pane?: boolean }): ReactNode => {
  const outbox = useSyncExternalStore(handle.composer.subscribe, handle.composer.get);
  const modes = useSyncExternalStore(handle.modes.subscribe, handle.modes.get);
  return pane ? (
    <PromptPane state={view.ui} width={width} modes={modes} />
  ) : (
    <FooterArea state={view.ui} width={width} modes={modes} outbox={outbox} />
  );
};
