import type { HarnessEvent, SessionStatus, TokenUsage } from "./events.ts";

/**
 * Loom's client<->daemon wire protocol: newline-delimited JSON over a Unix
 * domain socket. One connection multiplexes two logical channels:
 *
 *   - request / response  (client -> daemon -> client), correlated by `id`
 *   - a server -> client push stream of events, each stamped with a monotonic `seq`
 *
 * Every frame is a single JSON object on its own line. `kind` discriminates.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface RequestFrame {
  kind: "req";
  id: number;
  method: string;
  params?: unknown;
}

export interface OkResponseFrame {
  kind: "res";
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrResponseFrame {
  kind: "res";
  id: number;
  ok: false;
  error: WireError;
}

export type ResponseFrame = OkResponseFrame | ErrResponseFrame;

export interface WireError {
  code: string;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Server -> client push stream
// ---------------------------------------------------------------------------

/** A normalized harness event, forwarded to every attached client. */
export interface EventPush {
  kind: "push";
  seq: number;
  type: "event";
  event: HarnessEvent;
}

/** A session's authoritative fields changed (status/mode/model/usage/git). */
export interface SessionUpdatedPush {
  kind: "push";
  seq: number;
  type: "session_updated";
  session: SessionSnapshot;
  /** Bumped on every authoritative change; clients ignore older versions. */
  version: number;
  /** Who caused the change, when a client did. */
  by?: string;
}

/** A session row disappeared (gc). */
export interface SessionRemovedPush {
  kind: "push";
  seq: number;
  type: "session_removed";
  sessionId: string;
}

/**
 * The daemon could not replay the client's requested `sinceSeq` because the
 * ring buffer had already rolled past it. The client must discard local state
 * and treat the `hello` snapshot (or a fresh `session.list`) as authoritative.
 */
export interface ResyncPush {
  kind: "push";
  seq: number;
  type: "resync";
  reason: string;
}

export type PushFrame = EventPush | SessionUpdatedPush | SessionRemovedPush | ResyncPush;

export type Frame = RequestFrame | ResponseFrame | PushFrame;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface GitFacts {
  branch: string | null;
  commits: number;
  aheadOfBase: number;
  behindBase: number;
  dirty: boolean;
  lastCommitSubject: string | null;
}

export interface SessionSnapshot {
  id: string;
  parentId: string | null;
  provider: string;
  model: string | null;
  mode: string;
  status: SessionStatus;
  awaitReason: string | null;
  title: string | null;
  worktree: string | null;
  branch: string | null;
  baseBranch: string | null;
  usage: TokenUsage;
  contextUsed: number;
  contextLimit: number;
  costUsd: number;
  /** Where `costUsd` was computed — a local price table, the provider, or nothing yet. */
  costSource: "table" | "provider" | "none";
  turns: number;
  budget: { maxTokens: number | null; maxCostUsd: number | null; maxTurns: number | null };
  /** Budget enforcement state: `ok`, `warned` (soft breach), `halted` (hard breach → interrupted). */
  budgetState: "ok" | "warned" | "halted";
  /** Sub-agents this session has spawned (Claude's Task tool). Runtime-only, not persisted. */
  subagents: Array<{ id: string; name: string; active: boolean }>;
  git: GitFacts | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// hello handshake
// ---------------------------------------------------------------------------

export interface HelloParams {
  protocolVersion: number;
  /** Stable id for this client instance; used in change attribution. */
  clientId: string;
  /** Last push `seq` the client processed, for gap replay. Omit on first attach. */
  sinceSeq?: number;
}

export interface HelloResult {
  protocolVersion: number;
  daemon: {
    pid: number;
    version: string;
    startedAt: number;
    repoRoot: string;
  };
  /** Authoritative session list at handshake time. */
  sessions: SessionSnapshot[];
  /** Current head of the push stream. Frames after this arrive live. */
  seq: number;
  /**
   * True when the daemon will replay buffered frames in `(sinceSeq, seq]`.
   * False when it could not (buffer rolled, or no `sinceSeq` given) and the
   * client should rely on `sessions` above.
   */
  replaying: boolean;
}
