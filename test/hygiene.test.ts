import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { ChildStore } from "@loom/daemon/store/sessions";
import { pidAlive } from "@loom/daemon/daemon/hygiene";
import { makeHarness, type Harness } from "@loom/harness";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

function client(): Promise<LoomClient> {
  return LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
}

test("a daemon restart flips mid-run sessions to interrupted", async () => {
  const c1 = await client();
  const running = await c1.request<SessionSnapshot>("session.createStub", { prompt: "r", status: "running" });
  const awaiting = await c1.request<SessionSnapshot>("session.createStub", {
    prompt: "a",
    status: "awaiting_input",
    reason: "permission",
  });
  const idle = await c1.request<SessionSnapshot>("session.createStub", { prompt: "i", status: "idle" });
  await c1.close();

  await h.restart();

  const c2 = await client();
  const list = await c2.request<SessionSnapshot[]>("session.list");
  const byId = new Map(list.map((s) => [s.id, s]));
  assert.equal(byId.get(running.id)?.status, "interrupted");
  assert.equal(byId.get(awaiting.id)?.status, "interrupted");
  assert.equal(byId.get(idle.id)?.status, "idle");

  const hist = await c2.request<Array<{ status: string; reason: string | null }>>("session.history", {
    id: running.id,
  });
  assert.equal(hist.at(-1)?.status, "interrupted");
  assert.equal(hist.at(-1)?.reason, "daemon_restart");
  await c2.close();
});

test("startup hygiene terminates a live child from a previous daemon epoch", async () => {
  // A real, long-lived process standing in for a leaked Claude CLI child.
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  await delay(50);
  assert.ok(victim.pid && pidAlive(victim.pid));

  const children = new ChildStore(h.daemon.db);
  children.record(victim.pid, "claude-cli", "epoch-from-the-past");
  children.record(999_999, "mcp:tilth", "epoch-from-the-past"); // already-dead pid

  await h.restart();

  // hygiene SIGTERMs the victim and drops both bookkeeping rows.
  for (let i = 0; i < 50 && pidAlive(victim.pid!); i++) await delay(20);
  assert.equal(pidAlive(victim.pid!), false, "stale child should have been terminated");

  const after = new ChildStore(h.daemon.db).all();
  assert.equal(after.length, 0, "stale child rows should be cleared");

  if (victim.pid && pidAlive(victim.pid)) victim.kill("SIGKILL");
});

test("hygiene report is exposed on daemon.status", async () => {
  const c = await client();
  const s = await c.request<{ hygiene: { interruptedSessions: string[]; worktreePruned: boolean } }>(
    "daemon.status",
  );
  assert.ok(s.hygiene);
  assert.ok(Array.isArray(s.hygiene.interruptedSessions));
  await c.close();
});
