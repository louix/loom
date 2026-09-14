import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { homedir, tmpdir } from "node:os";
import type { HarnessEvent } from "@loom/core/events";
import {
  ClaudeProvider,
  __setClaudeSdk,
  allowedWriteRoots,
  outOfTreeWriteReason,
} from "@loom/connector-claude/adapter";
import { setLogLevel } from "@loom/core/logger";

setLogLevel("error");

test("model discovery explains a bundled CLI launch failure without exposing SDK error details", async () => {
  const path = Deno.env.get("PATH");
  Deno.env.set("PATH", "");
  try {
    for (const synchronous of [true, false]) {
      const failure = new Error(
        "Claude Code native binary at /private/token exists but failed to launch. secret",
      );
      __setClaudeSdk({
        query: () => {
          if (synchronous) throw failure;
          return { initializationResult: () => Promise.reject(failure), close: () => {} } as never;
        },
      });
      await assert.rejects(new ClaudeProvider().listModels(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /No claude executable was found on the daemon's PATH/);
        assert.match(error.message, /providers.claude.cli_path/);
        assert.doesNotMatch(error.message, /private|secret/);
        return true;
      });
    }
  } finally {
    if (path === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", path);
  }
});

// Structural stand-in for the SDK's `CanUseTool` — the real type isn't a root
// dependency, and only its shape matters here.
type PermissionResult = { behavior: "allow" | "deny"; message?: string } | null;
type FakeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { toolUseID?: string; requestId?: string },
) => Promise<PermissionResult>;

/** A `Query` stand-in: an async iterator that yields any seeded messages, then
 *  idles until `close()`, plus the control methods the adapter calls. No
 *  generator (keeps oxlint happy). */
const fakeQuery = (msgs: unknown[] = []) => {
  let stop = false;
  const queue = [...msgs];
  const iter = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next(): Promise<IteratorResult<unknown, void>> {
      while (queue.length === 0 && !stop) await delay(10);
      if (queue.length > 0) return { done: false, value: queue.shift() };
      return { done: true, value: undefined };
    },
    async return(): Promise<IteratorResult<unknown, void>> {
      stop = true;
      return { done: true, value: undefined };
    },
  };
  return Object.assign(iter, {
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

test("Claude surfaces required MCP initialization failure and closes the query", async () => {
  const q = fakeQuery([
    { type: "system", subtype: "init", mcp_servers: [{ name: "files", status: "failed" }] },
  ]);
  let closed = false;
  const close = q.close;
  q.close = () => {
    closed = true;
    close();
  };
  __setClaudeSdk({ query: () => q as never });
  const session = await new ClaudeProvider().createSession({
    sessionId: "required-mcp",
    cwd: "/tmp",
    prompt: "go",
    mode: "default",
    mcpServers: [{ name: "files", required: true, spec: { transport: "stdio", command: "files" } }],
    loomServer: false,
  });
  try {
    const events: HarnessEvent[] = [];
    for await (const event of session.events()) events.push(event);
    assert.ok(closed);
    assert.ok(
      events.some(
        (event) =>
          event.type === "error" &&
          event.fatal &&
          /Required tools failed to connect: files/.test(event.message),
      ),
    );
  } finally {
    await session.close();
  }
});

test("C6: interrupt() denies a parked canUseTool and muzzles later calls without a new prompt", async () => {
  let canUse!: FakeCanUseTool;
  __setClaudeSdk({
    query: (args: unknown) => {
      canUse = (args as { options: { canUseTool: FakeCanUseTool } }).options.canUseTool;
      return fakeQuery() as never;
    },
  });

  const provider = new ClaudeProvider();
  const s = await provider.createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "go",
    mode: "default",
    mcpServers: [],
    loomServer: false,
  });

  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const ev of s.events()) seen.push(ev);
  })();

  // A tool call parks on the gate and raises a permission_request.
  const parked = canUse("Bash", { command: "ls" }, { toolUseID: "t1", requestId: "t1" });
  await delay(20);
  assert.ok(
    seen.some((e) => e.type === "permission_request"),
    "the parked call raised a permission_request",
  );

  // The interrupt must resolve that parked promise (as a deny) — not leave it
  // hanging until the stream ends.
  await s.interrupt();
  const first = await parked;
  assert.equal(first?.behavior, "deny", "interrupt released the parked gate as a deny");

  // A tool call unwinding from the SDK's own command queue *after* the interrupt
  // is denied outright, with no fresh permission_request pushed into the stopped
  // session.
  seen.length = 0;
  const later = await canUse("Edit", { path: "x" }, { toolUseID: "t2", requestId: "t2" });
  assert.equal(later?.behavior, "deny");
  assert.equal(later?.message, "session interrupted");
  assert.ok(
    !seen.some((e) => e.type === "permission_request"),
    "no permission_request after the interrupt",
  );

  await s.close();
  await reader;
});

