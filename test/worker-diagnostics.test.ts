import assert from "node:assert/strict";
import { describeWorkerFailure } from "../runtime/src/worker/diagnostics.ts";
import { workerFailureSchema, type WorkerFailure } from "../core/src/worker-failure.ts";
import { readStartupProgress } from "../runtime/src/session-vm/progress.ts";

Deno.test("worker diagnostics retain known codes and locations without arbitrary exception data", () => {
  const error = Object.assign(new TypeError("ENOSPC secret-token"), { code: "ENOSPC" });
  error.stack = [
    "TypeError: secret-token",
    "    at secretFunction (file:///secret-token/runtime/src/worker/serve.ts:42:7)",
    "    at fetch (https://secret-token.example/private.ts:10:5)",
    "    at vendor (file:///secret-token/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:99:3)",
  ].join("\n");
  const info = describeWorkerFailure(error, "worker_loop");
  assert.deepEqual(info, {
    origin: "worker_loop",
    name: "TypeError",
    code: "ENOSPC",
    frames: [
      { module: "runtime/src/worker/serve.ts", line: 42, column: 7 },
      { module: "claude-agent-sdk", line: 99, column: 3 },
    ],
  });
  assert.equal(JSON.stringify(info).includes("secret-token"), false);
  for (const [message, code] of [
    ["Too many open files (os error 24): secret-token", "EMFILE"],
    ["Too many open files in system: secret-token", "unknown"],
    ["worker output overflow", "worker_output_overflow"],
    ["worker frame too large", "worker_frame_too_large"],
    ["connector event overflow", "connector_event_overflow"],
  ])
    assert.equal(describeWorkerFailure(new Error(message), "worker_loop").code, code);
  assert.deepEqual(describeWorkerFailure("secret-token", "unhandled_rejection"), {
    origin: "unhandled_rejection",
    name: "unknown",
    code: "unknown",
    frames: [],
  });
  Object.defineProperty(error, "name", {
    get() {
      throw new Error("secret-token");
    },
  });
  assert.equal(describeWorkerFailure(error, "worker_loop").name, "unknown");
});

Deno.test("worker failure frames are bounded and validated across fragmented stderr", async () => {
  const valid: WorkerFailure = {
    origin: "unhandled_rejection",
    name: "ConnectionReset",
    code: "ECONNRESET",
    frames: [],
  };
  const lines =
    [
      "vendor secret-token",
      JSON.stringify({ loomWorkerFailure: { ...valid, name: "secret-token" } }),
      JSON.stringify({
        loomWorkerFailure: { ...valid, frames: [{ module: "secret-token", line: 1, column: 1 }] },
      }),
      JSON.stringify({ loomWorkerFailure: { ...valid, message: "secret-token" } }),
    ].join("\n") + "\n";
  const records: WorkerFailure[] = [];
  await readStartupProgress(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < lines.length; i += 7)
          controller.enqueue(new TextEncoder().encode(lines.slice(i, i + 7)));
        controller.close();
      },
    }),
    () => {},
    undefined,
    undefined,
    (info) => records.push(info),
  );
  assert.deepEqual(records, [valid]);
  assert(!JSON.stringify(records).includes("secret-token"));
  const frame = { module: "runtime/src/worker/serve.ts", line: 1, column: 1 };
  assert(!workerFailureSchema.safeParse({ ...valid, frames: Array(5).fill(frame) }).success);
});

Deno.test("fatal exceptions emit diagnostics synchronously and still exit nonzero", async () => {
  const diagnosticModule = new URL("../runtime/src/worker/diagnostics.ts", import.meta.url).href;
  for (const [trigger, origin] of [
    ['setTimeout(() => { throw new TypeError("private payload"); }, 0)', "uncaught_error"],
    [
      'Promise.reject(Object.assign(new Error("private payload"), {code: "ECONNRESET"}))',
      "unhandled_rejection",
    ],
  ]) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import {installWorkerDiagnostics} from ${JSON.stringify(diagnosticModule)};
        installWorkerDiagnostics(); installWorkerDiagnostics(); ${trigger};`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 1);
    const records: WorkerFailure[] = [];
    await readStartupProgress(
      new Response(result.stderr).body!,
      () => {},
      undefined,
      undefined,
      (info) => records.push(info),
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.origin, origin);
    assert(!JSON.stringify(records).includes("private payload"));
  }
});

Deno.test("worker loop errors are reported before the explicit exit path", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("../runtime/src/worker/main.ts", import.meta.url).pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = child.output();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("not-json\n"));
  await writer.close();
  const result = await output;
  assert.equal(result.code, 1);
  const records: WorkerFailure[] = [];
  await readStartupProgress(
    new Response(result.stderr).body!,
    () => {},
    undefined,
    undefined,
    (info) => records.push(info),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]!.origin, "worker_loop");
  assert.equal(records[0]!.name, "SyntaxError");
  assert(records[0]!.frames.some((f) => f.module === "runtime/src/framing.ts"));
});
