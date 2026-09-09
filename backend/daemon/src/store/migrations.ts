/**
 * Ordered, append-only schema migrations. Index + 1 is the schema version the
 * migration brings the database to. Never edit or reorder an existing entry —
 * only append.
 */
export const MIGRATIONS: string[] = [
  // 1 — initial schema
  /* sql */ `
  CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    provider        TEXT NOT NULL,
    model           TEXT,
    mode            TEXT NOT NULL DEFAULT 'default',
    status          TEXT NOT NULL DEFAULT 'starting',
    await_reason    TEXT,
    title           TEXT,
    worktree        TEXT,
    branch          TEXT,
    base_branch     TEXT,
    provider_ref    TEXT,               -- adapter's own session id / transcript key
    budget_max_tokens    INTEGER,
    budget_max_cost_usd  REAL,
    budget_max_turns     INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE INDEX sessions_parent_idx ON sessions(parent_id);
  CREATE INDEX sessions_status_idx ON sessions(status);

  CREATE TABLE status_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    reason      TEXT,
    at          INTEGER NOT NULL
  );

  CREATE INDEX status_history_session_idx ON status_history(session_id, id);

  CREATE TABLE usage (
    session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    input          INTEGER NOT NULL DEFAULT 0,
    output         INTEGER NOT NULL DEFAULT 0,
    cache_read     INTEGER NOT NULL DEFAULT 0,
    cache_write    INTEGER NOT NULL DEFAULT 0,
    context_used   INTEGER NOT NULL DEFAULT 0,
    context_limit  INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL NOT NULL DEFAULT 0,
    turns          INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0
  );

  -- Child processes owned by a session's run (Claude CLI, MCP servers).
  -- Rows outliving their daemon are reaped by startup hygiene.
  CREATE TABLE runtime_children (
    pid           INTEGER PRIMARY KEY,
    session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    daemon_epoch  TEXT NOT NULL,
    started_at    INTEGER NOT NULL
  );
  `,

  // 2 — a manual rename locks the title against the auto-titler (M7a)
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
  `,

  // 3 — where a session's cost figure came from (M7b)
  /* sql */ `
  ALTER TABLE usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'none';
  `,

  // 4 — budget enforcement state: ok | warned | halted (M7c)
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN budget_state TEXT NOT NULL DEFAULT 'ok';
  `,

  // 5 — last-turn timing + cache split, for the prompt-cache liveness gauge
  /* sql */ `
  ALTER TABLE usage ADD COLUMN last_turn_at    INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage ADD COLUMN last_cache_read  INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage ADD COLUMN last_cache_write INTEGER NOT NULL DEFAULT 0;
  `,

  // 6 — conversation history for providers Loom persists itself (aisdk, M10).
  // The Claude adapter keeps its own transcript; these rows are the whole
  // record for an OpenAI-compatible session and are what `resumeSession` reads.
  /* sql */ `
  CREATE TABLE provider_messages (
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,          -- JSON-encoded ModelMessage
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  `,

  // 7 — per-turn checkpoints (undo / fork). One row per completed turn; the
  // daemon writes it on each \`result\`. \`fork_point\` is what an adapter needs to
  // rewind or branch at that turn — the provider_messages seq for aisdk, the
  // turn's last chain UUID for the Claude adapter. \`fork_turn\` on \`sessions\`
  // records where a hard fork branched from its parent (null = a root session).
  /* sql */ `
  CREATE TABLE checkpoints (
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn         INTEGER NOT NULL,
    provider_ref TEXT NOT NULL DEFAULT '',
    fork_point   TEXT NOT NULL DEFAULT '',
    user_text    TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (session_id, turn)
  );
  ALTER TABLE sessions ADD COLUMN fork_turn INTEGER;
  `,

  // 8 — a session that runs in the repo working dir instead of its own
  // worktree (\`[worktree] enabled = false\`, or a per-session override). Its
  // \`worktree\` column is NULL like a gc'd session's, so this flag is what tells
  // them apart — the daemon shows repo-root git facts for it and refuses a
  // hard fork.
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN in_place INTEGER NOT NULL DEFAULT 0;
  `,

  // 9 — durable per-session event history. The cross-session in-memory
  // `EventLog` ring (daemon.ts) only covers a live client's reconnect gap and
  // is shared by every session, so a busy session can evict a quiet one's
  // history outright; nothing there survives a restart either. `seq` mirrors
  // the EventLog frame's own seq so a replayed row dedupes identically to a
  // live push on the client.
  /* sql */ `
  CREATE TABLE session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX session_events_session_idx ON session_events(session_id, id);
  `,

  // 10 — drop the budget feature: there was no sane number to default a cost /
  // token / turn cap to, and Loom can't fetch a real one from any provider.
  /* sql */ `
  ALTER TABLE sessions DROP COLUMN budget_max_tokens;
  ALTER TABLE sessions DROP COLUMN budget_max_cost_usd;
  ALTER TABLE sessions DROP COLUMN budget_max_turns;
  ALTER TABLE sessions DROP COLUMN budget_state;
  `,

  // 11 — thinking-effort level a session was created (or later switched) with,
  // alongside the model it applies to (Claude Agent SDK `EffortLevel`).
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  `,

  // 12 — session status is now a closed union (SessionState). `status` holds
  // the variant `kind`; `await_reason` is renamed `status_detail` and carries
  // whichever payload the variant has (awaiting_input → the AwaitReason,
  // interrupted → "user" | "stream_ended", error → the message). Existing
  // `awaiting_input` rows already have their reason here; older `interrupted` /
  // `error` rows have NULL and the reader defaults them.
  /* sql */ `
  ALTER TABLE sessions RENAME COLUMN await_reason TO status_detail;
  `,

  // 13 — the daemon epoch that issued each event's `seq`. The EventLog seq
  // counter resets to 1 on every daemon start, so `seq` alone is only unique
  // within one daemon's lifetime; without the epoch a replayed row can
  // silently dedupe against an unrelated pre-restart frame on the client.
  // Rows written before this column existed get `''` — they predate epoch
  // tracking and are only ever ambiguous among themselves.
  /* sql */ `
  ALTER TABLE session_events ADD COLUMN epoch TEXT NOT NULL DEFAULT '';
  `,

  // 14 — the worktree's git HEAD (and whether it was dirty) at each checkpoint.
  // Undo/rewind only moves the model's context; without this there was no record
  // of where the working tree was, so `session.rewind` couldn't offer to restore
  // it or even tell the operator how far the files had drifted past the context.
  // Pre-existing rows get '' / 0 — no SHA was captured for them.
  /* sql */ `
  ALTER TABLE checkpoints ADD COLUMN head_sha TEXT NOT NULL DEFAULT '';
  ALTER TABLE checkpoints ADD COLUMN head_dirty INTEGER NOT NULL DEFAULT 0;
  `,

  // 15 — the base commit a session was last auto-rebase-nudged about. The
  // "already nudged for this base head" suppression lived in a daemon-instance
  // Map, so a restart re-injected the "base branch advanced" turn for a branch
  // still behind. Persist it instead.
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN auto_rebase_nudged_sha TEXT NOT NULL DEFAULT '';
  `,

  // 16 — the commit HEAD a session was last nudged about for uncommitted
  // changes (`[commit_reminder]`). Like migration 15, the "already nudged"
  // suppression has to outlive a daemon restart, so it's a row column and not a
  // daemon-instance Map. '' once the agent commits (HEAD moves) or the tree
  // goes clean.
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN commit_nudged_sha TEXT NOT NULL DEFAULT '';
  `,

  // 17 — the prompt-cache TTL the provider was last observed actually writing
  // at, in minutes. Before this the cache countdown ran purely on the
  // configured `prompt_cache_ttl` pin, which the provider is free to decline
  // (an API key, a plan outside its usage limits, Bedrock) — so the gauge could
  // count down an hour on a cache that had lapsed after five. 0 = never seen.
  /* sql */ `
  ALTER TABLE usage ADD COLUMN last_cache_ttl_minutes INTEGER NOT NULL DEFAULT 0;
  `,

  // 18 — token usage split by the provider+model that actually spent it. The
  // `usage` table is per session and a session can switch models mid-life
  // (`session.setModel`), so its totals are a mixture — no use for "does this
  // model cache at all?". Keyed per session too, so a single busy session
  // can't be mistaken for a trend. `ttl_minutes` is the last prompt-cache TTL
  // observed for the pair (0 = never observed).
  /* sql */ `
  CREATE TABLE model_usage (
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider    TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    input       INTEGER NOT NULL DEFAULT 0,
    output      INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL    NOT NULL DEFAULT 0,
    turns       INTEGER NOT NULL DEFAULT 0,
    ttl_minutes INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, provider, model)
  );

  CREATE INDEX model_usage_model_idx ON model_usage(provider, model);
  `,

  // 19 — evidence about cache lifetime for providers that report none. A cache
  // *hit* after an idle gap of N seconds proves the entry survived N seconds,
  // so `max_hit_gap_sec` is a sound lower bound on the TTL. The converse is not
  // true: a miss may be expiry, or may be prefix invalidation (a tool-list
  // change, an edited system prompt, server-side eviction), so misses are not
  // recorded — hits are proof, misses are hearsay. `last_turn_at` is per
  // provider+model so the gap is measured from when *this* model last ran,
  // which is what its own model-scoped cache would have been written by.
  /* sql */ `
  ALTER TABLE model_usage ADD COLUMN last_turn_at     INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE model_usage ADD COLUMN max_hit_gap_sec  INTEGER NOT NULL DEFAULT 0;
  `,

  // 20 — a user-authored note about a session, shown in Detail — meta, not part
  // of the event log. Reached from the Space palette only, no dedicated key.
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN comment TEXT;
  `,

  // 21 — which backend actually owns a session's history. Phase 4 of the
  // ChatGPT provider plan cut every ChatGPT model over to Codex's app-server
  // (a provider-owned thread, `provider_ref` = a Codex thread id); before
  // that, ordinary (non-Code-Mode) ChatGPT models ran on a direct
  // OAuth/Responses backend with a Loom-owned aisdk transcript in
  // `provider_messages`. Both wrote the same `provider = 'chatgpt'` row, so a
  // provider-name match can't tell a pre-cutover direct-backend row apart
  // from one that was already Code-Mode/Codex-backed (and would wrongly mark
  // the latter non-resumable) — and it misses `sdk = "chatgpt"` custom
  // profiles (`[providers.work]`) entirely, since those keep their own
  // configured id, not literally `'chatgpt'`.
  //
  // Use persisted evidence instead, independent of provider naming: only the
  // direct aisdk backend ever wrote rows into `provider_messages` (Code Mode
  // sessions never did, at any point in this plan) — its presence is proof a
  // session's history lives in Loom's transcript store, not a Codex thread.
  // Harmless to check across every provider, not just chatgpt ones: for any
  // provider where an aisdk transcript is the *current*, correct backend
  // (openai, google, anthropic, and non-chatgpt custom profiles),
  // `Daemon#resumable` never consults this column in the first place — it
  // only gates providers `[[sdk = "chatgpt"]]` currently configures, checked
  // by live config lookup, not by whatever this migration wrote for their id.
  // '' means "native/provider-owned thread" (including every ChatGPT row
  // created after this migration); 'aisdk' means "this session's history
  // lives in `provider_messages`", which is what actually makes a `chatgpt`-
  // sdk row unsafe to `thread/resume`. See `Daemon#resumable`.
  /* sql */ `
  ALTER TABLE sessions ADD COLUMN history_backend TEXT NOT NULL DEFAULT '';
  UPDATE sessions SET history_backend = 'aisdk'
    WHERE history_backend = ''
      AND EXISTS (SELECT 1 FROM provider_messages WHERE provider_messages.session_id = sessions.id);
  `,

  // 22 — corrective follow-up to 21. Migrations are append-only and never
  // edited once shipped: any database that already advanced to schema
  // version 21 keeps whatever that migration's SQL happened to be *at the
  // time it ran* forever — the migration runner only executes a step whose
  // index is >= the database's current version, so rewriting 21's own SQL
  // after the fact (as an earlier draft of this migration briefly did) never
  // reaches a database that already ran it. Only a new, later-numbered
  // migration can correct data an earlier one already wrote. (Migration 21
  // itself is numbered 21 rather than 20 because it landed on a branch
  // rebased onto `main`'s own concurrent, unrelated migration 20 — a second,
  // independent reason the same "never rely on a slot number, only on a
  // later migration" discipline matters here.)
  //
  // This exists because migration 21 first shipped naming-based
  // (`WHERE provider = 'chatgpt'`) before being caught in review and
  // rewritten to the evidence-based form above (`EXISTS (... provider_messages ...)`).
  // A database that ran the naming-based version has two kinds of wrong rows:
  // a `chatgpt` row with no `provider_messages` evidence (already a native
  // Codex thread, wrongly marked 'aisdk' — would wrongly refuse to resume);
  // and a `sdk = "chatgpt"` custom-profile row (e.g. `[providers.work]`) that
  // does have `provider_messages` evidence but was never touched at all,
  // since its provider name isn't literally `chatgpt` (still `''`, so it
  // reads as resumable when it is not). Recompute both directions from the
  // same evidence migration 21 should have used from the start.
  //
  // Never touches `'codex'` — that value is only ever written explicitly by
  // `Daemon#startSession` for a session it just created on Codex's
  // app-server (see `daemon.ts`), a stronger, direct signal than anything a
  // migration can infer after the fact and never wrong to trust.
  /* sql */ `
  UPDATE sessions SET history_backend = 'aisdk'
    WHERE history_backend = ''
      AND EXISTS (SELECT 1 FROM provider_messages WHERE provider_messages.session_id = sessions.id);
  UPDATE sessions SET history_backend = ''
    WHERE history_backend = 'aisdk'
      AND NOT EXISTS (SELECT 1 FROM provider_messages WHERE provider_messages.session_id = sessions.id);
  `,
  // 23 — `seq` / `epoch` existed to make (epoch, seq) the transcript's identity,
  // because the ring's frame seq was the only id a client ever saw. The row's
  // own `id` is a better one: assigned by the insert, monotonic within a
  // session across restarts, and now carried on the live push as well as in
  // page results, so pages and live frames merge by it directly. Nothing reads
  // either column any more, and `seq NOT NULL` would force the writer to invent
  // a value it no longer has.
  /* sql */ `
  ALTER TABLE session_events DROP COLUMN seq;
  ALTER TABLE session_events DROP COLUMN epoch;
  `,
  /* sql */ `
  CREATE TABLE account_usage (
    scope TEXT NOT NULL,
    window TEXT NOT NULL,
    status TEXT NOT NULL,
    utilization REAL,
    resets_at INTEGER,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (scope, window)
  );
  ALTER TABLE model_usage ADD COLUMN min_miss_gap_sec INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE model_usage ADD COLUMN last_cache_active INTEGER NOT NULL DEFAULT 0;
  `,
];