test("C1: rewind() resumes with the live model / mode, not the frozen start opts", async () => {
  const queryOpts: Array<Record<string, unknown>> = [];
  __setClaudeSdk({
    query: (args: unknown) => {
      const opts = (args as { options: Record<string, unknown> }).options;
      queryOpts.push(opts);
      return fakeQuery(
        queryOpts.length === 1
          ? [
              {
                type: "system",
                subtype: "init",
                session_id: "claude-src",
                model: "claude-sonnet-5",
              },
              {
                type: "assistant",
                parent_tool_use_id: null,
                uuid: "u-1",
                message: { content: [] },
              },
              { type: "result", subtype: "success", is_error: false, num_turns: 1, modelUsage: {} },
            ]
          : [],
      ) as never;
    },
    forkSession: async () => ({ sessionId: "claude-forked" }),
  });

  const provider = new ClaudeProvider();
  const s = await provider.createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "go",
    mode: "default",
    model: "claude-sonnet-5",
    mcpServers: [],
    loomServer: false,
  });
  const reader = (async () => {
    for await (const _ev of s.events()) void _ev;
  })();
  await delay(60); // let the seeded init / result frames land (providerRef, rewindRef)

  await s.setModel("claude-opus-5");
  await s.setMode("acceptEdits");
  await s.rewind(0, "u-1");

  assert.equal(queryOpts.length, 2, "the query was rebuilt for the resumed fork");
  assert.equal(queryOpts[1]?.["resume"], "claude-forked");
  assert.equal(
    queryOpts[1]?.["model"],
    "claude-opus-5",
    "resumed with the model set live, not the creation-time one",
  );
  assert.equal(queryOpts[1]?.["permissionMode"], "acceptEdits", "resumed with the mode set live");

  await s.close();
  await reader;
});

// ---------------------------------------------------------------------------
// compaction tracking
// ---------------------------------------------------------------------------

/** A `Query` stand-in whose message stream can be fed while the session runs —
 *  unlike `fakeQuery`, whose frames are all seeded up front. */
const fakeLiveQuery = () => {
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
    push: (m: unknown): void => {
      queue.push(m);
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

/** A live session over `fakeLiveQuery`, with its event stream collected. The
 *  session is torn down via `t.after` so a failing assertion can't leave the
 *  `fakeLiveQuery` poll loop (or the event reader) spinning and wedge the run. */
const setupLive = async (
  t: TestContext,
  configure: (q: ReturnType<typeof fakeLiveQuery>) => void = () => {},
) => {
  let q!: ReturnType<typeof fakeLiveQuery>;
  __setClaudeSdk({
    query: () => {
      q = fakeLiveQuery();
      configure(q);
      return q as never;
    },
  });
  const provider = new ClaudeProvider();
  const s = await provider.createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "go",
    mode: "default",
    mcpServers: [],
    loomServer: false,
  });
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const ev of s.events()) seen.push(ev);
  })();
  t.after(async () => {
    await s.close();
    await reader.catch(() => {});
  });
  return { s, q: q as ReturnType<typeof fakeLiveQuery>, seen, reader };
};

