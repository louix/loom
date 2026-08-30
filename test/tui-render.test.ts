import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { App } from "@loom/tui/app";
import type { FakeProvider } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

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
    // request mode: the footer drops the actions that don't resolve the request
    assert.doesNotMatch(stdout.last, /rename/);
    assert.doesNotMatch(stdout.last, /budget/);

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
    assert.match(stdout.last, /\[manual\]/, "the mode chip is always shown (default reads as 'manual')");
    stdin.feed(ESC);
    await delay(100);
    assert.doesNotMatch(stdout.last, /new session/);

    stdin.feed("\x05"); // ⌃e outside the prompt: Ctrl is editing-only, inert here
    await delay(80);
    assert.match(stdout.last, /▍ loom/, "still rendering — ⌃e did nothing in browse");
    assert.doesNotMatch(stdout.last, /new session/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

const OAI_CFG = `
[providers.oai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
models   = ["m1", "m2"]
`;

test("⇧⇥ cycles the mode and ⌥m opens the model picker on the selected session", async () => {
  const { connect, cleanup } = await harness({ config: OAI_CFG });
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "oai",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(180);
    assert.match(stdout.last, /\[manual\]/, "Detail shows the mode as a bracketed chip");

    stdin.feed("\x1b[Z"); // ⇧⇥ — cycle the permission mode
    await delay(160);
    const after = await client.request<SessionSnapshot[]>("session.list");
    assert.equal(after.find((x) => x.id === snap.id)?.mode, "plan", "⇧⇥ cycled manual → plan");
    assert.match(stdout.last, /\[plan\]/, "the Detail chip follows the change");

    stdin.feed("\x1bm"); // ⌥m — the model switcher (M is retired)
    await delay(140);
    assert.match(stdout.last, /model · oai/i, "⌥m opened the model picker");
    assert.match(stdout.last, /m1/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("⇧⇥ / ⌥m re-mode and re-model the target session from inside the send prompt", async () => {
  const { connect, cleanup } = await harness({ config: OAI_CFG });
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "oai",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(180);
    stdin.feed("\r"); // Enter opens the send prompt
    await delay(100);
    stdin.feed("switch to plan first");
    await delay(80);
    assert.match(stdout.last, /\[manual\]/, "the send prompt shows the session's current mode");

    stdin.feed("\x1b[Z"); // ⇧⇥ — cycle the live session's mode, message untouched
    await delay(160);
    const after = await client.request<SessionSnapshot[]>("session.list");
    assert.equal(after.find((x) => x.id === snap.id)?.mode, "plan", "the session was re-moded from the prompt");
    assert.match(stdout.last, /\[plan\]/, "the prompt chip reflects it");
    assert.match(stdout.last, /switch to plan first/, "the half-typed message survived");

    stdin.feed("\x1bm"); // ⌥m — model picker for the target
    await delay(140);
    assert.match(stdout.last, /model · oai/i, "⌥m opened the model picker for the target");

    stdin.feed("\r"); // pick m1 → back to the send prompt with the draft
    await delay(160);
    assert.match(stdout.last, /switch to plan first/, "the draft comes back after the model switch");
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

test("X deletes the selected session behind a confirm", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "throwaway",
    status: "idle",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    // delete is second-tier — reachable via X (or the palette), not the footer
    assert.doesNotMatch(stdout.last, /delete/);

    stdin.feed("X");
    await delay(100);
    assert.match(stdout.last, /Delete session/);

    stdin.feed(ESC);
    await delay(80);
    assert.doesNotMatch(stdout.last, /Delete session/);

    // a stub has no branch → the confirm offers no branch toggle
    stdin.feed("X");
    await delay(80);
    assert.doesNotMatch(stdout.last, /also delete branch/i);

    stdin.feed("\r"); // confirm
    await delay(150);
    const list = await client.request<SessionSnapshot[]>("session.list");
    assert.ok(!list.some((x) => x.id === s.id), "the row is gone");
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("X on a branched session offers a branch toggle; b arms it", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.create", {
    prompt: "kill this branch",
    provider: "fake",
  });
  const branch = s.branch as string;
  assert.ok(branch);
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    stdin.feed("X");
    await delay(100);
    assert.match(stdout.last, /Delete session/);
    assert.match(stdout.last, /also delete branch/i);

    stdin.feed("b"); // arm it
    await delay(80);
    assert.match(stdout.last, /will also delete branch/i);

    stdin.feed("\r"); // confirm
    await delay(200);
    const list = await client.request<SessionSnapshot[]>("session.list");
    assert.ok(!list.some((x) => x.id === s.id));
    const branches = execFileSync("git", ["-C", h.repoRoot, "branch", "--list", branch], {
      encoding: "utf8",
    });
    assert.equal(branches.trim(), "", "branch was deleted too");
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("Space opens the command palette; a filtered pick runs the action", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "rename me via the palette",
    status: "idle",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    stdin.feed(" "); // leader
    await delay(100);
    assert.match(stdout.last, /COMMANDS/);
    assert.match(stdout.last, /rename/);

    stdin.feed("rename");
    await delay(80);
    stdin.feed("\r"); // run it
    await delay(120);
    assert.match(stdout.last, /rename/); // the rename prompt is now open
    assert.doesNotMatch(stdout.last, /COMMANDS/);

    stdin.feed("\x15"); // ⌃u clear the prefilled title
    await delay(40);
    stdin.feed("palette win");
    await delay(80);
    stdin.feed("\r");
    await delay(200);
    const after = await client.request<SessionSnapshot>("session.get", { id: s.id });
    assert.equal(after.title, "palette win");
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
    stdin.feed("\r"); // Enter opens the send prompt
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

    // queue a second one while still running
    stdin.feed("\r"); // Enter opens the send prompt
    await delay(80);
    stdin.feed("and another");
    await delay(80);
    stdin.feed("\r");
    await delay(100);
    stdin.feed("t");
    await delay(120);
    assert.match(stdout.last, /▸ 2 queued/);

    fs?.finishTurn(); // -> idle: only ONE queued message goes per completed turn
    await delay(300);
    assert.deepEqual(fs?.sends, ["hold that thought"], "one per turn, not a burst");
    assert.match(stdout.last, /▸ 1 queued/, "the second is still queued");

    fs?.finishTurn(); // the send()'s turn completes -> release the next
    await delay(300);
    assert.deepEqual(fs?.sends, ["hold that thought", "and another"]);
    assert.doesNotMatch(stdout.last, /▸ \d+ queued/);
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
    stdin.feed("\r"); // Enter opens the send prompt
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
    stdin.feed("\r"); // Enter opens the send prompt
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

test("n shows the provider / model; ⌥p opens the chooser and returns to the prompt", async () => {
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
    stdin.feed("n");
    await delay(120);
    // the prompt names the provider it will use and its default model
    assert.match(stdout.last, /new session/i);
    assert.match(stdout.last, /claude/);
    assert.match(stdout.last, /claude-sonnet-5/);

    stdin.feed("\x1bp"); // ⌥p → provider chooser
    await delay(120);
    assert.match(stdout.last, /PROVIDER/);
    assert.match(stdout.last, /openai/);

    stdin.feed("\r"); // pick the highlighted provider (claude — first row)
    await delay(120);
    // claude now carries a curated model list
    assert.match(stdout.last, /MODEL/);
    assert.match(stdout.last, /claude-sonnet-5/);
    stdin.feed("\r"); // pick the highlighted model, back to the prompt
    await delay(120);
    assert.match(stdout.last, /new session/i);

    stdin.feed("\x1bp"); // ⌥p again
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
    assert.match(stdout.last, /gpt-5-mini/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("⌥p model step shows an empty state when a provider has no models", async () => {
  const { connect, cleanup } = await harness({
    config: `
[providers.oai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
`,
  });
  const client = await connect();
  await client.request("session.createStub", { prompt: "a task", status: "idle", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(220);
    stdin.feed("n");
    await delay(120);
    stdin.feed("\x1bp"); // ⌥p
    await delay(120);
    stdin.feed("oai");
    await delay(100);
    stdin.feed("\r"); // pick oai
    await delay(140);
    assert.match(stdout.last, /MODEL/);
    assert.match(stdout.last, /no models detected for "oai"/i);
    stdin.feed("\r"); // enter continues anyway
    await delay(120);
    assert.match(stdout.last, /new/i);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("⌥p keeps what's already typed in the new-session prompt", async () => {
  const { connect, cleanup } = await harness({
    config: `
[providers.openai]
adapter  = "aisdk"
base_url = "http://x/v1"
model    = "gpt-5"
models   = ["gpt-5", "gpt-5-mini"]
`,
  });
  const client = await connect();
  await client.request("session.createStub", { prompt: "a task", status: "idle", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(220);
    stdin.feed("n");
    await delay(120);
    stdin.feed("fix the parser bug");
    await delay(100);
    stdin.feed("\x1bp"); // ⌥p
    await delay(120);
    stdin.feed("openai");
    await delay(100);
    stdin.feed("\r"); // pick openai
    await delay(120);
    stdin.feed("\r"); // pick the first model
    await delay(120);
    assert.match(stdout.last, /new session/i);
    assert.match(stdout.last, /fix the parser bug/);
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
    assert.match(stdout.last, /type to search/); // placeholder while the filter is empty
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
    stdin.feed("u"); // undo is second-tier (palette / help), but the key still works
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

test("F forks the selected aisdk session; the fork shows its lineage", async () => {
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
    stdin.feed("F"); // hard fork
    await delay(300);
    assert.match(stdout.last, /⑂/); // the fork's id carries a fork glyph in the fleet
    assert.match(stdout.last, /forked from .* @ turn 0/); // Detail lineage line
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});
