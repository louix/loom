import assert from "node:assert/strict";
import { join } from "node:path";
import { cleanupSessionVm } from "../runtime/src/session-vm/cleanup.ts";
Deno.test("session cleanup revokes credentials and bridges even when reaping fails", async () => {
  const state = await Deno.makeTempDir();
  const auth = join(state, "auth.json");
  await Deno.writeTextFile(auth, "test-secret");
  const called: string[] = [];
  try {
    await assert.rejects(
      cleanupSessionVm({
        stop: async () => {
          called.push("stop");
          throw new Error("stop failed");
        },
        egress: async () => {
          called.push("egress");
        },
        credentials: () => Deno.remove(auth),
        reap: async () => {
          called.push("reap");
          throw new Error("reap failed");
        },
        git: async () => {
          called.push("git");
        },
        state: async () => {
          called.push("state");
        },
      }),
      AggregateError,
    );
    assert.deepEqual(called, ["stop", "egress", "reap", "git"]);
    await assert.rejects(Deno.stat(auth), Deno.errors.NotFound);
    assert((await Deno.stat(state)).isDirectory);
  } finally {
    await Deno.remove(state, { recursive: true });
  }
});
