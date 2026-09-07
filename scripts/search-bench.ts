/**
 * Temporary instrumentation for the TUI reduction plan (§5): how long
 * `session.search`'s rank costs over a synthetic history far larger than
 * anyone's real one. Delete with `tui-bench.ts` once the plan's final report
 * is written.
 *
 *   deno run -A scripts/search-bench.ts [sessions] [eventsPerSession]
 */
import { openDb } from "@loom/daemon/store/db";
import { SessionEventStore } from "@loom/daemon/store/session-events";
import { SessionSearchStore } from "@loom/daemon/store/session-search";
import type { SessionSnapshot } from "@loom/core/wire";
import type { HarnessEvent } from "@loom/core/events";

const PATH = "/tmp/search-bench.db";
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    Deno.removeSync(PATH + suffix);
  } catch {
    // no previous run to clear
  }
}

const SESSIONS = Number(Deno.args[0] ?? 200);
const EVENTS = Number(Deno.args[1] ?? 500);

const db = openDb(PATH);
const events = new SessionEventStore(db);

const WORDS =
  "mobile access rollout parser docs zebra migration layout depot refactor daemon socket transcript ranking".split(
    " ",
  );
const para = (n: number, seed: number): string =>
  Array.from({ length: n }, (_, i) => WORDS[(seed + i * 7) % WORDS.length]).join(" ");

/** Only the two fields the matcher reads — the rest of a snapshot is irrelevant
 *  to the scan being measured. */
const snaps: SessionSnapshot[] = [];

db.exec("BEGIN");
for (let i = 0; i < SESSIONS; i++) {
  const id = `sess-${String(i).padStart(5, "0")}`;
  const title = `session ${para(3, i)}`;
  db.prepare(
    "INSERT INTO sessions (id, provider, model, mode, status, title, worktree, branch, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "fake", "m", "default", "idle", title, "/tmp", "main", i, i);
  snaps.push({ id, title } as unknown as SessionSnapshot);
  // A realistic mix: text is a minority of a transcript, so the scan walks
  // plenty of tool traffic it must not search.
  const bodies = (e: number): Record<string, unknown>[] => [
    { type: "user_message", text: para(80, i + e), injected: false },
    { type: "assistant_text", text: para(200, i + e) },
    { type: "tool_call", id: `c${e}`, name: "Bash", input: { command: para(20, e) } },
    { type: "tool_result", id: `c${e}`, ok: true, output: { text: para(200, e) } },
    { type: "thinking", text: para(150, e) },
  ];
  for (let e = 0; e < EVENTS; e++) {
    const body = bodies(e)[e % 5]!;
    events.append(id, { ...body, sessionId: id, ts: e } as unknown as HarnessEvent);
  }
}
db.exec("COMMIT");

const search = new SessionSearchStore(db);
const time = (q: string): { ms: number; hits: number } => {
  const t0 = performance.now();
  const hits = search.rank(snaps, q).length;
  return { ms: Math.round((performance.now() - t0) * 10) / 10, hits };
};

time("mobile"); // warm the page cache; the cold number measures the disk, not this
console.log(
  JSON.stringify(
    {
      sessions: SESSIONS,
      eventsPerSession: EVENTS,
      dbMB: Math.round(Deno.statSync(PATH).size / 1e5) / 10,
      fuzzy: time("mobile"),
      literal: time("'zebra migration"),
      twoTerms: time("mobile access"),
      miss: time("'qqqqqqqq"),
    },
    null,
    2,
  ),
);
db.close();
