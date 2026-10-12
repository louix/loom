/**
 * The archive reminder (`[archive_reminder]`, docs/loom-agents.md,
 * Lifecycle): as a supervisor's turn ends, one Loom message naming its
 * children that have finished and are not archived, each child at most once.
 * The decision is pure; the daemon reads the facts and sends the message.
 */
import type { LoomMessage } from "@loom/core/loom-message";
import type { SessionState } from "@loom/core/session-state";
import type { GitFacts } from "@loom/core/wire";

/** A child as its supervisor's turn end finds it. */
export interface ReminderChild {
  readonly id: string;
  readonly title: string | null;
  readonly state: SessionState["kind"];
  /** Named in an earlier reminder (`archive_reminded`, kept across restarts). */
  readonly reminded: boolean;
  /** Its report is still being made or waits in the supervisor's queue: the
   *  supervisor has not seen that it finished. */
  readonly reportPending: boolean;
  /** Messages wait in its own queue: it has more to do. */
  readonly queued: boolean;
}

/** The supervisor's queue as its turn ends. */
export interface ReminderSupervisor {
  /** Any hold, the user's or not: a reminder never lifts or passes one. */
  readonly held: boolean;
  /** Entries wait: they start its next turn, whose end decides again. */
  readonly queued: boolean;
}

/** A child to name, with the state it finished in as the supervisor reads it. */
export interface FinishedChild {
  readonly id: string;
  readonly title: string | null;
  readonly finished: string;
}

export type ArchiveReminder =
  | { readonly kind: "none" }
  | { readonly kind: "later"; readonly why: "held" | "queued" }
  | { readonly kind: "remind"; readonly children: readonly FinishedChild[] };

/** Settled states, as the reminder names them; null for a child that is not finished. */
const FINISHED_AS: Record<SessionState["kind"], string | null> = {
  idle: "idle",
  error: "failed",
  interrupted: "interrupted",
  starting: null,
  running: null,
  working_background: null,
  awaiting_input: null,
  done: null,
};

/**
 * What a supervisor's turn end does about its children: nothing when none
 * has finished unannounced; `later` when its queue is held or has entries
 * waiting (nothing is reminded, so its next turn end decides again);
 * otherwise one reminder naming them.
 */
export const archiveReminder = (
  supervisor: ReminderSupervisor,
  children: readonly ReminderChild[],
): ArchiveReminder => {
  const finished = children.flatMap((c): FinishedChild[] => {
    const as = FINISHED_AS[c.state];
    return as === null || c.reminded || c.reportPending || c.queued
      ? []
      : [{ id: c.id, title: c.title, finished: as }];
  });
  if (finished.length === 0) return { kind: "none" };
  if (supervisor.held) return { kind: "later", why: "held" };
  if (supervisor.queued) return { kind: "later", why: "queued" };
  return { kind: "remind", children: finished };
};

/** A child's branch against the supervisor's, its base. */
const showWorkspace = (git: GitFacts): string =>
  [
    git.aheadOfBase === 0
      ? "branch merged"
      : `${git.aheadOfBase} commit${git.aheadOfBase === 1 ? "" : "s"} not merged into yours`,
    ...(git.dirty ? ["uncommitted changes"] : []),
  ].join(", ");

/** The reminder; `git`, each child's workspace facts where they could be read. */
export const archiveReminderMessage = (
  children: readonly FinishedChild[],
  git: (id: string) => GitFacts | null,
): LoomMessage => ({
  kind: "archive_reminder",
  children: children.map((c) => {
    const facts = git(c.id);
    return {
      id: c.id,
      title: c.title,
      about: [c.finished, ...(facts ? [showWorkspace(facts)] : [])].join(", "),
    };
  }),
});
