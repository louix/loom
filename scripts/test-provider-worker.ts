/** Local fixture companion, deliberately run with --deny-net by its test. */
import assert from "node:assert/strict";
import { createProviderWorker } from "../backend/daemon/src/daemon/provider-worker.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { makeLogger } from "../core/src/logger.ts";
const [endpoint] = Deno.args;
assert(endpoint);
await assert.rejects(fetch(endpoint), Deno.errors.NotCapable);
const workspace = await Deno.makeTempDir();
const transcript = new WorkerTranscript("smoke", () => {});
const provider = await createProviderWorker("@loom/connector-generic", {
  id: "fixture",
  config: {
    sdk: "openai",
    model: "fixture",
    models: ["fixture"],
    baseUrl: endpoint,
    apiKey: "fixture",
  },
  transcript,
  logger: makeLogger("fixture"),
});
try {
  const session = await provider.createSession({
    sessionId: "smoke",
    cwd: workspace,
    prompt: "Remember cobalt",
    mode: "default",
    mcpServers: [],
  });
  try {
    for await (const event of session.events()) {
      if (event.type === "error") throw Error(event.message);
      if (event.type === "result") {
        assert.equal(event.kind, "ok");
        break;
      }
    }
    assert(transcript.load("smoke").length >= 2, "host transcript was not updated");
  } finally {
    await session.close();
  }
} finally {
  await Deno.remove(workspace, { recursive: true });
}
console.log("network-denied parent, networked worker and host transcript passed");
