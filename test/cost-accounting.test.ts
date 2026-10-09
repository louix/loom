/**
 * Cost-accounting fixtures (isolation plan A0/A7). Each case drives a
 * representative Claude CLI sequence through the real `ClaudeProvider` (over
 * a fake SDK query), the real `SessionManager` and the real `SessionStore`,
 * then compares the persisted session total — the number the TUI prints —
 * with what the provider actually billed for the requests in that sequence.
 *
 * `ClaudeCliSim` models the CLI's cost ledger as SDK 0.3.282 documents it
 * (`SDKResultSuccess.total_cost_usd` / `modelUsage` in `sdk.d.ts`) and as the
 * CLI 2.1.280 was observed to behave (docs/cost-accounting-investigation.md):
 * running totals per process covering main loop, subagents and compaction;
 * zeroed values on crash results; a `cost-state` stamp at a graceful exit that
 * `--resume` restores; `get_usage` reporting the restored ledger before the
 * first turn; `sdk.forkSession()` copying no stamp; and `/clear` emitting
 * `conversation_reset` and a fresh `init` before zeroing the ledger.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeEventMapper } from "@loom/connector-claude/map";
import { ClaudeProvider, __setClaudeSdk, __setSeedTimeoutMs } from "@loom/connector-claude/adapter";
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

  get sessionId(): string {
    return this.#sessionId;
  }

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

  /** The `init` frame that opens a process's first turn. */
  init(): unknown {
    return { type: "system", subtype: "init", session_id: this.#sessionId };
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

  /**
   * `/clear`: as observed on CLI 2.1.280 — `conversation_reset`, an `init`
   * under a new session id, then a result whose ledger is already zero.
   */
  clear(newSessionId: string): unknown[] {
    const reset = {
      type: "conversation_reset",
      new_conversation_id: crypto.randomUUID(),
      uuid: crypto.randomUUID(),
      session_id: this.#sessionId,
      trigger: "clear",
    };
    this.#sessionId = newSessionId;
    this.#ledger = emptyLedger();
    return [reset, this.init(), this.result({ num_turns: 0, modelUsage: {} })];
  }

  /** What `get_usage` reports: the ledger as it stands. */
  usageReport(): unknown {
    return {
      session: { total_cost_usd: this.#ledger.costUsd, model_usage: this.#ledger.models },
      rate_limits_available: false,
      rate_limits: null,
    };
  }

  /**
   * A native history fork: `sdk.forkSession()` copies the session and a new
   * process resumes the copy under `newId`. The copy carries no `cost-state`,
   * so its ledger starts empty — or, with `restoreSource`, the worst case of
   * a CLI that restored the source's total anyway.
   */
  fork(newId: string, restoreSource = false): this {
    const source = this.#saved.get(this.#sessionId) ?? this.#ledger;
    this.#sessionId = newId;
    this.#ledger = restoreSource ? cloneLedger(source) : emptyLedger();
    return this;
  }

  /** The process ends. Only a graceful exit stamps the transcript. */
  exit(graceful = true): void {
    if (graceful) this.#saved.set(this.#sessionId, cloneLedger(this.#ledger));
  }
}

// --- a fake SDK query over the simulated CLI ---------------------------------

type UsageMode = "report" | "fail" | "hang";

/**
 * A `Query` stand-in: frames are pushed by the test, user messages are pulled
 * from the prompt the adapter hands the SDK (so a held prompt is observable),
 * and `get_usage` answers from the simulated CLI — or fails, or never answers.
 */
const fakeQuery = (cli: ClaudeCliSim, prompt: AsyncIterable<unknown>, usage: () => UsageMode) => {
  let stop = false;
  let received = 0;
  const queue: unknown[] = [];
  void (async () => {
    for await (const _ of prompt) received++;
  })();
  const iter = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next(): Promise<IteratorResult<unknown, void>> {
      while (queue.length === 0 && !stop) await delay(2);
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
    received: (): number => received,
    interrupt: async () => ({ still_queued: [] as string[] }),
    close: () => {
      stop = true;
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    initializationResult: async () => ({ models: [] }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (): Promise<unknown> => {
      const mode = usage();
      if (mode === "fail") return Promise.reject(new Error("get_usage unsupported"));
      if (mode === "hang") return new Promise(() => {});
      return Promise.resolve(cli.usageReport());
    },
  });
};

type FakeQuery = ReturnType<typeof fakeQuery>;

const until = async (pred: () => boolean, what: string, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await delay(2);
  }
};

const isResultEvent = (frame: unknown): boolean => {
  const f = frame as {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    queued_turn_count?: number;
  };
  if (f.type !== "result") return false;
  // A healthy result with turns still queued is an internal seam, not a turn.
  return !(f.subtype === "success" && f.is_error !== true && (f.queued_turn_count ?? 0) > 0);
};

// --- the Loom side ------------------------------------------------------

const ID = "loom-cost";

/**
 * `ClaudeProvider` → `SessionManager` → `SessionStore`, wired the way the
 * daemon wires them. A provider-reported delta is stored as-is, which is all
 * `Daemon.#priceUsage` does with one; nothing here prices from a table. A
 * revive passes the store's observed provider total exactly as
 * `Daemon.#reviveLocked` does.
 */
class Pipeline {
  readonly cli = new ClaudeCliSim();
  readonly provider = new ClaudeProvider();
  usage: UsageMode = "report";
  forkId = "claude-fork-1";
  db!: ReturnType<typeof openDb>;
  store!: SessionStore;
  mgr!: SessionManager;
  q!: FakeQuery;
  /** Every `onProviderRef` write, in order, across daemon restarts. */
  readonly refWrites: string[] = [];
  /** The `resume` ref of every query started with one. */
  readonly resumed: string[] = [];
  readonly dbPath: string;
  /** User messages the test has handed the current query. */
  #used = 0;
  #needsSend = false;
  #initPending = true;

  constructor(dbPath = ":memory:") {
    this.dbPath = dbPath;
    this.#openStore();
    __setClaudeSdk({
      query: ((args: { prompt: AsyncIterable<unknown>; options: { resume?: string } }) => {
        this.q = fakeQuery(this.cli, args.prompt, () => this.usage);
        this.#used = 0;
        this.#initPending = true;
        this.#needsSend = Boolean(args.options.resume);
        if (args.options.resume) this.resumed.push(args.options.resume);
        return this.q;
      }) as never,
      forkSession: (async () => ({ sessionId: this.forkId })) as never,
    });
  }

  #openStore(): void {
    this.db = openDb(this.dbPath);
    this.store = new SessionStore(this.db);
    if (!this.store.get(ID)) this.store.create({ id: ID, provider: "claude" });
    this.mgr = new SessionManager({
      emitEvent: () => {},
      onStatus: () => {},
      onUsage: (id, delta: UsageDelta) => this.store.addUsage(id, delta),
      onResult: () => {},
      onTurnCompleted: () => {},
      onOverlay: () => {},
      onProviderRef: (id, ref) => {
        this.refWrites.push(ref);
        this.store.setFields(id, { providerRef: ref });
      },
      onMode: () => {},
      log: makeLogger("test"),
    });
  }

  async create(): Promise<void> {
    this.cli.start("claude-1");
    await this.mgr.create(this.provider, {
      sessionId: ID,
      cwd: "/tmp",
      prompt: "go",
      mode: "default",
      mcpServers: [],
      loomServer: false,
    });
  }

  /** Wait until the CLI has pulled the next user message, sending one if needed. */
  async next(text = "next"): Promise<void> {
    if (this.#needsSend) await this.mgr.send(ID, text);
    this.#needsSend = true;
    const want = ++this.#used;
    await until(() => this.q.received() >= want, "the CLI never received the user message");
  }

  /** Push frames (opening the process's first turn with `init`) and wait for their results. */
  async feed(...frames: unknown[]): Promise<void> {
    if (this.#initPending && !frames.some((f) => (f as { type?: string }).type === "system")) {
      frames.unshift(this.cli.init());
    }
    this.#initPending = false;
    const want = this.row().turns + frames.filter(isResultEvent).length;
    this.q.push(...frames);
    await until(() => this.row().turns >= want, "the turn never settled");
  }

  /** One ordinary main-loop turn: a cache-reading request that also writes. */
  async turn(uuid: string, model = "claude-sonnet"): Promise<void> {
    await this.next();
    const t = { input: 400, output: 900, cacheRead: 30_000, cacheWrite: 2_000 };
    this.cli.request(model, t);
    await this.feed(this.cli.assistant(uuid, t), this.cli.result());
  }

  /** What `Daemon.#reviveLocked` does: resume the stored ref with its observed total. */
  async #resume(): Promise<void> {
    const ref = this.store.providerRef(ID)!;
    this.cli.start(ref, "resume");
    const usageBaseline = this.store.providerTotal(ID, ref);
    await this.mgr.resume(this.provider, {
      sessionId: ID,
      providerRef: ref,
      cwd: "/tmp",
      mcpServers: [],
      ...(usageBaseline ? { usageBaseline } : {}),
    });
  }

  /** The CLI exits (gracefully or not) and a later send revives the session. */
  async revive(graceful = true): Promise<void> {
    this.cli.exit(graceful);
    await this.mgr.close(ID);
    await this.#resume();
  }

  /** The daemon stops and starts again over the same database, then revives. */
  async restart(graceful = true): Promise<void> {
    this.cli.exit(graceful);
    await this.mgr.shutdown();
    this.db.close();
    this.#openStore();
    await this.#resume();
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

const withPipeline = async (fn: (p: Pipeline) => Promise<void>, dbPath?: string): Promise<void> => {
  const p = new Pipeline(dbPath);
  try {
    await p.create();
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

// --- one CLI process ---------------------------------------------------------

test("one process: cache pricing, a model change and subagent usage are charged once", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");

    // The user switches model mid-session; a Task subagent runs on Haiku in
    // the same turn. Both land in the next result's `modelUsage`.
    await p.next();
    const main = { input: 50, output: 2_000, cacheRead: 60_000, cacheWrite: 8_000 };
    p.cli.request("claude-opus", main);
    p.cli.request("claude-haiku", { input: 12_000, output: 3_000, cacheWrite: 4_000 }, false);
    await p.feed(p.cli.assistant("a2", main), p.cli.result());

    near(p.row().costUsd, p.cli.billedUsd, "model change + subagent");
    assert.equal(p.row().costSource, "provider");
    const tokens = p.row().usage;
    assert.equal(tokens.cacheRead, 90_000, "cache reads counted once");
    assert.equal(tokens.input, 12_450, "subagent input counted once, via modelUsage");
  });
});

test("one process: compaction lowers context occupancy but never the incurred cost", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");

    // Automatic compaction runs inside a turn: the summarise call is billed
    // and shows up in the next result's modelUsage, not in `result.usage`.
    await p.next();
    p.cli.request("claude-sonnet", { input: 150_000, output: 6_000 }, false);
    const t = { input: 400, output: 900, cacheRead: 8_000, cacheWrite: 2_000 };
    p.cli.request("claude-sonnet", t);
    await p.feed(
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 160_000, post_tokens: 9_000 },
      },
      p.cli.assistant("a3", t),
      p.cli.result(),
    );

    // A manual `/compact` is its own SDK turn with its own result.
    await p.next();
    p.cli.request("claude-sonnet", { input: 40_000, output: 3_000 }, false);
    await p.feed(
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 41_000, post_tokens: 5_000 },
      },
      p.cli.result(),
    );

    near(p.row().costUsd, p.cli.billedUsd, "auto + manual compaction");
    assert.equal(p.row().contextUsed, 5_000, "context is occupancy, not spend");
  });
});

