import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readStartupProgress } from "../runtime/src/session-vm/progress.ts";
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
