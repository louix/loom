/** Opt-in live check: two short requests, host transcript persistence and fresh-VM resume. */
import assert from "node:assert/strict";
import { gitFixture } from "./lib/git-fixture.ts";
import { loadConfig, resolveApiKey } from "../backend/daemon/src/config/config.ts";
import { withAisdkVmSessions } from "../backend/daemon/src/daemon/aisdk-vm-provider.ts";
import { createProvider as createGeneric } from "../connectors/generic/src/index.ts";
import { createProvider as createGemini } from "../connectors/gemini/src/index.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { AgentSession } from "../core/src/types.ts";
const f = await gitFixture();
const state = await Deno.makeTempDir({ prefix: "loom-aisdk-smoke-state-" });
Deno.env.set("XDG_STATE_HOME", state);
const [artifact, smolvm, providerId, modelId] = Deno.args;
assert(
  artifact && smolvm && providerId && modelId,
  "Usage: test-aisdk-session-vm.ts ARTIFACT SMOLVM PROVIDER MODEL",
);
const p = loadConfig(Deno.cwd()).providers.aisdk[providerId]!;
assert(p && p.sdk !== "chatgpt", "Choose an AISDK provider");
const store = new WorkerTranscript("smoke", () => {});
const model = modelId;
const ctx = {
  id: providerId,
  config: {
    model,
    models: [model],
    baseUrl: p.baseUrl,
    apiKey: resolveApiKey(p),
    sdk: p.sdk,
    sessionVm: { artifact, smolvm, repoRoot: f.repo },
  },
  transcript: store,
  logger: makeLogger("smoke"),
};
let session: AgentSession | undefined;
const provider = await withAisdkVmSessions(
  await (p.sdk === "google" ? createGemini : createGeneric)(ctx),
  ctx,
);
const turn = async () => {
  for await (const event of session!.events()) {
    if (event.type === "result") {
      assert.equal(event.kind, "ok");
      return;
    }
    if (event.type === "error") throw new Error("provider error");
  }
  throw new Error("missing result");
};
const timer = setTimeout(() => {
  console.error("smoke timed out");
  Deno.exit(1);
}, 90000);
try {
  session = await provider.createSession({
    sessionId: "smoke",
    cwd: f.workspace,
    prompt: "Remember the word cobalt. Reply with exactly OK. Do not use tools.",
    mode: "default",
    mcpServers: [],
  });
  await turn();
  assert(store.count("smoke") >= 2);
  console.log("VM request and host transcript persistence passed");
  await session.close();
  session = await provider.resumeSession({
    sessionId: "smoke",
    providerRef: "smoke",
    cwd: f.workspace,
    model,
    mode: "default",
    mcpServers: [],
  });
  await session.send(
    "What word did I ask you to remember? Reply with that word only. Do not use tools.",
  );
  await turn();
  assert(JSON.stringify(store.load("smoke").at(-1)).toLowerCase().includes("cobalt"));
  console.log("Fresh VM resume passed");
} finally {
  clearTimeout(timer);
  await session?.close();
  await provider.close?.();
  await f.close();
  await Deno.remove(state, { recursive: true });
}
