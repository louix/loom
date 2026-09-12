import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { makeHarness } from "@loom/harness";
import { loomPaths } from "@loom/core/paths";
import { stopDaemon } from "../cli/src/stop.ts";

test("stop waits for disconnection and repo ownership release before a restart", async () => {
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: false,
  });
  const { pid } = loomPaths(h.repoRoot);
  try {
    // Standalone harnesses skip pidfiles; hold one to model cleanup after socket close.
    await Deno.writeTextFile(pid, JSON.stringify(c.daemonInfo));
    let finished = false;
    const stopping = stopDaemon(c).then(() => {
      finished = true;
    });
    await h.daemon.whenClosed();
    await delay(50);
    assert.equal(finished, false);
    await Deno.remove(pid);
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
    await Deno.writeTextFile(loomPaths(h.repoRoot).pid, JSON.stringify(c.daemonInfo));
    await assert.rejects(stopDaemon(c, 100), /shutdown timed out/);
  } finally {
    await c.close();
    await h.cleanup();
  }
});
