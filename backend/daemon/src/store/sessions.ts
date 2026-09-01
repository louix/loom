import type { TokenUsage } from "@loom/core/events";
import { parseSessionState, type SessionState, sessionStateDetail } from "@loom/core/session-state";
import type { SessionSnapshot } from "@loom/core/wire";
import { type Db, withTransaction } from "./db.ts";

// ---------------------------------------------------------------------------
// Row shapes (snake_case, straight from SQLite)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  parent_id: string | null;
  provider: string;
  model: string | null;
  effort: string | null;
  mode: string;
  status: string;
  status_detail: string | null;
  title: string | null;
  worktree: string | null;
  branch: string | null;
  base_branch: string | null;
  in_place: number;
  provider_ref: string | null;
  title_locked: number;
  fork_turn: number | null;
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
  cost_source: string;
  turns: number;
  last_turn_at: number;
  last_cache_read: number;
  last_cache_write: number;
  updated_at: number;
}

export interface NewSession {
  id: string;
  provider: string;
  model?: string | null;
  effort?: string | null;
  mode?: string;
  parentId?: string | null;
  title?: string | null;
  worktree?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  /** Runs in the repo working dir, no dedicated worktree. Immutable after create. */
  inPlace?: boolean;
  providerRef?: string | null;
}

export interface UsageDelta {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  turns?: number;
  costUsd?: number;
  /** Where `costUsd` came from — overwrites the stored value when present. */
  costSource?: "table" | "provider" | "none";
  /** Absolute values (last-request), not deltas. */
  contextUsed?: number;
  contextLimit?: number;
  /** Wall-clock of the turn this delta closed — arms the cache countdown. */
  lastTurnAt?: number;
  /** This turn's cache read / write token split (absolute, not accumulated). */
  lastCacheRead?: number;
  lastCacheWrite?: number;
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
    // One transaction: an interrupted `create` must not leave a session row
    // without its `usage` row / opening history entry.
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO sessions
             (id, parent_id, provider, model, effort, mode, status, title, worktree, branch,
              base_branch, in_place, provider_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.id,
          s.parentId ?? null,
          s.provider,
          s.model ?? null,
          s.effort ?? null,
          s.mode ?? "default",
          s.title ?? null,
          s.worktree ?? null,
          s.branch ?? null,
          s.baseBranch ?? null,
          s.inPlace ? 1 : 0,
          s.providerRef ?? null,
          now,
          now,
        );
      this.#db.prepare("INSERT INTO usage (session_id, updated_at) VALUES (?, ?)").run(s.id, now);
      this.#appendHistory(s.id, "starting", null, now);
    });
  }

  get(id: string): SessionSnapshot | null {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as
      | SessionRow
      | undefined;
    if (!row) return null;
    const usage = this.#db
      .prepare("SELECT * FROM usage WHERE session_id = ?")
      .get(id) as unknown as UsageRow | undefined;
    return toSnapshot(row, usage);
  }

  list(): SessionSnapshot[] {
    const rows = this.#db.prepare("SELECT * FROM sessions").all() as unknown as SessionRow[];
    const usageRows = this.#db.prepare("SELECT * FROM usage").all() as unknown as UsageRow[];
    const byId = new Map(usageRows.map((u) => [u.session_id, u]));
    return rows.map((r) => toSnapshot(r, byId.get(r.id)));
  }

  setStatus(id: string, state: SessionState, note: string | null = null): void {
    const now = Date.now();
    const res = this.#db
      .prepare("UPDATE sessions SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?")
      .run(state.kind, sessionStateDetail(state), now, id);
    if (res.changes === 0) throw new Error(`no such session: ${id}`);
    // History records the variant plus the transition's audit note.
    this.#appendHistory(id, state.kind, note, now);
  }

  /** Flip every session left mid-run by a crashed daemon to `interrupted`.
   *  `working_background` counts as mid-run: its background tasks died with the
   *  old CLI process, so the turn will not resume on its own. */
  markMidRunInterrupted(): string[] {
    const now = Date.now();
    const rows = this.#db
      .prepare(
        "SELECT id FROM sessions WHERE status IN ('starting', 'running', 'awaiting_input', 'working_background')",
      )
      .all() as Array<{ id: string }>;
    const stmt = this.#db.prepare(
      "UPDATE sessions SET status = 'interrupted', status_detail = 'user', updated_at = ? WHERE id = ?",
    );
    withTransaction(this.#db, () => {
      for (const { id } of rows) {
        stmt.run(now, id);
        this.#appendHistory(id, "interrupted", "daemon_restart", now);
      }
    });
    return rows.map((r) => r.id);
  }

  setFields(
    id: string,
    fields: Partial<{
      model: string | null;
      effort: string | null;
      mode: string;
      title: string | null;
      titleLocked: boolean;
      worktree: string | null;
      branch: string | null;
      baseBranch: string | null;
      providerRef: string | null;
      forkTurn: number | null;
    }>,
  ): void {
    const cols: string[] = [];
    const vals: Array<string | number | null> = [];
    const map: Record<string, string> = {
      model: "model",
      effort: "effort",
      mode: "mode",
      title: "title",
      titleLocked: "title_locked",
      worktree: "worktree",
      branch: "branch",
      baseBranch: "base_branch",
      providerRef: "provider_ref",
      forkTurn: "fork_turn",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in fields) {
        cols.push(`${col} = ?`);
        const v = (fields as Record<string, string | number | boolean | null>)[k];
        vals.push(typeof v === "boolean" ? Number(v) : (v ?? null));
      }
    }
    if (cols.length === 0) return;
    vals.push(Date.now());
    this.#db
      .prepare(`UPDATE sessions SET ${cols.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...vals, id);
  }

  addUsage(id: string, d: UsageDelta): void {
    const now = Date.now();
    // A single NaN / Infinity from a provider would bind as NULL and poison the
    // accumulator column for the session's life (and silently disable budget
    // enforcement). Coerce every additive field to a finite number first.
    const acc = (v: number | undefined): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
    const accFloat = (v: number | undefined): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const abs = (v: number | undefined): number | null =>
      typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
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
           cost_source = COALESCE(?, cost_source),
           turns = turns + ?,
           context_used = COALESCE(?, context_used),
           context_limit = COALESCE(?, context_limit),
           last_turn_at = COALESCE(?, last_turn_at),
           last_cache_read = COALESCE(?, last_cache_read),
           last_cache_write = COALESCE(?, last_cache_write),
           updated_at = ?
         WHERE session_id = ?`,
      )
      .run(
        acc(d.input),
        acc(d.output),
        acc(d.cacheRead),
        acc(d.cacheWrite),
        accFloat(d.costUsd),
        d.costSource ?? null,
        acc(d.turns),
        abs(d.contextUsed),
        abs(d.contextLimit),
        abs(d.lastTurnAt),
        abs(d.lastCacheRead),
        abs(d.lastCacheWrite),
        now,
        id,
      );
    // Also bump the sessions row so a client rebasing a stale `session.list`
    // against a fresh `session_updated` push (see the TUI reducer) doesn't
    // regress the usage/cost/turns it just received.
    this.#db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
  }

  /** Set the turn counter directly — used by `undo` after truncating the transcript. */
  setTurns(id: string, turns: number): void {
    this.#db
      .prepare("UPDATE usage SET turns = ?, updated_at = ? WHERE session_id = ?")
      .run(turns, Date.now(), id);
  }

  /** The provider's own persisted session id, once the adapter reports it. */
  providerRef(id: string): string | null {
    const row = this.#db.prepare("SELECT provider_ref FROM sessions WHERE id = ?").get(id) as
      | { provider_ref: string | null }
      | undefined;
    return row?.provider_ref ?? null;
  }

  /** True once a manual rename has pinned the title against the auto-titler. */
  titleLocked(id: string): boolean {
    const row = this.#db.prepare("SELECT title_locked FROM sessions WHERE id = ?").get(id) as
      | { title_locked: number }
      | undefined;
    return (row?.title_locked ?? 0) !== 0;
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
// checkpoints — one per completed turn, for undo / fork
// ---------------------------------------------------------------------------

export interface Checkpoint {
  turn: number;
  /** Adapter transcript id at this turn (Claude session id; "" for aisdk). */
  providerRef: string;
  /** What an adapter needs to branch here: provider_messages seq (aisdk) or chain UUID (claude). */
  forkPoint: string;
  /** A snippet of the turn's user message, for the undo picker. */
  userText: string;
  createdAt: number;
}

export class CheckpointStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(sessionId: string, cp: Omit<Checkpoint, "createdAt">): void {
    this.#db
      .prepare(
        `INSERT INTO checkpoints (session_id, turn, provider_ref, fork_point, user_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, turn) DO UPDATE SET
           provider_ref = excluded.provider_ref,
           fork_point   = excluded.fork_point,
           user_text    = excluded.user_text`,
      )
      .run(sessionId, cp.turn, cp.providerRef, cp.forkPoint, cp.userText, Date.now());
  }

  list(sessionId: string): Checkpoint[] {
    return this.#db
      .prepare(
        "SELECT turn, provider_ref AS providerRef, fork_point AS forkPoint, user_text AS userText, created_at AS createdAt " +
          "FROM checkpoints WHERE session_id = ? ORDER BY turn",
      )
      .all(sessionId) as unknown as Checkpoint[];
  }

  at(sessionId: string, turn: number): Checkpoint | null {
    const row = this.#db
      .prepare(
        "SELECT turn, provider_ref AS providerRef, fork_point AS forkPoint, user_text AS userText, created_at AS createdAt " +
          "FROM checkpoints WHERE session_id = ? AND turn = ?",
      )
      .get(sessionId, turn) as unknown as Checkpoint | undefined;
    return row ?? null;
  }

  /** Drop checkpoints after `turn` (called after a rewind). */
  truncate(sessionId: string, turn: number): void {
    this.#db
      .prepare("DELETE FROM checkpoints WHERE session_id = ? AND turn > ?")
      .run(sessionId, turn);
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
// meta — "last used" values that seed the next new session's defaults
// ---------------------------------------------------------------------------

/**
 * Remembers the last model each provider ran, plus the last provider and
 * permission mode picked at session creation, so the next `new` defaults to
 * whatever was last used without any of it being pinned in config. Stored as
 * `default_model:<providerId>` / `last_provider` / `last_mode` rows in the
 * always-present `meta` key/value table (no migration needed). An `""` value
 * is treated as unset.
 */
export class ProviderDefaultStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #get(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row && row.value ? row.value : null;
  }

  #set(key: string, value: string): void {
    if (!value) return;
    this.#db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  #key(providerId: string): string {
    return `default_model:${providerId}`;
  }

  #effortKey(providerId: string): string {
    return `default_effort:${providerId}`;
  }

  /** The remembered model for `providerId`, or null if none has run yet. */
  model(providerId: string): string | null {
    return this.#get(this.#key(providerId));
  }

  /** Record `model` as the provider's new default. No-op for an empty model. */
  remember(providerId: string, model: string): void {
    this.#set(this.#key(providerId), model);
  }

  /** The remembered thinking-effort level for `providerId`, or null if none has run yet. */
  effort(providerId: string): string | null {
    return this.#get(this.#effortKey(providerId));
  }

  /** Record `effort` as the provider's new default. No-op for an empty value. */
  rememberEffort(providerId: string, effort: string): void {
    this.#set(this.#effortKey(providerId), effort);
  }

  /** The last provider picked at session creation, or null if none yet. */
  provider(): string | null {
    return this.#get("last_provider");
  }

  /** Record `providerId` as the default for the next new session. */
  rememberProvider(providerId: string): void {
    this.#set("last_provider", providerId);
  }

  /** The last permission mode picked at session creation, or null if none yet. */
  mode(): string | null {
    return this.#get("last_mode");
  }

  /** Record `mode` as the default for the next new session. */
  rememberMode(mode: string): void {
    this.#set("last_mode", mode);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const toSnapshot = (row: SessionRow, usage: UsageRow | undefined): SessionSnapshot => {
  return {
    id: row.id,
    parentId: row.parent_id,
    forkTurn: row.fork_turn,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    mode: row.mode,
    status: parseSessionState(row.status, row.status_detail),
    title: row.title,
    worktree: row.worktree,
    branch: row.branch,
    baseBranch: row.base_branch,
    inPlace: row.in_place === 1,
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
    costSource: (usage?.cost_source as SessionSnapshot["costSource"]) ?? "none",
    turns: usage?.turns ?? 0,
    subagents: [], // runtime overlay filled in by the daemon
    backgroundTasks: [], // runtime overlay filled in by the daemon
    rateLimits: {}, // runtime overlay filled in by the daemon
    cache: {
      ttlMinutes: 0, // overlaid from config by the daemon
      lastTurnAt: usage?.last_turn_at ?? 0,
      lastRead: usage?.last_cache_read ?? 0,
      lastWrite: usage?.last_cache_write ?? 0,
    },
    keepWarm: false, // runtime overlay filled in by the daemon
    canRewind: false, // runtime overlay filled in by the daemon
    git: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
