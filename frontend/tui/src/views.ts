/** Pure projections for the header, fleet rows and visible transcript window. */
import type { ClientState } from "@loom/client";
import { waiting, type Outbox } from "./composer.ts";
import type { Find } from "./fleet-search.ts";
import { fleetFilterStatus, searchStale } from "./fleet-search.ts";
import {
  fleetDaemon,
  fleetProviders,
  fleetSessions,
  connectionOf,
  type Connection,
  type FleetChild,
  type FleetEntry,
  type FleetLayout,
} from "./model.ts";
import {
  logContext,
  logFilterTag,
  totalRows,
  windowRows,
  filterLog,
  transcriptLines,
  queuedLine,
  type Transcript,
  type LogFilter,
  type PhysicalRow,
} from "./transcript.ts";

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

export interface HeaderView {
  readonly connection: Connection;
  readonly version: string;
  readonly repo: string;
  readonly sessions: number;
  readonly waiting: number;
  readonly running: number;
  readonly background: number;
}

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

export const headerView = (fleet: ClientState): HeaderView => {
  const state = { fleet };
  const connection = connectionOf(state);
  const daemon = fleetDaemon(state);
  const sessions = fleetSessions(state);
  let waiting = 0;
  let running = 0;
  let background = 0;
  for (const s of sessions) {
    if (s.status.kind === "awaiting_input") waiting += 1;
    else if (s.status.kind === "running" || s.status.kind === "starting") running += 1;
    else if (s.status.kind === "working_background") background += 1;
  }
  return {
    connection,
    version: daemon?.version ?? "?",
    repo: daemon ? basename(daemon.repoRoot) : "—",
    sessions: sessions.length,
    waiting,
    running,
    background,
  };
};

// ---------------------------------------------------------------------------
// fleet pane
// ---------------------------------------------------------------------------

/**
 * What the list area holds. The three empty cases are not one "no rows": an
 * unknown fleet, a fleet with nothing in it, and a filter that has not come
 * back yet each say something different, and collapsing them is how a client
 * that has merely lost its socket invites you to start a second session for
 * work already running.
 */
export type FleetBody =
  | { readonly t: "none" }
  | { readonly t: "searching" }
  | { readonly t: "noMatch" }
  | { readonly t: "rows"; readonly entries: readonly FleetEntry[] };

export interface FleetPaneView {
  readonly body: FleetBody;
  readonly selectedId: string | null;
  /** The drilled-into child, when the selection is drilled in. */
  readonly focused: FleetChild | null;
  /** The filter's header text, or null while the filter is closed. */
  readonly filterStatus: string | null;
  /** Provider id → its fleet colour, from the snapshot. */
  readonly providerColors: ReadonlyMap<string, string>;
  /** Window position, for the `↕ a–b of n` row. */
  readonly offset: number;
  readonly shown: number;
  readonly total: number;
}

export const fleetPaneView = (
  fleet: ClientState,
  layout: FleetLayout,
  selectedId: string | null,
  focused: FleetChild | null,
  find: Find | null,
): FleetPaneView => {
  const state = { fleet };
  let body: FleetBody;
  if (layout.total > 0) body = { t: "rows", entries: layout.visible };
  else if (!find) body = { t: "none" };
  else body = searchStale(find) ? { t: "searching" } : { t: "noMatch" };

  return {
    body,
    selectedId,
    focused,
    filterStatus: find ? fleetFilterStatus(find, fleetSessions(state)) : null,
    providerColors: new Map(fleetProviders(state).map((p) => [p.id, p.color])),
    offset: layout.offset,
    shown: layout.visible.length,
    total: layout.total,
  };
};

// ---------------------------------------------------------------------------
// event log
// ---------------------------------------------------------------------------

export interface LogView {
  /** The drilled-into child, when the pane is narrowed to one. */
  readonly child: FleetChild | null;
  /** Compact label for the current filter, for the pane header. */
  readonly tag: string;
  /** True while the viewport is off the live tail: the pane border takes the
   *  accent and the header shows how much is above. */
  readonly scrolled: boolean;
  /** Rows scrolled past above the window, for the `↑N more` indicator. */
  readonly above: number;
  /** The wrapped rows this frame draws — already filtered, measured and
   *  windowed, so a spinner beat repaints them without rebuilding them. */
  readonly rows: readonly PhysicalRow[];
  /** The selected session (or the focused child) is working: draw the spinner
   *  row under the log. */
  readonly spinning: boolean;
}

export const logView = (
  transcript: Transcript,
  box: Outbox,
  sessionId: string | null,
  filter: LogFilter,
  child: FleetChild | null,
  spinning: boolean,
  width: number,
  height: number,
  scroll: number,
): LogView => {
  const capacity = Math.max(1, height - 3);
  const lines = [
    ...transcriptLines(transcript),
    ...waiting(box).map((text) => queuedLine(sessionId ?? "", text)),
  ];
  const ctx = logContext(filterLog(lines, filter, child?.id ?? null), width);
  const total = totalRows(ctx);
  const off = Math.min(scroll, Math.max(0, total - capacity));
  const end = total - off;
  const above = Math.max(0, end - capacity);
  return {
    child,
    tag: logFilterTag(filter),
    scrolled: off > 0,
    above,
    rows: windowRows(ctx, above, end),
    spinning,
  };
};
