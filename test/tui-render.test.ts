import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink";
import { LoomClient } from "../src/client/client.ts";
import type { SessionSnapshot } from "../src/protocol/wire.ts";
import { App } from "../src/tui/app.ts";
import type { FakeProvider } from "../src/provider/fake/fake.ts";
import { makeHarness, type Harness } from "./helpers.ts";

const ESC = "\x1b";


class FakeOut extends EventEmitter {
  columns = 120;
  rows = 40;
  frames: string[] = [];
  write = (s: string): boolean => {
    this.frames.push(s);
    return true;
  };
  get last(): string {
    return this.frames.at(-1) ?? "";
  }
}
class FakeIn extends EventEmitter {
  isTTY = true;
  #q: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.#q.shift() ?? null;
  }
  feed(s: string): void {
    this.#q.push(s);
    this.emit("readable");
  }
}

function mount(client: LoomClient) {
  const stdout = new FakeOut();
  const stdin = new FakeIn();
  const app = render(createElement(App, { client }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdout, stdin, app };
}

/**
 * Each test gets its own daemon + repo so the fleet contents (and therefore
 * which session the TUI auto-selects) are deterministic. Create sessions
 * *before* mounting so they arrive in the `hello` snapshot; emit live events
 * *after*, once the client has subscribed.
 */
async function harness(opts: { config?: string } = {}): Promise<{
  h: Harness;
  connect: (replayHistory?: boolean) => Promise<LoomClient>;
  cleanup: () => Promise<void>;
}> {
  const h = await makeHarness(opts);
  return {
    h,
    connect: (replayHistory = false) =>
      LoomClient.connect({
        repoRoot: h.repoRoot,
        sockPath: h.sockPath,
        autospawn: false,
        reconnect: true,
        replayHistory,
      }),
    cleanup: () => h.cleanup(),
  };
}

test("renders the fleet, tracks selection by key, and shows help", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", { prompt: "add a --json flag", status: "running", provider: "fake" });
  await client.request("session.createStub", {
    prompt: "write the release notes",
    status: "awaiting_input",
    reason: "permission",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    assert.match(stdout.last, /▍ loom/);
    assert.match(stdout.last, /AWAITING INPUT/);
    assert.match(stdout.last, /write the release notes/);
    assert.match(stdout.last, /approve/);
    assert.match(stdout.last, /deny/);

    stdin.feed("j");
    await delay(120);
    assert.match(stdout.last, /add a --json flag/);
    assert.match(stdout.last, /interrupt/);
    assert.doesNotMatch(stdout.last, /approve/);

    stdin.feed("?");
    await delay(120);
    assert.match(stdout.last, /loom — keys/);
    assert.match(stdout.last, /mark the session done/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("esc does not quit; only overlays back out", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", { prompt: "a task", status: "idle", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    stdin.feed(ESC);
    await delay(100);
    assert.match(stdout.last, /▍ loom/, "still rendering after esc — the UI did not exit");

    stdin.feed("n");
    await delay(100);
    assert.match(stdout.last, /new session/);
    assert.doesNotMatch(stdout.last, /\[default\]/, "no chip while the mode is the default");
    stdin.feed(ESC);
    await delay(100);
    assert.doesNotMatch(stdout.last, /new session/);

    stdin.feed("\x05"); // ⌃e in browse: there is no prompt to edit
    await delay(80);
    assert.match(stdout.last, /open a prompt first/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("R raises a restart confirmation that esc dismisses", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", { prompt: "busy", status: "running", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    stdin.feed("R");
    await delay(100);
    assert.match(stdout.last, /Restart the daemon\?/);
    assert.match(stdout.last, /will be interrupted/);
    stdin.feed(ESC);
    await delay(100);
    assert.doesNotMatch(stdout.last, /Restart the daemon\?/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("re-opening the TUI backfills the event log from the running daemon", async () => {
  const { connect, cleanup } = await harness();
  const first = await connect();
  const s = await first.request<SessionSnapshot>("session.createStub", {
    prompt: "long-lived session",
    status: "running",
    provider: "fake",
  });
  await first.request("dev.emit", {
    event: { sessionId: s.id, type: "assistant_text", text: "something from an earlier viewing" },
  });
  await delay(80);
  await first.close();

  const second = await connect(true);
  const { stdout, app } = mount(second);
  try {
    assert.ok(
      second.bufferedEvents.some(
        (f) => f.event.type === "assistant_text" && f.event.text === "something from an earlier viewing",
      ),
      "the client replayed the daemon's buffered history",
    );
    await delay(200);
    assert.match(stdout.last, /something from an earlier viewing/, "the TUI seeded its log from it");
  } finally {
    app.unmount();
    await second.close();
    await cleanup();
  }
});

test("a running session's send prompt asks asap vs turn-end; queue drains on idle", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", { prompt: "busy worker", provider: "fake" });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);
  fs?.emit({ type: "assistant_text", text: "working…" }); // -> running
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(180);
    stdin.feed("s");
    await delay(100);
    stdin.feed("hold that thought");
    await delay(100);
    stdin.feed("\r"); // Enter -> the choice modal (session is running)
    await delay(120);
    assert.match(stdout.last, /still working/);
    assert.match(stdout.last, /inject now/);
    assert.match(stdout.last, /the turn ends/);

    stdin.feed("t"); // queue for turn end
    await delay(150);
    assert.match(stdout.last, /▸ 1 queued/, "the Detail pane shows the queue");

    fs?.finishTurn(); // -> idle: the queued message is sent, the queue clears
    await delay(300);
    assert.doesNotMatch(stdout.last, /▸ \d+ queued/, "queue drained once the session went idle");
    assert.deepEqual(fs?.sends, ["hold that thought"]);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("SendChoice: a doubled keypress resolves the overlay once", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", { prompt: "busy", provider: "fake" });
  const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
  fs?.emit({ type: "assistant_text", text: "working…" });
  const { stdin, app } = mount(client);
  try {
    await delay(180);
    stdin.feed("s");
    await delay(80);
    stdin.feed("just once");
    await delay(80);
    stdin.feed("\r"); // -> SendChoice
    await delay(120);
    stdin.feed("a"); // resolve
    stdin.feed("a"); // ...again before the re-render — must be a no-op
    await delay(250);
    assert.deepEqual(fs?.sends, ["just once"], "resolved exactly once");
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("a queue on a session that never returns to idle is reported, not silently dropped", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", { prompt: "worker", provider: "fake" });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);
  fs?.emit({ type: "assistant_text", text: "working…" }); // -> running
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(180);
    stdin.feed("s");
    await delay(80);
    stdin.feed("later note");
    await delay(80);
    stdin.feed("\r"); // -> SendChoice
    await delay(100);
    stdin.feed("t"); // queue it
    await delay(150);
    assert.match(stdout.last, /▸ 1 queued/);

    fs?.fail("upstream exploded"); // -> error, never goes idle
    await delay(250);
    assert.match(stdout.last, /queued message.*not sent/i, "the stranded queue is surfaced");
    assert.doesNotMatch(stdout.last, /▸ \d+ queued/, "and cleared");
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("`e` renames the selected session via session.setTitle", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "old name",
    status: "idle",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    stdin.feed("e");
    await delay(100);
    assert.match(stdout.last, /rename/);
    stdin.feed("\x15"); // ⌃u clears the prefilled title in one keystroke
    await delay(40);
    stdin.feed("shiny new name");
    await delay(120);
    stdin.feed("\r");
    await delay(200);
    const after = await client.request<SessionSnapshot>("session.get", { id: s.id });
    assert.equal(after.title, "shiny new name");
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("the pending permission is spelled out in a panel", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "needs approval",
    status: "awaiting_input",
    reason: "permission",
    provider: "fake",
  });
  const { stdout, app } = mount(client);
  try {
    await delay(150);
    await client.request("dev.emit", {
      event: { sessionId: s.id, type: "permission_request", id: "p1", tool: "Bash", input: { command: "npm publish" } },
    });
    await delay(200);
    assert.match(stdout.last, /PERMISSION — Bash/);
    assert.match(stdout.last, /npm publish/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("a plan review opens an overlay; `i` sends the implement decision", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", { prompt: "plan this", provider: "fake" });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(150);
    fs?.emit({ type: "plan_review", id: "pr1", plan: "1. carve the seam\n2. wire the RPC\n3. paint the overlay" });
    await delay(200);
    // the request panel flags it
    assert.match(stdout.last, /PLAN REVIEW/);

    stdin.feed("a"); // open the overlay
    await delay(150);
    assert.match(stdout.last, /wire the RPC/);
    assert.match(stdout.last, /implement fresh/);

    // `d` opens the discuss sub-prompt; esc backs out to the plan overlay,
    // NOT to browse (the daemon is still blocked on the decision).
    stdin.feed("d");
    await delay(120);
    assert.match(stdout.last, /discuss/i);
    stdin.feed("\x1b"); // esc
    await delay(120);
    assert.match(stdout.last, /wire the RPC/, "back on the plan overlay");
    assert.equal(fs?.planResponses.length, 0, "nothing was sent");

    stdin.feed("i"); // implement
    await delay(200);
    assert.equal(fs?.planResponses.length, 1);
    assert.deepEqual(fs?.planResponses[0]?.decision, { action: "implement" });
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("sub-agents show in the Detail pane and prefix their log rows", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", { prompt: "spawn helpers", provider: "fake" });
  const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
  const { stdout, app } = mount(client);
  try {
    await delay(150);
    fs?.emit({ type: "subagent_started", subagentId: "t1", name: "reviewer" });
    fs?.emit({ type: "subagent_started", subagentId: "t2", name: "tester" });
    fs?.emit({ type: "assistant_text", text: "checking imports", agentId: "t1" });
    await delay(220);
    assert.match(stdout.last, /2\/2 sub-agents · reviewer, tester/);
    assert.match(stdout.last, /⑂reviewer/);

    fs?.emit({ type: "subagent_stopped", subagentId: "t1" });
    await delay(180);
    assert.match(stdout.last, /reviewer ✓, tester/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("Tab toggles the fullscreen event log", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "look at logs",
    status: "running",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(150);
    await client.request("dev.emit", {
      event: { sessionId: s.id, type: "assistant_text", text: "hello from the agent" },
    });
    await delay(120);
    assert.doesNotMatch(stdout.last, /fullscreen/);

    stdin.feed("\t");
    await delay(120);
    assert.match(stdout.last, /EVENTS · fullscreen/);
    assert.doesNotMatch(stdout.last, /FLEET/);

    stdin.feed("\t");
    await delay(120);
    assert.match(stdout.last, /FLEET/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("N opens the provider → model picker, then the new-session prompt", async () => {
  const { connect, cleanup } = await harness({
    config: `
[providers.openai]
adapter  = "aisdk"
base_url = "http://x/v1"
model    = "gpt-5"
models   = ["gpt-5", "gpt-5-mini", "o4"]
`,
  });
  const client = await connect();
  await client.request("session.createStub", { prompt: "a task", status: "idle", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(220);
    stdin.feed("N");
    await delay(120);
    assert.match(stdout.last, /PROVIDER/);
    assert.match(stdout.last, /openai/);

    stdin.feed("\r"); // pick the highlighted provider (claude — first row)
    await delay(120);
    // claude has no model list → straight to the new prompt
    assert.match(stdout.last, /new/i);

    stdin.feed(ESC);
    await delay(80);
    stdin.feed("N");
    await delay(100);
    stdin.feed("openai");
    await delay(100);
    stdin.feed("\r"); // pick openai
    await delay(120);
    assert.match(stdout.last, /MODEL/);
    assert.match(stdout.last, /gpt-5-mini/);

    stdin.feed("mini");
    await delay(100);
    stdin.feed("\r");
    await delay(120);
    assert.match(stdout.last, /new session/i);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("f opens the find picker and filters the fleet by text", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", { prompt: "refactor the parser", status: "idle", provider: "fake" });
  await client.request("session.createStub", { prompt: "update the docs", status: "idle", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    stdin.feed("f");
    await delay(120);
    assert.match(stdout.last, /FIND SESSION/);
    assert.match(stdout.last, /refactor the parser/);
    assert.match(stdout.last, /update the docs/);

    stdin.feed("parser");
    await delay(120);
    assert.match(stdout.last, /refactor the parser/);
    assert.doesNotMatch(stdout.last, /update the docs/);

    stdin.feed(ESC);
    await delay(100);
    assert.match(stdout.last, /▍ loom/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("u opens the undo picker listing earlier turns", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", { prompt: "the original task", provider: "fake" });
  const fs = (await h.daemon.providers.get("fake") as FakeProvider).session(snap.id);
  fs?.finishTurn(); // turn 1
  await delay(60);
  await client.request("session.send", { id: snap.id, text: "a follow-up" });
  fs?.finishTurn(); // turn 2
  await delay(60);
  await client.request("session.send", { id: snap.id, text: "one more" });
  fs?.finishTurn(); // turn 3
  await delay(80);

  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    assert.match(stdout.last, /u\b/); // footer offers undo on an idle multi-turn session
    stdin.feed("u");
    await delay(150);
    assert.match(stdout.last, /UNDO/);
    assert.match(stdout.last, /turn 1 · the original task/);
    assert.match(stdout.last, /turn 2 · a follow-up/);
    assert.doesNotMatch(stdout.last, /turn 3/); // can't rewind to the current turn

    stdin.feed(ESC);
    await delay(80);
    assert.match(stdout.last, /▍ loom/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("⌃f forks the selected aisdk session; the fork shows its lineage", async () => {
  const { h, connect, cleanup } = await harness({
    config: `
[providers.openai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "gpt-5"
`,
  });
  const client = await connect();
  const parent = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "trunk work",
    status: "idle",
    provider: "openai",
  });
  const db = h.daemon.db;
  const ins = db.prepare(
    "INSERT INTO provider_messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, 0)",
  );
  for (let i = 0; i < 2; i++) ins.run(parent.id, i, i % 2 ? "assistant" : "user", `"m${i}"`);

  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    stdin.feed("\x06"); // ⌃f
    await delay(300);
    assert.match(stdout.last, /⑂/); // the fork's id carries a fork glyph in the fleet
    assert.match(stdout.last, /forked from .* @ turn 0/); // Detail lineage line
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});