test("one process: duplicate results, queued interim results and zeroed crash results", async () => {
  await withPipeline(async (p) => {
    await p.next();
    const t = { input: 400, output: 900, cacheRead: 30_000, cacheWrite: 2_000 };
    p.cli.request("claude-sonnet", t);
    const first = p.cli.result();
    // The same cumulative frame delivered twice must not charge twice.
    await p.feed(p.cli.assistant("a1", t), first, first);
    near(p.row().costUsd, p.cli.billedUsd, "duplicate result");

    // A mid-engagement result (more user turns queued) still carries usage.
    await p.next();
    p.cli.request("claude-sonnet", { input: 10, output: 400, cacheRead: 32_000 });
    p.cli.request("claude-sonnet", { input: 10, output: 400, cacheRead: 33_000 });
    await p.feed(p.cli.result({ queued_turn_count: 1 }), p.cli.result());
    near(p.row().costUsd, p.cli.billedUsd, "queued interim result");

    // A crash result with zeroed totals must not reset the baseline and
    // re-charge everything on the next healthy result.
    await p.next();
    await p.feed(p.cli.crashResult());
    await p.turn("a2");
    near(p.row().costUsd, p.cli.billedUsd, "zeroed crash result");
  });
});

test("an explicit conversation_reset starts a new ledger; a smaller total alone does not", () => {
  const result = (cost: number) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: cost,
    modelUsage: { m: { inputTokens: Math.round(cost * 1000), costUSD: cost } },
  });
  const charged = (m: ClaudeEventMapper, frame: unknown): number =>
    m
      .map(frame)
      .filter((e): e is Extract<HarnessEvent, { type: "usage" }> => e.type === "usage")
      .reduce((sum, e) => sum + (e.costDeltaUsd ?? 0), 0);

  // A partial report below the running total is not a reset: nothing is
  // charged until the total passes the old mark again.
  const partial = new ClaudeEventMapper(ID);
  assert.equal(charged(partial, result(1)), 1);
  assert.equal(charged(partial, result(0.4)), 0);
  assert.ok(Math.abs(charged(partial, result(1.2)) - 0.2) < 1e-9);
  assert.ok(Math.abs(partial.state.costUsd - 1.2) < 1e-9);

  // After the reset frame the same smaller total is new spend.
  const reset = new ClaudeEventMapper(ID);
  assert.equal(charged(reset, result(1)), 1);
  reset.map({ type: "conversation_reset", new_conversation_id: "c2", session_id: "c1" });
  assert.ok(Math.abs(charged(reset, result(0.4)) - 0.4) < 1e-9);
  assert.ok(Math.abs(reset.state.costUsd - 1.4) < 1e-9, "charged totals never regress");
});

