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
 * A session's position within its group: when its last user-submitted root
 * turn ended, else when it was created. The key only moves at a turn boundary
 * the daemon persists, so streaming, tool and sub-agent activity, usage,
 * renames and incoming snapshot order cannot shuffle a group.
 */
const recency = (s: SessionSnapshot): number => s.turnCompletedAt ?? s.createdAt;

const byId = (a: SessionSnapshot, b: SessionSnapshot): number =>
  a.id < b.id ? -1 : Number(a.id > b.id);

/**
 * Status group, then most recent turn boundary first, then id — for every
 * session nobody in the list supervises. Each one's Loom agents follow it,
 * nested in the order they were started (and theirs after them), whatever
 * their own status: the fleet draws them under their supervisor, and the
 * cursor walks them there.
 */
export const sortSessions = (list: readonly SessionSnapshot[]): SessionSnapshot[] => {
  const ids = new Set(list.map((s) => s.id));
  const nested = (s: SessionSnapshot) =>
    s.supervisorId !== undefined && s.supervisorId !== s.id && ids.has(s.supervisorId);
  const roots = list
    .filter((s) => !nested(s))
    .sort((a, b) => {
      const group = RANK[a.status.kind] - RANK[b.status.kind];
      if (group !== 0) return group;
      const recent = recency(b) - recency(a);
      if (recent !== 0) return recent;
      return byId(a, b);
    });
  const agents = new Map<string, SessionSnapshot[]>();
  for (const s of list.filter(nested).sort((a, b) => a.createdAt - b.createdAt || byId(a, b)))
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
