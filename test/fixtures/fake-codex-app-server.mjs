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
 * `LOOM_TEST_TOOL_CALL_SPEC` (JSON `{tool, arguments}`), when set alongside
 * `LOOM_TEST_TOOL_CALL_RESULT_FILE`, makes `thread/start` fire a genuine
 * server-initiated `item/tool/call` request right after replying — exercising
 * `CodexAppServerSession#toolCall`'s real request/response path instead of
 * calling its private method directly. The client's response is written to
 * the result file as JSON for the test to poll.
 * `LOOM_TEST_USER_INPUT_SPEC` (JSON `{questions}`), when set alongside
 * `LOOM_TEST_USER_INPUT_RESULT_FILE`, fires a genuine `item/tool/
 * requestUserInput` request the same way, for the native-question path.
 * `LOOM_TEST_PRE_NOTIFICATION` (JSON `{method, params}`), when set, sends one
 * plain notification (no id) right after `thread/start`'s reply, before any
 * of the above — used to simulate a `subAgentActivity` item establishing a
 * known sub-agent thread id before an approval request claims it.
 * `LOOM_TEST_APPROVAL_SPEC` (JSON `{method, threadId, params}`), when set
 * alongside `LOOM_TEST_APPROVAL_RESULT_FILE`, fires an arbitrary
 * approval-shaped server request (any method, any `threadId`) — used to
 * exercise `#serverRequest`'s unrecognized-thread rejection and a known
 * sub-agent thread's acceptance.
 * `LOOM_TEST_HOLD_TURN=1` skips `turn/start`'s automatic `turn/completed`
 * notification, so a test can call `setMode` while a turn is genuinely still
 * open. `LOOM_TEST_INTERRUPT_MARKER_FILE`, when set, is written on receiving
 * `turn/interrupt`, so a test can assert whether (or that) an interrupt
 * actually happened. `LOOM_TEST_FAIL_TURN_INTERRUPT=1` makes `turn/interrupt`
 * reply with a JSON-RPC error instead of `{}`, for exercising cleanup that
 * must run even when the interrupt RPC itself fails.
 * `LOOM_TEST_TOOL_CALL_AFTER_INTERRUPT_SPEC` (JSON `{tool, arguments}`), when
 * set alongside `LOOM_TEST_APPROVAL_RESULT_FILE`, fires one `item/tool/call`
 * request tagged with the turn being interrupted, right after replying to
 * `turn/interrupt` — simulating a request that was already in flight for
 * that turn, to exercise the client's stale-turn rejection.
 * `LOOM_TEST_COMPLETE_TURN_WITH_REPLY` (`1`, or `started` to also announce
 * the turn) writes `turn/start`'s reply and `turn/completed` in one chunk.
 * `LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE=1` makes `thread/settings/update`
 * reply with a JSON-RPC error instead of `{}`, for exercising a failed
 * `setMode` mid-transition (e.g. inside `respondToPlan`).
 * `LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE` (a base file path) holds
 * `thread/settings/update`'s response: `${base}.received` is written the
 * moment the request arrives (so a test knows it's genuinely in flight),
 * and the response itself waits for `${base}.release` to exist — for
 * exercising something else (e.g. an independent `interrupt()`) racing a
 * slow settings RPC. `LOOM_TEST_HOLD_TURN_START_CALL` (a 1-indexed count)
 * plus `LOOM_TEST_HOLD_TURN_START` (a base path, same `.received`/`.release`
 * protocol) do the same for one specific numbered `turn/start` call — e.g.
 * holding only the *second* turn a session starts, for racing an interrupt
 * against a slow `turn/start` without also blocking the first turn a test
 * needs just to get set up.
 *
 * Native settings are modelled the way Codex 0.156 behaves: start/resume
 * replies carry the effective approval policy and reviewer (a resume reply
 * also the saved collaboration mode, unless LOOM_TEST_RESUME_SETTINGS says
 * `collaborationMode: null`); `collaborationMode/list` offers Default and
 * Plan; `thread/settings/update` acknowledges and then, only if something
 * changed, sends `thread/settings/updated`. Knobs: LOOM_TEST_RESUME_SETTINGS,
 * LOOM_TEST_COLLABORATION_MODES / LOOM_TEST_NO_COLLABORATION_MODES,
 * LOOM_TEST_SETTINGS_NOTIFICATION_FIRST, LOOM_TEST_SUPPRESS_SETTINGS_
 * NOTIFICATION, LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE_FROM, LOOM_TEST_HOLD_
 * THREAD_SETTINGS_UPDATE_CALL, LOOM_TEST_EXIT_ON_SETTINGS_UPDATE, and
 * LOOM_TEST_PLAN_ITEM (a turn started in Plan ends with that proposed plan).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

let nextOutgoingId = 1_000_000; // far outside CodexRpcClient's own id space
const pendingOutgoing = new Map();
let startedThreadId; // set once thread/start replies, for handlers below it
let afterInterruptFired = false; // LOOM_TEST_TOOL_CALL_AFTER_INTERRUPT_SPEC fires once
let turnStartCount = 0; // for LOOM_TEST_HOLD_TURN_START_CALL
let settingsUpdateCount = 0; // for the *_THREAD_SETTINGS_UPDATE_* call knobs

/** The thread's native settings, as `thread/settings/updated` reports them. */
let threadSettings = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  model: "fake-model",
  effort: null,
  collaborationMode: {
    mode: "default",
    settings: { model: "fake-model", reasoning_effort: null, developer_instructions: null },
  },
};
const settingsReply = () => ({
  model: threadSettings.model,
  reasoningEffort: threadSettings.effort,
  approvalPolicy: threadSettings.approvalPolicy,
  approvalsReviewer: threadSettings.approvalsReviewer,
  sandbox: threadSettings.sandboxPolicy,
});
const notifySettings = () =>
  send({
    jsonrpc: "2.0",
    method: "thread/settings/updated",
    params: { threadId: startedThreadId, threadSettings },
  });
