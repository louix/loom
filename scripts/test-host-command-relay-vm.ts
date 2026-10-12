/**
 * A relayed host command, end to end against a real runtime: the guest's AISDK
 * generic connector calls a tool on a stdio MCP server running on the host, through
 * the host stdio→HTTP bridge and the session's MCP relay. A synthetic local model
 * endpoint, also relayed, asks for the call. No provider credentials or traffic.
 *
 * Checks the tool ran on the host (its pid and marker reach the model), and that
 * stopping the session's host command leaves nothing running.
 *
 * Usage: deno run -A scripts/test-host-command-relay-vm.ts <session-runtime> <smolvm>
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedWorkerLauncher } from "../backend/daemon/src/daemon/isolated-worker.ts";
import { startHostCommandMcp } from "../backend/daemon/src/daemon/host-command-mcp.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import {
  sessionVmDirectory,
  stoppedSessionVm,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { gitFixture } from "./lib/git-fixture.ts";

const MODEL_GUEST_PORT = 3130;
const TOOL_GUEST_PORT = 3131;
const MARKER = "relayed-into-the-vm";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass a session runtime and smolvm");
const f = await gitFixture();
// Keep this run's VM inventory and session state out of the user's.
Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));

let fixtureError: unknown;
let toolResult: string | undefined;
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const body = await request.json();
    const text = JSON.stringify(body.messages);
    const chunk = (delta: unknown, finish: string | null) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    const stream = { headers: { "content-type": "text/event-stream" } };
    if (!text.includes("call-whoami")) {
      assert(
        JSON.stringify(body.tools ?? []).includes("whoami"),
        "the host command's tool reached the guest agent",
      );
      return new Response(
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-whoami",
                type: "function",
                function: { name: "whoami", arguments: "{}" },
              },
            ],
          },
          null,
        ) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
        stream,
      );
    }
    toolResult = text;
    return new Response(
      chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      stream,
    );
  } catch (error) {
    fixtureError = error;
    return new Response("Fixture assertion failed", { status: 400 });
  }
});

const host = await startHostCommandMcp("fixture", {
  transport: "stdio",
  command: Deno.execPath(),
  args: [
    "run",
    "--quiet",
    "-A",
    fileURLToPath(new URL("../test/fixtures/host-command-mcp.ts", import.meta.url)),
  ],
  env: { LOOM_TEST_MARKER: MARKER },
});
assert(host.handle.spec.transport === "http");
const hostUrl = new URL(host.handle.spec.url);
const guestUrl = new URL(hostUrl);
guestUrl.port = String(TOOL_GUEST_PORT);

const id = "relay";
const launcher = createIsolatedWorkerLauncher(f.repo);
const progress: string[] = [];
let passed = false;
const deadline = setTimeout(() => {
  console.error("Host command relay VM check timed out\n" + progress.join("\n"));
  Deno.exit(1);
}, 600_000);
let worker: Awaited<ReturnType<typeof launcher.launch>> | undefined;
let session: RemoteWorkerSession | undefined;
try {
  await stoppedSessionVm(f.repo, id);
  worker = await launcher.launch({
    workspace: f.workspace,
    sessionId: id,
    provider: "fixture",
    artifact,
    smolvm,
    sessionDirectory: sessionVmDirectory(f.repo, id),
    repoRoot: f.repo,
    auth: {},
    providerHosts: [],
    mcpRelays: [
      { port: server.addr.port, guestPort: MODEL_GUEST_PORT },
      { port: Number(hostUrl.port), guestPort: TOOL_GUEST_PORT },
    ],
    onProgress: (message) => progress.push(message),
  });
  const launched = worker;
  ({ session } = await RemoteWorkerSession.connect(
    id,
    "fixture",
    mockLaunchSpec(f.workspace),
    () => launched,
    { startupMs: 120_000, requestMs: 120_000 },
    {
      connector: "@loom/connector-generic",
      config: {
        sdk: "openai",
        model: "fixture",
        models: ["fixture"],
        baseUrl: `http://127.0.0.1:${MODEL_GUEST_PORT}/v1`,
        apiKey: "synthetic-fixture-key",
      },
    },
  ));
  await session.attachTranscript(new WorkerTranscript(id, () => {}));
  await session.start({
    method: "create",
    args: [
      {
        sessionId: id,
        cwd: f.workspace,
        // Let the fixture's tool call run unprompted.
        mode: "auto",
        prompt: "Who is the host command?",
        mcpServers: [
          {
            name: "fixture",
            spec: { ...host.handle.spec, url: guestUrl.toString() },
          },
        ],
      },
    ],
  });
  let text = "";
  for await (const event of session.events()) {
    if (event.type === "assistant_text") text += event.text;
    if (event.type === "error") throw fixtureError ?? new Error(event.message);
    if (event.type === "result") {
      assert.equal(event.kind, "ok");
      break;
    }
  }
  assert.equal(text, "OK");
  assert(fixtureError === undefined, String(fixtureError));
  // The tool ran on the host: its environment marker came back through the relay.
  assert(toolResult?.includes(MARKER), "tool result: " + toolResult);
  const pid = Number(/pid\\*":(\d+)/.exec(toolResult ?? "")?.[1]);
  assert(pid > 0, "host pid in the tool result");
  await session.close();
  session = undefined;
  await worker.cleanup?.();
  worker = undefined;
  await host.close();
  await host.exited;
  // Its group has gone: a member's /proc entry outlives it only as a zombie.
  const stat = await Deno.readTextFile(`/proc/${pid}/stat`).catch(() => "");
  assert(!stat || /\) [ZX] /.test(stat), "host command still running: " + stat);
  passed = true;
  console.log(JSON.stringify({ guestToolCall: true, ranOnHost: true, hostCommandStopped: true }));
} finally {
  clearTimeout(deadline);
  await session?.close().catch(() => {});
  worker?.terminate();
  await worker?.cleanup?.();
  await launcher.close();
  await host.close();
  await server.shutdown();
  if (passed) await f.close();
  else console.error(`Retained synthetic fixture: ${f.root}\n${progress.join("\n")}`);
}