test("/clear: the zeroed ledger is a reset, not a reason to stop charging", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    await p.next("/clear");
    await p.feed(...p.cli.clear("claude-2"));
    await p.turn("b1");
    await p.turn("b2");
    near(p.row().costUsd, p.cli.billedUsd, "after /clear");
    // What a resume of the cleared session would restore: its own ledger only.
    const observed = p.store.providerTotal(ID);
    assert.equal(observed?.ref, "claude-2");
    assert.ok(observed && observed.costUsd < p.row().costUsd);
  });
});

// --- across CLI processes ------------------------------------------------------

for (const restoreSource of [false, true])
  test(`native fork: the copy is charged only its own spend${restoreSource ? " even if the CLI restores the source's total" : ""}`, async () => {
    await withPipeline(async (p) => {
      await p.turn("a1");
      await p.turn("a2");
      const sourceRef = p.store.providerRef(ID)!;
      const sourceCost = p.row().costUsd;
      const sourceTotal = p.store.providerTotal(ID, sourceRef)!;
      let copied = "";
      __setClaudeSdk({
        forkSession: (async (id: string) => {
          copied = id;
          return { sessionId: p.forkId };
        }) as never,
      });
      const FORK = "loom-cost-fork";
      p.store.create({ id: FORK, provider: "claude" });
      p.cli.exit();
      p.cli.fork(p.forkId, restoreSource);
      // What the daemon's `session.fork` sends; the source's observed total
      // rides along to show it is not used as the copy's baseline.
      await p.mgr.resume(p.provider, {
        sessionId: FORK,
        providerRef: sourceRef,
        forkHistory: true,
        cwd: "/tmp",
        mcpServers: [],
        usageBaseline: sourceTotal,
      });
      assert.equal(copied, sourceRef, "the copy is made from the source's session");
      assert.equal(p.mgr.snapshot(FORK)?.providerRef, p.forkId, "known before the CLI speaks");

      await p.mgr.send(FORK, "continue on the fork");
      await until(() => p.q.received() >= 1, "the fork's CLI never received the message");
      const t = { input: 300, output: 700, cacheRead: 20_000, cacheWrite: 1_000 };
      const own = p.cli.request("claude-sonnet", t);
      p.q.push(p.cli.init(), p.cli.assistant("f1", t), p.cli.result());
      await until(() => p.store.get(FORK)!.turns >= 1, "the fork's turn never settled");

      near(p.store.get(FORK)!.costUsd, own, "the fork");
      near(p.row().costUsd, sourceCost, "the source");
    });
  });

