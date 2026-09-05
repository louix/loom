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
 * `LOOM_TEST_FAIL_STARTUP=1` makes `thread/start`/`thread/resume` reply with a
 * JSON-RPC error, for exercising `CodexAppServerSession`'s startup-failure
 * cleanup. `LOOM_TEST_EXIT_MARKER_DIR`, when set, drops an empty file named
 * after this process's pid into that directory on exit (for any reason —
 * killed, crashed, or a clean stdin close), so a test can assert the child
 * actually exited instead of leaking.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// This file is a fixture, not a test. A bare `node --test` matches
// `**/test/**/*.mjs` and would execute it, then hang forever on stdin. Bail
// when the test runner is our parent (real spawns never carry this var).
if (process.env["NODE_TEST_CONTEXT"]) process.exit(0);

const exitMarkerDir = process.env["LOOM_TEST_EXIT_MARKER_DIR"];
if (exitMarkerDir) {
  process.on("exit", () => {
    try {
      writeFileSync(join(exitMarkerDir, String(process.pid)), "");
    } catch {
      // best effort — a missing/unwritable dir shouldn't crash the fixture
    }
  });
  // `proc.kill()` sends SIGTERM by default; Node only runs `exit` handlers on
  // a signal if something has actually handled it (otherwise the OS just
  // terminates the process and JS never runs again). Handle it ourselves and
  // exit normally so the marker above still gets written under a real kill.
  process.on("SIGTERM", () => process.exit(0));
}

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
    if (process.env["LOOM_TEST_FAIL_STARTUP"]) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "fake app-server: forced thread/start failure" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: fixture("thread-start") });
    return;
  }
  if (method === "thread/resume") {
    if (process.env["LOOM_TEST_FAIL_STARTUP"]) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "fake app-server: forced thread/resume failure" } });
      return;
    }
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
