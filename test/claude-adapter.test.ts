import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessEvent } from "@loom/core/events";
import { ClaudeProvider, __setClaudeSdk } from "@loom/connector-claude/adapter";
import { setLogLevel } from "@loom/core/logger";

setLogLevel("error");

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
              { type: "system", subtype: "init", session_id: "claude-src", model: "claude-sonnet-5" },
              { type: "assistant", parent_tool_use_id: null, uuid: "u-1", message: { content: [] } },
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
  assert.equal(
    queryOpts[1]?.["permissionMode"],
    "acceptEdits",
    "resumed with the mode set live",
  );

  await s.close();
  await reader;
});
