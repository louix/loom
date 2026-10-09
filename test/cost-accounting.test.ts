/**
 * Cost-accounting fixtures (isolation plan A0, feeding A7). Each case drives a
 * representative Claude SDK `result` sequence through the real mapper, the
 * real `SessionManager` and the real `SessionStore`, then compares the
 * persisted session total — the number the TUI's fleet row prints — with what
 * the provider actually billed for the requests in that sequence.
 *
 * `ClaudeCliSim` models the CLI's cost ledger as SDK 0.3.282 documents it
 * (`SDKResultSuccess.total_cost_usd` / `modelUsage` in `sdk.d.ts`): running
 * totals per CLI process covering main loop, subagents and compaction calls;
 * zeroed values on crash results; and "a resumed or forked session continues
 * from the total its transcript saved, when it has one". The saved total is
 * the transcript's `cost-state` entry, appended at a graceful exit and
 * restored by `--resume`. `sdk.forkSession()` copies only chain entries, so
 * an undo's resumed fork starts from zero. See
 * docs/cost-accounting-investigation.md for the evidence.
 *
 * Cases that pin a real defect assert the correct total and are skipped with
 * the defect named, so the suite stays green until A7 lands the fix.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeEventMapper } from "@loom/connector-claude/map";
import { ClaudeProvider, __setClaudeSdk } from "@loom/connector-claude/adapter";
import { FakeProvider } from "@loom/connector-mock";
import type { HarnessEvent } from "@loom/core/events";
import { makeLogger, setLogLevel } from "@loom/core/logger";
import { SessionManager } from "@loom/daemon/daemon/session-manager";
import { openDb } from "@loom/daemon/store/db";
import { SessionStore, type UsageDelta } from "@loom/daemon/store/sessions";

setLogLevel("error");

// --- the provider side --------------------------------------------------

interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface ModelEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow: number;
}

interface Ledger {
  costUsd: number;
  models: Record<string, ModelEntry>;
}

/** USD per million tokens: input, output, cache read, 5-minute cache write. */
const RATES: Record<string, [number, number, number, number]> = {
  "claude-opus": [15, 75, 1.5, 18.75],
  "claude-sonnet": [3, 15, 0.3, 3.75],
  "claude-haiku": [1, 5, 0.1, 1.25],
};

const priceOf = (model: string, t: Tokens): number => {
  const [input, output, read, write] = RATES[model]!;
  return (
    ((t.input ?? 0) * input +
      (t.output ?? 0) * output +
      (t.cacheRead ?? 0) * read +
      (t.cacheWrite ?? 0) * write) /
    1_000_000
  );
};

const emptyLedger = (): Ledger => ({ costUsd: 0, models: {} });
const cloneLedger = (l: Ledger): Ledger => structuredClone(l);

/**
 * The Claude CLI's cost ledger across process lifetimes. `billedUsd` is the
 * ground truth: every request ever made, never restored and never reset.
 */
class ClaudeCliSim {
  billedUsd = 0;
  #ledger = emptyLedger();
  /** Transcript `cost-state` entries, last-wins per provider session id. */
  readonly #saved = new Map<string, Ledger>();
  #sessionId = "";
  #turnUsage: Required<Tokens> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  /**
   * A new CLI process. `resume` restores the saved total for that session id,
   * if any; `fresh` is a new session id and an `sdk.forkSession()` fork
   * carries no `cost-state`, so both start at zero.
   */
  start(sessionId: string, how: "fresh" | "resume" | "fork" = "fresh"): this {
    this.#sessionId = sessionId;
    const saved = how === "resume" ? this.#saved.get(sessionId) : undefined;
    this.#ledger = saved ? cloneLedger(saved) : emptyLedger();
    return this;
  }

