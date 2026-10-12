/**
 * `session.taskOutput` through the daemon: the live adapter answers, a
 * provider without the read says so, and a failed read is an error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import type { FakeProvider } from "@loom/connector-mock";
import type { TaskOutput } from "@loom/core/types";
import { makeHarness } from "@loom/harness";

const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

test("session.taskOutput asks the live adapter, or says why it cannot", async () => {
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
    const snap = await c.request<SessionSnapshot>("session.create", {
      prompt: "start",
      provider: "fake",
    });
    await waitFor(() => provider.session(snap.id) !== undefined);
    const fs = provider.session(snap.id)!;
    const read = (taskId: string) =>
      c.request<TaskOutput>("session.taskOutput", { id: snap.id, taskId });

    assert.deepEqual(await read("bash-1"), { t: "unsupported" }, "the fake has no such read");

    const asked: string[] = [];
    Object.assign(fs, {
      readTaskOutput: async (taskId: string): Promise<TaskOutput> => {
        asked.push(taskId);
        if (taskId === "boom") throw new Error("the CLI went away");
        return { t: "output", output: "tick\n", totalBytes: 5, truncated: false };
      },
    });
    assert.deepEqual(await read("bash-1"), {
      t: "output",
      output: "tick\n",
      totalBytes: 5,
      truncated: false,
    });
    await assert.rejects(read("boom"), /the CLI went away/);
    assert.deepEqual(asked, ["bash-1", "boom"]);

    await assert.rejects(c.request("session.taskOutput", { id: "nope", taskId: "bash-1" }));
  } finally {
    await c.close();
    await h.cleanup();
  }
});
