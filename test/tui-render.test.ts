import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink";
import { LoomClient } from "../src/client/client.ts";
import type { SessionSnapshot } from "../src/protocol/wire.ts";
import { App } from "../src/tui/app.ts";
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

let h: Harness;
before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

function connect(replayHistory = false): Promise<LoomClient> {
  return LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
    replayHistory,
  });
}

test("renders the fleet, tracks selection by key, and shows help", async () => {
  const client = await connect();
  await client.request("session.createStub", { prompt: "add a --json flag", status: "running", provider: "fake" });
  await client.request("session.createStub", {
    prompt: "write the release notes",
    status: "awaiting_input",
    reason: "permission",
    provider: "fake",
  });

  const { stdout, stdin, app } = mount(client);
  await delay(200);
  assert.match(stdout.last, /▍ loom/);
  assert.match(stdout.last, /FLEET/);
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
  stdin.feed("?");
  await delay(80);

  app.unmount();
  await client.close();
});

test("esc does not quit; only overlays back out", async () => {
  const client = await connect();
  await client.request("session.createStub", { prompt: "a task", status: "idle", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  await delay(160);

  stdin.feed(ESC);
  await delay(100);
  assert.match(stdout.last, /▍ loom/, "still rendering after esc — the UI did not exit");

  // n opens the prompt, esc backs out of it
  stdin.feed("n");
  await delay(100);
  assert.match(stdout.last, /new session/);
  assert.doesNotMatch(stdout.last, /\[default\]/, "no chip while the mode is the default");
  stdin.feed(ESC);
  await delay(100);
  assert.doesNotMatch(stdout.last, /new session/);

  app.unmount();
  await client.close();
});

test("R raises a restart confirmation that esc dismisses", async () => {
  const client = await connect();
  await client.request("session.createStub", { prompt: "busy", status: "running", provider: "fake" });
  const { stdout, stdin, app } = mount(client);
  await delay(160);

  stdin.feed("R");
  await delay(100);
  assert.match(stdout.last, /Restart the daemon\?/);
  assert.match(stdout.last, /will be interrupted/);
  stdin.feed(ESC);
  await delay(100);
  assert.doesNotMatch(stdout.last, /Restart the daemon\?/);

  app.unmount();
  await client.close();
});

test("re-opening the TUI backfills the event log from the running daemon", async () => {
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

  // a brand-new client, the way `loom tui` opens one on a second run
  const second = await connect(true);
  const { stdout, stdin, app } = mount(second);
  try {
    assert.ok(
      second.bufferedEvents.some(
        (f) => f.event.type === "assistant_text" && f.event.text === "something from an earlier viewing",
      ),
      "the client replayed the daemon's buffered history",
    );
    stdin.feed("f"); // show all sessions — selection is unpredictable across this file's stubs
    await delay(200);
    assert.match(stdout.last, /something from an earlier viewing/, "the TUI seeded its log from it");
  } finally {
    app.unmount();
    await second.close();
  }
});

test("Tab toggles the fullscreen event log", async () => {
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "look at logs",
    status: "running",
    provider: "fake",
  });
  await client.request("dev.emit", { event: { sessionId: s.id, type: "assistant_text", text: "hello from the agent" } });

  const { stdout, stdin, app } = mount(client);
  await delay(200);
  assert.doesNotMatch(stdout.last, /fullscreen/);

  stdin.feed("\t");
  await delay(120);
  assert.match(stdout.last, /EVENTS · fullscreen/);
  assert.doesNotMatch(stdout.last, /FLEET/);

  stdin.feed("\t");
  await delay(120);
  assert.match(stdout.last, /FLEET/);

  app.unmount();
  await client.close();
});