/** Apply a `thread/settings/update`; returns whether anything changed (Codex
 *  acknowledges a no-op without any settings notification). */
const updateSettings = (params) => {
  const before = JSON.stringify(threadSettings);
  const next = structuredClone(threadSettings);
  for (const key of ["approvalPolicy", "approvalsReviewer", "sandboxPolicy", "model", "effort"])
    if (params?.[key] != null) next[key] = params[key];
  if (params?.collaborationMode) {
    const { mode, settings } = params.collaborationMode;
    // Codex fills in the preset's own instructions for `null`.
    next.collaborationMode = {
      mode,
      settings: { ...settings, developer_instructions: `${mode} instructions` },
    };
    next.model = settings.model;
    next.effort = settings.reasoning_effort;
  }
  threadSettings = next;
  return JSON.stringify(next) !== before;
};

/** Captures the client's eventual response to a fixture-initiated request
 *  (`item/tool/call`, `item/tool/requestUserInput`, an approval-shaped
 *  request, ...) into `resultFile` as JSON, for a test to poll. */
const capture = (resultFile) => (response) => {
  try {
    writeFileSync(resultFile, JSON.stringify(response.result ?? { error: response.error }));
  } catch {
    // best effort — a missing/unwritable result file shouldn't crash the fixture
  }
};

