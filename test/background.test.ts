import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BackgroundTasks, backgroundTools } from "@loom/aisdk/tools/background";

const dir = mkdtempSync(join(tmpdir(), "loom-bg-"));
const spawned: BackgroundTasks[] = [];
const spawnTasks = (cwd = dir): BackgroundTasks => {
  const t = new BackgroundTasks(cwd);
  spawned.push(t);
  return t;
};

afterEach(() => {
  while (spawned.length > 0) spawned.pop()!.close();
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("background: start, read output, then read the exit", async () => {
  const bg = spawnTasks();
  const id = bg.start("echo hello");
  assert.match(id, /^bg-\d+$/);
  // The first read resolves on the output — the task may still be running.
  const r = await bg.read(id, { waitMs: 5_000 });
  assert.match(r.output, /hello/);
  // The next read waits out the exit and reports it; the cursor had reset.
  const final = await bg.read(id, { waitMs: 5_000 });
  assert.equal(final.running, false);
  assert.equal(final.exitCode, 0);
  assert.equal(final.timedOut, false);
  assert.equal(final.output, "(no new output)");
});

test("background: exit code propagates", async () => {
  const bg = spawnTasks();
  const id = bg.start("exit 3");
  const r = await bg.read(id, { waitMs: 5_000 });
  assert.equal(r.running, false);
  assert.equal(r.exitCode, 3);
});

test("background: timeout kills the task and marks timed_out", async () => {
  const bg = spawnTasks();
  const id = bg.start("sleep 30", 200);
  const r = await bg.read(id, { waitMs: 5_000 });
  assert.equal(r.running, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
});

test("background: timeout_ms 0 disables the timeout", async () => {
  const bg = spawnTasks();
  const id = bg.start("sleep 0.4", 0);
  const r = await bg.read(id, { waitMs: 5_000 });
  assert.equal(r.running, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.exitCode, 0);
});

test("background: kill stops the task", async () => {
  const bg = spawnTasks();
  const id = bg.start("sleep 30", 0);
  assert.equal(bg.kill(id).output, "(no output)");
  const r = await bg.read(id, { waitMs: 2_000 });
  assert.equal(r.running, false);
});

test("background: unread buffer is clamped and reports drops", async () => {
  const bg = spawnTasks();
  const id = bg.start("yes boom", 300);
  // Let it blast past the clamp unread; a read loop here would drain the pipe
  // in tiny increments and never trigger the live collapse.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const r = await bg.read(id);
  assert.equal(r.running, false);
  assert.equal(r.timedOut, true);
  assert.match(r.output, /dropped|truncated/);
});

test("background: filter keeps only matching lines", async () => {
  const bg = spawnTasks();
  const id = bg.start("printf 'foo\\nbar\\n'");
  const r = await bg.read(id, { waitMs: 5_000, filter: "foo" });
  assert.match(r.output, /^1 of 3 lines matched/);
  assert.match(r.output, /^foo$/m);
  assert.ok(!/^bar$/m.test(r.output));
});

test("background: invalid filter regex errors", async () => {
  const bg = spawnTasks();
  const id = bg.start("echo hi");
  await assert.rejects(() => bg.read(id, { waitMs: 5_000, filter: "(" }), /invalid filter/);
});

test("background: an explicit wait_ms is honored when nothing happens", async () => {
  const bg = spawnTasks();
  const id = bg.start("sleep 30", 0);
  const t0 = Date.now();
  const r = await bg.read(id, { waitMs: 300 });
  const elapsed = Date.now() - t0;
  assert.equal(r.running, true);
  assert.equal(r.output, "(no new output)");
  assert.ok(elapsed >= 250, `should have waited, took ${elapsed}ms`);
  assert.ok(elapsed < 5_000, `explicit wait_ms should be honored, took ${elapsed}ms`);
});

test("background: wait_ms accepts waits beyond the old 30 s cap", () => {
  const bg = spawnTasks();
  const schema = backgroundTools(bg).background_output!.inputSchema as z.ZodType;
  // A full day must validate — the schema must not clamp wait_ms (the read
  // itself ends early on new output or exit regardless of the value).
  assert.deepEqual(schema.parse({ id: "bg-1", wait_ms: 86_400_000 }), {
    id: "bg-1",
    wait_ms: 86_400_000,
  });
});

test("background: caps concurrently running tasks", () => {
  const bg = spawnTasks();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(bg.start("sleep 30", 0));
  assert.throws(() => bg.start("sleep 30", 0), /kill one with background_kill/);
  for (const id of ids) bg.kill(id);
});

test("background: unknown id errors and lists running tasks", async () => {
  const bg = spawnTasks();
  const id = bg.start("sleep 30", 0);
  await assert.rejects(
    () => bg.read("bg-nope"),
    /unknown background task "bg-nope" — running: bg-1/,
  );
  bg.kill(id);
});

test("background: commands run in the session cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "loom-bg-cwd-"));
  const bg = spawnTasks(cwd);
  const id = bg.start("pwd");
  const r = await bg.read(id, { waitMs: 5_000 });
  assert.equal(r.output.trim(), realpathSync(cwd));
  rmSync(cwd, { recursive: true, force: true });
});
