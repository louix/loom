/** Real AISDK guest requests and fresh-VM resume; synthetic local credentials only. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { gitFixture } from "./lib/git-fixture.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass AISDK_ARTIFACT SMOLVM");
const f = await gitFixture();
const transcript = new WorkerTranscript("fixture", () => {});
let requests = 0;
let fixtureError: unknown;
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-fixture-key");
    const body = await request.json();
    assert(body.stream);
    assert(JSON.stringify(body.messages).includes("cobalt"));
    if (requests > 0) assert(JSON.stringify(body.messages).includes("OK"));
    const text = requests++ === 0 ? "OK" : "cobalt";
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      "data: " +
      JSON.stringify({
        id: "fixture-response",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      }) +
      "\n\n";
    return new Response(
      chunk({ role: "assistant", content: text }, null) +
        chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }) +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  } catch (error) {
    fixtureError = error;
    return new Response("Fixture assertion failed", { status: 400 });
  }
});
let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
let session: RemoteWorkerSession | undefined;
let passed = false;
// Allow both cold boots their 120-second startup budget, plus the two turns.
const deadline = setTimeout(() => worker?.terminate(), 300_000);
try {
  for (const resume of [false, true]) {
    worker = await launchSessionVm({
      artifact,
      smolvm,
      workspace: f.workspace,
      sessionDirectory: join(f.root, "persistent"),
      auth: {},
      providerHosts: [],
      mcpRelays: [{ port: server.addr.port, guestPort: 3130 }],
    });
    ({ session } = await RemoteWorkerSession.connect(
      "fixture",
      "fixture",
      mockLaunchSpec(f.workspace),
      () => worker!,
      120_000,
      {
        connector: "@loom/connector-generic",
        config: {
          sdk: "openai",
          model: "fixture",
          models: ["fixture"],
          baseUrl: "http://127.0.0.1:3130/v1",
          apiKey: "synthetic-fixture-key",
        },
      },
    ));
    await session.attachTranscript(transcript);
    const options = {
      sessionId: "fixture",
      cwd: f.workspace,
      mode: "default" as const,
      mcpServers: [],
    };
    if (resume) {
      await session.start({ method: "resume", args: [{ ...options, providerRef: "fixture" }] });
      await session.send("What word did I ask you to remember?");
    } else {
      await session.start({
        method: "create",
        args: [{ ...options, prompt: "Remember cobalt. Reply OK." }],
      });
    }
    let text = "";
    let finished = false;
    for await (const event of session.events()) {
      if (event.type === "assistant_text") text += event.text;
      if (event.type === "error") throw fixtureError ?? new Error(event.message);
      if (event.type === "result") {
        assert.equal(event.kind, "ok");
        finished = true;
        break;
      }
    }
    assert(finished);
    assert.equal(text, resume ? "cobalt" : "OK");
    assert(transcript.count("fixture") >= 2);
    await session.close();
    await worker.cleanup?.();
    session = undefined;
    worker = undefined;
  }
  assert.equal(requests, 2);
  passed = true;
  console.log(
    JSON.stringify({ guestRequests: requests, hostTranscript: true, freshVmResume: true }),
  );
} finally {
  clearTimeout(deadline);
  await session?.close();
  worker?.terminate();
  await worker?.cleanup?.();
  await server.shutdown();
  if (passed) await f.close();
  else console.error(`Retained synthetic fixture: ${f.root}`);
}
