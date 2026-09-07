/**
 * What each pane draws, derived once per frame from the inputs it actually
 * reads.
 *
 * The root used to hand every pane the whole {@link TuiState} and a fresh
 * `Date.now()`, so a spinner beat re-derived the transcript and a keystroke in
 * the prompt rebuilt the fleet list. A pane's inputs are narrower than that,
 * and none of these builders reads anything a pane does not draw — which is
 * what lets the handle memoise them on identity and lets the components sit
 * behind `React.memo` without a custom comparison anywhere.
 *
 * Colours are deliberately absent. A view carries the *state* a pane paints
 * (`Connection`, `Tone`, a status kind); the component looks the colour up
 * through `theme.ts` as it renders, so switching the theme repaints without
 * invalidating a single memo.
 */
import type { SessionMode } from "@loom/core/types";
import type { SessionSnapshot } from "@loom/core/wire";
import { fleetFilterStatus, searchStale } from "./fleet-search.ts";
import {
  cacheStatus,
  compactingFor,
  fleetDaemon,
  fleetProviders,
  fleetSessions,
  focusedChildOf,
  providerAccountOf,
  providerColorOf,
  queueFor,
  shownLog,
  type Connection,
  type FleetChild,
  type FleetEntry,
  type FleetLayout,
  type TuiState,
} from "./model.ts";
import { pendingMode } from "./mode-control.ts";
import { logContext, logFilterTag, totalRows, windowRows, type PhysicalRow } from "./transcript.ts";

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

export const headerView = (state: TuiState, connection: Connection): HeaderView => {
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
  | { readonly t: "unknown" }
  | { readonly t: "none" }
  | { readonly t: "searching" }
  | { readonly t: "noMatch" }
  | { readonly t: "rows"; readonly entries: readonly FleetEntry[] };

export interface FleetPaneView {
  readonly connection: Connection;
  readonly body: FleetBody;
  readonly selectedId: string | null;
  /** The drilled-into child, when the selection is drilled in. */
  readonly focused: FleetChild | null;
  /** The filter's header text, or null while the filter is closed. */
  readonly filterStatus: string | null;
  /** Provider id → its fleet colour, from the snapshot. */
  readonly providerColors: ReadonlyMap<string, string>;
  /** Sessions with a compaction in flight — a `⇊` in the cache-dot slot. */
  readonly compacting: ReadonlySet<string>;
  /** Window position, for the `↕ a–b of n` row. */
  readonly offset: number;
  readonly shown: number;
  readonly total: number;
  /** True while any visible row's cache is warm — a colour that moves with the
   *  clock, and the only thing in this pane that does apart from the spinner. */
  readonly ages: boolean;
  /** True while any visible row spins. */
  readonly spins: boolean;
}

const SPINNING = new Set(["running", "starting", "working_background"]);

export const fleetPaneView = (
  state: TuiState,
  layout: FleetLayout,
  connection: Connection,
  now: number,
): FleetPaneView => {
  const compacting = new Set<string>();
  for (const s of fleetSessions(state)) if (s.compacting !== undefined) compacting.add(s.id);

  let body: FleetBody;
  if (state.fleet.tag !== "data") body = { t: "unknown" };
  else if (layout.total > 0) body = { t: "rows", entries: layout.visible };
  else if (!state.find) body = { t: "none" };
  else body = searchStale(state.find) ? { t: "searching" } : { t: "noMatch" };

  let ages = false;
  let spins = false;
  for (const e of layout.visible) {
    if (e.kind === "child") spins = true;
    if (e.kind !== "session") continue;
    if (SPINNING.has(e.s.status.kind) || compacting.has(e.s.id)) spins = true;
    if (cacheStatus(e.s, now).state === "warm") ages = true;
  }

  return {
    connection,
    body,
    selectedId: state.selectedId,
    focused: focusedChildOf(state),
    filterStatus: state.find ? fleetFilterStatus(state.find, fleetSessions(state)) : null,
    providerColors: new Map(fleetProviders(state).map((p) => [p.id, p.color])),
    compacting,
    offset: layout.offset,
    shown: layout.visible.length,
    total: layout.total,
    ages,
    spins,
  };
};

// ---------------------------------------------------------------------------
// detail pane
// ---------------------------------------------------------------------------

export interface DetailView {
  readonly session: SessionSnapshot;
  readonly queued: readonly string[];
  /** Ink colour for the provider/model line; matches the Fleet id colour. */
  readonly engineColor: string;
  /** `<login method> (<org>)` for a Claude profile; "" hides the line. */
  readonly account: string;
  readonly compacting: { readonly startedAt: number; readonly before: number } | null;
  /** The mode a cycle is heading for while the daemon has not taken it yet. */
  readonly pendingMode: SessionMode | null;
  /** The pane shows a cache countdown or a rate-limit reset: text that moves
   *  with the clock even when nothing is running. */
  readonly ages: boolean;
}

export const detailView = (
  state: TuiState,
  sel: SessionSnapshot | null,
  now: number,
): DetailView | null => {
  if (!sel) return null;
  const compacting = compactingFor(state, sel.id);
  return {
    session: sel,
    queued: queueFor(state, sel.id),
    engineColor: providerColorOf(state, sel.provider),
    account: providerAccountOf(state, sel.provider),
    compacting,
    pendingMode: pendingMode(state.modes, sel.id),
    ages:
      compacting !== null ||
      cacheStatus(sel, now).state === "warm" ||
      Object.keys(sel.rateLimits).length > 0,
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
  state: TuiState,
  sel: SessionSnapshot | null,
  width: number,
  height: number,
  scroll: number,
): LogView => {
  const child = focusedChildOf(state);
  const capacity = Math.max(1, height - 3);
  const ctx = logContext(shownLog(state), width);
  const total = totalRows(ctx);
  const off = Math.min(scroll, Math.max(0, total - capacity));
  const end = total - off;
  const above = Math.max(0, end - capacity);
  return {
    child,
    tag: logFilterTag(state.logFilter),
    scrolled: off > 0,
    above,
    rows: windowRows(ctx, above, end),
    spinning: child !== null || (sel !== null && SPINNING.has(sel.status.kind)),
  };
};