const beats = (seen: HarnessEvent[]) =>
  seen.filter(
    (e): e is Extract<HarnessEvent, { type: "compact_progress" }> => e.type === "compact_progress",
  );

test("context capacity arrives before a completed turn and ignores stale model polls", async (t) => {
  const polls: ((report: { rawMaxTokens: number; maxTokens: number }) => void)[] = [];
  let q!: ReturnType<typeof fakeLiveQuery>;
  __setClaudeSdk({
    query: () => {
      q = fakeLiveQuery();
      return Object.assign(q, {
        getContextUsage: () => new Promise((resolve) => polls.push(resolve)),
      }) as never;
    },
  });
  const s = await new ClaudeProvider().createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "go",
    mode: "default",
    mcpServers: [],
    loomServer: false,
  });
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const e of s.events()) seen.push(e);
  })();
  t.after(async () => {
    await s.close();
    await reader;
  });
  await delay(20);
  assert.equal(polls.length, 1, "startup asks for capacity without waiting for a result");
  q.push({ type: "assistant", message: { content: [], usage: { input_tokens: 44_400 } } });
  await delay(20);
  polls[0]!({ rawMaxTokens: 200_000, maxTokens: 180_000 });
  await delay(10);
  assert.equal(s.snapshot().contextLimit, 200_000);
  assert.equal(s.snapshot().contextUsed, 44_400, "capacity lookup preserves live usage");
  assert.ok(
    seen.some(
      (e) => e.type === "context" && e.contextLimit === 200_000 && e.contextUsed === 44_400,
    ),
  );

  await s.setModel("opus");
  await s.setModel("sonnet");
  polls[2]!({ rawMaxTokens: 1_000_000, maxTokens: 900_000 });
  await delay(10);
  polls[1]!({ rawMaxTokens: 200_000, maxTokens: 180_000 });
  await delay(10);
  assert.equal(
    s.snapshot().contextLimit,
    1_000_000,
    "an older model lookup cannot overwrite the current one",
  );
  await s.setModel("sonnet");
  polls[3]!({ rawMaxTokens: 0, maxTokens: 0 });
  await delay(10);
  assert.equal(
    s.snapshot().contextLimit,
    1_000_000,
    "an unavailable report does not erase a known limit",
  );
});

test("interrupt stops foreground, detached, nested and late Claude tasks", async (t) => {
  const stopped: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { s, q } = await setupLive(t, (q) => {
    q.interrupt = async () => {
      await gate;
      return { still_queued: [] };
    };
    Object.assign(q, {
      stopTask: async (id: string) => {
        stopped.push(id);
      },
    });
  });
  q.push({
    type: "system",
    subtype: "task_started",
    task_id: "foreground",
    is_backgrounded: false,
  });
  q.push({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "detached", task_type: "local_agent", description: "child" }],
  });
  await delay(20);
  const first = s.interrupt();
  const second = s.interrupt();
  assert.equal(first, second, "repeat interrupts coalesce");
  await assert.rejects(s.send("more"), /cancellation is unresolved/);
  q.push({ type: "system", subtype: "task_started", task_id: "nested", spawn_depth: 2 });
  await delay(20);
  release();
  await first;
  assert.deepEqual(stopped.sort(), ["detached", "foreground", "nested"]);
  q.push({ type: "system", subtype: "task_started", task_id: "late" });
  await delay(20);
  assert.ok(stopped.includes("late"));
  await s.send("continue");
  q.push({ type: "system", subtype: "task_started", task_id: "new-turn" });
  await delay(20);
  assert.ok(!stopped.includes("new-turn"), "new work is not cancelled by the old interrupt");
});

