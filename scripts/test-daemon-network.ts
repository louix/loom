import { fileURLToPath } from "node:url";
/** Local acceptance companion: a full daemon with Unix-only networking and worker-backed APIs. */
import assert from "node:assert/strict";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
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
console.log("network-denied daemon catalog and provider turn passed");
