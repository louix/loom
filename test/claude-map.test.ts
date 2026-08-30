import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeEventMapper } from "@loom/connector-claude/map";
import type { HarnessEvent } from "@loom/core/events";

const SID = "loom-1";

function byType<T extends HarnessEvent["type"]>(
  evs: HarnessEvent[],
  type: T,
): Extract<HarnessEvent, { type: T }>[] {
  return evs.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);
}

test("init captures the provider ref and model but emits nothing", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "system",
    subtype: "init",
    session_id: "claude-abc",
    model: "claude-sonnet-5",
  });
  assert.deepEqual(out, []);
  assert.equal(m.state.providerRef, "claude-abc");
  assert.equal(m.state.model, "claude-sonnet-5");
});

test("assistant message splits into text / thinking / tool_call, carrying agentId", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "assistant",
    parent_tool_use_id: "task-7",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
  assert.equal(out.length, 3);
  assert.equal(out[0]?.type, "thinking");
  assert.equal(byType(out, "assistant_text")[0]?.text, "hello");
  const call = byType(out, "tool_call")[0];
  assert.equal(call?.name, "Bash");
  assert.deepEqual(call?.input, { command: "ls" });
  assert.equal(call?.agentId, "task-7");
});

test("assistant error field becomes a non-fatal error event", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "assistant",
    parent_tool_use_id: null,
    error: "rate_limit",
    message: { content: [] },
  });
  const err = byType(out, "error")[0];
  assert.ok(err);
  assert.equal(err.fatal, false);
  assert.match(err.message, /rate_limit/);
});

test("user tool_result blocks normalize with ok reflecting is_error", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "ok", is_error: false },
        { type: "tool_result", tool_use_id: "tu-2", content: "boom", is_error: true },
      ],
    },
  });
  const results = byType(out, "tool_result");
  assert.equal(results.length, 2);
  assert.equal(results[0]?.id, "tu-1");
  assert.equal(results[0]?.ok, true);
  assert.equal(results[1]?.ok, false);
});

test("result success emits a usage delta then a result; state goes cumulative", () => {
  const m = new ClaudeEventMapper(SID);
  m.map({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 },
    },
  });
  const out = m.map({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 0,
        costUSD: 0.02,
        contextWindow: 200000,
      },
    },
  });
  const usage = byType(out, "usage")[0];
  assert.ok(usage);
  assert.deepEqual(usage.tokens, { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0 });
  assert.equal(usage.contextUsed, 1050);
  assert.equal(usage.contextLimit, 200000);
  assert.equal(usage.costDeltaUsd, 0.02);

  const res = byType(out, "result")[0];
  assert.equal(res?.ok, true);
  assert.equal(res?.summary, "done");
  assert.equal(m.state.turns, 1);
  assert.equal(m.state.costUsd, 0.02);
});

test("contextUsed tracks the last single request, not the turn's cumulative usage", () => {
  // A turn that drives several internal tool-calling round trips reports a
  // `result.usage` that sums every one of those calls — many times the real
  // context window. contextUsed must follow the last individual request.
  const m = new ClaudeEventMapper(SID);
  m.map({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [], usage: { input_tokens: 900_000, cache_read_input_tokens: 0 } },
  });
  m.map({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [], usage: { input_tokens: 5_000, cache_read_input_tokens: 950_000 } },
  });
  // A subagent call in between must not clobber the main loop's context fill.
  m.map({
    type: "assistant",
    parent_tool_use_id: "task-1",
    message: { content: [], usage: { input_tokens: 4_000_000, cache_read_input_tokens: 0 } },
  });
  const out = m.map({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    usage: { input_tokens: 4_905_000, cache_read_input_tokens: 950_000 },
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 4_905_000,
        cacheReadInputTokens: 950_000,
        contextWindow: 1_000_000,
      },
    },
  });
  const usage = byType(out, "usage")[0];
  assert.equal(usage?.contextUsed, 955_000);
});