test("partial Claude task cancellation rejects and can be retried", async (t) => {
  const attempts: string[] = [];
  let fail = true;
  const { s, q } = await setupLive(t, (q) => {
    Object.assign(q, {
      stopTask: async (id: string) => {
        attempts.push(id);
        if (id === "bad" && fail) throw new Error("stop rejected");
      },
    });
  });
  for (const id of ["good", "bad"])
    q.push({ type: "system", subtype: "task_started", task_id: id });
  await delay(20);
  await assert.rejects(s.interrupt(), /cancellation incomplete.*bad/);
  assert.deepEqual(attempts.sort(), ["bad", "good"]);
  await assert.rejects(s.send("more"), /cancellation is unresolved/);
  fail = false;
  await s.interrupt();
  assert.equal(attempts.filter((id) => id === "good").length, 1);
  assert.equal(attempts.filter((id) => id === "bad").length, 2);
  await s.send("continue");
});

test("child cancellation runs even if the parent interrupt fails", async (t) => {
  let stopped = false;
  const { s, q } = await setupLive(t, (q) => {
    q.interrupt = async () => {
      throw new Error("parent interrupt failed");
    };
    Object.assign(q, {
      stopTask: async () => {
        stopped = true;
      },
    });
  });
  q.push({ type: "system", subtype: "task_started", task_id: "child" });
  await delay(20);
  await assert.rejects(s.interrupt(), /parent interrupt failed/);
  assert.equal(stopped, true);
});

test("an older Claude runtime cannot silently ignore child cancellation", async (t) => {
  const { s, q } = await setupLive(t);
  q.push({ type: "system", subtype: "task_started", task_id: "child" });
  await delay(20);
  await assert.rejects(s.interrupt(), /does not support stopping tasks/);
});

test("queued turns surviving Claude interrupt are reported as incomplete cancellation", async (t) => {
  const { s } = await setupLive(t, (q) => {
    q.interrupt = async () => ({ still_queued: ["queued-turn"] });
  });
  await assert.rejects(s.interrupt(), /still has 1 queued turn/);
  await assert.rejects(s.send("more"), /cancellation is unresolved/);
});

test("a task completing while its stop request fails is already cancelled", async (t) => {
  let reject!: (err: Error) => void;
  const { s, q } = await setupLive(t, (q) => {
    Object.assign(q, {
      stopTask: () =>
        new Promise<void>((_resolve, r) => {
          reject = r;
        }),
    });
  });
  q.push({ type: "system", subtype: "task_started", task_id: "finished" });
  await delay(20);
  const stopped = s.interrupt();
  await delay(10);
  q.push({
    type: "system",
    subtype: "task_notification",
    task_id: "finished",
    status: "completed",
  });
  await delay(20);
  reject(new Error("task no longer exists"));
  await stopped;
});

test("compact() holds until the compact_boundary lands, beating compact_progress meanwhile", async (t) => {
  const { s, q, seen, reader } = await setupLive(t);
  // Establish a context estimate so the beats carry a real `before`.
  q.push({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "u-1",
    message: { content: [], usage: { input_tokens: 40_000, cache_read_input_tokens: 50_000 } },
  });
  await delay(30);

  let settled = false;
  const done = s.compact().then(() => {
    settled = true;
  });
  await delay(50);
  assert.ok(!settled, "compact() must not resolve before the boundary lands");
  assert.ok(beats(seen).length >= 1, "expected an immediate compact_progress beat");
  assert.equal(beats(seen)[0]?.before, 90_000, "the beat carries the pre-compact context estimate");

  q.push({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 90_000, post_tokens: 8_000 },
  });
  const outcome = await Promise.race([
    done.then(() => "settled" as const),
    delay(3_000).then(() => "hung" as const),
  ]);
  assert.equal(outcome, "settled", "the boundary releases the compact wait");
  assert.ok(
    seen.some((e) => e.type === "compact"),
    "the boundary reached the event stream",
  );
  const atSettle = beats(seen).length;
  await delay(60);
  assert.equal(beats(seen).length, atSettle, "beats stop once the boundary lands");

  await s.close();
  await reader;
});

