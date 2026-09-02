import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render, renderToString } from "ink";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { App } from "@loom/tui/app";
import { FooterArea, promptRows } from "@loom/tui/components";
import { initialState, reduce } from "@loom/tui/model";
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

/**
 * Poll the newest frame until it matches, or fail after `timeoutMs`. Steadier
 * than a fixed `delay` for actions that spawn a worktree — the `@oxc-node/core`
 * register hook adds enough per-import cost to blow a tight fixed wait.
 */
const waitFor = async (stdout: FakeOut, re: RegExp, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(stdout.last)) return;
    await delay(25);
  }
  assert.match(stdout.last, re);
};

const mount = (
  client: LoomClient,
  extra: Partial<Parameters<typeof App>[0]> = {},
  /** Terminal size override — layout regressions are width-sensitive. */
  size: { columns?: number; rows?: number } = {},
) => {
  const stdout = new FakeOut();
  if (size.columns !== undefined) stdout.columns = size.columns;
  if (size.rows !== undefined) stdout.rows = size.rows;
  const stdin = new FakeIn();
  const app = render(createElement(App, { client, ...extra }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdout, stdin, app };
};

/**
 * Each test gets its own daemon + repo so the fleet contents (and therefore
 * which session the TUI auto-selects) are deterministic. Create sessions
 * *before* mounting so they arrive in the `hello` snapshot; emit live events
 * *after*, once the client has subscribed.
 */
const harness = async (
  opts: { config?: string } = {},
): Promise<{
  h: Harness;
  connect: (replayHistory?: boolean) => Promise<LoomClient>;
  cleanup: () => Promise<void>;
}> => {
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
};

test("renders the fleet, tracks selection by key, and shows help", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", {
    prompt: "add a --json flag",
    status: "running",
    provider: "fake",
  });
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
  await client.request("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    stdin.feed(ESC);
    await delay(100);
    assert.match(stdout.last, /▍ loom/, "still rendering after esc — the UI did not exit");

    stdin.feed("n");
    await delay(100);
    assert.match(stdout.last, /new session/);
    assert.match(
      stdout.last,
      /\[manual\]/,
      "the mode chip is always shown (default reads as 'manual')",
    );
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

test("⌥t shows a dim notice when the session's model has no thinking-effort control", async () => {
  const { connect, cleanup } = await harness({ config: OAI_CFG });
  const client = await connect();
  await client.request<SessionSnapshot>("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "oai",
    model: "m1",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(180);
    stdin.feed("\x1bt"); // ⌥t — no "oai" model advertises thinking-effort support
    await delay(140);
    assert.match(stdout.last, /oai\/m1 has no thinking-effort control/i);
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
    assert.equal(
      after.find((x) => x.id === snap.id)?.mode,
      "plan",
      "the session was re-moded from the prompt",
    );
    assert.match(stdout.last, /\[plan\]/, "the prompt chip reflects it");
    assert.match(stdout.last, /switch to plan first/, "the half-typed message survived");

    stdin.feed("\x1bm"); // ⌥m — model picker for the target
    await delay(140);
    assert.match(stdout.last, /model · oai/i, "⌥m opened the model picker for the target");

    stdin.feed("\r"); // pick m1 → back to the send prompt with the draft
    await delay(160);
    assert.match(
      stdout.last,
      /switch to plan first/,
      "the draft comes back after the model switch",
    );
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("R raises a restart confirmation that esc dismisses", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", {
    prompt: "busy",
    status: "running",
    provider: "fake",
  });
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

test("X on a branched session offers a branch toggle; b disarms it", async () => {
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
    assert.match(stdout.last, /will also delete branch/i);

    stdin.feed("b"); // disarm it
    await delay(80);
    assert.match(stdout.last, /keep branch/i);

    stdin.feed("\r"); // confirm
    await delay(200);
    const list = await client.request<SessionSnapshot[]>("session.list");
    assert.ok(!list.some((x) => x.id === s.id));
    const branches = execFileSync("git", ["-C", h.repoRoot, "branch", "--list", branch], {
      encoding: "utf8",
    });
    assert.notEqual(branches.trim(), "", "branch was kept");
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

test("the palette's 'doctor' opens an overlay of tools, connectors and daemon vitals", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request<SessionSnapshot>("session.createStub", {
    prompt: "x",
    status: "idle",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(160);
    stdin.feed(" "); // leader
    await delay(100);
    stdin.feed("doctor");
    await delay(80);
    stdin.feed("\r");
    await waitFor(stdout, /loom — doctor/);
    assert.match(stdout.last, /connectors/);
    assert.match(stdout.last, /tilth/); // an mcp mount is listed
    assert.match(stdout.last, /ask_user, commit/); // the loom tools row

    stdin.feed(ESC);
    await delay(80);
    assert.doesNotMatch(stdout.last, /loom — doctor/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("the palette's 'view logs' opens the daemon + TUI logs in $EDITOR", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", { prompt: "x", status: "idle", provider: "fake" });

  const dir = mkdtempSync(join(tmpdir(), "loom-logtest-"));
  const daemonLog = join(dir, "daemon.log");
  const tuiLog = join(dir, "tui.log");
  writeFileSync(daemonLog, '{"scope":"daemon","msg":"daemon line"}\n');
  writeFileSync(tuiLog, '{"scope":"tui","msg":"tui line"}\n');

  const calls: Array<{
    text: string;
    ext: string | undefined;
    asideName: string | undefined;
    asideBody: string | undefined;
  }> = [];
  const openEditor = async (
    text: string,
    opts?: { ext?: string; aside?: { name: string; body: string } },
  ): Promise<string | null> => {
    calls.push({
      text,
      ext: opts?.ext,
      asideName: opts?.aside?.name,
      asideBody: opts?.aside?.body,
    });
    return null;
  };

  const { stdin, app } = mount(client, { logs: { daemon: daemonLog, tui: tuiLog }, openEditor });
  try {
    await delay(160);
    stdin.feed(" "); // leader
    await delay(100);
    stdin.feed("view logs");
    await delay(80);
    stdin.feed("\r");
    await delay(120);

    assert.equal(calls.length, 1, "openEditor was called once");
    const [handoff] = calls;
    assert.ok(handoff);
    assert.match(handoff.text, /daemon line/);
    assert.equal(handoff.ext, "log");
    assert.equal(handoff.asideName, "tui.log");
    assert.match(handoff.asideBody ?? "", /tui line/);
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
        (f) =>
          f.event.type === "assistant_text" && f.event.text === "something from an earlier viewing",
      ),
      "the client replayed the daemon's buffered history",
    );
    await delay(200);
    assert.match(
      stdout.last,
      /something from an earlier viewing/,
      "the TUI seeded its log from it",
    );
  } finally {
    app.unmount();
    await second.close();
    await cleanup();
  }
});

test("selecting a session backfills its durable history when the live ring doesn't have it", async () => {
  const { connect, cleanup } = await harness();
  const first = await connect();
  const s = await first.request<SessionSnapshot>("session.createStub", {
    prompt: "long-lived session",
    status: "running",
    provider: "fake",
  });
  await first.request("dev.emit", {
    event: { sessionId: s.id, type: "assistant_text", text: "persisted from a prior turn" },
  });
  await delay(80);
  await first.close();

  // No replayHistory: unlike the test above, this client's own ring starts
  // empty, so the old client's history can only reach the TUI via the new
  // per-session `session.events` fetch triggered by selecting the session.
  const second = await connect(false);
  assert.equal(second.bufferedEvents.length, 0);
  const { stdout, app } = mount(second);
  try {
    await delay(200);
    assert.match(
      stdout.last,
      /persisted from a prior turn/,
      "the TUI fetched the session's durable history on selection",
    );
  } finally {
    app.unmount();
    await second.close();
    await cleanup();
  }
});

test("a running session's send prompt asks asap vs turn-end; queue drains on idle", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "busy worker",
    provider: "fake",
  });
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
    stdin.feed("\r"); // bare Enter — sends now, no overlay
    await delay(150);
    assert.deepEqual(fs?.sends, ["hold that thought"]);

    // queue one while still running, via ⌥⏎
    stdin.feed("\r"); // Enter opens the send prompt
    await delay(80);
    stdin.feed("and another");
    await delay(80);
    stdin.feed("\x1b\r"); // ⌥⏎ — queue for turn end
    await delay(120);
    assert.match(stdout.last, /▸ 1 queued/, "the Detail pane shows the queue");

    fs?.finishTurn(); // -> idle: the queued message goes
    await delay(300);
    assert.deepEqual(fs?.sends, ["hold that thought", "and another"]);
    assert.doesNotMatch(stdout.last, /▸ \d+ queued/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("a queue on a session that never returns to idle is reported, not silently dropped", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "worker",
    provider: "fake",
  });
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
    stdin.feed("\x1b\r"); // ⌥⏎ — queue for turn end
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
      event: {
        sessionId: s.id,
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: { command: "npm publish" },
      },
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

test("a stale plan in pending never masks the permission the session is parked on", async () => {
  // The regression from the fleet: a plan that was approved while this client
  // was detached leaves an unresolvable `pending.plan` behind (nothing in the
  // event stream marks a plan resolved — here the tool_result carries an
  // unrelated id, as recorded by older daemons). When the session then parks
  // on a bash permission, the panel must describe the bash command — the
  // daemon's `status.on` names the parked request, the reconstruction only
  // feeds it.
  const { connect, cleanup } = await harness();
  const client = await connect();
  const s = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "stale plan",
    status: "awaiting_input",
    reason: "permission",
    provider: "fake",
  });
  const { stdout, app } = mount(client);
  try {
    await delay(150);
    await client.request("dev.emit", {
      event: { sessionId: s.id, type: "plan_review", id: "pr-old", plan: "1. long-approved step" },
    });
    await client.request("dev.emit", {
      event: { sessionId: s.id, type: "tool_result", id: "unrelated", ok: true, output: "" },
    });
    await client.request("dev.emit", {
      event: {
        sessionId: s.id,
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: { command: "npm publish" },
      },
    });
    await delay(250);
    assert.match(stdout.last, /PERMISSION — Bash/);
    assert.match(stdout.last, /npm publish/);
    assert.doesNotMatch(stdout.last, /PLAN REVIEW/);
    assert.doesNotMatch(stdout.last, /long-approved step/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("a plan review opens an overlay; `i` sends the implement decision", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "plan this",
    provider: "fake",
  });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(150);
    // Some context burned before the plan lands — the overlay meters it.
    fs?.finishTurn({ contextUsed: 42_000 });
    fs?.emit({
      type: "plan_review",
      id: "pr1",
      plan: "1. carve the seam\n2. wire the RPC\n3. paint the overlay",
    });
    await delay(200);
    // the request panel flags it
    assert.match(stdout.last, /PLAN REVIEW/);

    stdin.feed("a"); // open the overlay
    await delay(150);
    assert.match(stdout.last, /wire the RPC/);
    assert.match(stdout.last, /implement fresh/);
    assert.match(stdout.last, /42% context/, "the session's context meter");
    assert.match(stdout.last, /implementation mode \[acceptEdits\]/);

    // ⇧⇥ cycles the mode the implementation will run in.
    stdin.feed("\x1b[Z");
    await delay(120);
    assert.match(stdout.last, /implementation mode \[auto\]/);

    // `d` opens the discuss sub-prompt; esc backs out to the plan overlay,
    // NOT to browse (the daemon is still blocked on the decision).
    stdin.feed("d");
    await delay(120);
    assert.match(stdout.last, /discuss/i);
    stdin.feed("\x1b"); // esc
    await delay(120);
    assert.match(stdout.last, /wire the RPC/, "back on the plan overlay");
    assert.equal(fs?.planResponses.length, 0, "nothing was sent");

    stdin.feed("i"); // implement — in the mode `m` left selected
    await delay(200);
    assert.equal(fs?.planResponses.length, 1);
    assert.deepEqual(fs?.planResponses[0]?.decision, { action: "implement", mode: "auto" });
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("plan review · ⌥p retargets implement-fresh; a new provider forks a session", async () => {
  const { h, connect, cleanup } = await harness({ config: OAI_CFG });
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "plan this",
    provider: "fake",
  });
  const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(150);
    fs?.finishTurn({ contextUsed: 10_000 });
    fs?.emit({ type: "plan_review", id: "pr1", plan: "the approved plan body" });
    await delay(200);
    stdin.feed("a"); // open the overlay
    await delay(150);
    assert.match(stdout.last, /implement fresh →/);
    assert.match(stdout.last, /⌥p retarget/);

    stdin.feed("\x1bp"); // ⌥p — the retarget wizard
    await delay(120);
    assert.match(stdout.last, /retarget · provider/i);
    stdin.feed("oai");
    await delay(100);
    stdin.feed("\r"); // pick oai → model step
    await delay(120);
    assert.match(stdout.last, /retarget · model · oai/i);
    stdin.feed("\r"); // pick m1 → stage (oai advertises no effort levels)
    await delay(150);

    // back on the overlay: the target and the fork hint
    assert.match(stdout.last, /implement fresh → oai \/ m1/);
    assert.match(stdout.last, /fresh forked session/);

    const before = (await client.request<SessionSnapshot[]>("session.list")).length;
    stdin.feed("f"); // implement fresh → forks a fresh oai session
    await delay(250);
    assert.deepEqual(fs?.planResponses.at(-1)?.decision, { action: "handoff" });
    const after = await client.request<SessionSnapshot[]>("session.list");
    assert.equal(after.length, before + 1);
    const fork = after.find((s) => s.provider === "oai");
    assert.ok(fork, "a fresh oai session was forked from the plan");
    assert.equal(fork?.parentId, snap.id);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("sub-agents show in the Detail pane and prefix their log rows", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "spawn helpers",
    provider: "fake",
  });
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

test("→ drills into a session's children; EVENTS follows the focused child", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "spawn helpers",
    provider: "fake",
  });
  const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(150);
    fs?.emit({ type: "assistant_text", text: "mainline chatter" });
    fs?.emit({ type: "subagent_started", subagentId: "t1", name: "reviewer" });
    fs?.emit({ type: "assistant_text", text: "reviewing the diff", agentId: "t1" });
    await delay(220);
    assert.match(stdout.last, /⑂reviewer/, "the sub-agent's rows prefix in at fleet level");

    stdin.feed("\x1b[C"); // → — drill into the child rows
    await delay(220);
    // Breadcrumb + events header name the focused child; the pane narrows to
    // just that sub-agent's stream.
    assert.match(stdout.last, /FLEET · \S+ ▸ ⑂ reviewer/);
    assert.match(stdout.last, /EVENTS · ⑂ reviewer/);
    assert.match(stdout.last, /reviewing the diff/);
    assert.doesNotMatch(stdout.last, /mainline chatter/);

    stdin.feed("\x1b"); // esc — back out to the fleet
    await delay(220);
    assert.match(stdout.last, /mainline chatter/, "the full session stream returns");
    assert.doesNotMatch(stdout.last, /EVENTS · ⑂/, "the events header is back to plain");
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
  await client.request("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "fake",
  });
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
  await client.request("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "fake",
  });
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
  await client.request("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "fake",
  });
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

test("/ opens the find picker and filters the fleet by text", async () => {
  const { connect, cleanup } = await harness();
  const client = await connect();
  await client.request("session.createStub", {
    prompt: "refactor the parser",
    status: "idle",
    provider: "fake",
  });
  await client.request("session.createStub", {
    prompt: "update the docs",
    status: "idle",
    provider: "fake",
  });
  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    stdin.feed("/");
    await delay(120);
    assert.match(stdout.last, /FIND SESSION/);
    assert.match(stdout.last, /type to search/); // placeholder while the filter is empty
    assert.match(stdout.last, /refactor the parser/);
    assert.match(stdout.last, /update the docs/);

    stdin.feed("parser");
    await delay(120);
    assert.match(stdout.last, /refactor the parser/);
    assert.doesNotMatch(stdout.last, /update the docs/);

    stdin.feed("\x15"); // ⌃u — readline kill-to-start clears the filter
    await delay(120);
    assert.match(stdout.last, /update the docs/); // list un-narrows with it

    stdin.feed(ESC);
    await delay(100);
    assert.match(stdout.last, /▍ loom/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("u opens the undo picker listing every turn, newest last", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "the original task",
    provider: "fake",
  });
  const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
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
    // the latest turn is undoable too — pick it to rephrase what you just sent
    assert.match(stdout.last, /turn 3 · one more/);

    stdin.feed(ESC);
    await delay(80);
    assert.match(stdout.last, /▍ loom/);
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

test("picking a turn rewinds the session and reopens the prompt pre-filled", async () => {
  const { h, connect, cleanup } = await harness({
    config: `
[providers.openai]
adapter  = "aisdk"
base_url = "http://127.0.0.1:9/v1"
model    = "gpt-5"
`,
  });
  const client = await connect();
  const snap = await client.request<SessionSnapshot>("session.createStub", {
    prompt: "turn one prompt",
    status: "idle",
    provider: "openai",
  });
  const db = h.daemon.db;
  const insMsg = db.prepare(
    "INSERT INTO provider_messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, 0)",
  );
  for (let i = 0; i < 4; i++) insMsg.run(snap.id, i, i % 2 ? "assistant" : "user", `"m${i}"`);
  const insCp = db.prepare(
    "INSERT INTO checkpoints (session_id, turn, provider_ref, fork_point, user_text, created_at) VALUES (?, ?, '', ?, ?, 0)",
  );
  insCp.run(snap.id, 1, "2", "turn one prompt");
  insCp.run(snap.id, 2, "4", "the second prompt we will redo");
  db.prepare("UPDATE usage SET turns = 2 WHERE session_id = ?").run(snap.id);

  const { stdout, stdin, app } = mount(client);
  try {
    await delay(200);
    stdin.feed("u");
    await waitFor(stdout, /UNDO/);
    stdin.feed("redo"); // fuzzy-match narrows to the turn-2 row (matches its message)
    await delay(80);
    assert.match(stdout.last, /turn 2 · the second prompt/);
    assert.doesNotMatch(stdout.last, /turn 1 · turn one prompt/);
    stdin.feed("\r"); // enter → undo turn 2
    // the compose prompt is back (as if Enter had been pressed on the session),
    // pre-filled with turn 2's full message, ready to edit and re-send
    await waitFor(stdout, /send \[manual\]\n ▍ the second prompt we will redo/);
    assert.match(stdout.last, /↶ rewound to turn 1/); // the rewind landed

    // the transcript was truncated to turn 1 (2 messages kept) and turn 2's
    // checkpoint dropped
    const kept = db
      .prepare("SELECT COUNT(*) AS n FROM provider_messages WHERE session_id = ?")
      .get(snap.id) as { n: number };
    assert.equal(kept.n, 2);
    const cps = await client.request<Array<{ turn: number }>>("session.checkpoints", {
      id: snap.id,
    });
    assert.deepEqual(
      cps.map((c) => c.turn),
      [1],
    );
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
    await waitFor(stdout, /forked from .* @ turn 0/); // Detail lineage line
    assert.match(stdout.last, /⑂/); // the fork's id carries a fork glyph in the fleet
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// frame-height regression: a footer row that word-wraps (or a Detail pane
// taller than its budget) makes the frame taller than the terminal, the alt
// screen scrolls, and the top bar slides off. Ink frames carry one \n per
// physical row, so a stripped frame must split to exactly `rows` lines.
// ---------------------------------------------------------------------------

/* oxlint-disable no-control-regex -- stripping terminal escape sequences */
const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
/* oxlint-enable no-control-regex */

test("the footer notice owns a truncating row — hints + notice can never wrap", () => {
  const long = `injected “${"word ".repeat(30)}” — lands after the current tool call`;
  const state = reduce(initialState(), { t: "notice", text: long, tone: "good" });
  assert.equal(promptRows(state, 60), 3, "the layout reserves the notice's row");
  const out = renderToString(createElement(FooterArea, { state, width: 60 }));
  const lines = stripAnsi(out).split("\n");
  assert.equal(lines.length, 3, "notice + rule + hints, nothing wrapped");
  assert.match(lines[0]!, /✓ injected/, "the notice is tone-glyphed on its own row");
  assert.match(lines[1]!, /^─+$/, "the rule separates the notice from the hints");
  for (const line of lines) {
    assert.ok(line.length <= 60, `footer row exceeds the width: ${JSON.stringify(line)}`);
  }
});

test("a transient notice never grows the frame past the terminal height", async () => {
  const { connect, cleanup } = await harness({ config: OAI_CFG });
  const client = await connect();
  await client.request<SessionSnapshot>("session.createStub", {
    prompt: "a task",
    status: "idle",
    provider: "oai",
    model: "m1",
  });
  // 90 cols: the old footer put the notice at the end of the hints row, which
  // overflowed and word-wrapped at this width — growing the frame a row past
  // the terminal and pushing the top bar off the alt screen.
  const { stdout, stdin, app } = mount(client, {}, { columns: 90 });
  const frameLines = (): number => stripAnsi(stdout.last).split("\n").length;
  try {
    // ⌥t acts on the *selected* session — wait until the Detail pane shows it,
    // or the key lands before selection and is dropped.
    await waitFor(stdout, /engine oai/);
    assert.equal(frameLines(), stdout.rows, "the frame fills the terminal exactly");
    stdin.feed("\x1bt"); // ⌥t — no "oai" model advertises thinking-effort support
    await waitFor(stdout, /has no thinking-effort control/);
    assert.equal(
      frameLines(),
      stdout.rows,
      "the notice was absorbed into the footer budget — the frame did not grow",
    );
  } finally {
    app.unmount();
    await client.close();
    await cleanup();
  }
});
