import type { SessionStateKind } from "./events.ts";
import type { SessionSnapshot } from "./wire.ts";

/** A fleet section. Background work is listed with running, so it has no
 *  section of its own to be drawn in or navigated to. */
export type FleetGroup = Exclude<SessionStateKind, "working_background">;

// Exhaustive: adding a session state requires choosing its section.
const GROUP: Record<SessionStateKind, FleetGroup> = {
  awaiting_input: "awaiting_input",
  running: "running",
  starting: "starting",
  working_background: "running",
  interrupted: "interrupted",
  idle: "idle",
  error: "error",
  done: "done",
};

// Exhaustive: adding a section requires choosing its position.
const RANK: Record<FleetGroup, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 2,
  interrupted: 3,
  idle: 4,
  error: 5,
  done: 6,
};

/** The section a session showing `kind` is listed in. */
export const groupOf = (kind: SessionStateKind): FleetGroup => GROUP[kind];

/** Every session state. */
export const SESSION_STATE_KINDS = Object.keys(GROUP) as readonly SessionStateKind[];

/** Shared fleet section order: the fleet draws its sections in it, and
 *  {@link sortSessionsBy} ranks by it, so keyboard navigation follows suit. */
export const GROUP_ORDER: readonly FleetGroup[] = (Object.keys(RANK) as FleetGroup[]).sort(
  (a, b) => RANK[a] - RANK[b],
);

/**
 * A session's position within its group: when its last user-submitted root
 * turn ended, else when it was created. The key only moves at a turn boundary
 * the daemon persists, so streaming, tool and sub-agent activity, usage,
 * renames and incoming snapshot order cannot shuffle a group.
 */
const recency = (s: SessionSnapshot): number => s.turnCompletedAt ?? s.createdAt;

const byId = (a: SessionSnapshot, b: SessionSnapshot): number =>
  a.id < b.id ? -1 : Number(a.id > b.id);

/**
 * Section (see {@link groupOf}) of the state `kindOf` names, then most recent turn boundary first,
 * then id — for every session nobody in the list supervises. Each one's Loom
 * agents follow it, nested and ordered the same way among themselves (so an
 * archived one comes last), and theirs after them: the fleet draws them under
 * their supervisor.
 */
export const sortSessionsBy =
  (kindOf: (s: SessionSnapshot) => SessionStateKind) =>
  (list: readonly SessionSnapshot[]): SessionSnapshot[] => {
    const ids = new Set(list.map((s) => s.id));
    const nested = (s: SessionSnapshot) =>
      s.supervisorId !== undefined && s.supervisorId !== s.id && ids.has(s.supervisorId);
    const order = (a: SessionSnapshot, b: SessionSnapshot): number => {
      const group = RANK[groupOf(kindOf(a))] - RANK[groupOf(kindOf(b))];
      if (group !== 0) return group;
      const recent = recency(b) - recency(a);
      if (recent !== 0) return recent;
      return byId(a, b);
    };
    const roots = list.filter((s) => !nested(s)).sort(order);
    const agents = new Map<string, SessionSnapshot[]>();
    for (const s of list.filter(nested).sort(order))
      agents.set(s.supervisorId!, [...(agents.get(s.supervisorId!) ?? []), s]);
    const out: SessionSnapshot[] = [];
    const seen = new Set<string>();
    const place = (s: SessionSnapshot): void => {
      if (seen.has(s.id)) return;
      seen.add(s.id);
      out.push(s);
      for (const agent of agents.get(s.id) ?? []) place(agent);
    };
    for (const s of roots) place(s);
    // A supervision loop has no root to hang from: keep its sessions listed.
    for (const s of list) place(s);
    return out;
  };

/** {@link sortSessionsBy} each session's own state. */
export const sortSessions = sortSessionsBy((s) => s.status.kind);

/** How deep `s` is nested under supervisors in `list`: 0 for a root row. */
export const nestingDepth = (
  s: SessionSnapshot,
  byIdIn: ReadonlyMap<string, SessionSnapshot>,
): number => {
  let depth = 0;
  const seen = new Set<string>([s.id]);
  for (let at = s.supervisorId; at !== undefined && byIdIn.has(at) && !seen.has(at); depth++) {
    seen.add(at);
    at = byIdIn.get(at)!.supervisorId;
  }
  return depth;
};