test("implement fresh replaces the planning query before applying the selected settings", async (t) => {
  const calls: {
    prompt: AsyncIterable<{ message?: { content?: string } }>;
    options: Record<string, unknown> & { canUseTool: FakeCanUseTool };
  }[] = [];
  const queries: ReturnType<typeof fakeLiveQuery>[] = [];
  const inputs: string[][] = [];
  let oldClosed = false;
  __setClaudeSdk({
    query: (args: unknown) => {
      const request = args as (typeof calls)[number];
      if (calls.length) assert.ok(oldClosed, "old query must close before starting implementation");
      calls.push(request);
      const received: string[] = [];
      inputs.push(received);
      void (async () => {
        for await (const input of request.prompt) received.push(input.message?.content ?? "");
      })();
      const q = fakeLiveQuery();
      if (!queries.length) {
        const close = q.close;
        q.close = () => {
          oldClosed = true;
          q.push({
            type: "assistant",
            message: { content: [{ type: "text", text: "stale implementation" }] },
          });
          close();
        };
      }
      queries.push(q);
      return q as never;
    },
  });
  const s = await new ClaudeProvider().createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "plan this",
    model: "opus",
    mode: "plan",
    mcpServers: [],
    loomServer: false,
  });
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const event of s.events()) seen.push(event);
  })();
  t.after(async () => {
    await s.close();
    await reader;
  });
  const canUse = calls[0]!.options.canUseTool;
  const review = canUse("ExitPlanMode", { plan: "the approved plan" }, { toolUseID: "p1" });
  await s.respondToPlan("p1", {
    action: "implement_fresh",
    mode: "auto",
    model: "sonnet",
    effort: "high",
  });
  assert.equal((await review)?.behavior, "deny");
  await delay(20);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.options.model, "sonnet");
  assert.equal(calls[1]!.options.permissionMode, "auto");
  assert.equal(calls[1]!.options.effort, "high");
  assert.equal(calls[1]!.options.resume, undefined);
  assert.equal(calls[1]!.options.cwd, "/tmp");
  assert.deepEqual(inputs[0], ["plan this"]);
  assert.equal(inputs[1]?.length, 1);
  assert.match(inputs[1]![0]!, /Original goal: plan this/);
  assert.match(inputs[1]![0]!, /the approved plan/);
  assert.equal(s.snapshot().mode, "auto");
  assert.equal(s.snapshot().model, "sonnet");
  assert.ok(
    !seen.some(
      (e) => e.type === "error" || e.type === "compact_progress" || e.type === "assistant_text",
    ),
  );
  assert.ok(
    seen.some((e) => e.type === "compact"),
    "discarded transcript checkpoints are invalidated",
  );
  await s.respondToPlan("p1", { action: "implement_fresh" });
  assert.equal(calls.length, 2, "duplicate approval cannot start another implementation");
});

for (const stop of ["interrupt", "close"] as const) {
  test(`implement fresh does not restart after ${stop} during teardown`, async (t) => {
    let canUse!: FakeCanUseTool;
    let queries = 0;
    __setClaudeSdk({
      query: (args: unknown) => {
        queries++;
        canUse = (args as { options: { canUseTool: FakeCanUseTool } }).options.canUseTool;
        return fakeLiveQuery() as never;
      },
    });
    const s = await new ClaudeProvider().createSession({
      sessionId: "c1",
      cwd: "/tmp",
      prompt: "plan this",
      mode: "plan",
      mcpServers: [],
      loomServer: false,
    });
    t.after(() => s.close());
    const review = canUse("ExitPlanMode", { plan: "the plan" }, { toolUseID: "p1" });
    const changing = s.respondToPlan("p1", { action: "implement_fresh", mode: "auto" });
    await s[stop]();
    await changing;
    await review;
    assert.equal(queries, 1, "stopping must not launch an implementation query");
  });
}