test("undo: a resumed sdk.forkSession() fork restarts at zero and onQuerySwap carries the rest", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    p.cli.exit();
    p.cli.start(p.forkId, "fork");
    await p.mgr.rewind(ID, 0, "a1");
    await p.turn("b1");
    await p.turn("b2");
    near(p.row().costUsd, p.cli.billedUsd, "undo");
  });
});

// --- the provider ref a revive resumes -----------------------------------------

test("a steady provider ref is written once per attach, not per event", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    await p.turn("a3");
    assert.deepEqual(p.refWrites, ["claude-1"]);
    await p.revive();
    await p.turn("a4");
    assert.deepEqual(p.resumed, ["claude-1"]);
    assert.deepEqual(p.refWrites, ["claude-1", "claude-1"]);
    near(p.row().costUsd, p.cli.billedUsd, "unchanged ref");
  });
});

test("undo: the fork's ref is persisted at once, so a revive resumes the post-undo transcript", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    p.cli.exit();
    p.cli.start(p.forkId, "fork");
    await p.mgr.rewind(ID, 0, "a1");
    // No turn has run on the fork yet, so no `init` has named it.
    assert.equal(p.store.providerRef(ID), p.forkId);
    await p.revive();
    assert.deepEqual(p.resumed, [p.forkId, p.forkId]);
    await p.turn("b1");
    near(p.row().costUsd, p.cli.billedUsd, "undo, then revive");
  });
});

