import type { SessionStateKind } from "./events.ts";
import type { SessionSnapshot } from "./wire.ts";

// Exhaustive: adding a session state requires choosing its fleet position.
const RANK: Record<SessionStateKind, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 2,
  working_background: 3,
  interrupted: 4,
  idle: 5,
  error: 6,
  done: 7,
};

/** Shared fleet section order, also used for keyboard navigation. */
export const STATUS_ORDER: readonly SessionStateKind[] = (
  Object.keys(RANK) as SessionStateKind[]
).sort((a, b) => RANK[a] - RANK[b]);

/**
 * Status group, then newest-created first. Only immutable fields break ties:
 * activity, naming and incoming snapshot order cannot shuffle a group.
 */
export const sortSessions = (list: readonly SessionSnapshot[]): SessionSnapshot[] =>
  [...list].sort((a, b) => {
    const group = RANK[a.status.kind] - RANK[b.status.kind];
    if (group !== 0) return group;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : Number(a.id > b.id);
  });
