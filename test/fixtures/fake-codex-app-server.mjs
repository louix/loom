#!/usr/bin/env node
/**
 * A minimal `codex app-server` for tests — newline-delimited JSON-RPC 2.0 over
 * stdio. Handles just enough of the real protocol, from versioned canned
 * responses in `./codex-protocol/*.json`, to exercise `CodexRpcClient`,
 * `discoverCodexModels` and `CodexAppServerSession` deterministically without
 * a real `codex` install or credentials.
 *
 * `initialize` echoes back `CODEX_HOME` from its own environment so tests can
 * assert the directory Loom resolved actually reached the subprocess.
 * `model/list` paginates between the two fixture pages via `params.cursor`.
 * `test/hang` deliberately never responds, for exercising request timeouts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This file is a fixture, not a test. A bare `node --test` matches
// `**/test/**/*.mjs` and would execute it, then hang forever on stdin. Bail
// when the test runner is our parent (real spawns never carry this var).
if (process.env["NODE_TEST_CONTEXT"]) process.exit(0);

const fixture = (name) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./codex-protocol/${name}.json`, import.meta.url)), "utf8"),
  );

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

const handle = (req) => {
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { codexHome: process.env["CODEX_HOME"] ?? null } });
    return;
  }
  if (method === "initialized" || method === "test/hang") return;
  if (method === "thread/start") {
    send({ jsonrpc: "2.0", id, result: fixture("thread-start") });
    return;
  }
  if (method === "thread/resume") {
    const base = fixture("thread-resume");
    // Echo whether developerInstructions arrived, in the thread id, so tests
    // can assert on it through `CodexAppServerSession.resume()`'s public
    // `providerRef` without a new test-only hook into production code.
    const id_ = params?.developerInstructions ? `${base.thread.id}-with-instructions` : base.thread.id;
    send({ jsonrpc: "2.0", id, result: { thread: { id: id_ } } });
    return;
  }
  if (method === "turn/start") {
    send({ jsonrpc: "2.0", id, result: fixture("turn-start") });
    // A real turn finishes asynchronously via a notification, not the reply.
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "fake-turn-1", status: "completed" } },
      });
    }, 0);
    return;
  }
  if (
    method === "turn/interrupt" ||
    method === "turn/steer" ||
    method === "thread/settings/update" ||
    method === "turn/settings/update" ||
    method === "thread/compact/start"
  ) {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "model/list") {
    const page = params?.cursor === "page2" ? fixture("model-list-page2") : fixture("model-list-page1");
    send({ jsonrpc: "2.0", id, result: page });
    return;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `fake app-server: unhandled method ${method}` },
    });
  }
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed input
    }
  }
});
process.stdin.on("end", () => process.exit(0));
