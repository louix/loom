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
];
