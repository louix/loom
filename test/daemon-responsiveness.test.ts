import assert from "node:assert/strict";
import { test } from "node:test";
import { LoomClient } from "@loom/client";
import { WorktreeManager } from "@loom/daemon/daemon/worktrees";
import { makeHarness } from "@loom/harness";
import type { HistoryPage } from "@loom/core/wire";

test("hello and history complete while advisory Git is still pending", async (t) => {
  const h = await makeHarness();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<void>();
  const original = WorktreeManager.prototype.factsAsync;
  const sync = t.mock.method(WorktreeManager.prototype, "facts", () => {
    throw new Error("snapshot must not synchronously probe Git");
  });
  const asyncProbe = t.mock.method(
    WorktreeManager.prototype,
    "factsAsync",
    function (this: WorktreeManager, path: string, base: string | null) {
      started.resolve();
      return gate.promise.then(() => original.call(this, path, base));
    },
  );
  let client: LoomClient | undefined;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    h.daemon.registry.create({ id: "idle-session", provider: "fake", inPlace: true });
    client = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    await started.promise;
    const page = await client.request<HistoryPage>("session.events", { id: "idle-session" }, 1000);
    assert.deepEqual(page.items, []);
    assert.equal(sync.mock.callCount(), 0);
    off = client.subscribe((state) => {
      if (state.tag === "data" && state.value.sessions.some((s) => s.git?.branch === "main"))
        refreshed.resolve();
    });
    timer = setTimeout(() => refreshed.reject(new Error("Git refresh was never published")), 2000);
    gate.resolve();
    await refreshed.promise;
  } finally {
    gate.resolve();
    clearTimeout(timer);
    off?.();
    sync.mock.restore();
    asyncProbe.mock.restore();
    await client?.close();
    await h.cleanup();
  }
});