test("undo: the persisted total follows the fork's ref into a revive", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    p.cli.exit();
    p.cli.start(p.forkId, "fork");
    await p.mgr.rewind(ID, 0, "a1");
    await p.turn("b1");
    assert.equal(p.store.providerTotal(ID)?.ref, p.forkId);
    // Without get_usage the fallback is the only seed: resuming the pre-undo
    // ref would restore its larger stamp and find no total for it.
    p.usage = "fail";
    await p.revive();
    assert.deepEqual(p.resumed, [p.forkId, p.forkId]);
    await p.turn("b2");
    near(p.row().costUsd, p.cli.billedUsd, "undo, turn, revive without get_usage");
  });
});

test("/clear: the new CLI session's ref is persisted, and a revive resumes it with its total", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    await p.next("/clear");
    await p.feed(...p.cli.clear("claude-2"));
    assert.equal(p.store.providerRef(ID), "claude-2");
    await p.turn("b1");
    assert.deepEqual(p.refWrites, ["claude-1", "claude-2"]);
    assert.ok(p.store.providerTotal(ID, "claude-2"), "the total is keyed to the new ref");
    p.usage = "fail";
    await p.revive();
    assert.deepEqual(p.resumed, ["claude-2"]);
    await p.turn("b2");
    near(p.row().costUsd, p.cli.billedUsd, "/clear, then revive without get_usage");
  });
});

