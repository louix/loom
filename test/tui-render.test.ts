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

/** Minimal stand-ins for process.stdout / process.stdin that Ink accepts. */
class FakeOut extends EventEmitter {
  columns = 120;
  rows = 36;
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

let h: Harness;
before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.cleanup();
});

test("the TUI renders the fleet, tracks selection, and shows help", async () => {
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
  });

  await client.request("session.createStub", {
    prompt: "add a --json flag to the CLI",
    status: "running",
    provider: "fake",
  });
  await client.request("session.createStub", {
    prompt: "write the release notes",
    status: "awaiting_input",
    reason: "permission",
    provider: "fake",
  });

  const stdout = new FakeOut();
  const stdin = new FakeIn();
  const app = render(createElement(App, { client }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await delay(200);
  assert.match(stdout.last, /▍ loom/);
  assert.match(stdout.last, /FLEET/);
  assert.match(stdout.last, /EVENTS/);
  assert.match(stdout.last, /AWAITING INPUT/);
  assert.match(stdout.last, /write the release notes/);
  // awaiting_input sorts first and is auto-selected → its verbs are in the footer
  assert.match(stdout.last, /approve/);
  assert.match(stdout.last, /deny/);

  // move down to the running session; footer verbs follow the selection
  stdin.feed("j");
  await delay(120);
  assert.match(stdout.last, /add a --json flag/);
  assert.match(stdout.last, /interrupt/);
  assert.doesNotMatch(stdout.last, /approve/);

  // help overlay
  stdin.feed("?");
  await delay(120);
  assert.match(stdout.last, /loom — keys/);
  assert.match(stdout.last, /mark the session done/);

  app.unmount();
  await client.close();
});

test("a live event pushed after mount lands in the event log", async () => {
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
  });
  const created = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "investigate the flake",
    status: "running",
    provider: "fake",
  });

  const stdout = new FakeOut();
  const stdin = new FakeIn();
  const app = render(createElement(App, { client }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await delay(150);

  // select the new session, then drive an event into it
  await client.request("dev.emit", {
    event: { sessionId: created.id, type: "assistant_text", text: "reading the worktree test" },
  });
  await delay(150);

  // it is selected if it is the only running one; otherwise switch the filter
  stdin.feed("f");
  await delay(120);
  assert.match(stdout.last, /reading the worktree test/);

  app.unmount();
  await client.close();
});