  /** One API request. `main` requests count towards `result.usage`. */
  request(model: string, t: Tokens, main = true): number {
    const cost = priceOf(model, t);
    this.billedUsd += cost;
    this.#ledger.costUsd += cost;
    const e = (this.#ledger.models[model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      contextWindow: 200_000,
    });
    e.inputTokens += t.input ?? 0;
    e.outputTokens += t.output ?? 0;
    e.cacheReadInputTokens += t.cacheRead ?? 0;
    e.cacheCreationInputTokens += t.cacheWrite ?? 0;
    e.costUSD += cost;
    if (main) {
      this.#turnUsage.input += t.input ?? 0;
      this.#turnUsage.output += t.output ?? 0;
      this.#turnUsage.cacheRead += t.cacheRead ?? 0;
      this.#turnUsage.cacheWrite += t.cacheWrite ?? 0;
    }
    return cost;
  }

  /** The main-loop assistant frame for a request, carrying its own usage. */
  assistant(uuid: string, t: Tokens): unknown {
    return {
      type: "assistant",
      parent_tool_use_id: null,
      uuid,
      message: {
        content: [{ type: "text", text: "…" }],
        usage: {
          input_tokens: t.input ?? 0,
          output_tokens: t.output ?? 0,
          cache_read_input_tokens: t.cacheRead ?? 0,
          cache_creation_input_tokens: t.cacheWrite ?? 0,
        },
      },
    };
  }

  /** The turn's `result`: the running totals, as every result carries them. */
  result(extra: Record<string, unknown> = {}): unknown {
    const usage = this.#turnUsage;
    this.#turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "done",
      total_cost_usd: this.#ledger.costUsd,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheWrite,
      },
      modelUsage: cloneLedger(this.#ledger).models,
      ...extra,
    };
  }

  /** A crash / startup-error result: zeroed totals, whatever was spent. */
  crashResult(): unknown {
    return {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {
        "claude-sonnet": {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          contextWindow: 0,
        },
      },
    };
  }

  /** The process ends. Only a graceful exit stamps the transcript. */
  exit(graceful = true): void {
    if (graceful) this.#saved.set(this.#sessionId, cloneLedger(this.#ledger));
  }
}

// --- the Loom side ------------------------------------------------------

const ID = "loom-cost";

/**
 * Mapper → `SessionManager` → `SessionStore`, wired the way the daemon wires
 * them. A provider-reported delta is stored as-is, which is all
 * `Daemon.#priceUsage` does with one; nothing here prices from a table.
 */
class Pipeline {
  readonly db = openDb(":memory:");
  readonly store = new SessionStore(this.db);
  readonly provider = new FakeProvider();
  readonly mgr: SessionManager;
  mapper = new ClaudeEventMapper(ID);
  #emitted = 0;
  #seen = 0;

  constructor() {
    this.store.create({ id: ID, provider: "claude" });
    this.mgr = new SessionManager({
      emitEvent: () => {
        this.#seen++;
      },
      onStatus: () => {},
      onUsage: (id, delta: UsageDelta) => this.store.addUsage(id, delta),
      onResult: () => {},
      onTurnCompleted: () => {},
      onOverlay: () => {},
      onProviderRef: () => {},
      onMode: () => {},
      log: makeLogger("test"),
    });
  }

  async open(): Promise<void> {
    await this.mgr.create(this.provider, {
      sessionId: ID,
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
      loomServer: false,
    });
  }

  /** What `ClaudeProvider.resumeSession` does: a new adapter, so a new mapper. */
  async revive(): Promise<void> {
    await this.mgr.close(ID);
    this.#emitted = this.#seen;
    await this.mgr.resume(this.provider, { sessionId: ID, providerRef: "claude-1", cwd: "/tmp" });
    this.mapper = new ClaudeEventMapper(ID);
  }

  /** Map provider frames and push every resulting event through the manager. */
  async feed(...frames: unknown[]): Promise<HarnessEvent[]> {
    const fs = this.provider.session(ID)!;
    const out: HarnessEvent[] = [];
    for (const frame of frames) {
      for (const ev of this.mapper.map(frame)) {
        out.push(ev);
        fs.emit(ev);
        this.#emitted++;
      }
    }
    const start = Date.now();
    while (this.#seen < this.#emitted) {
      if (Date.now() - start > 2000) throw new Error("events were not drained");
      await delay(2);
    }
    return out;
  }

  /** The persisted session row — what the fleet list prints. */
  row() {
    return this.store.get(ID)!;
  }

  async close(): Promise<void> {
    await this.mgr.shutdown();
    this.db.close();
  }
}

const withPipeline = async (fn: (p: Pipeline) => Promise<void>): Promise<void> => {
  const p = new Pipeline();
  try {
    await p.open();
    await fn(p);
  } finally {
    await p.close();
  }
};