test("fresh implementation: a new CLI session starts at zero and onQuerySwap carries the plan", () => {
  // ClaudeSession.#implementFresh(): a new query() without `resume`, so no seed.
  const cli = new ClaudeCliSim().start("claude-plan");
  const m = new ClaudeEventMapper(ID);
  let charged = 0;
  const feed = (...frames: unknown[]) => {
    for (const f of frames)
      for (const e of m.map(f)) if (e.type === "usage") charged += e.costDeltaUsd ?? 0;
  };
  const t = { input: 400, output: 900, cacheRead: 30_000, cacheWrite: 2_000 };
  cli.request("claude-opus", t);
  feed(cli.init(), cli.assistant("a1", t), cli.result());
  cli.exit();
  m.onQuerySwap();
  cli.start("claude-impl", "fresh");
  for (const uuid of ["b1", "b2"]) {
    cli.request("claude-sonnet", t);
    feed(cli.assistant(uuid, t), cli.result());
  }
  near(charged, cli.billedUsd, "fresh implementation");
  near(m.state.costUsd, cli.billedUsd, "mapper total");
});

test("revive without a saved total: a killed CLI leaves nothing to restore, so the new process starts at zero", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    await p.revive(false); // SIGKILL: no `cost-state` stamp
    await p.turn("a3");
    near(p.row().costUsd, p.cli.billedUsd, "revive after an unstamped exit");
  });
});

test("revive after a graceful exit charges only the new spend", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    await p.revive(); // daemon restart, idle suspension, refresh, provider switch…
    await p.turn("a3");
    near(p.row().costUsd, p.cli.billedUsd, "revive after a graceful exit");
  });
});

test("repeated revives keep the session total equal to the billed spend", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    for (let i = 2; i <= 5; i++) {
      await p.revive();
      await p.turn(`a${i}`);
    }
    near(p.row().costUsd, p.cli.billedUsd, "five processes");
  });
});

test("revive after a crash restores an older stamp without re-charging it", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.revive();
    await p.turn("a2");
    await p.revive(false); // killed: the stamp still says "after a1"
    await p.turn("a3");
    near(p.row().costUsd, p.cli.billedUsd, "revive after a crash");
  });
});

test("get_usage failure: the persisted observation seeds the resumed baseline", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    const observed = p.store.providerTotal(ID, "claude-1");
    assert.ok(observed, "each result persists the CLI's running total");
    near(observed.costUsd, p.cli.billedUsd, "observed running total");
    p.usage = "fail";
    await p.revive();
    await p.turn("a3");
    near(p.row().costUsd, p.cli.billedUsd, "fallback seed after a graceful exit");
  });
});

test("the persisted observation survives a daemon restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cost-"));
  try {
    await withPipeline(
      async (p) => {
        await p.turn("a1");
        await p.turn("a2");
        p.usage = "fail";
        await p.restart();
        await p.turn("a3");
        near(p.row().costUsd, p.cli.billedUsd, "fallback seed across a daemon restart");
      },
      join(dir, "loom.db"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash with no stamp and no get_usage never charges negative or twice", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    const before = p.row().costUsd;
    p.usage = "fail";
    // The CLI restores nothing, but the only seed left is Loom's last
    // observation. The new process's spend stays under that mark, so it goes
    // uncharged — a bounded undercount, never a re-charge or a negative delta.
    await p.revive(false);
    await p.turn("a3");
    const row = p.row();
    assert.ok(row.costUsd >= before, "the total never decreases");
    assert.ok(row.costUsd <= p.cli.billedUsd + 1e-9, "nothing is charged twice");
  });
});

