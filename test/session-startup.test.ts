import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readStartupProgress } from "../runtime/src/session-vm/progress.ts";
import {
  enterSessionEnvironment,
  drainSessionEnvironment,
} from "../runtime/src/session-vm/maintenance.ts";
import { lockSessionState } from "../runtime/src/session-vm/persistence.ts";
import { discardSessionDisks } from "../runtime/src/session-vm/disks.ts";

test("startup phases survive fragmented stderr without publishing vendor output", async () => {
  const chunks = [
    'private-token\n{"loomStart',
    'up":"boot"}\n',
    "x".repeat(1000),
    '\n{"loomStartup":"toString"}\n{"loomStartup":"activate","secret":"ignored"}\n',
    '{"loomStartup":"prepare"}\n',
  ];
  const stages: string[] = [];
  await readStartupProgress(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    (stage) => stages.push(stage),
  );
  assert.deepEqual(stages, ["boot", "activate", "prepare"]);
});

test("preparation blocks admission and waits for running VMs before replacing a base", async () => {
  const home = await Deno.makeTempDir();
  let running: Deno.FsFile | undefined;
  let preparation: Deno.FsFile | undefined;
  let exclusive: Deno.FsFile | undefined;
  try {
    running = await enterSessionEnvironment(home);
    preparation = await lockSessionState(join(home, "preparation"));
    await assert.rejects(enterSessionEnvironment(home), /preparation is running/);
    const cancelled = new AbortController();
    const waiting = drainSessionEnvironment(home, cancelled.signal);
    cancelled.abort();
    await assert.rejects(waiting);
    let drained = false;
    const pending = drainSessionEnvironment(home, new AbortController().signal).then((lease) => {
      drained = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drained, false);
    running.close();
    running = undefined;
    exclusive = await pending;
    assert.equal(drained, true);
    await assert.rejects(enterSessionEnvironment(home), /preparation is running/);
    exclusive.close();
    exclusive = undefined;
    preparation.close();
    preparation = undefined;
    running = await enterSessionEnvironment(home);
  } finally {
    running?.close();
    preparation?.close();
    exclusive?.close();
    await Deno.remove(home, { recursive: true });
  }
});

test("discarding legacy guest disks preserves host profiles and worktree changes", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(home, "session/disks"), { recursive: true });
    await Deno.mkdir(join(home, "session/profile"));
    await Deno.writeTextFile(join(home, "session/disks/storage.raw"), "guest-only");
    await Deno.writeTextFile(join(home, "session/profile/history"), "conversation");
    await Deno.writeTextFile(join(home, "unstaged"), "host change");
    await discardSessionDisks(join(home, "session"));
    await discardSessionDisks(join(home, "session"));
    await assert.rejects(Deno.stat(join(home, "session/disks")), Deno.errors.NotFound);
    assert.equal(await Deno.readTextFile(join(home, "session/profile/history")), "conversation");
    assert.equal(await Deno.readTextFile(join(home, "unstaged")), "host change");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