const handle = (req) => {
  const { id, method, params } = req;
  if (process.env.LOOM_TEST_REQUEST_LOG)
    appendFileSync(process.env.LOOM_TEST_REQUEST_LOG, JSON.stringify(req) + "\n");
  // A response to a request *we* sent (e.g. our own `item/tool/call`), not a
  // request from the client — has an id but no method.
  if (method === undefined && id !== undefined && pendingOutgoing.has(id)) {
    const resolve = pendingOutgoing.get(id);
    pendingOutgoing.delete(id);
    resolve(req);
    return;
  }
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { codexHome: process.env["CODEX_HOME"] ?? null } });
    return;
  }
  if (method === "initialized" || method === "test/hang") return;
  if (method === "account/rateLimits/read") {
    if (process.env["LOOM_TEST_LIMITS_ERROR"])
      send({ id, error: { code: -32601, message: "limits unavailable" } });
    else send({ id, result: JSON.parse(process.env["LOOM_TEST_LIMITS"] || "{}") });
    return;
  }
  if (method === "account/read") {
    // LOOM_TEST_ACCOUNT_TYPE lets a test simulate a non-ChatGPT account
    // (unset → the normal, valid ChatGPT subscription account).
    const type = process.env["LOOM_TEST_ACCOUNT_TYPE"] || "chatgpt";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        account: { type, email: "test@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (method === "thread/start") {
    if (process.env["LOOM_TEST_START_PARAMS_FILE"])
      writeFileSync(
        process.env["LOOM_TEST_START_PARAMS_FILE"],
        JSON.stringify({ params, argv: process.argv }),
      );
    if (process.env["LOOM_TEST_FAIL_STARTUP"]) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "fake app-server: forced thread/start failure" },
      });
      return;
    }
    const started = fixture("thread-start");
    startedThreadId = started.thread.id;
    updateSettings({
      approvalPolicy: params?.approvalPolicy,
      approvalsReviewer: params?.approvalsReviewer,
      model: params?.model,
    });
    // Like Codex, a start reply carries no collaboration mode: new threads use Default.
    send({ jsonrpc: "2.0", id, result: { ...started, ...settingsReply() } });

    // Deferred (setTimeout, not sent synchronously alongside the thread/start
    // reply above): the client's `await` that assigns `this.#threadId` from
    // that reply is a queued microtask, not something that's run yet by the
    // time a synchronously-sent follow-up message would be parsed — a
    // message these particular mechanisms need `this.#threadId` to already
    // be set to test correctly (unlike LOOM_TEST_TOOL_CALL_SPEC below, which
    // predates that guard and doesn't depend on it). A macrotask tick is
    // enough to let it run first.
    const preNotification = process.env["LOOM_TEST_PRE_NOTIFICATION"];
    if (preNotification) {
      const { method, params } = JSON.parse(preNotification);
      setTimeout(() => {
        send({ jsonrpc: "2.0", method, params });
        send({
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "notification-marker",
              text: "notification delivered",
            },
          },
        });
      }, 0);
    }

    const spec = process.env["LOOM_TEST_TOOL_CALL_SPEC"];
    if (spec) {
      const { tool, arguments: toolArgs } = JSON.parse(spec);
      const reqId = nextOutgoingId++;
      pendingOutgoing.set(reqId, capture(process.env["LOOM_TEST_TOOL_CALL_RESULT_FILE"]));
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "item/tool/call",
        params: {
          threadId: started.thread.id,
          turnId: "fake-turn-1",
          callId: "fake-call-1",
          namespace: null,
          tool,
          arguments: toolArgs ?? {},
        },
      });
    }

    const userInputSpec = process.env["LOOM_TEST_USER_INPUT_SPEC"];
    if (userInputSpec) {
      const { questions } = JSON.parse(userInputSpec);
      const reqId = nextOutgoingId++;
      pendingOutgoing.set(reqId, capture(process.env["LOOM_TEST_USER_INPUT_RESULT_FILE"]));
      setTimeout(
        () =>
          send({
            jsonrpc: "2.0",
            id: reqId,
            method: "item/tool/requestUserInput",
            params: {
              threadId: started.thread.id,
              turnId: "fake-turn-1",
              itemId: "fake-item-1",
              questions: questions ?? [],
              isBlocking: true,
              autoResolutionMs: null,
            },
          }),
        0,
      );
    }

    const approvalSpec = process.env["LOOM_TEST_APPROVAL_SPEC"];
    if (approvalSpec) {
      const { method, threadId, params: approvalParams } = JSON.parse(approvalSpec);
      const reqId = nextOutgoingId++;
      pendingOutgoing.set(reqId, capture(process.env["LOOM_TEST_APPROVAL_RESULT_FILE"]));
      // Deferred an extra tick relative to the pre-notification above so a
      // subagent-thread test's `subAgentActivity` notification is guaranteed
      // to be processed (and recorded into `#subagentThreadIds`) first.
      setTimeout(
        () =>
          send({
            jsonrpc: "2.0",
            id: reqId,
            method,
            params: {
              threadId: threadId ?? started.thread.id,
              turnId: "fake-turn-1",
              itemId: "fake-approval-item-1",
              startedAtMs: Date.now(),
              ...approvalParams,
            },
          }),
        10,
      );
    }
    return;
  }
  if (method === "thread/resume" || method === "thread/fork") {
    if (process.env["LOOM_TEST_FAIL_STARTUP"]) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `fake app-server: forced ${method} failure` },
      });
      return;
    }
    const base = fixture("thread-resume");
    // Echo whether developerInstructions arrived, in the thread id, so tests
    // can assert on it through `CodexAppServerSession.resume()`'s public
    // `providerRef` without a new test-only hook into production code. A fork
    // names a new thread derived from the one it copied.
    const resumed = params?.developerInstructions
      ? `${base.thread.id}-with-instructions`
      : base.thread.id;
    const id_ = method === "thread/fork" ? `${params?.threadId}-fork` : resumed;
    // LOOM_TEST_RESUME_SETTINGS (JSON) is what Codex saved for the thread; a
    // `collaborationMode: null` there makes the reply omit the field.
    const saved = JSON.parse(process.env["LOOM_TEST_RESUME_SETTINGS"] || "{}");
    if (saved.collaborationMode) updateSettings({ collaborationMode: saved.collaborationMode });
    // A reviewer in the resume request replaces the saved one.
    updateSettings({
      approvalPolicy: params?.approvalPolicy,
      approvalsReviewer: params?.approvalsReviewer ?? saved.approvalsReviewer,
    });
    startedThreadId = id_;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        thread: { id: id_ },
        ...settingsReply(),
        ...(saved.collaborationMode === null
          ? {}
          : { collaborationMode: threadSettings.collaborationMode }),
      },
    });
    const replay = process.env["LOOM_TEST_USAGE_REPLAY"];
    if (replay)
      send({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: id_, turnId: "historical-turn", tokenUsage: JSON.parse(replay) },
      });
    return;
  }
  if (method === "turn/start") {
    turnStartCount++;
    // A turn runs under the collaboration mode in effect when it starts.
    // LOOM_TEST_PLAN_ITEM: a planning turn ends with that native proposed plan.
    const planning = threadSettings.collaborationMode.mode === "plan";
    const planId = `fake-plan-${turnStartCount}`;
    const completeTurn = () => {
      if (planning && process.env["LOOM_TEST_PLAN_ITEM"])
        send({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId: startedThreadId,
            turnId: "fake-turn-1",
            item: { type: "plan", id: planId, text: process.env["LOOM_TEST_PLAN_ITEM"] },
          },
        });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "fake-turn-1", status: "completed" } },
      });
    };
    const respondToTurnStart = () => {
      // LOOM_TEST_COMPLETE_TURN_WITH_REPLY: the reply and the turn's
      // completion (`=started`: with `turn/started` between them) in one
      // write, so the client reads them together — a turn that ends at once.
      const withReply = process.env["LOOM_TEST_COMPLETE_TURN_WITH_REPLY"];
      if (withReply) {
        const result = fixture("turn-start");
        const messages = [
          { jsonrpc: "2.0", id, result },
          ...(withReply === "started"
            ? [{ jsonrpc: "2.0", method: "turn/started", params: { turn: result.turn } }]
            : []),
          {
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { turn: { ...result.turn, status: "completed" } },
          },
        ];
        process.stdout.write(messages.map((m) => JSON.stringify(m) + "\n").join(""));
        return;
      }
      send({ jsonrpc: "2.0", id, result: fixture("turn-start") });
      const limits = process.env["LOOM_TEST_LIMITS_UPDATE"];
      if (limits) send({ method: "account/rateLimits/updated", params: JSON.parse(limits) });
      const usage = process.env["LOOM_TEST_USAGE_UPDATES"];
      if (usage)
        for (const update of JSON.parse(usage)) {
          send({
            jsonrpc: "2.0",
            method: "thread/tokenUsage/updated",
            params: {
              threadId: update.threadId ?? startedThreadId,
              turnId: "fake-turn-1",
              tokenUsage: update,
            },
          });
        }
      // A real turn finishes asynchronously via a notification, not the reply.
      // LOOM_TEST_HOLD_TURN=1 skips this so a test can act (e.g. call
      // `setMode`) while the turn is still genuinely open.
      if (!process.env["LOOM_TEST_HOLD_TURN"] && pendingOutgoing.size === 0) {
        setTimeout(() => {
          if (process.env["LOOM_TEST_TITLE_REPLY"])
            send({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId: startedThreadId,
                turnId: "fake-turn-1",
                item: {
                  type: "agentMessage",
                  id: "title",
                  text: process.env["LOOM_TEST_TITLE_REPLY"],
                },
              },
            });
          completeTurn();
        }, 0);
      }
      // Let tests complete a held turn naturally, without turn/interrupt.
      const release = process.env["LOOM_TEST_COMPLETE_TURN_FILE"];
      if (process.env["LOOM_TEST_HOLD_TURN"] && release) {
        const timer = setInterval(() => {
          if (!existsSync(release)) return;
          clearInterval(timer);
          completeTurn();
        }, 10);
      }
    };
    // LOOM_TEST_HOLD_TURN_START_CALL names which 1-indexed turn/start call to
    // hold (e.g. "2" holds only the *second* turn started in this session —
    // typically the fresh turn a `respondToPlan` transition starts, leaving
    // the first turn that actually gets the exit_plan tool call moving
    // normally). Same `${base}.received`/`${base}.release` protocol as
    // LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE, via LOOM_TEST_HOLD_TURN_START.
    const holdCall = Number(process.env["LOOM_TEST_HOLD_TURN_START_CALL"] || "0");
    const holdBase = process.env["LOOM_TEST_HOLD_TURN_START"];
    if (holdCall && turnStartCount === holdCall && holdBase) {
      try {
        writeFileSync(`${holdBase}.received`, "");
      } catch {
        // best effort
      }
      const releasePath = `${holdBase}.release`;
      const poll = setInterval(() => {
        if (existsSync(releasePath)) {
          clearInterval(poll);
          respondToTurnStart();
        }
      }, 10);
      return;
    }
    respondToTurnStart();
    return;
  }
  if (method === "turn/interrupt") {
    const marker = process.env["LOOM_TEST_INTERRUPT_MARKER_FILE"];
    if (marker) {
      try {
        writeFileSync(marker, "");
      } catch {
        // best effort
      }
    }
    // Simulates a request that was already in flight for the turn being
    // interrupted — e.g. a dynamic tool call the model made just before the
    // interrupt reached Codex. Fired regardless of LOOM_TEST_FAIL_TURN_INTERRUPT
    // below, tagged with the very turnId this request is interrupting, so the
    // client's own staleness guard (not this fixture) is what's under test.
    const afterInterruptSpec = process.env["LOOM_TEST_TOOL_CALL_AFTER_INTERRUPT_SPEC"];
    if (afterInterruptSpec && !afterInterruptFired) {
      afterInterruptFired = true;
      const { tool, arguments: toolArgs } = JSON.parse(afterInterruptSpec);
      const reqId = nextOutgoingId++;
      pendingOutgoing.set(reqId, capture(process.env["LOOM_TEST_APPROVAL_RESULT_FILE"]));
      send({
        jsonrpc: "2.0",
        id: reqId,
        method: "item/tool/call",
        params: {
          threadId: startedThreadId,
          turnId: params?.turnId ?? "fake-turn-1",
          callId: "fake-call-after-interrupt",
          namespace: null,
          tool,
          arguments: toolArgs ?? {},
        },
      });
    }
    if (process.env["LOOM_TEST_FAIL_TURN_INTERRUPT"]) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "fake app-server: forced turn/interrupt failure" },
      });
      return;
    }
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "thread/settings/update") {
    // LOOM_TEST_EXIT_ON_SETTINGS_UPDATE=1: the server dies with the update unanswered.
    if (process.env["LOOM_TEST_EXIT_ON_SETTINGS_UPDATE"]) process.exit(1);
    settingsUpdateCount++;
    // LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE_FROM (1-indexed) rejects that call and later ones.
    const failFrom = Number(process.env["LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE_FROM"] || "0");
    const respondNow = () => {
      if (
        process.env["LOOM_TEST_FAIL_THREAD_SETTINGS_UPDATE"] ||
        (failFrom && settingsUpdateCount >= failFrom)
      ) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: "fake app-server: forced thread/settings/update failure",
          },
        });
        return;
      }
      const changed = updateSettings(params);
      // Codex acknowledges first and reports the settings after; the knobs
      // reverse that order, or never report them at all.
      const notify =
        changed && !process.env["LOOM_TEST_SUPPRESS_SETTINGS_NOTIFICATION"] ? notifySettings : null;
      if (process.env["LOOM_TEST_SETTINGS_NOTIFICATION_FIRST"]) notify?.();
      send({ jsonrpc: "2.0", id, result: {} });
      if (!process.env["LOOM_TEST_SETTINGS_NOTIFICATION_FIRST"]) notify?.();
    };
    // A test can hold this response to simulate a slow settings RPC racing
    // against an independent interrupt()/close() — LOOM_TEST_HOLD_THREAD_
    // SETTINGS_UPDATE names a base path; `${base}.received` is written
    // immediately (so the test knows the request is genuinely in flight
    // before acting), and the response waits for `${base}.release` to exist.
    // LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE_CALL (1-indexed) holds only that call.
    const holdBase = process.env["LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE"];
    const holdCall = Number(process.env["LOOM_TEST_HOLD_THREAD_SETTINGS_UPDATE_CALL"] || "0");
    if (holdBase && (!holdCall || holdCall === settingsUpdateCount)) {
      try {
        writeFileSync(`${holdBase}.received`, "");
      } catch {
        // best effort
      }
      const releasePath = `${holdBase}.release`;
      const poll = setInterval(() => {
        if (existsSync(releasePath)) {
          clearInterval(poll);
          respondNow();
        }
      }, 10);
      return;
    }
    respondNow();
    return;
  }
  // LOOM_TEST_STEER=reject: the turn already ended (`expectedTurnId` no
  // longer matches). =echo: the steered input becomes a `userMessage` item
  // carrying its `clientUserMessageId` as `clientId`, as Codex reports it.
  if (method === "turn/steer" && process.env["LOOM_TEST_STEER"] === "reject") {
    send({ jsonrpc: "2.0", id, error: { code: -32600, message: "expected turn is not active" } });
    return;
  }
  if (method === "turn/steer" && process.env["LOOM_TEST_STEER"] === "echo") {
    send({ jsonrpc: "2.0", id, result: { turnId: params?.expectedTurnId } });
    send({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: startedThreadId,
        turnId: params?.expectedTurnId,
        item: {
          type: "userMessage",
          id: `user-${id}`,
          clientId: params?.clientUserMessageId ?? null,
          content: params?.input ?? [],
        },
      },
    });
    return;
  }
  if (
    method === "turn/steer" ||
    method === "turn/settings/update" ||
    method === "thread/compact/start"
  ) {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "collaborationMode/list") {
    // LOOM_TEST_COLLABORATION_MODES (JSON array) replaces Codex's presets;
    // LOOM_TEST_NO_COLLABORATION_MODES=1 makes the method unknown, as on older servers.
    if (process.env["LOOM_TEST_NO_COLLABORATION_MODES"]) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
      return;
    }
    const data = process.env["LOOM_TEST_COLLABORATION_MODES"]
      ? JSON.parse(process.env["LOOM_TEST_COLLABORATION_MODES"])
      : [
          { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
          { name: "Default", mode: "default", model: null, reasoning_effort: null },
        ];
    send({ jsonrpc: "2.0", id, result: { data } });
    return;
  }
  if (method === "model/list") {
    // LOOM_TEST_MODEL_LIST=endless pages forever with fresh cursors; =repeat
    // keeps handing back the same cursor — both for the discovery bounds.
    const mode = process.env["LOOM_TEST_MODEL_LIST"];
    if (mode === "endless" || mode === "repeat") {
      const n = Number(String(params?.cursor ?? "c0").slice(1)) + 1;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          data: [{ model: `m-${n}`, displayName: `M ${n}`, supportedReasoningEfforts: [] }],
          nextCursor: mode === "endless" ? `c${n}` : "c1",
        },
      });
      return;
    }
    const page =
      params?.cursor === "page2" ? fixture("model-list-page2") : fixture("model-list-page1");
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