const near = (actual: number, expected: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: Loom $${actual.toFixed(6)}, billed $${expected.toFixed(6)}`,
  );
};

/** One ordinary main-loop turn: a cache-reading request that also writes. */
const turn = (cli: ClaudeCliSim, uuid: string, model = "claude-sonnet"): unknown[] => {
  const t = { input: 400, output: 900, cacheRead: 30_000, cacheWrite: 2_000 };
  cli.request(model, t);
  return [cli.assistant(uuid, t), cli.result()];
};

// --- one CLI process: the sequences the mapper already gets right ---------

test("one process: cache pricing, a model change and subagent usage are charged once", async () => {
  await withPipeline(async (p) => {
    const cli = new ClaudeCliSim().start("claude-1");
    await p.feed({ type: "system", subtype: "init", session_id: "claude-1" }, ...turn(cli, "a1"));

    // The user switches model mid-session; a Task subagent runs on Haiku in
    // the same turn. Both land in the next result's `modelUsage`.
    const main = { input: 50, output: 2_000, cacheRead: 60_000, cacheWrite: 8_000 };
    cli.request("claude-opus", main);
    cli.request("claude-haiku", { input: 12_000, output: 3_000, cacheWrite: 4_000 }, false);
    await p.feed(cli.assistant("a2", main), cli.result());

    near(p.row().costUsd, cli.billedUsd, "model change + subagent");
    assert.equal(p.row().costSource, "provider");
    const tokens = p.row().usage;
    assert.equal(tokens.cacheRead, 90_000, "cache reads counted once");
    assert.equal(tokens.input, 12_450, "subagent input counted once, via modelUsage");
  });
});

test("one process: compaction lowers context occupancy but never the incurred cost", async () => {
  await withPipeline(async (p) => {
    const cli = new ClaudeCliSim().start("claude-1");
    await p.feed(...turn(cli, "a1"), ...turn(cli, "a2"));
    const before = p.row().costUsd;

    // Automatic compaction runs inside a turn: the summarise call is billed
    // and shows up in the next result's modelUsage, not in `result.usage`.
    cli.request("claude-sonnet", { input: 150_000, output: 6_000 }, false);
    await p.feed({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 160_000, post_tokens: 9_000 },
    });
    assert.equal(p.row().costUsd, before, "the boundary itself carries no cost");
    await p.feed(...turn(cli, "a3"));

    // A manual `/compact` is its own SDK turn with its own result.
    cli.request("claude-sonnet", { input: 40_000, output: 3_000 }, false);
    await p.feed(
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 41_000, post_tokens: 5_000 },
      },
      cli.result(),
    );

    near(p.row().costUsd, cli.billedUsd, "auto + manual compaction");
    assert.equal(p.row().contextUsed, 5_000, "context is occupancy, not spend");
  });
});

test("one process: duplicate results, queued interim results and zeroed crash results", async () => {
  await withPipeline(async (p) => {
    const cli = new ClaudeCliSim().start("claude-1");
    const [assistant, first] = turn(cli, "a1");
    // The same cumulative frame delivered twice must not charge twice.
    await p.feed(assistant, first, first);
    near(p.row().costUsd, cli.billedUsd, "duplicate result");

    // A mid-engagement result (more user turns queued) still carries usage.
    cli.request("claude-sonnet", { input: 10, output: 400, cacheRead: 32_000 });
    await p.feed(cli.result({ queued_turn_count: 1 }));
    near(p.row().costUsd, cli.billedUsd, "queued interim result");

    // A crash result with zeroed totals must not reset the baseline and
    // re-charge everything on the next healthy result.
    await p.feed(cli.crashResult(), ...turn(cli, "a2"));
    near(p.row().costUsd, cli.billedUsd, "zeroed crash result");
  });
});

test("undo: a resumed sdk.forkSession() fork restarts at zero and onQuerySwap carries the rest", async () => {
  await withPipeline(async (p) => {
    const cli = new ClaudeCliSim().start("claude-1");
    await p.feed(...turn(cli, "a1"), ...turn(cli, "a2"));
    cli.exit();

    // ClaudeSession.rewind(): fork the transcript, swap the query.
    p.mapper.onQuerySwap();
    cli.start("claude-fork-1", "fork");
    await p.feed(...turn(cli, "b1"), ...turn(cli, "b2"));
    near(p.row().costUsd, cli.billedUsd, "undo");
  });
});

test("fresh implementation: a new CLI session starts at zero and onQuerySwap carries the plan", async () => {
  await withPipeline(async (p) => {
    const cli = new ClaudeCliSim().start("claude-plan");
    await p.feed(...turn(cli, "a1", "claude-opus"));
    cli.exit();
    // ClaudeSession.#implementFresh(): a new query() without `resume`.
    p.mapper.onQuerySwap();
    cli.start("claude-impl", "fresh");
    await p.feed(...turn(cli, "b1"), ...turn(cli, "b2"));
    near(p.row().costUsd, cli.billedUsd, "fresh implementation");
  });
});

test("revive without a saved total: a killed CLI leaves nothing to restore, so the new process starts at zero", async () => {
  await withPipeline(async (p) => {
    const cli = new ClaudeCliSim().start("claude-1");
    await p.feed(...turn(cli, "a1"), ...turn(cli, "a2"));
    cli.exit(false); // SIGKILL: no `cost-state` stamp
    await p.revive();
    cli.start("claude-1", "resume");
    await p.feed(...turn(cli, "a3"));
    near(p.row().costUsd, cli.billedUsd, "revive after an unstamped exit");
  });
});

// --- across CLI processes: the defect --------------------------------------

// DEFECT (resume re-charges history): ClaudeProvider.resumeSession builds a new
// ClaudeSession whose ClaudeEventMapper starts its query baseline at zero
// (connectors/claude/src/map.ts:263-264), but the resumed CLI restores the
// transcript's saved `cost-state`, so its first result's `total_cost_usd` and
// `modelUsage` already include every earlier process. The mapper emits that
// whole history as this turn's `costDeltaUsd` (map.ts:623) and the store adds
// it again (sessions.ts:356).
test(
  "revive after a graceful exit charges only the new spend",
  { skip: "DEFECT: resume re-charges the restored cost-state (A7)" },
  async () => {
    await withPipeline(async (p) => {
      const cli = new ClaudeCliSim().start("claude-1");
      await p.feed(...turn(cli, "a1"), ...turn(cli, "a2"));
      cli.exit(); // daemon restart, idle suspension, refresh, provider switch…
      await p.revive();
      cli.start("claude-1", "resume");
      await p.feed(...turn(cli, "a3"));
      near(p.row().costUsd, cli.billedUsd, "revive after a graceful exit");
    });
  },
);

// DEFECT (resume re-charges history), compounded: each revive re-charges the
// whole running total, so the overcount grows with every restart.
test(
  "repeated revives keep the session total equal to the billed spend",
  { skip: "DEFECT: resume re-charges the restored cost-state (A7)" },
  async () => {
    await withPipeline(async (p) => {
      const cli = new ClaudeCliSim().start("claude-1");
      await p.feed(...turn(cli, "a1"));
      for (let i = 2; i <= 5; i++) {
        cli.exit();
        await p.revive();
        cli.start("claude-1", "resume");
        await p.feed(...turn(cli, `a${i}`));
      }
      near(p.row().costUsd, cli.billedUsd, "five processes");
    });
  },
);

// DEFECT (resume re-charges history), crash variant: the CLI restores the last
// *graceful* stamp, which can be older than the last result Loom saw.
test(
  "revive after a crash restores an older stamp without re-charging it",
  { skip: "DEFECT: resume re-charges the restored cost-state (A7)" },
  async () => {
    await withPipeline(async (p) => {
      const cli = new ClaudeCliSim().start("claude-1");
      await p.feed(...turn(cli, "a1"));
      cli.exit();
      await p.revive();
      cli.start("claude-1", "resume");
      await p.feed(...turn(cli, "a2"));
      cli.exit(false); // killed: the stamp still says "after a1"
      await p.revive();
      cli.start("claude-1", "resume");
      await p.feed(...turn(cli, "a3"));
      near(p.row().costUsd, cli.billedUsd, "revive after a crash");
    });
  },
);

// --- through the adapter ------------------------------------------------

/** A `Query` stand-in fed while the session runs (as in claude-adapter.test.ts). */
const liveQuery = () => {
  let stop = false;
  const queue: unknown[] = [];
  const iter = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next(): Promise<IteratorResult<unknown, void>> {
      while (queue.length === 0 && !stop) await delay(5);
      if (queue.length > 0) return { done: false, value: queue.shift() };
      return { done: true, value: undefined };
    },
    async return(): Promise<IteratorResult<unknown, void>> {
      stop = true;
      return { done: true, value: undefined };
    },
  };
  return Object.assign(iter, {
    push: (...m: unknown[]): void => {
      queue.push(...m);
    },
    interrupt: async () => ({ still_queued: [] as string[] }),
    close: () => {
      stop = true;
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    initializationResult: async () => ({ models: [] }),
  });
};

type LiveQuery = ReturnType<typeof liveQuery>;

/** Collect a session's charged cost; tear it down via `t.after`. */
const collect = (
  t: TestContext,
  s: { events(): AsyncIterable<HarnessEvent>; close(): Promise<void> },
) => {
  const charged = { usd: 0, results: 0 };
  const reader = (async () => {
    for await (const ev of s.events()) {
      if (ev.type === "usage") charged.usd += ev.costDeltaUsd ?? 0;
      if (ev.type === "result") charged.results++;
    }
  })();
  t.after(async () => {
    await s.close();
    await reader.catch(() => {});
  });
  return charged;
};

const until = async (pred: () => boolean): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 2000) throw new Error("condition not met in time");
    await delay(5);
  }
};

// DEFECT (resume re-charges history), at the adapter boundary: a resumed
// ClaudeSession's first usage event carries the restored history.
test(
  "a resumed ClaudeSession charges only the spend since it started",
  { skip: "DEFECT: resume re-charges the restored cost-state (A7)" },
  async (t) => {
    const cli = new ClaudeCliSim().start("claude-1");
    turn(cli, "a1");
    turn(cli, "a2");
    cli.exit();
    const before = cli.billedUsd;

    let q!: LiveQuery;
    let resumed: unknown;
    __setClaudeSdk({
      query: (args: unknown) => {
        resumed = (args as { options: { resume?: string } }).options.resume;
        q = liveQuery();
        return q as never;
      },
    });
    const s = await new ClaudeProvider().resumeSession({
      sessionId: ID,
      providerRef: "claude-1",
      cwd: "/tmp",
    });
    const charged = collect(t, s);
    assert.equal(resumed, "claude-1");
    cli.start("claude-1", "resume");
    await s.send("next");
    q.push({ type: "system", subtype: "init", session_id: "claude-1" }, ...turn(cli, "a3"));
    await until(() => charged.results === 1);
    near(charged.usd, cli.billedUsd - before, "resumed adapter");
  },
);

// DEFECT (interrupted turns are never charged): while `#interrupted` is set,
// ClaudeSession.#drain still advances the mapper's baseline but drops the
// `usage` event (connectors/claude/src/adapter.ts:676-680), so the spend of an
// interrupted turn never reaches the session total. Undercount, not inflation.
test(
  "an interrupted turn's spend is still charged",
  { skip: "DEFECT: interrupt drops the turn's usage event (A7)" },
  async (t) => {
    const cli = new ClaudeCliSim().start("claude-1");
    let q!: LiveQuery;
    __setClaudeSdk({
      query: () => {
        q = liveQuery();
        return q as never;
      },
    });
    const s = await new ClaudeProvider().createSession({
      sessionId: ID,
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
      loomServer: false,
    });
    const charged = collect(t, s);
    q.push({ type: "system", subtype: "init", session_id: "claude-1" }, ...turn(cli, "a1"));
    await until(() => charged.results === 1);

    // A long turn is interrupted after it has already spent; the CLI's
    // result for it carries that spend in its running total.
    const spent = { input: 300, output: 5_000, cacheRead: 40_000, cacheWrite: 1_000 };
    cli.request("claude-sonnet", spent);
    q.push(cli.assistant("a2", spent));
    await s.interrupt();
    q.push(cli.result({ subtype: "error_during_execution", is_error: true }));
    await delay(50);

    await s.send("again");
    q.push(...turn(cli, "a3"));
    await until(() => charged.results === 2);
    near(charged.usd, cli.billedUsd, "interrupted turn");
  },
);
