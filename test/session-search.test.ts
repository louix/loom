/**
 * Cross-session search, daemon side: the query grammar and ranking (moved here
 * from the TUI's `fleet-search`, which used to run it over one client's cached
 * transcript pages) and the database scan that feeds them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@loom/daemon/store/db";
import { SessionStore } from "@loom/daemon/store/sessions";
import { SessionEventStore } from "@loom/daemon/store/session-events";
import { SessionSearchStore } from "@loom/daemon/store/session-search";
import { setLogLevel } from "@loom/core/logger";
import type { HarnessEvent } from "@loom/core/events";
import type { SessionSnapshot } from "@loom/core/wire";

setLogLevel("error");

/**
 * A store over a throwaway database, plus the two writes a test needs: a
 * session with a title, and an event on it. `ids(q)` is the ranked answer.
 */
const mkSearch = () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-search-"));
  const db = openDb(join(dir, "loom.db"));
  const sessions = new SessionStore(db);
  const events = new SessionEventStore(db);
  const search = new SessionSearchStore(db);
  let clock = 0;
  const snaps: SessionSnapshot[] = [];
  return {
    /** Newest last, which is the order `sortSnapshots` hands the store. */
    session: (id: string, title: string | null): void => {
      sessions.create({ id, provider: "fake", title });
      const s = sessions.get(id);
      assert.ok(s);
      snaps.push(s);
    },
    /** The event body without the fields every event shares — `Omit` over the
     *  union would distribute into a shape with no common members. */
    emit: (
      sessionId: string,
      event: Partial<HarnessEvent> & { type: HarnessEvent["type"] },
    ): void => {
      clock += 1;
      events.append(sessionId, { ...(event as object), sessionId, ts: clock } as HarnessEvent);
    },
    ids: (q: string): string[] => search.rank(snaps, q).map((h) => h.id),
    rank: (q: string) => search.rank(snaps, q),
    snaps,
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const withSearch = (fn: (s: ReturnType<typeof mkSearch>) => void): void => {
  const s = mkSearch();
  try {
    fn(s);
  } finally {
    s.cleanup();
  }
};

test("search: a 'term is a literal substring, case-insensitive", () => {
  withSearch((s) => {
    s.session("lit", "say Hello there");
    s.session("spread", "spelling h-e-l-l-o out");
    assert.deepEqual(s.ids("'hello"), ["lit"]);
  });
});

test("search: bare terms match fuzzily; space-separated terms are AND'd", () => {
  withSearch((s) => {
    s.session("m", "mobile layout");
    s.session("a", "database access");
    s.session("both", "mobile access rollout");
    assert.deepEqual(s.ids("layout"), ["m"]);
    assert.deepEqual(s.ids("mobile access"), ["both"]);
  });
});

test("search: title beats your messages beats the agent's", () => {
  withSearch((s) => {
    s.session("theirs", "chat");
    s.session("mine", "chat");
    s.session("title", "mobile rollout");
    s.emit("mine", { type: "user_message", text: "start the mobile work", injected: false });
    s.emit("theirs", { type: "assistant_text", text: "the mobile plan is ready" });
    assert.deepEqual(s.ids("mobile"), ["title", "mine", "theirs"]);
  });
});

test("search: an answer is yours, a question is the agent's", () => {
  withSearch((s) => {
    s.session("answered", "chat");
    s.session("asked", "chat");
    s.emit("answered", { type: "answer", id: "q1", text: "the zebra one" });
    s.emit("asked", { type: "question", id: "q1", question: "which zebra did you mean?" });
    assert.deepEqual(s.ids("zebra"), ["answered", "asked"]);
  });
});

test("search: tool traffic and thinking are invisible", () => {
  withSearch((s) => {
    s.session("x", "unrelated");
    s.emit("x", { type: "tool_call", id: "c1", name: "Bash", input: { command: "grep mobile *" } });
    s.emit("x", { type: "tool_result", id: "c1", ok: true, output: { text: "mobile" } });
    s.emit("x", { type: "thinking", text: "they said mobile, so…" });
    assert.deepEqual(s.ids("mobile"), []);
  });
});

test("search: terms are AND'd across a session's messages, not within one", () => {
  withSearch((s) => {
    s.session("split", "chat");
    s.emit("split", { type: "user_message", text: "about the zebra", injected: false });
    s.emit("split", { type: "user_message", text: "and the migration", injected: false });
    assert.deepEqual(s.ids("zebra migration"), ["split"]);
  });
});

test("search: whole message bodies are searched, not a one-line summary", () => {
  withSearch((s) => {
    s.session("a", "chat");
    s.emit("a", {
      type: "user_message",
      text: `${"filler ".repeat(60)}zebra migration`,
      injected: false,
    });
    assert.deepEqual(s.ids("'zebra migration"), ["a"]);
  });
});

test("search: equal scores keep the fleet's order", () => {
  withSearch((s) => {
    s.session("first", "zebra run");
    s.session("second", "zebra run");
    const hits = s.rank("'zebra");
    assert.deepEqual(
      hits.map((h) => h.id),
      ["first", "second"],
    );
    assert.equal(hits[0]!.score, hits[1]!.score, "fixture: the two really do tie");
  });
});

test("search: an empty query is every session, unranked", () => {
  withSearch((s) => {
    s.session("a", "x");
    s.session("b", "y");
    assert.deepEqual(s.ids(""), ["a", "b"]);
    assert.deepEqual(s.ids("   "), ["a", "b"]);
  });
});

test("search: an untitled session is found by the short id the fleet shows it under", () => {
  withSearch((s) => {
    s.session("abcdef0123456789", null);
    assert.deepEqual(s.ids("'abcdef01"), ["abcdef0123456789"]);
  });
});

test("search: text is found in a session no client has ever opened", () => {
  withSearch((s) => {
    // The point of moving this to the daemon: the corpus is the durable table,
    // so nothing here depends on a client having downloaded a transcript page.
    s.session("never-visited", "chat");
    s.emit("never-visited", {
      type: "assistant_text",
      text: "the pelican crossing is repainted",
    });
    assert.deepEqual(s.ids("pelican"), ["never-visited"]);
  });
});
