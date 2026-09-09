import type { CacheCreation } from "@loom/core/cache";
import type { TokenUsage, RateLimitEvent } from "@loom/core/events";
import {
  parseSessionState,
  type SessionState,
  type SessionStateKind,
  sessionStateDetail,
} from "@loom/core/session-state";
import type { ModelUsage, SessionSnapshot } from "@loom/core/wire";
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
  comment: string | null;
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
  last_cache_ttl_minutes: number;
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
  /** Which backend actually owns this session's history (`''` = the
   *  provider's own native thread; `'aisdk'` = a legacy Loom-owned
   *  transcript, chatgpt-only, immutable after create). See migration 20. */
  historyBackend?: string;
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
  /** Request usage observation time, including misses; separate from cache liveness. */
  requestAt?: number;
  /** This turn's cache read / write token split (absolute, not accumulated). */
  lastCacheRead?: number;
  lastCacheWrite?: number;
  /** The TTL the provider was observed writing at this turn, in minutes (absolute). */
  lastCacheTtlMinutes?: number;
  /** Observed per-TTL write counts, used to price mixed cache writes. */
  cacheCreation?: CacheCreation;
}

/** A session that was mid-run when the previous daemon instance exited. */
export interface MidRunSession {
  id: string;
  /** The status the row held before hygiene flipped it to `interrupted`. */
  was: SessionStateKind;
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
              base_branch, in_place, provider_ref, history_backend, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          s.historyBackend ?? "",
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
   *  old CLI process, so the turn will not resume on its own. Returns each id
   *  with the status it held, so the daemon can re-drive the actively-working
   *  ones on boot (`[auto_resume]`); `awaiting_input` stays parked. */
  markMidRunInterrupted(): MidRunSession[] {
    const now = Date.now();
    const rows = this.#db
      .prepare(
        "SELECT id, status FROM sessions WHERE status IN ('starting', 'running', 'awaiting_input', 'working_background')",
      )
      .all() as Array<{ id: string; status: SessionStateKind }>;
    const stmt = this.#db.prepare(
      "UPDATE sessions SET status = 'interrupted', status_detail = 'user', updated_at = ? WHERE id = ?",
    );
    withTransaction(this.#db, () => {
      for (const { id } of rows) {
        stmt.run(now, id);
        this.#appendHistory(id, "interrupted", "daemon_restart", now);
      }
    });
    return rows.map((r) => ({ id: r.id, was: r.status }));
  }

  setFields(
    id: string,
    fields: Partial<{
      provider: string;
      model: string | null;
      effort: string | null;
      mode: string;
      title: string | null;
      comment: string | null;
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
      provider: "provider",
      model: "model",
      effort: "effort",
      mode: "mode",
      title: "title",
      comment: "comment",
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
    // Caches are scoped to a provider+model pair, so a switch strands whatever
    // we had measured: the next turn cannot hit the old pair's entry. Detect a
    // real change (not a no-op re-assert, which must not reset a live
    // countdown) and forget the observation along with it.
    const cur = this.#db.prepare("SELECT provider, model FROM sessions WHERE id = ?").get(id) as
      | { provider: string; model: string | null }
      | undefined;
    const switching =
      cur !== undefined &&
      (("provider" in fields && fields.provider !== cur.provider) ||
        ("model" in fields && (fields.model ?? null) !== cur.model));
    vals.push(Date.now());
    withTransaction(this.#db, () => {
      this.#db
        .prepare(`UPDATE sessions SET ${cols.join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...vals, id);
      if (switching) this.#clearCacheObservation(id);
    });
  }

  /**
   * Repoint every session on provider `from` to `to` — recovery for a renamed
   * / re-keyed provider (e.g. a `[[claude_profiles]]` `name` change, which
   * recomputes its id). Reuses {@link setFields} per row so cache-observation
   * clearing and `updated_at` stay consistent with any other provider switch.
   * Also carries over the "last used" caches (`ProviderDefaultStore` below)
   * keyed by the old id, without clobbering a value `to` already has. Returns
   * the number of sessions relinked.
   */
  relinkProvider(from: string, to: string): number {
    const ids = this.#db.prepare("SELECT id FROM sessions WHERE provider = ?").all(from) as Array<{
      id: string;
    }>;
    for (const { id } of ids) this.setFields(id, { provider: to });
    for (const prefix of ["default_model:", "default_effort:"]) {
      const row = this.#db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(`${prefix}${from}`) as { value: string } | undefined;
      if (row) {
        this.#db
          .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
          .run(`${prefix}${to}`, row.value);
        this.#db.prepare("DELETE FROM meta WHERE key = ?").run(`${prefix}${from}`);
      }
    }
    this.#db
      .prepare("UPDATE meta SET value = ? WHERE key = 'last_provider' AND value = ?")
      .run(to, from);
    return ids.length;
  }

  /**
   * Forget what this session's prompt cache was doing. Called when it changes
   * provider or model: cache entries are scoped to a provider+model pair, so
   * the new pair starts cold and unmeasured, and the old pair's TTL, countdown
   * and read/write split all describe an entry the next turn cannot hit.
   * `model_usage` needs no equivalent — it is already keyed by the pair.
   */
  #clearCacheObservation(id: string): void {
    this.#db
      .prepare(
        `UPDATE usage
            SET last_turn_at = 0, last_cache_read = 0, last_cache_write = 0,
                last_cache_ttl_minutes = 0, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(Date.now(), id);
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
           cost_source = CASE
             WHEN ? IS NULL THEN cost_source
             WHEN cost_source = 'partial' THEN 'partial'
             WHEN input + output + cache_read + cache_write = 0 AND cost_usd = 0 THEN ?
             WHEN cost_source = ? THEN cost_source
             WHEN cost_source = 'none' OR ? = 'none' THEN 'partial'
             ELSE 'mixed' END,
           turns = turns + ?,
           context_used = COALESCE(?, context_used),
           context_limit = COALESCE(?, context_limit),
           last_turn_at = COALESCE(?, last_turn_at),
           last_cache_read = COALESCE(?, last_cache_read),
           last_cache_write = COALESCE(?, last_cache_write),
           last_cache_ttl_minutes = COALESCE(?, last_cache_ttl_minutes),
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
        d.costSource ?? null,
        d.costSource ?? null,
        d.costSource ?? null,
        acc(d.turns),
        abs(d.contextUsed),
        abs(d.contextLimit),
        abs(d.lastTurnAt),
        abs(d.lastCacheRead),
        abs(d.lastCacheWrite),
        abs(d.lastCacheTtlMinutes),
        now,
        id,
      );
    // Also bump the sessions row: `updated_at` is the fleet's recency sort key,
    // so a turn that only moved usage still has to reorder the list.
    this.#db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
  }

  recordAccountUsage(scope: string, ev: RateLimitEvent): void {
    this.#db
      .prepare(`INSERT INTO account_usage
      (scope, window, status, utilization, resets_at, observed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, window) DO UPDATE SET status = excluded.status,
        utilization = excluded.utilization, resets_at = excluded.resets_at,
        observed_at = excluded.observed_at
      WHERE excluded.observed_at >= observed_at`)
      .run(
        scope,
        ev.window ?? "default",
        ev.status,
        ev.utilization ?? null,
        ev.resetsAt ?? null,
        ev.ts,
      );
  }

  accountUsage(scope: string, now = Date.now()): SessionSnapshot["rateLimits"] {
    const rows = this.#db
      .prepare(`SELECT * FROM account_usage WHERE scope = ?
      AND (resets_at > ? OR (resets_at IS NULL AND observed_at > ?))`)
      .all(scope, now, now - 5 * 60_000);
    return Object.fromEntries(
      rows.map((r) => [
        String(r["window"]),
        {
          status: r["status"] as RateLimitEvent["status"],
          ...(r["utilization"] !== null ? { utilization: Number(r["utilization"]) } : {}),
          ...(r["resets_at"] !== null ? { resetsAt: Number(r["resets_at"]) } : {}),
          observedAt: Number(r["observed_at"]),
        },
      ]),
    );
  }

  /**
   * Fold a usage delta into the running total for the provider+model that
   * spent it. Called alongside {@link addUsage}, which keeps the same numbers
   * per session; this is the same spend sliced by model instead.
   *
   * Attribution is "whichever model is in force when the delta lands", so a
   * `session.setModel` that races a turn's own usage event can bill a few
   * tokens to the new model. Not worth a per-turn model stamp on the wire.
   */
  addModelUsage(sessionId: string, provider: string, model: string, d: UsageDelta): void {
    const now = Date.now();
    const acc = (v: number | undefined): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
    const accFloat = (v: number | undefined): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    const ttl = acc(d.lastCacheTtlMinutes);
    // Keep hit and cold-gap evidence separately: a miss can be invalidation,
    // and an aggregated turn can write then hit. Neither proves a TTL.
    // SQLite evaluates SET against the old row, before advancing the clock.
    const hit = acc(d.cacheRead) > 0 ? 1 : 0;
    // The turn's own wall-clock, matching what `usage.last_turn_at` records —
    // not "now", which drifts by however long the rollup took to arrive.
    const requestAt = d.requestAt ?? d.lastTurnAt;
    const at =
      typeof requestAt === "number" && Number.isFinite(requestAt) ? Math.trunc(requestAt) : 0;
    this.#db
      .prepare(
        `INSERT INTO model_usage
           (session_id, provider, model, input, output, cache_read, cache_write,
            cost_usd, turns, ttl_minutes, last_turn_at, max_hit_gap_sec, updated_at, last_cache_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(session_id, provider, model) DO UPDATE SET
           input       = input + excluded.input,
           output      = output + excluded.output,
           cache_read  = cache_read + excluded.cache_read,
           cache_write = cache_write + excluded.cache_write,
           cost_usd    = cost_usd + excluded.cost_usd,
           turns       = turns + excluded.turns,
           -- absolute, and a delta that carries no TTL must not clear it
           ttl_minutes = CASE WHEN excluded.ttl_minutes > 0
                              THEN excluded.ttl_minutes ELSE ttl_minutes END,
           max_hit_gap_sec = CASE
             WHEN ? = 1 AND last_turn_at > 0
                  AND (excluded.last_turn_at - last_turn_at) / 1000 > max_hit_gap_sec
             THEN (excluded.last_turn_at - last_turn_at) / 1000
             ELSE max_hit_gap_sec END,
           last_turn_at = CASE WHEN ? = 1 THEN excluded.last_turn_at ELSE last_turn_at END,
           min_miss_gap_sec = CASE
             WHEN ? = 1 AND last_cache_active = 1 AND last_turn_at > 0
               AND excluded.last_turn_at > last_turn_at
               AND (min_miss_gap_sec = 0 OR (excluded.last_turn_at - last_turn_at) / 1000 < min_miss_gap_sec)
             THEN MAX(1, (excluded.last_turn_at - last_turn_at) / 1000)
             ELSE min_miss_gap_sec END,
           last_cache_active = CASE WHEN excluded.last_turn_at > 0
             THEN excluded.last_cache_active ELSE last_cache_active END,
           updated_at   = excluded.updated_at`,
      )
      .run(
        sessionId,
        provider,
        model,
        acc(d.input),
        acc(d.output),
        acc(d.cacheRead),
        acc(d.cacheWrite),
        accFloat(d.costUsd),
        acc(d.turns),
        ttl,
        at,
        now,
        acc(d.cacheRead) > 0 || acc(d.cacheWrite) > 0 ? 1 : 0,
        hit,
        at > 0 ? 1 : 0,
        at > 0 && acc(d.input) + acc(d.cacheWrite) > 0 && !hit ? 1 : 0,
      );
  }

  /**
   * Per-provider+model usage. With `sessionId` it's that session's breakdown
   * (`sessions` is always 1); without, it's every session summed, which is the
   * view that says whether a model caches at all. Busiest first.
   */
  modelUsage(sessionId?: string): ModelUsage[] {
    const where = sessionId ? "WHERE session_id = ?" : "";
    const rows = this.#db
      .prepare(
        `SELECT provider, model,
                SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
                SUM(cost_usd) AS cost_usd, SUM(turns) AS turns,
                -- the freshest observation across the grouped sessions
                (SELECT m2.ttl_minutes FROM model_usage m2
                  WHERE m2.provider = m.provider AND m2.model = m.model
                    ${sessionId ? "AND m2.session_id = m.session_id" : ""}
                    AND m2.ttl_minutes > 0
                  ORDER BY m2.updated_at DESC LIMIT 1) AS ttl_minutes,
                MAX(max_hit_gap_sec) AS max_hit_gap_sec,
                COALESCE(MIN(NULLIF(min_miss_gap_sec, 0)), 0) AS min_miss_gap_sec,
                COUNT(*) AS sessions, MAX(updated_at) AS updated_at
           FROM model_usage m
           ${where}
          GROUP BY provider, model
          ORDER BY (SUM(input) + SUM(cache_read) + SUM(cache_write) + SUM(output)) DESC`,
      )
      .all(...(sessionId ? [sessionId] : [])) as Array<Record<string, number | string | null>>;
    return rows.map((r) => ({
      provider: String(r["provider"] ?? ""),
      model: String(r["model"] ?? ""),
      input: Number(r["input"] ?? 0),
      output: Number(r["output"] ?? 0),
      cacheRead: Number(r["cache_read"] ?? 0),
      cacheWrite: Number(r["cache_write"] ?? 0),
      costUsd: Number(r["cost_usd"] ?? 0),
      turns: Number(r["turns"] ?? 0),
      ttlMinutes: Number(r["ttl_minutes"] ?? 0),
      maxHitGapSec: Number(r["max_hit_gap_sec"] ?? 0),
      minMissGapSec: Number(r["min_miss_gap_sec"] ?? 0),
      sessions: Number(r["sessions"] ?? 0),
      updatedAt: Number(r["updated_at"] ?? 0),
    }));
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

  /** Which backend owns this session's history (`""` = the provider's own
   *  native thread; `"aisdk"` = a legacy, pre-cutover ChatGPT transcript).
   *  Immutable after create — see migration 20. */
  historyBackend(id: string): string {
    const row = this.#db.prepare("SELECT history_backend FROM sessions WHERE id = ?").get(id) as
      | { history_backend: string }
      | undefined;
    return row?.history_backend ?? "";
  }

  /** The base short-SHA the operator was last nudged to integrate for this
   *  session (`""` = never / integrated since). Persisted so a daemon restart
   *  doesn't re-inject the same "base advanced" nudge turn. */
  autoRebaseNudgedSha(id: string): string {
    const row = this.#db
      .prepare("SELECT auto_rebase_nudged_sha FROM sessions WHERE id = ?")
      .get(id) as { auto_rebase_nudged_sha: string } | undefined;
    return row?.auto_rebase_nudged_sha ?? "";
  }

  setAutoRebaseNudgedSha(id: string, sha: string): void {
    this.#db
      .prepare("UPDATE sessions SET auto_rebase_nudged_sha = ?, updated_at = ? WHERE id = ?")
      .run(sha, Date.now(), id);
  }

  /** The commit HEAD pointed at when this session was last reminded about
   *  uncommitted changes (`""` = never / committed since). Persisted so a daemon
   *  restart doesn't re-inject the same reminder. */
  commitNudgedSha(id: string): string {
    const row = this.#db.prepare("SELECT commit_nudged_sha FROM sessions WHERE id = ?").get(id) as
      | { commit_nudged_sha: string }
      | undefined;
    return row?.commit_nudged_sha ?? "";
  }

  setCommitNudgedSha(id: string, sha: string): void {
    this.#db
      .prepare("UPDATE sessions SET commit_nudged_sha = ?, updated_at = ? WHERE id = ?")
      .run(sha, Date.now(), id);
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
  /** The worktree's git HEAD when this turn completed (`""` = not captured — an
   *  in-place session, or a pre-migration-14 row). */
  headSha: string;
  /** Whether the worktree had uncommitted changes when this turn completed. */
  headDirty: boolean;
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
        `INSERT INTO checkpoints
           (session_id, turn, provider_ref, fork_point, user_text, head_sha, head_dirty, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, turn) DO UPDATE SET
           provider_ref = excluded.provider_ref,
           fork_point   = excluded.fork_point,
           user_text    = excluded.user_text,
           head_sha     = excluded.head_sha,
           head_dirty   = excluded.head_dirty`,
      )
      .run(
        sessionId,
        cp.turn,
        cp.providerRef,
        cp.forkPoint,
        cp.userText,
        cp.headSha,
        cp.headDirty ? 1 : 0,
        Date.now(),
      );
  }

  #cols =
    "turn, provider_ref AS providerRef, fork_point AS forkPoint, user_text AS userText, " +
    "head_sha AS headSha, head_dirty AS headDirty, created_at AS createdAt";

  list(sessionId: string): Checkpoint[] {
    const rows = this.#db
      .prepare(`SELECT ${this.#cols} FROM checkpoints WHERE session_id = ? ORDER BY turn`)
      .all(sessionId) as unknown as Array<Checkpoint & { headDirty: number | boolean }>;
    return rows.map((r) => ({ ...r, headDirty: Boolean(r.headDirty) }));
  }

  at(sessionId: string, turn: number): Checkpoint | null {
    const row = this.#db
      .prepare(`SELECT ${this.#cols} FROM checkpoints WHERE session_id = ? AND turn = ?`)
      .get(sessionId, turn) as unknown as
      | (Checkpoint & { headDirty: number | boolean })
      | undefined;
    return row ? { ...row, headDirty: Boolean(row.headDirty) } : null;
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
    comment: row.comment,
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
    requests: [], // runtime overlay filled in by the daemon
    subagents: [], // runtime overlay filled in by the daemon
    backgroundTasks: [], // runtime overlay filled in by the daemon
    rateLimits: {}, // runtime overlay filled in by the daemon
    cache: {
      // What the provider was last seen doing. 0 here means "never observed",
      // and the daemon falls back to the configured pin in `#enrich`.
      ttlMinutes: usage?.last_cache_ttl_minutes ?? 0,
      ttlSource: (usage?.last_cache_ttl_minutes ?? 0) > 0 ? "observed" : "none",
      lastTurnAt: usage?.last_turn_at ?? 0,
      lastRead: usage?.last_cache_read ?? 0,
      lastWrite: usage?.last_cache_write ?? 0,
    },
    keepWarm: false, // runtime overlay filled in by the daemon
    canRewind: false, // runtime overlay filled in by the daemon
    resumable: true, // runtime overlay filled in by the daemon
    git: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
