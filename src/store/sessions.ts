import type { SessionStatus, TokenUsage } from "../protocol/events.ts";
import type { SessionSnapshot } from "../protocol/wire.ts";
import type { Db } from "./db.ts";

// ---------------------------------------------------------------------------
// Row shapes (snake_case, straight from SQLite)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  parent_id: string | null;
  provider: string;
  model: string | null;
  mode: string;
  status: string;
  await_reason: string | null;
  title: string | null;
  worktree: string | null;
  branch: string | null;
  base_branch: string | null;
  provider_ref: string | null;
  budget_max_tokens: number | null;
  budget_max_cost_usd: number | null;
  budget_max_turns: number | null;
  created_at: number;
  updated_at: number;
}

interface UsageRow {
  session_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  context_used: number;
  context_limit: number;
  cost_usd: number;
  turns: number;
  updated_at: number;
}

export interface NewSession {
  id: string;
  provider: string;
  model?: string | null;
  mode?: string;
  parentId?: string | null;
  title?: string | null;
  worktree?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  providerRef?: string | null;
  budget?: {
    maxTokens?: number | null;
    maxCostUsd?: number | null;
    maxTurns?: number | null;
  };
}

export interface UsageDelta {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  turns?: number;
  costUsd?: number;
  /** Absolute values (last-request), not deltas. */
  contextUsed?: number;
  contextLimit?: number;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(s: NewSession): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO sessions
           (id, parent_id, provider, model, mode, status, title, worktree, branch,
            base_branch, provider_ref, budget_max_tokens, budget_max_cost_usd,
            budget_max_turns, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.parentId ?? null,
        s.provider,
        s.model ?? null,
        s.mode ?? "default",
        s.title ?? null,
        s.worktree ?? null,
        s.branch ?? null,
        s.baseBranch ?? null,
        s.providerRef ?? null,
        s.budget?.maxTokens ?? null,
        s.budget?.maxCostUsd ?? null,
        s.budget?.maxTurns ?? null,
        now,
        now,
      );
    this.#db.prepare("INSERT INTO usage (session_id, updated_at) VALUES (?, ?)").run(s.id, now);
    this.#appendHistory(s.id, "starting", null, now);
  }

  get(id: string): SessionSnapshot | null {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as
      | SessionRow
      | undefined;
    if (!row) return null;
    const usage = this.#db.prepare("SELECT * FROM usage WHERE session_id = ?").get(id) as unknown as
      | UsageRow
      | undefined;
    return toSnapshot(row, usage);
  }

  list(): SessionSnapshot[] {
    const rows = this.#db.prepare("SELECT * FROM sessions").all() as unknown as SessionRow[];
    const usageRows = this.#db.prepare("SELECT * FROM usage").all() as unknown as UsageRow[];
    const byId = new Map(usageRows.map((u) => [u.session_id, u]));
    return rows.map((r) => toSnapshot(r, byId.get(r.id)));
  }

  setStatus(id: string, status: SessionStatus, reason: string | null = null): void {
    const now = Date.now();
    // `await_reason` is only meaningful while awaiting input; clear it otherwise.
    // The reason is still recorded in status_history for every transition.
    const awaitReason = status === "awaiting_input" ? reason : null;
    const res = this.#db
      .prepare("UPDATE sessions SET status = ?, await_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, awaitReason, now, id);
    if (res.changes === 0) throw new Error(`no such session: ${id}`);
    this.#appendHistory(id, status, reason, now);
  }

  /** Flip every session left mid-run by a crashed daemon to `interrupted`. */
  markMidRunInterrupted(): string[] {
    const now = Date.now();
    const rows = this.#db
      .prepare("SELECT id FROM sessions WHERE status IN ('starting', 'running', 'awaiting_input')")
      .all() as Array<{ id: string }>;
    const stmt = this.#db.prepare(
      "UPDATE sessions SET status = 'interrupted', await_reason = NULL, updated_at = ? WHERE id = ?",
    );
    for (const { id } of rows) {
      stmt.run(now, id);
      this.#appendHistory(id, "interrupted", "daemon_restart", now);
    }
    return rows.map((r) => r.id);
  }

  setFields(
    id: string,
    fields: Partial<{
      model: string | null;
      mode: string;
      title: string | null;
      worktree: string | null;
      branch: string | null;
      providerRef: string | null;
    }>,
  ): void {
    const cols: string[] = [];
    const vals: Array<string | null> = [];
    const map: Record<string, string> = {
      model: "model",
      mode: "mode",
      title: "title",
      worktree: "worktree",
      branch: "branch",
      providerRef: "provider_ref",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in fields) {
        cols.push(`${col} = ?`);
        vals.push((fields as Record<string, string | null>)[k] ?? null);
      }
    }
    if (cols.length === 0) return;
    vals.push(String(Date.now()));
    this.#db
      .prepare(`UPDATE sessions SET ${cols.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...vals, id);
  }

  addUsage(id: string, d: UsageDelta): void {
    const now = Date.now();
    // input/output/cache/cost/turns accumulate; context_used / context_limit
    // are absolute (last-request) and only overwritten when the delta carries
    // them — a bare `{ turns: 1 }` must not zero the context bar.
    this.#db
      .prepare(
        `UPDATE usage SET
           input = input + ?,
           output = output + ?,
           cache_read = cache_read + ?,
           cache_write = cache_write + ?,
           cost_usd = cost_usd + ?,
           turns = turns + ?,
           context_used = COALESCE(?, context_used),
           context_limit = COALESCE(?, context_limit),
           updated_at = ?
         WHERE session_id = ?`,
      )
      .run(
        d.input ?? 0,
        d.output ?? 0,
        d.cacheRead ?? 0,
        d.cacheWrite ?? 0,
        d.costUsd ?? 0,
        d.turns ?? 0,
        d.contextUsed ?? null,
        d.contextLimit ?? null,
        now,
        id,
      );
  }

  /** The provider's own persisted session id, once the adapter reports it. */
  providerRef(id: string): string | null {
    const row = this.#db
      .prepare("SELECT provider_ref FROM sessions WHERE id = ?")
      .get(id) as { provider_ref: string | null } | undefined;
    return row?.provider_ref ?? null;
  }

  statusHistory(id: string): Array<{ status: string; reason: string | null; at: number }> {
    return this.#db
      .prepare("SELECT status, reason, at FROM status_history WHERE session_id = ? ORDER BY id")
      .all(id) as Array<{ status: string; reason: string | null; at: number }>;
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  #appendHistory(id: string, status: string, reason: string | null, at: number): void {
    this.#db
      .prepare("INSERT INTO status_history (session_id, status, reason, at) VALUES (?, ?, ?, ?)")
      .run(id, status, reason, at);
  }
}

// ---------------------------------------------------------------------------
// runtime_children — child processes tracked for restart hygiene
// ---------------------------------------------------------------------------

export interface ChildRow {
  pid: number;
  session_id: string | null;
  kind: string;
  daemon_epoch: string;
  started_at: number;
}

export class ChildStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(pid: number, kind: string, daemonEpoch: string, sessionId: string | null = null): void {
    this.#db
      .prepare(
        `INSERT INTO runtime_children (pid, session_id, kind, daemon_epoch, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pid) DO UPDATE SET
           session_id = excluded.session_id,
           kind = excluded.kind,
           daemon_epoch = excluded.daemon_epoch,
           started_at = excluded.started_at`,
      )
      .run(pid, sessionId, kind, daemonEpoch, Date.now());
  }

  forget(pid: number): void {
    this.#db.prepare("DELETE FROM runtime_children WHERE pid = ?").run(pid);
  }

  all(): ChildRow[] {
    return this.#db.prepare("SELECT * FROM runtime_children").all() as unknown as ChildRow[];
  }

  /** Rows not belonging to the current daemon epoch — candidates for reaping. */
  fromOtherEpochs(currentEpoch: string): ChildRow[] {
    return this.#db
      .prepare("SELECT * FROM runtime_children WHERE daemon_epoch != ?")
      .all(currentEpoch) as unknown as ChildRow[];
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toSnapshot(row: SessionRow, usage: UsageRow | undefined): SessionSnapshot {
  return {
    id: row.id,
    parentId: row.parent_id,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    status: row.status as SessionStatus,
    awaitReason: row.await_reason,
    title: row.title,
    worktree: row.worktree,
    branch: row.branch,
    usage: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cache_read,
          cacheWrite: usage.cache_write,
        }
      : { ...ZERO_USAGE },
    contextUsed: usage?.context_used ?? 0,
    contextLimit: usage?.context_limit ?? 0,
    costUsd: usage?.cost_usd ?? 0,
    turns: usage?.turns ?? 0,
    budget: {
      maxTokens: row.budget_max_tokens,
      maxCostUsd: row.budget_max_cost_usd,
      maxTurns: row.budget_max_turns,
    },
    git: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