test("a fresh query startup failure reaches the caller and closes the event stream", async (t) => {
  let canUse!: FakeCanUseTool;
  let queries = 0;
  __setClaudeSdk({
    query: (args: unknown) => {
      if (queries++) throw new Error("startup failed");
      canUse = (args as { options: { canUseTool: FakeCanUseTool } }).options.canUseTool;
      return fakeLiveQuery() as never;
    },
  });
  const s = await new ClaudeProvider().createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "plan this",
    mode: "plan",
    mcpServers: [],
    loomServer: false,
  });
  t.after(() => s.close());
  const seen: HarnessEvent[] = [];
  const reader = (async () => {
    for await (const e of s.events()) seen.push(e);
  })();
  const review = canUse("ExitPlanMode", { plan: "the plan" }, { toolUseID: "p1" });
  await assert.rejects(s.respondToPlan("p1", { action: "implement_fresh" }), /startup failed/);
  await review;
  await reader;
  assert.ok(
    seen.some((e) => e.type === "error" && e.fatal && e.message.includes("startup failed")),
  );
  assert.ok(!seen.some((e) => e.type === "compact_progress"));
});

test("a failed turn without a boundary releases the compact wait", async (t) => {
  const { s, q, seen, reader } = await setupLive(t);
  const done = s.compact();
  await delay(30);
  q.push({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    num_turns: 1,
    errors: ["boom"],
  });
  const outcome = await Promise.race([
    done.then(() => "settled" as const),
    delay(3_000).then(() => "hung" as const),
  ]);
  assert.equal(outcome, "settled", "a failed turn ends the compaction wait");
  // The wait releases a tick before the reader drains the mapped events.
  await delay(20);
  assert.ok(
    seen.some((e) => e.type === "result" && e.kind === "error"),
    "the mapper surfaced the failed turn",
  );
  await s.close();
  await reader;
});

test("interrupt() abandons an in-flight compaction and releases the wait", async (t) => {
  const { s, q, seen, reader } = await setupLive(t);
  const done = s.compact();
  await delay(30);
  await s.interrupt();
  const outcome = await Promise.race([
    done.then(() => "settled" as const),
    delay(3_000).then(() => "hung" as const),
  ]);
  assert.equal(outcome, "settled", "interrupt releases the compaction wait");
  assert.ok(
    seen.some((e) => e.type === "error" && !e.fatal && e.message.includes("compaction abandoned")),
    "clients get an abandon error to clear the compacting indicator",
  );
  // A late boundary (the aborted turn unwinding) must not resume the beats.
  q.push({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 90_000, post_tokens: 8_000 },
  });
  await delay(40);
  assert.equal(beats(seen).length, 1, "no beats resume after the abandon");

  await s.close();
  await reader;
});

// ---------------------------------------------------------------------------
// out-of-worktree write guard (auto mode)
// ---------------------------------------------------------------------------

const ROOT = "/home/user/dev/loom/.loom/trees/abc123";

test("outOfTreeWriteReason: flags a write rooted at the wrong checkout", () => {
  // Absolute path into the main checkout — the classic drift.
  assert.match(
    outOfTreeWriteReason(ROOT, ROOT, "Edit", {
      file_path: "/home/user/dev/loom/frontend/tui/src/components.tsx",
    }) ?? "",
    /outside this session's worktree/,
  );
  // A relative path resolves against the tool's live cwd, not the root.
  assert.ok(outOfTreeWriteReason(ROOT, "/home/user/dev/loom", "Write", { file_path: "README.md" }));
  // `..` climbing out.
  assert.ok(outOfTreeWriteReason(ROOT, ROOT, "MultiEdit", { file_path: "../xyz/f.ts" }));
  assert.ok(outOfTreeWriteReason(ROOT, ROOT, "NotebookEdit", { notebook_path: "/etc/nb.ipynb" }));
  // tilth MCP write tools: the drift vector is a `root` off the wrong checkout.
  assert.ok(
    outOfTreeWriteReason(ROOT, ROOT, "mcp__tilth__tilth_write", {
      root: "/home/user/dev/loom",
      path: "frontend/tui/src/components.tsx",
    }),
  );
  assert.ok(
    outOfTreeWriteReason(ROOT, ROOT, "mcp__tilth__tilth_edit", {
      path: "/home/user/dev/loom/x.ts",
    }),
  );
});

