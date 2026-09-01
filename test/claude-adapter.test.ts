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

/** A `Query` stand-in: an async iterator that idles until `close()`, plus the
 *  control methods the adapter calls. No generator (keeps oxlint happy). */
const fakeQuery = () => {
  let stop = false;
  const iter = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next(): Promise<IteratorResult<never, void>> {
      while (!stop) await delay(15);
      return { done: true, value: undefined };
    },
    async return(): Promise<IteratorResult<never, void>> {
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
