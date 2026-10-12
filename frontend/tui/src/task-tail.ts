/**
 * The output tail of the background task the cursor rests on: read from the
 * daemon (`session.taskOutput`) when the task's row is focused and its pane is
 * on screen, then again every {@link TASK_TAIL_POLL_MS} while it stays so. A
 * task that is no longer shown — another row, another tab, the pane folded
 * away, the task ended and its row gone — is not read again.
 */
import type { TaskOutput } from "@loom/core/types";
import { mkStore } from "./store.ts";

/** A background task of a session. */
export interface TaskTailTarget {
  readonly sessionId: string;
  readonly taskId: string;
}

/** What the pane shows for the task. */
export type TaskTail =
  | { readonly t: "loading" }
  | {
      readonly t: "shown";
      readonly output: string;
      readonly totalBytes: number;
      readonly truncated: boolean;
      /** When it was read. */
      readonly at: number;
    }
  /** The provider has no output for this task (Claude: an agent task). */
  | { readonly t: "unreadable" }
  /** The provider cannot read task output at all. */
  | { readonly t: "unsupported" }
  /** The last read failed; the next poll tries again. */
  | { readonly t: "failed"; readonly message: string; readonly at: number };

export interface TaskTailView {
  readonly target: TaskTailTarget;
  readonly tail: TaskTail;
}

export const TASK_TAIL_POLL_MS = 2_000;

const sameTarget = (a: TaskTailTarget | null, b: TaskTailTarget | null): boolean =>
  a === b || (a !== null && b !== null && a.sessionId === b.sessionId && a.taskId === b.taskId);

/** Fold one read into what the pane shows. */
const tailOf = (r: TaskOutput, at: number): TaskTail => {
  switch (r.t) {
    case "output":
      return { t: "shown", output: r.output, totalBytes: r.totalBytes, truncated: r.truncated, at };
    case "unreadable":
      return { t: "unreadable" };
    case "unsupported":
      return { t: "unsupported" };
  }
};

/** Keep polling after this? Only what can change is read again. */
const polls = (tail: TaskTail): boolean => tail.t === "shown" || tail.t === "failed";

export const mkTaskTail = ({
  read,
  pollMs = TASK_TAIL_POLL_MS,
  now = Date.now,
}: {
  read: (target: TaskTailTarget) => Promise<TaskOutput>;
  pollMs?: number;
  now?: () => number;
}) => {
  const store = mkStore<TaskTailView | null>(null);
  // Bumped by every change of target: a read answering an older one is dropped.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = (gen: number): void => {
    timer = null;
    const target = store.get()?.target;
    if (gen !== generation || !target) return;
    const settle = (tail: TaskTail): void => {
      if (gen !== generation) return;
      store.set({ target, tail });
      // One read at a time: the next is timed from this answer, not the last ask.
      if (polls(tail)) timer = setTimeout(() => poll(gen), pollMs);
    };
    read(target).then(
      (r) => settle(tailOf(r, now())),
      (err: unknown) =>
        settle({
          t: "failed",
          message: err instanceof Error ? err.message : String(err),
          at: now(),
        }),
    );
  };

  /** Show this task's tail, or none. Idempotent: the same target keeps its poll. */
  const want = (target: TaskTailTarget | null): void => {
    if (sameTarget(target, store.get()?.target ?? null)) return;
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    store.set(target ? { target, tail: { t: "loading" } } : null);
    if (target) poll(generation);
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    want,
    dispose: (): void => want(null),
  };
};

export type TaskTailControl = ReturnType<typeof mkTaskTail>;