test("outOfTreeWriteReason: leaves in-tree writes and non-write tools alone", () => {
  assert.equal(outOfTreeWriteReason(ROOT, ROOT, "Edit", { file_path: `${ROOT}/a/b.ts` }), null);
  assert.equal(outOfTreeWriteReason(ROOT, ROOT, "Write", { file_path: "src/b.ts" }), null);
  assert.equal(outOfTreeWriteReason(ROOT, `${ROOT}/src`, "Edit", { file_path: "b.ts" }), null);
  // tilth with an in-tree root + relative path.
  assert.equal(
    outOfTreeWriteReason(ROOT, ROOT, "mcp__tilth__tilth_write", { root: ROOT, path: "a/b.ts" }),
    null,
  );
  // A sibling dir that shares the root as a string prefix is still outside.
  assert.ok(outOfTreeWriteReason(ROOT, ROOT, "Edit", { file_path: `${ROOT}-scratch/b.ts` }));
  // Not a file-mutating tool (tilth reads included), or no checkable path.
  assert.equal(outOfTreeWriteReason(ROOT, ROOT, "Bash", { command: "rm -rf /" }), null);
  assert.equal(
    outOfTreeWriteReason(ROOT, ROOT, "mcp__tilth__tilth_view", { root: "/elsewhere" }),
    null,
  );
  assert.equal(outOfTreeWriteReason(ROOT, ROOT, "Edit", {}), null);
});

test("outOfTreeWriteReason: lets through the roots that are writable anyway", () => {
  const allowed = allowedWriteRoots("/home/user/.claude-work");
  // Temp scratch and this session's `claude` profile dir — both outside the
  // tree by construction, both routine writes.
  assert.equal(
    outOfTreeWriteReason(ROOT, ROOT, "Write", { file_path: "/tmp/x.json" }, allowed),
    null,
  );
  assert.equal(
    outOfTreeWriteReason(ROOT, ROOT, "Edit", { file_path: `${tmpdir()}/deep/x.json` }, allowed),
    null,
  );
  assert.equal(
    outOfTreeWriteReason(
      ROOT,
      ROOT,
      "mcp__tilth__tilth_write",
      { path: "/home/user/.claude-work/memory/a.md" },
      allowed,
    ),
    null,
  );
  // The default profile dir, when the connector pins none.
  assert.equal(
    outOfTreeWriteReason(
      ROOT,
      ROOT,
      "Write",
      { file_path: `${homedir()}/.claude/settings.json` },
      allowedWriteRoots(),
    ),
    null,
  );
  // A pinned profile dir does not drag the default one along with it.
  assert.ok(
    outOfTreeWriteReason(ROOT, ROOT, "Write", { file_path: `${homedir()}/.claude/x` }, allowed),
  );
  // Everything else outside the tree still prompts — including a prefix match.
  assert.ok(outOfTreeWriteReason(ROOT, ROOT, "Write", { file_path: "/etc/passwd" }, allowed));
  assert.ok(outOfTreeWriteReason(ROOT, ROOT, "Write", { file_path: "/tmpfoo/x" }, allowed));
});

type FakeHook = (input: unknown) => Promise<{
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}>;

const captureHook = async (mode: "auto" | "default") => {
  let options!: { hooks?: { PreToolUse?: Array<{ hooks: FakeHook[] }> } };
  __setClaudeSdk({
    query: (args: unknown) => {
      options = (args as { options: typeof options }).options;
      return fakeQuery() as never;
    },
  });
  const s = await new ClaudeProvider().createSession({
    sessionId: "c1",
    cwd: ROOT,
    prompt: "go",
    mode,
    mcpServers: [],
    loomServer: false,
  });
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook, "a PreToolUse hook is registered");
  return { s, hook };
};

