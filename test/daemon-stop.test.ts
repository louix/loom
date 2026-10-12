import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { makeHarness } from "@loom/harness";
import { loomPaths } from "@loom/core/paths";
import { lockRepository } from "@loom/daemon/daemon/lifecycle";
import { stopDaemon } from "../cli/src/stop.ts";

test("stop waits for disconnection and repo ownership release before a restart", async () => {
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: false,
  });
  const { lock, sock } = loomPaths(h.repoRoot);
  const endpoint = { kind: "current", sock, lock } as const;
  try {
    // Standalone harnesses skip the lock; hold it to model cleanup after socket close.
    const held = await lockRepository(lock, c.daemonInfo?.epoch ?? "");
    let finished = false;
    const stopping = stopDaemon(c, endpoint).then(() => {
      finished = true;
    });
    await h.daemon.whenClosed();
    await delay(50);
    assert.equal(finished, false);
    held.release();
    await stopping;
    assert.equal(finished, true);
    await h.restart();
    const next = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
      reconnect: false,
    });
    try {
      await next.request("ping");
    } finally {
      await next.close();
    }
  } finally {
    await c.close();
    await h.cleanup();
  }
});

test("stop reports a bounded failure if the daemon retains repo ownership", async () => {
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: false,
  });
  try {
    const { lock, sock } = loomPaths(h.repoRoot);
    const held = await lockRepository(lock, c.daemonInfo?.epoch ?? "");
    try {
      await assert.rejects(
        stopDaemon(c, { kind: "current", sock, lock }, 100),
        /shutdown timed out/,
      );
    } finally {
      held.release();
    }
  } finally {
    await c.close();
    await h.cleanup();
  }
});
