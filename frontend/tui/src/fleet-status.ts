/**
 * The status a FLEET row shows, which for a Loom supervisor is not always its
 * own (docs/loom-agents.md). Display only: the daemon's state for a supervisor
 * whose turn has ended stays `idle` while its agents work, because the A9
 * queue hands a session its end-of-turn entries — its agents' reports among
 * them — only once it has settled.
 */
import type { SessionStateKind } from "@loom/core/events";
import type { SessionSnapshot } from "@loom/core/wire";

/** Whether any of a session's Loom agents (however deep) still has work going. */
export type AgentsWork = "agents_busy" | "agents_quiet";

/**
 * A turn that has ended while an agent still works reads as background work:
 * its own turn is done, the work it started is not. Anything more specific of
 * its own — a question, an error, a live turn, a stop — shows as itself.
 */
const SHOWN: Record<SessionStateKind, Record<AgentsWork, SessionStateKind>> = {
  awaiting_input: { agents_busy: "awaiting_input", agents_quiet: "awaiting_input" },
  running: { agents_busy: "running", agents_quiet: "running" },
  starting: { agents_busy: "starting", agents_quiet: "starting" },
  working_background: { agents_busy: "working_background", agents_quiet: "working_background" },
  interrupted: { agents_busy: "interrupted", agents_quiet: "interrupted" },
  idle: { agents_busy: "working_background", agents_quiet: "idle" },
  error: { agents_busy: "error", agents_quiet: "error" },
  done: { agents_busy: "done", agents_quiet: "done" },
};

/** What an agent shows that keeps its supervisor working. Its questions and
 *  failures do not: they are on its own row and in the supervisor's summary. */
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

export const shownStatus = (own: SessionStateKind, agents: AgentsWork): SessionStateKind =>
  SHOWN[own][agents];

/** What each session in `sessions` shows, its agents listed there counted in.
 *  A session not in `sessions` shows its own state. */
export const shownStatusIn = (
  sessions: readonly SessionSnapshot[],
): ((s: SessionSnapshot) => SessionStateKind) => {
  // `seen` cuts a supervision loop, which the daemon refuses but a list can
  // still carry mid-update.
  const shown = (s: SessionSnapshot, seen: ReadonlySet<string>): SessionStateKind => {
    const busy = sessions.some(
      (a) =>
        a.supervisorId === s.id && !seen.has(a.id) && WORKING[shown(a, new Set([...seen, a.id]))],
    );
    return shownStatus(s.status.kind, busy ? "agents_busy" : "agents_quiet");
  };
  return (s) => shown(s, new Set([s.id]));
};
