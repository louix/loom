/**
 * The status a FLEET row shows, which for a Loom supervisor is not always its
 * own (docs/loom-agents.md). Display only: the daemon's state for a supervisor
 * whose turn has ended stays `idle` while its agents work, because the A9
 * queue hands a session its end-of-turn entries — its agents' reports among
 * them — only once it has settled. An agent's question is answered on the
 * agent's own row; its supervisor only points at it.
 */
import type { SessionStateKind } from "@loom/core/events";
import type { SessionSnapshot } from "@loom/core/wire";

/**
 * What a session's Loom agents (however deep) add to its row. A question
 * outranks work: it waits on the person, work does not.
 */
export type AgentsState = "agents_asking" | "agents_busy" | "agents_quiet";

/**
 * An agent waiting on the person raises its supervisor into needs-input; a
 * turn that has ended while an agent still works reads as background work.
 * The supervisor's own question, error or stop shows as itself, and an
 * archived supervisor stays archived.
 */
const SHOWN: Record<SessionStateKind, Record<AgentsState, SessionStateKind>> = {
  awaiting_input: {
    agents_asking: "awaiting_input",
    agents_busy: "awaiting_input",
    agents_quiet: "awaiting_input",
  },
  running: { agents_asking: "awaiting_input", agents_busy: "running", agents_quiet: "running" },
  starting: { agents_asking: "awaiting_input", agents_busy: "starting", agents_quiet: "starting" },
  working_background: {
    agents_asking: "awaiting_input",
    agents_busy: "working_background",
    agents_quiet: "working_background",
  },
  interrupted: {
    agents_asking: "interrupted",
    agents_busy: "interrupted",
    agents_quiet: "interrupted",
  },
  idle: {
    agents_asking: "awaiting_input",
    agents_busy: "working_background",
    agents_quiet: "idle",
  },
  error: { agents_asking: "error", agents_busy: "error", agents_quiet: "error" },
  done: { agents_asking: "done", agents_busy: "done", agents_quiet: "done" },
};

/** What an agent shows that keeps its supervisor working. Its questions
 *  count apart (`agents_asking`); its failures not at all: they are on its
 *  own row and in the supervisor's summary. */
const WORKING: Record<SessionStateKind, boolean> = {
  awaiting_input: false,
  running: true,
  starting: true,
  working_background: true,
  interrupted: false,
  idle: false,
  error: false,
  done: false,
};

export const shownStatus = (own: SessionStateKind, agents: AgentsState): SessionStateKind =>
  SHOWN[own][agents];

/** The agents under `s` (however deep) waiting on the person, by their own
 *  state, depth first in `sessions` order. */
export const waitingAgentsIn =
  (sessions: readonly SessionSnapshot[]) =>
  (s: SessionSnapshot): SessionSnapshot[] =>
    waitingUnder(sessions, s, new Set([s.id]));

/** What each session in `sessions` shows, its agents listed there counted in.
 *  A session not in `sessions` shows its own state. */
export const shownStatusIn = (
  sessions: readonly SessionSnapshot[],
): ((s: SessionSnapshot) => SessionStateKind) => {
  // `seen` cuts a supervision loop, which the daemon refuses but a list can
  // still carry mid-update.
  const shown = (s: SessionSnapshot, seen: ReadonlySet<string>): SessionStateKind => {
    if (waitingUnder(sessions, s, seen).length > 0)
      return shownStatus(s.status.kind, "agents_asking");
    const busy = sessions.some(
      (a) =>
        a.supervisorId === s.id && !seen.has(a.id) && WORKING[shown(a, new Set([...seen, a.id]))],
    );
    return shownStatus(s.status.kind, busy ? "agents_busy" : "agents_quiet");
  };
  return (s) => shown(s, new Set([s.id]));
};

const waitingUnder = (
  sessions: readonly SessionSnapshot[],
  s: SessionSnapshot,
  seen: ReadonlySet<string>,
): SessionSnapshot[] =>
  sessions
    .filter((a) => a.supervisorId === s.id && !seen.has(a.id))
    .flatMap((a) => [
      ...(a.status.kind === "awaiting_input" ? [a] : []),
      ...waitingUnder(sessions, a, new Set([...seen, a.id])),
    ]);