test("a result that lands before the seed is held, then diffed against the fallback", async (t) => {
  __setSeedTimeoutMs(100);
  t.after(() => __setSeedTimeoutMs(10_000));
  await withPipeline(async (p) => {
    await p.turn("a1");
    await p.turn("a2");
    p.usage = "hang";
    p.cli.exit();
    await p.mgr.close(ID);
    // Resume without the store's observation would re-charge; the held
    // startup-error result carries the restored totals.
    p.cli.start("claude-1", "resume");
    const usageBaseline = p.store.providerTotal(ID, "claude-1")!;
    await p.mgr.resume(p.provider, {
      sessionId: ID,
      providerRef: "claude-1",
      cwd: "/tmp",
      mcpServers: [],
      usageBaseline,
    });
    const before = p.row().costUsd;
    await p.feed(p.cli.init(), p.cli.result({ subtype: "error_during_execution", is_error: true }));
    near(p.row().costUsd, before, "the restored total is not charged again");
    await p.turn("a3");
    near(p.row().costUsd, p.cli.billedUsd, "after a get_usage timeout");
  });
});

// --- interrupts ----------------------------------------------------------------

test("an interrupted turn's spend is still charged", async () => {
  await withPipeline(async (p) => {
    await p.turn("a1");

    // A long turn is interrupted after it has already spent; the CLI's
    // result for it carries that spend in its running total.
    await p.next();
    const spent = { input: 300, output: 5_000, cacheRead: 40_000, cacheWrite: 1_000 };
    p.cli.request("claude-sonnet", spent);
    p.q.push(p.cli.assistant("a2", spent));
    await p.mgr.interrupt(ID);
    const trailing = p.cli.result({ subtype: "error_during_execution", is_error: true });
    p.q.push(trailing);
    await until(
      () => Math.abs(p.row().costUsd - p.cli.billedUsd) < 1e-9,
      `interrupted turn: Loom $${p.row().costUsd}, billed $${p.cli.billedUsd}`,
    );

    // A trailing duplicate of that result is not charged twice.
    p.q.push(trailing);
    await p.turn("a3");
    near(p.row().costUsd, p.cli.billedUsd, "interrupt + trailing result");
  });
});

// --- through the adapter alone ------------------------------------------------

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

test("a resumed ClaudeSession charges only the spend since it started", async (t) => {
  const cli = new ClaudeCliSim().start("claude-1");
  const t1 = { input: 400, output: 900, cacheRead: 30_000, cacheWrite: 2_000 };
  cli.request("claude-sonnet", t1);
  cli.request("claude-sonnet", t1);
  cli.exit();
  const before = cli.billedUsd;
  cli.start("claude-1", "resume");

  let q!: FakeQuery;
  let resumed: unknown;
  __setClaudeSdk({
    query: ((args: { prompt: AsyncIterable<unknown>; options: { resume?: string } }) => {
      resumed = args.options.resume;
      q = fakeQuery(cli, args.prompt, () => "report");
      return q;
    }) as never,
  });
  const s = await new ClaudeProvider().resumeSession({
    sessionId: ID,
    providerRef: "claude-1",
    cwd: "/tmp",
  });
  const charged = collect(t, s);
  assert.equal(resumed, "claude-1");
  await s.send("next");
  await until(() => q.received() === 1, "the held prompt was released");
  cli.request("claude-sonnet", t1);
  q.push(cli.init(), cli.assistant("a3", t1), cli.result());
  await until(() => charged.results === 1, "the turn settled");
  near(charged.usd, cli.billedUsd - before, "resumed adapter");
});
