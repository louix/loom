import { fileURLToPath } from "node:url";
/** Local acceptance companion: a full daemon with Unix-only networking and worker-backed APIs. */
import assert from "node:assert/strict";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import {
  WORKER_SCRATCH_ROOT,
  workerScratches,
} from "../backend/daemon/src/daemon/worker-scratch.ts";
import { CONNECTORS } from "../cli/src/connectors.ts";
import { LoomClient } from "../client/src/client.ts";

import type { SessionSnapshot } from "../core/src/wire.ts";
const [endpoint, repoRoot, configFile] = Deno.args;
assert(endpoint && repoRoot && configFile);
await assert.rejects(fetch(endpoint), Deno.errors.NotCapable);
const daemon = await Daemon.start({ repoRoot, configFile, connectors: CONNECTORS });
const client = await LoomClient.connect({
  repoRoot,
  sockPath: daemon.paths.sock,
  autospawn: false,
});
try {
  const cli = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--deny-net",
      fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
      "--repo",
      repoRoot,
      "ls",
      "--json",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(cli.success, new TextDecoder().decode(cli.stderr));
  const row = await client.request<SessionSnapshot>("session.create", {
    provider: "fixture",
    prompt: "Reply OK",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await client.request<SessionSnapshot>("session.get", { id: row.id });
    assert.notEqual(state.status.kind, "error");
    if (state.status.kind === "idle") break;
    assert(Date.now() < deadline, "turn timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await client.request("session.messages", { id: row.id }), ["Reply OK"]);
} finally {
  await client.close();
  await daemon.stop("test");
}
// The stop abandons the session's auto-title one-shot mid-reply; its worker
// must still be closed, and its scratch removed, before the daemon exits.
assert.deepEqual(
  (await workerScratches(WORKER_SCRATCH_ROOT)).filter(({ claim }) => claim.owner === Deno.pid),
  [],
);
console.log("network-denied daemon catalog and provider turn passed");
// Like loomd, exit once stopped rather than when the event loop drains: an
// `AbortSignal.any` over an `AbortSignal.timeout` keeps Deno alive until that
// timeout fires, even once aborted (catalogue discovery and plan usage: 30 s).
Deno.exit(0);