test("a second turn's usage is the delta over cumulative, not the running total", () => {
  const m = new ClaudeEventMapper(SID);
  m.map({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "t1",
    num_turns: 1,
    usage: { input_tokens: 1000 },
    modelUsage: {
      x: { inputTokens: 1000, outputTokens: 100, costUSD: 0.01, contextWindow: 200000 },
    },
  });
  const out = m.map({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "t2",
    num_turns: 2,
    usage: { input_tokens: 1500 },
    // cumulative totals across the query() call
    modelUsage: {
      x: { inputTokens: 2500, outputTokens: 260, costUSD: 0.028, contextWindow: 200000 },
    },
  });
  const usage = byType(out, "usage")[0];
  assert.equal(usage?.tokens.input, 1500);
  assert.equal(usage?.tokens.output, 160);
  assert.ok(Math.abs((usage?.costDeltaUsd ?? 0) - 0.018) < 1e-9);
  assert.equal(m.state.turns, 2);
});

test("result error emits an error and a failed result", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 12,
    errors: ["hit the turn cap"],
    usage: { input_tokens: 10 },
    modelUsage: {},
  });
  assert.equal(byType(out, "error")[0]?.message.includes("hit the turn cap"), true);
  const res = byType(out, "result")[0];
  assert.equal(res?.ok, false);
});

test("a Task tool_use raises subagent_started; its tool_result raises subagent_stopped", () => {
  const m = new ClaudeEventMapper(SID);
  const started = m.map({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_use",
          id: "task-1",
          name: "Task",
          input: { subagent_type: "code-reviewer", description: "review the diff" },
        },
      ],
    },
  });
  assert.equal(byType(started, "tool_call").length, 1);
  const sub = byType(started, "subagent_started")[0];
  assert.equal(sub?.subagentId, "task-1");
  assert.equal(sub?.name, "code-reviewer");

  // an unrelated tool_result doesn't stop it
  const other = m.map({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "bash-9", content: "ok" }] },
  });
  assert.equal(byType(other, "subagent_stopped").length, 0);

  const stopped = m.map({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "task-1", content: "looks good" }] },
  });
  assert.equal(byType(stopped, "tool_result").length, 1);
  assert.equal(byType(stopped, "subagent_stopped")[0]?.subagentId, "task-1");

  // stopping twice doesn't double-fire
  const again = m.map({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "task-1", content: "x" }] },
  });
  assert.equal(byType(again, "subagent_stopped").length, 0);
});

test("a compact_boundary system message becomes a compact event", () => {
  const m = new ClaudeEventMapper(SID);
  m.map({ type: "system", subtype: "init", session_id: "c1", model: "claude-sonnet-5" });
  const out = m.map({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 154000 },
  });
  const c = byType(out, "compact")[0];
  assert.ok(c);
  assert.equal(c.trigger, "manual");
  assert.equal(c.before, 154000);
  assert.equal(c.after, 0);
});

test("compact_boundary with post_tokens updates the mapper's context estimate", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 180000, post_tokens: 30000 },
    summary: "kept the plan",
  });
  const c = byType(out, "compact")[0];
  assert.equal(c?.trigger, "auto");
  assert.equal(c?.after, 30000);
  assert.equal(c?.summary, "kept the plan");
  assert.equal(m.state.contextUsed, 30000);
});

test("a rate_limit_event becomes a rate_limit event", () => {
  const m = new ClaudeEventMapper(SID);
  const out = m.map({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 82,
      resetsAt: 12345,
    },
  });
  const ev = byType(out, "rate_limit")[0];
  assert.ok(ev);
  assert.equal(ev.status, "allowed_warning");
  assert.equal(ev.window, "five_hour");
  assert.equal(ev.utilization, 82);
  assert.equal(ev.resetsAt, 12345);
});

test("a rate_limit_event with no info maps to nothing", () => {
  const m = new ClaudeEventMapper(SID);
  assert.deepEqual(m.map({ type: "rate_limit_event" }), []);
});

test("stream_event and unknown messages map to nothing", () => {
  const m = new ClaudeEventMapper(SID);
  assert.deepEqual(m.map({ type: "stream_event", event: {} }), []);
  assert.deepEqual(m.map({ type: "tool_progress", tool_name: "Bash" }), []);
});