const preToolUse = (tool: string, input: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse" as const,
  tool_name: tool,
  tool_input: input,
  cwd: ROOT,
});

test("auto mode: the PreToolUse hook forces an ask for an out-of-worktree edit", async () => {
  const { s, hook } = await captureHook("auto");
  const out = await hook(
    preToolUse("Edit", { file_path: "/home/user/dev/loom/frontend/tui/src/components.tsx" }),
  );
  assert.equal(out.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(
    out.hookSpecificOutput?.permissionDecisionReason ?? "",
    /outside this session's worktree/,
  );

  // In-tree edits and non-write tools are untouched.
  assert.deepEqual(await hook(preToolUse("Edit", { file_path: `${ROOT}/a.ts` })), {});
  assert.deepEqual(await hook(preToolUse("Read", { file_path: "/etc/hosts" })), {});
  await s.close();
});

test("non-auto modes: the hook defers (every other mode already prompts)", async () => {
  const { s, hook } = await captureHook("default");
  assert.deepEqual(await hook(preToolUse("Edit", { file_path: "/home/user/dev/loom/x.ts" })), {});
  await s.close();
});

test("the guard tracks a live setMode into auto", async () => {
  const { s, hook } = await captureHook("default");
  const outside = preToolUse("Write", { file_path: "/home/user/dev/loom/x.ts" });
  assert.deepEqual(await hook(outside), {}, "default: deferred");
  await s.setMode("auto");
  assert.equal(
    (await hook(outside)).hookSpecificOutput?.permissionDecision,
    "ask",
    "auto: now guarded",
  );
  await s.close();
});

test("interruption blocks auto-approved tools from surviving queued turns", async () => {
  const { s, hook } = await captureHook("auto");
  try {
    await s.interrupt();
    for (const tool of ["Bash", "Write", "Agent"])
      assert.equal(
        (await hook(preToolUse(tool, {}))).hookSpecificOutput?.permissionDecision,
        "deny",
      );
  } finally {
    await s.close();
  }
});

test("resumeSession forwards the ref's systemPromptAppend into the CLI's systemPrompt option", async () => {
  const queryOpts: Array<Record<string, unknown>> = [];
  __setClaudeSdk({
    query: (args: unknown) => {
      queryOpts.push((args as { options: Record<string, unknown> }).options);
      return fakeQuery() as never;
    },
  });

  const provider = new ClaudeProvider();
  const s = await provider.resumeSession({
    sessionId: "c1",
    providerRef: "claude-src",
    cwd: "/tmp",
    systemPromptAppend: "resumed-instructions-marker",
  });

  assert.deepEqual(queryOpts[0]?.["systemPrompt"], {
    type: "preset",
    preset: "claude_code",
    append: "resumed-instructions-marker",
  });
  await s.close();
});

test("setEffort rejects a value the CLI's live flag settings don't support, without touching the query", async () => {
  let applied: unknown;
  __setClaudeSdk({
    query: () =>
      Object.assign(fakeQuery(), {
        applyFlagSettings: async (settings: unknown) => {
          applied = settings;
        },
      }) as never,
  });

  const provider = new ClaudeProvider();
  const s = await provider.createSession({
    sessionId: "c1",
    cwd: "/tmp",
    prompt: "go",
    mode: "default",
    mcpServers: [],
    loomServer: false,
  });

  await s.setEffort("high");
  assert.deepEqual(applied, { effortLevel: "high" });

  await assert.rejects(() => s.setEffort("minimal"), /does not support live effort changes/);
  assert.deepEqual(
    applied,
    { effortLevel: "high" },
    "the unsupported value must never reach the CLI",
  );

  await s.close();
});
