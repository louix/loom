import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { sweepWorkerScratch } from "../backend/daemon/src/daemon/worker-scratch.ts";

interface ScratchFixture {
  readonly name: string;
  readonly claim?: string;
}

const mkScratch = async (root: string, { name, claim }: ScratchFixture) => {
  await Deno.mkdir(join(root, name));
  if (claim !== undefined) await Deno.writeTextFile(join(root, name, "loom-worker.json"), claim);
};

/** A pid, and process group, that no longer exists. */
const mkDeadPid = async (): Promise<number> => {
  const child = new Deno.Command("true").spawn();
  await child.status;
  return child.pid;
};

test("sweepWorkerScratch removes only claimed scratch whose launcher and worker are gone", async () => {
  // given
  const root = await Deno.makeTempDir();
  const dead = await mkDeadPid();
  const live = new Deno.Command("sleep", { args: ["30"], detached: true }).spawn();
  try {
    const claim = (owner: number, group?: number) =>
      JSON.stringify(group === undefined ? { owner } : { owner, group });
    await mkScratch(root, { name: "loom-provider-worker-gone", claim: claim(dead, dead) });
    await mkScratch(root, { name: "loom-claude-worker-gone", claim: claim(dead, dead) });
    await mkScratch(root, {
      name: "loom-claude-worker-launcher-alive",
      claim: claim(Deno.pid, dead),
    });
    await mkScratch(root, { name: "loom-claude-worker-group-alive", claim: claim(dead, live.pid) });
    await mkScratch(root, { name: "loom-claude-worker-never-launched", claim: claim(dead) });
    await mkScratch(root, { name: "loom-claude-worker-unclaimed" });
    await mkScratch(root, { name: "loom-claude-worker-garbled", claim: "{" });
    await mkScratch(root, { name: "loom-claude-worker-negative", claim: claim(-1, -1) });
    await mkScratch(root, { name: "other-gone", claim: claim(dead, dead) });
    await Deno.symlink(join(root, "other-gone"), join(root, "loom-claude-worker-link"));
    // when
    const removed = await sweepWorkerScratch(root);
    // then
    assert.deepEqual(removed.sort(), [
      join(root, "loom-claude-worker-gone"),
      join(root, "loom-provider-worker-gone"),
    ]);
    assert.deepEqual((await Array.fromAsync(Deno.readDir(root))).map((e) => e.name).sort(), [
      "loom-claude-worker-garbled",
      "loom-claude-worker-group-alive",
      "loom-claude-worker-launcher-alive",
      "loom-claude-worker-link",
      "loom-claude-worker-negative",
      "loom-claude-worker-never-launched",
      "loom-claude-worker-unclaimed",
      "other-gone",
    ]);
  } finally {
    live.kill("SIGKILL");
    await live.status;
    await Deno.remove(root, { recursive: true });
  }
});
