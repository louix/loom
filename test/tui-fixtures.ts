import type { AwaitReason } from "@loom/core/events";
import {
  stateAwaitingInput,
  type SessionState,
  type SessionStateKind,
} from "@loom/core/session-state";
import type { DaemonInfo, ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { loadableLoaded } from "@loom/core/loadable";
import type { QueueEntryView, SessionQueue } from "@loom/core/message-queue";
import type { Action } from "@loom/tui/model";

let clock = 1_000;

/** One queue entry as a snapshot carries it: queued for the next boundary,
 *  written by `client-a`, unless `over` says otherwise. */
export const queueEntry = (id: string, over: Partial<QueueEntryView> = {}): QueueEntryView => ({
  id,
  author: "client-a",
  delivery: "next_boundary",
  state: "queued",
  uncertain: false,
  revision: 0,
  preview: `text ${id}`,
  bytes: 6,
  dequeue: { t: "next_tool_or_turn_end" },
  ...over,
});

/** A session's queue for `snap({ queue })`. */
export const queueOf = (
  entries: readonly QueueEntryView[],
  hold: SessionQueue["hold"] = null,
): SessionQueue => ({ hold, entries: [...entries] });

/** Build a `SessionState` from a bare kind (+ an await reason), for fixtures. */
const toState = (
  kind: SessionStateKind = "idle",
  awaitReason: AwaitReason | null = null,
): SessionState => {
  switch (kind) {
    case "awaiting_input":
      return stateAwaitingInput(awaitReason ?? "permission");
    case "interrupted":
      return { kind: "interrupted", by: "user" };
    case "error":
      return { kind: "error", message: "" };
    default:
      return { kind } as SessionState;
  }
};

export const snap = (
  over: Partial<Omit<SessionSnapshot, "status">> & {
    status?: SessionStateKind | SessionState;
    awaitReason?: AwaitReason | null;
  } = {},
): SessionSnapshot => {
  const now = ++clock;
  const { status: statusKind, awaitReason, ...rest } = over;
  return {
    id: over.id ?? `s${now}`,
    parentId: null,
    forkTurn: null,
    provider: "fake",
    model: null,
    effort: null,
    mode: "default",
    status: typeof statusKind === "object" ? statusKind : toState(statusKind, awaitReason),
    title: "a task",
    comment: null,
    worktree: null,
    branch: null,
    baseBranch: null,
    inPlace: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsed: 0,
    contextLimit: 0,
    costUsd: 0,
    costSource: "none",
    turns: 0,
    requests: [],
    subagents: [],
    backgroundTasks: [],
    rateLimits: {},
    cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
    keepWarm: false,
    canRewind: true,
    resumable: true,
    git: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
};

export const daemon: DaemonInfo = {
  pid: 1,
  version: "0.0.1",
  repoRoot: "/tmp/demo",
  startedAt: 0,
  epoch: "e1",
};

/**
 * A complete-replacement snapshot action — the only way fleet state reaches the
 * reducer. Tests that used to push a single per-session update now hand over the
 * whole fleet as it stands after the change, which is exactly what the daemon
 * does.
 */
export const fleet = (sessions: SessionSnapshot[], providers: ProviderInfo[] = []): Action => ({
  t: "state",
  state: loadableLoaded({ daemon, providers, sessions }),
});
