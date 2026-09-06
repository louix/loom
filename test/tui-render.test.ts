import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render, renderToString, type Key } from "ink";
import { LoomClient } from "@loom/client";
import type { ClientState } from "@loom/client";
import { loadableIdle, loadableLoaded, loadablePending } from "@loom/core/loadable";
import { stateAwaitingInput, stateIdle, stateRunning } from "@loom/core/session-state";
import { LOOM_VERSION } from "@loom/core/version";
import type { SessionInteraction } from "@loom/core/interaction";
import type {
  DaemonInfo,
  HistoryCursor,
  HistoryPage,
  PushFrame,
  SessionSnapshot,
} from "@loom/core/wire";
import { App } from "@loom/tui/app";
import {
  askQuestionLines,
  FooterArea,
  logRowCount,
  PromptPane,
  promptPaneRows,
  promptRows,
  RequestPanel,
  requestPanelRows,
} from "@loom/tui/components";
import {
  mkFleetHandle,
  type FleetClient,
  type FleetHandle,
  type Term,
} from "@loom/tui/fleet-handle";
import {
  initialState,
  makePrompt,
  queueFor,
  reduce,
  requestsFor,
  sessionLog,
  TRANSCRIPT_CAP,
  transcriptFor,
} from "@loom/tui/model";
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
const waitFor = async (
  stdout: FakeOut,
  cond: RegExp | ((last: string) => boolean),
  timeoutMs = 3000,
): Promise<void> => {
  const ok = typeof cond === "function" ? cond : (s: string) => cond.test(s);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok(stdout.last)) return;
    await delay(25);
  }
  if (typeof cond === "function") {
    assert.ok(ok(stdout.last), `waitFor predicate never held; last frame:\n${stdout.last}`);
  } else {
    assert.match(stdout.last, cond);
  }
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
  connect: () => Promise<LoomClient>;
  cleanup: () => Promise<void>;
}> => {
  const h = await makeHarness(opts);
  return {
    h,
    connect: () =>
      LoomClient.connect({
        repoRoot: h.repoRoot,
        sockPath: h.sockPath,
        autospawn: false,
        reconnect: true,
      }),
    cleanup: () => h.cleanup(),
  };
};

// Every test below is fully self-contained — its own harness (daemon + temp
// git repo), client, ink instance and fake streams — so they overlap safely.
// The suite's wall time is dominated by this file's serial chain of paced UI
// tests; 4-way overlap cuts it to roughly a quarter. Bounded (not `true`) so a
// small machine doesn't host every daemon at once.
describe("tui-render", { concurrency: 4 }, () => {
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
      assert.match(stdout.last, /archive the session/);
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
      await delay(360); // clear the 300ms setMode debounce
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

  test("a left click selects a FLEET row and cycles the DETAIL [mode] chip", async () => {
    /* oxlint-disable no-control-regex -- stripping terminal escape sequences */
    const strip = (s: string): string =>
      s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    /* oxlint-enable no-control-regex */

    const { connect, cleanup } = await harness();
    const client = await connect();
    await client.request<SessionSnapshot>("session.createStub", {
      prompt: "the other task",
      status: "running",
      provider: "fake",
    });
    const target = await client.request<SessionSnapshot>("session.createStub", {
      prompt: "click target task",
      status: "idle",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(client);

    // The one non-header line carrying the fleet cursor glyph.
    const cursorRow = (): string =>
      strip(stdout.last)
        .split("\n")
        .find((l) => l.includes("▍") && !l.includes("loom")) ?? "";
    // 1-based screen row / column of a substring in the current frame.
    const at = (needle: string): { col: number; row: number } => {
      const lines = strip(stdout.last).split("\n");
      const row = lines.findIndex((l) => l.includes(needle));
      return { row: row + 1, col: lines[row]!.indexOf(needle) + 1 };
    };
    const click = (p: { col: number; row: number }): void =>
      stdin.feed(`\x1b[<0;${p.col};${p.row}M`);

    try {
      await waitFor(stdout, (t) => /the other task/.test(t) && /click target task/.test(t));
      assert.match(cursorRow(), /the other task/, "the running session is selected first");

      click(at("click target task"));
      await waitFor(stdout, () => /click target task/.test(cursorRow()));

      await waitFor(stdout, /\[manual\]/);
      click(at("[manual]"));
      await waitFor(stdout, /\[plan\]/);
      await delay(360); // clear the 300ms setMode debounce
      const after = await client.request<SessionSnapshot[]>("session.list");
      assert.equal(
        after.find((x) => x.id === target.id)?.mode,
        "plan",
        "the click cycled the mode",
      );

      // A click on empty space in the events pane is inert.
      const before = cursorRow();
      click({ col: 118, row: 30 });
      await delay(80);
      assert.equal(cursorRow(), before, "a click that hits no region changes nothing");
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
      await delay(360); // clear the 300ms setMode debounce
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

  test("a held readline motion whose repeats Ink batched into one chunk still repeats", async () => {
    const { connect, cleanup } = await harness();
    const client = await connect();
    await client.request("session.createStub", {
      prompt: "a task",
      status: "idle",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(client);
    try {
      await delay(180);
      stdin.feed("\r"); // open the send prompt
      await delay(100);
      stdin.feed("alpha beta gamma delta");
      await delay(80);
      assert.match(stdout.last, /alpha beta gamma delta/);
      // Three ⌃w arriving as one coalesced chunk — how Ink hands over a key held
      // through a render lag. Without the replay, parseKeypress drops the whole
      // "\x17\x17\x17" run and nothing happens after the first word.
      stdin.feed("\x17\x17\x17");
      await delay(80);
      assert.match(stdout.last, /▍ alpha$/m, "all three ⌃w landed — only the first word is left");
      assert.doesNotMatch(stdout.last, /beta|gamma|delta/);
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

  test("re-opening the TUI reads the session's history back from the daemon", async () => {
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

    // A fresh client sees none of that on its push stream — it wasn't attached.
    // The transcript is a fetched resource, so the `session.events` page pulled
    // when the session is selected is the one and only path it arrives by.
    const second = await connect();
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

  test("scrolling to the top of the log pages in older durable history on demand", async () => {
    const { connect, cleanup } = await harness();
    const first = await connect();
    const s = await first.request<SessionSnapshot>("session.createStub", {
      prompt: "a session with a long back-history",
      status: "running",
      provider: "fake",
    });
    // Nine durable events, only ever seen by this now-closed client.
    for (let i = 1; i <= 9; i++) {
      await first.request("dev.emit", {
        event: { sessionId: s.id, type: "assistant_text", text: `history line ${i}` },
      });
    }
    await delay(80);
    await first.close();

    // Fresh client, empty ring: this history reaches the TUI only through paged
    // `session.events` fetches. Page size 3 → the newest 3 on select, older ones
    // only once the viewport nears the top.
    const second = await connect();
    const { stdout, stdin, app } = mount(second, { historyPageSize: 3 }, { rows: 24 });
    try {
      await waitFor(stdout, /history line 9/);
      assert.match(stdout.last, /history line 7/, "the first page (newest 3) is shown");
      assert.doesNotMatch(stdout.last, /history line 6/, "older pages are not fetched yet");

      stdin.feed("\x1b[5~"); // PgUp — nears the top, pulls the next older page
      await waitFor(stdout, /history line 6/);
      assert.match(stdout.last, /history line 4/, "the second page folded in above");

      stdin.feed("\x1b[5~"); // PgUp again — back to the very first event
      await waitFor(stdout, /history line 1/);

      // One more page request returns [] and latches `done`; further PgUp is a
      // no-op (no churn, no crash) and the top of the log stays put.
      stdin.feed("\x1b[5~");
      stdin.feed("\x1b[5~");
      await delay(120);
      assert.match(stdout.last, /history line 1/, "still anchored at the first event");
    } finally {
      app.unmount();
      await second.close();
      await cleanup();
    }
  });

  test("PgUp climbs to the very top of a wrapped log (scroll math is physical rows)", async () => {
    const { connect, cleanup } = await harness();
    const first = await connect();
    const s = await first.request<SessionSnapshot>("session.createStub", {
      prompt: "a session with heavily wrapped output",
      status: "running",
      provider: "fake",
    });
    // Six messages whose text wraps to dozens of screen rows each: a handful of
    // logical log lines, hundreds of physical rows. Regression: the scroll
    // ceiling was computed from the *logical* line count, so PgUp froze partway
    // up a wrapped log, unable to reach its start.
    for (let i = 1; i <= 6; i++) {
      await first.request("dev.emit", {
        event: {
          sessionId: s.id,
          type: "assistant_text",
          text: `wrapped-${i}-top ${"wrap ".repeat(300)}`,
        },
      });
    }
    await delay(80);
    await first.close();

    const second = await connect();
    const { stdout, stdin, app } = mount(second);
    try {
      // The tail view shows event 6's wrapped filler; its head row is a page up.
      await waitFor(stdout, /wrap wrap wrap/);
      for (let i = 0; i < 40 && !/wrapped-1-top/.test(stdout.last); i++) {
        stdin.feed("\x1b[5~"); // PgUp
        await delay(50);
      }
      assert.match(stdout.last, /wrapped-1-top/, "PgUp reaches the first event's first row");
    } finally {
      app.unmount();
      await second.close();
      await cleanup();
    }
  });

  test("paging a wrapped log folds in older pages and reaches the first event", async () => {
    const { connect, cleanup } = await harness();
    const first = await connect();
    const s = await first.request<SessionSnapshot>("session.createStub", {
      prompt: "a paged session with wrapped output",
      status: "running",
      provider: "fake",
    });
    // Nine heavily wrapped events (~16 screen rows each) paged 3 at a time: every
    // fold-in lands a few dozen wrapped rows ABOVE the viewport while it is
    // pinned at the top, so paging to the first event exercises the fold + re-pin
    // path at real wrap factors.
    for (let i = 1; i <= 9; i++) {
      await first.request("dev.emit", {
        event: {
          sessionId: s.id,
          type: "assistant_text",
          text: `page${i}-head ${"filler ".repeat(120)}`,
        },
      });
    }
    await delay(80);
    await first.close();

    // Drive the real fleet handle — the App minus ink. The view updates
    // synchronously on every dispatch, so assertions read state instead of
    // racing ink's render delivery, which has no latency bound on a fake stdout.
    const second = await connect();
    const handle = mkFleetHandle({
      client: second,
      term: {
        exit: () => {},
        suspendTerminal: async () => {},
        write: () => {},
        isTTY: true,
        getSize: () => ({ cols: 120, rows: 40 }),
        onResize: () => () => {},
      },
      historyPageSize: 3,
    });
    const teardown = handle.effectStart();
    try {
      const pressPgUp = (): void => handle.handleKey("", { pageUp: true } as Key);
      const oldest = (): string => sessionLog(handle.getView().state)[0]?.text ?? "";
      // Gate on the log COUNT: the fold dispatches land in the view's state
      // synchronously, while rendered-output checks race ink's delivery.
      const climbTo = async (): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (sessionLog(handle.getView().state).length < 9 && Date.now() < deadline) {
          pressPgUp(); // pins the top and pulls the next-older page
          await delay(100);
        }
      };

      await climbTo();
      assert.equal(sessionLog(handle.getView().state).length, 9, "every page folded in");
      assert.match(oldest(), /^page1-head/, "the climb reaches the very first event");
      // Keep climbing: the viewport must be able to reach the log's top. (The
      // original bug clamped `logScroll` against the *logical* line count, which
      // strands it partway up a wrapped log no matter how many times you press.)
      // A fixed generous burst — no early exits — so the endpoint is deterministic.
      for (let i = 0; i < 15; i++) {
        pressPgUp();
        await delay(30);
      }
      const view = handle.getView();
      const paneWidth = view.body === "split" ? view.rightW : view.cols;
      const top = Math.max(0, logRowCount(view.state, paneWidth) - view.logPage);
      assert.equal(view.logScroll, top, "the viewport reaches the log's top");

      // Past the start the done latch fires: further PgUp neither moves nor churns.
      pressPgUp();
      pressPgUp();
      assert.equal(sessionLog(handle.getView().state).length, 9, "no churn past the start");
      assert.equal(handle.getView().logScroll, top, "still pinned at the log's top");
    } finally {
      teardown();
      await second.close();
      await cleanup();
    }
  });

  test("a scrolled-back log stays pinned as new events land; Home/End jump to the ends", async () => {
    const { connect, cleanup } = await harness();
    const first = await connect();
    const s = await first.request<SessionSnapshot>("session.createStub", {
      prompt: "a chatty session",
      status: "running",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(first, {}, { rows: 22 });
    try {
      await waitFor(stdout, /EVENTS/);
      // Thirty short lines, streamed in after the client subscribed.
      for (let i = 1; i <= 30; i++) {
        await first.request("dev.emit", {
          event: {
            sessionId: s.id,
            type: "assistant_text",
            text: `pinline-${String(i).padStart(2, "0")}`,
          },
        });
      }
      await waitFor(stdout, /pinline-30/);

      // Scroll back a couple of pages: the border turns accent and older lines
      // are now in view, the live tail is gone.
      stdin.feed("\x1b[5~");
      stdin.feed("\x1b[5~");
      await waitFor(stdout, /pinline-18/);
      assert.doesNotMatch(stdout.last, /pinline-30/, "scrolled off the live tail");
      const visible = (frame: string): string[] =>
        [...frame.matchAll(/pinline-\d\d/g)].map((m) => m[0]);
      const before = visible(stdout.last);

      // A fresh event lands at the tail — the viewport must not move: the exact
      // same lines render and the new one stays below the window.
      await first.request("dev.emit", {
        event: { sessionId: s.id, type: "assistant_text", text: "brandnew-line" },
      });
      await delay(150);
      assert.deepEqual(visible(stdout.last), before, "the scrolled viewport held still");
      assert.doesNotMatch(stdout.last, /brandnew-line/, "the new line stayed below the window");

      // End snaps back to the live tail; the new line is there.
      stdin.feed("\x1b[F");
      await waitFor(stdout, /brandnew-line/);
      assert.doesNotMatch(stdout.last, /pinline-01/, "End is at the bottom, not the top");

      // Home jumps to the very first line held.
      stdin.feed("\x1b[H");
      await waitFor(stdout, /pinline-01/);
      assert.doesNotMatch(stdout.last, /brandnew-line/, "Home is at the top, not the bottom");
    } finally {
      app.unmount();
      await first.close();
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
    const { h, connect, cleanup } = await harness();
    const client = await connect();
    const s = await client.request<SessionSnapshot>("session.create", {
      prompt: "needs approval",
      provider: "fake",
    });
    const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
    const fs = fake.session(s.id);
    const { stdout, app } = mount(client);
    try {
      await delay(150);
      fs?.emit({
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: { command: "npm publish" },
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

  test("an answered plan still in the transcript never masks the request the session is parked on", async () => {
    // The regression from the fleet: an answered plan used to leave an
    // unresolvable `pending.plan` behind, because the client reconstructed the
    // request set from the event stream and nothing in that stream marks a plan
    // resolved. The request set is the daemon's now — the plan_review stays in
    // the transcript, where it belongs, and stops being something to answer.
    const { h, connect, cleanup } = await harness();
    const client = await connect();
    const s = await client.request<SessionSnapshot>("session.create", {
      prompt: "stale plan",
      provider: "fake",
    });
    const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
    const fs = fake.session(s.id);
    const { stdout, app } = mount(client);
    try {
      await delay(150);
      fs?.emit({ type: "plan_review", id: "pr-old", plan: "1. long-approved step" });
      await delay(150);
      await client.request("session.respondPlan", {
        id: s.id,
        requestId: "pr-old",
        action: "implement",
      });
      fs?.emit({
        type: "permission_request",
        id: "p1",
        tool: "Bash",
        input: { command: "npm publish" },
      });
      await delay(250);
      assert.match(stdout.last, /PERMISSION — Bash/);
      assert.match(stdout.last, /npm publish/);
      assert.doesNotMatch(stdout.last, /PLAN REVIEW/);
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

  test("plan review · a long plan scrolls; esc backs out and `a` re-opens", async () => {
    const { h, connect, cleanup } = await harness();
    const client = await connect();
    const snap = await client.request<SessionSnapshot>("session.create", {
      prompt: "plan this",
      provider: "fake",
    });
    const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    const { stdout, stdin, app } = mount(client);
    try {
      await delay(150);
      const plan = Array.from({ length: 25 }, (_, i) => `${i + 1}. step ${i + 1} of the plan`).join(
        "\n",
      );
      fs?.emit({ type: "plan_review", id: "pr1", plan });
      await delay(200);

      stdin.feed("a"); // open the overlay
      await delay(150);
      assert.match(stdout.last, /implement — the agent proceeds/, "the overlay is open");
      assert.match(stdout.last, /1\. step 1 of the plan/, "top of the plan is visible");
      assert.doesNotMatch(stdout.last, /25\. step 25 of the plan/, "the tail is below the fold");
      assert.match(
        stdout.last,
        /↕ lines 1–\d+ of 25 {2}· {2}PgUp\/PgDn/,
        "the scroll-position indicator",
      );

      stdin.feed("\x1b[6~"); // PgDn
      await delay(120);
      assert.match(stdout.last, /25\. step 25 of the plan/, "PgDn reveals the tail");
      assert.doesNotMatch(stdout.last, /1\. step 1 of the plan/);

      stdin.feed("\x1b[5~"); // PgUp — back to the top
      await delay(120);
      assert.match(stdout.last, /1\. step 1 of the plan/);
      assert.doesNotMatch(stdout.last, /25\. step 25 of the plan/);

      // esc backs out to the fleet without answering — the daemon stays blocked,
      // so the request panel keeps flagging the review and `a` re-opens it.
      stdin.feed(ESC);
      await delay(120);
      assert.doesNotMatch(stdout.last, /implement — the agent proceeds/, "overlay closed");
      assert.match(stdout.last, /PLAN REVIEW/, "request panel still flags the pending review");
      assert.equal(fs?.planResponses.length, 0, "nothing was sent to the daemon");

      stdin.feed("a"); // re-open
      await delay(150);
      assert.match(stdout.last, /implement — the agent proceeds/, "the overlay is back");
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("sub-agents show in the Detail pane; their frames stay in the subtree", async () => {
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
      assert.doesNotMatch(
        stdout.last,
        /checking imports/,
        "a sub-agent's frames stay in its subtree, out of the main stream",
      );

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
      assert.doesNotMatch(
        stdout.last,
        /reviewing the diff/,
        "the sub-agent's stream stays in its subtree at fleet level",
      );

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

  test("⇥ toggles the fleet list; esc brings it back", async () => {
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
      await waitFor(stdout, /FLEET/);

      stdin.feed("\t"); // overview → session: detail + events, no fleet column
      await waitFor(stdout, (t) => /engine fake/.test(t) && !/FLEET/.test(t));

      stdin.feed("\t"); // …and back: the fleet list returns
      await waitFor(stdout, (t) => /FLEET/.test(t) && /engine fake/.test(t));

      stdin.feed("\t"); // into session again…
      await waitFor(stdout, (t) => /engine fake/.test(t) && !/FLEET/.test(t));
      stdin.feed("\x1b"); // …and esc snaps straight back to overview
      await waitFor(stdout, /FLEET/);
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("a narrow terminal hides detail + events until ⇥ swaps to the session pane", async () => {
    const { connect, cleanup } = await harness();
    const client = await connect();
    const s = await client.request<SessionSnapshot>("session.createStub", {
      prompt: "narrow layout task",
      status: "running",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(client, {}, { columns: 60 });
    try {
      await client.request("dev.emit", {
        event: { sessionId: s.id, type: "assistant_text", text: "one column now" },
      });
      // overview: the fleet list alone — no detail, no events, no switcher bar.
      await waitFor(stdout, /FLEET/);
      assert.doesNotMatch(stdout.last, /EVENTS/);
      assert.doesNotMatch(stdout.last, /engine fake/);
      assert.doesNotMatch(stdout.last, /⇥ next/);

      stdin.feed("\t"); // → the session pane: detail + events, full width
      await waitFor(stdout, (t) => /EVENTS/.test(t) && /one column now/.test(t));
      assert.doesNotMatch(stdout.last, /FLEET/);

      stdin.feed("\t"); // → back to the fleet list
      await waitFor(stdout, (t) => /FLEET/.test(t) && !/EVENTS/.test(t));
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("→ still only drills into children — the layout zoom is on ⇥, not the arrows", async () => {
    const { h, connect, cleanup } = await harness();
    const client = await connect();
    const snap = await client.request<SessionSnapshot>("session.create", {
      prompt: "spawn helpers",
      provider: "fake",
    });
    const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    const { stdout, stdin, app } = mount(client, {}, { columns: 60 });
    try {
      await delay(150);
      fs?.emit({ type: "assistant_text", text: "mainline chatter" });
      fs?.emit({ type: "subagent_started", subagentId: "t1", name: "reviewer" });
      fs?.emit({ type: "assistant_text", text: "reviewing the diff", agentId: "t1" });
      await waitFor(stdout, /⑂ reviewer/);

      // → drills into the child rows and stays on the fleet list — it does not
      // change the layout view.
      stdin.feed("\x1b[C");
      await waitFor(stdout, /▸ ⑂ reviewer/);
      assert.match(stdout.last, /FLEET/);
      assert.doesNotMatch(stdout.last, /EVENTS/);

      // ← backs out of the drill-down, still on the fleet list.
      stdin.feed("\x1b[D");
      await waitFor(stdout, (t) => !/▸ ⑂ reviewer/.test(t));
      assert.match(stdout.last, /FLEET/);
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("a wide terminal shows the full split", async () => {
    const { connect, cleanup } = await harness();
    const client = await connect();
    await client.request("session.createStub", {
      prompt: "wide layout task",
      status: "running",
      provider: "fake",
    });
    const { stdout, app } = mount(client, {}, { columns: 120 });
    try {
      await waitFor(stdout, /engine fake/);
      assert.match(stdout.last, /FLEET/);
      assert.match(stdout.last, /EVENTS/);
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
      // claude's catalog wasn't probed here (standalone daemon) — the model step
      // shows its empty state and enter continues with the configured model
      assert.match(stdout.last, /MODEL/);
      assert.match(stdout.last, /claude uses its configured model/);
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

  /** The Detail pane's title line — the selected session's title, a row under
   *  the DETAIL header. Tells the selection apart from the fleet's own rows. */
  const detailTitle = (frame: string): string => {
    const lines = frame
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n");
    const i = lines.findIndex((l) => l.includes("DETAIL"));
    return lines.slice(i + 1, i + 3).join(" ");
  };

  test("/ filters the fleet in place; ↑↓ keep moving the selection", async () => {
    const { connect, cleanup } = await harness();
    const client = await connect();
    await client.request("session.createStub", {
      prompt: "refactor the parser",
      status: "idle",
      provider: "fake",
    });
    // A beat between the two so their `updatedAt` differs: `sortSessions` puts
    // the newer "update the docs" first, and its final tie-break is the random
    // session UUID — a coin flip that otherwise flakes the ↑ assertion below.
    await delay(5);
    await client.request("session.createStub", {
      prompt: "update the docs",
      status: "idle",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(client);
    try {
      await waitFor(stdout, /refactor the parser/);
      stdin.feed("/");
      await waitFor(stdout, /type to filter/); // the inline filter line on FLEET
      assert.match(stdout.last, /refactor the parser/);
      assert.match(stdout.last, /update the docs/);

      stdin.feed("parser");
      await waitFor(stdout, (s) => !/update the docs/.test(s)); // narrowed to the match
      assert.match(stdout.last, /refactor the parser/);

      stdin.feed("\x15"); // ⌃u — readline kill-to-start clears the filter
      await waitFor(stdout, /update the docs/); // list un-narrows with it

      // A query matching both rows, then ↑: the selection moves — the arrows are
      // NOT swallowed by the filter — and the Detail pane follows it. (The fleet
      // order puts the docs session first, so ↑ walks onto it.)
      stdin.feed("the");
      await waitFor(stdout, (s) => /refactor the parser/.test(detailTitle(s)));
      stdin.feed("\x1b[A"); // ↑
      await waitFor(stdout, (s) => /update the docs/.test(detailTitle(s)));

      stdin.feed(ESC); // esc clears + closes the filter
      await waitFor(stdout, (s) => !/type to filter/.test(s));
      assert.match(stdout.last, /▍ loom/);
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("with a query up the fleet is one flat, ranked list; 'term pins a literal", async () => {
    const { connect, cleanup } = await harness();
    const client = await connect();
    // Created oldest-first so "unrelated chatter" heads the fleet (newest): the
    // filtered order must be decided by ranking, not recency.
    await client.request("session.createStub", {
      prompt: "mobile layouts",
      status: "idle",
      provider: "fake",
    });
    await delay(5);
    await client.request("session.createStub", {
      prompt: "demobilize the depot",
      status: "idle",
      provider: "fake",
    });
    await delay(5);
    await client.request("session.createStub", {
      prompt: "unrelated chatter",
      status: "idle",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(client);
    try {
      await waitFor(stdout, /unrelated chatter/);
      assert.match(stdout.last, /IDLE/); // closed filter: the grouped view

      stdin.feed("/");
      await waitFor(stdout, /type to filter/);
      stdin.feed("mobile");
      await waitFor(stdout, (s) => !/IDLE/.test(s)); // filtering: one flat list, no headers
      assert.match(stdout.last, /FLEET · 2\/3 matches/);
      // "mobile layouts" carries the cursor (the selection rode onto the best
      // match) and sits above the scattered m…o…b…i…l…e hit inside "demobilize".
      const lines = stdout.last
        // oxlint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n");
      const cursor = lines.findIndex((l) => l.includes("▍") && l.includes("mobile layouts"));
      const weak = lines.findIndex((l) => l.includes("demobilize"));
      assert.notEqual(cursor, -1, "the best match is selected");
      assert.notEqual(weak, -1, "the weaker match is still listed");
      assert.ok(cursor < weak, "the best match is listed first");

      stdin.feed("\x15"); // ⌃u — clear, then an exact term: "demobilize" has no "mobile"
      stdin.feed("'mobile");
      await waitFor(stdout, (s) => !/demobilize/.test(s));
      assert.match(stdout.last, /FLEET · 1\/3 match\b/);
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

    // The rows above were written straight into the DB, behind the daemon's
    // back — nothing published a snapshot for them. Attach the UI's client
    // afterwards so its opening snapshot reads the seeded state (`u` is only
    // offered on a session with turns to undo).
    const uiClient = await connect();
    const { stdout, stdin, app } = mount(uiClient);
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
      // pre-filled with turn 2's full message, ready to edit and re-send — it
      // draws on the session's EVENTS pane (label row, then the input line)
      await waitFor(stdout, /send \[manual\][\s\S]*?▍ the second prompt we will redo/);
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
      await uiClient.close();
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

  test("the pane reply input never ellipsizes or overdraws its wrapped rows", () => {
    // The pane prompt used to wrap to 2 columns more than the pane actually gave
    // the editor (paneRoom forgot the caret gutter), so every room-filling row
    // overflowed its Text and Ink mangled it — a `…` with the row's last chars
    // hidden under it, and (now that the editor never ellipsizes) a hard-wrapped
    // extra physical line that overdraws the frame budget. At width 40 the room
    // is 34: this 36-x word hard-breaks into a full row plus "xx tail".
    const state = reduce(initialState(), {
      t: "openPrompt",
      prompt: makePrompt({
        kind: "send",
        sessionId: "a",
        label: "send",
        text: `${"x".repeat(36)} tail`,
      }),
    });
    const out = stripAnsi(renderToString(createElement(PromptPane, { state, width: 40 })));
    assert.ok(!out.includes("…"), "the editor must never ellipsize its own text");
    assert.ok(out.includes("x".repeat(34)), "a room-filling row draws every column");
    // The pane draws exactly the height the layout budgeted for it, and each
    // editor row keeps its `▍ ` gutter cell — a too-wide row can neither grow
    // the frame nor crowd the gutter.
    const lines = stripAnsi(out).split("\n");
    assert.equal(lines.length, promptPaneRows(state, 40), "the pane fits its row budget");
    const editorLines = lines.filter((line) => line.includes("▍") || line.includes("⋮"));
    assert.equal(editorLines.length, promptPaneRows(state, 40) - 1 /* label row */);
    for (const line of editorLines) {
      assert.match(line, /^ *▍ /, `the gutter keeps its cell: ${JSON.stringify(line)}`);
    }
  });

  const QUESTIONS = [
    {
      question: "Which auth method should we use for the API?",
      header: "Auth",
      options: [
        { label: "OAuth 2.0", description: "delegated, needs an IdP" },
        { label: "API keys", description: "simplest, rotate manually" },
        { label: "mTLS", description: "certs on both ends" },
        { label: "JWT bearer", description: "stateless, short-lived" },
      ],
    },
    {
      question: "Where should sessions live?",
      header: "Sessions",
      options: [{ label: "Redis" }, { label: "Postgres" }],
    },
  ];

  const askRequest = (input: unknown = { questions: QUESTIONS }): SessionInteraction => ({
    kind: "user_question",
    id: "p1",
    tool: "AskUserQuestion",
    input,
    at: 1,
  });

  test("the request panel expands to show every option of the active question", () => {
    const request = askRequest();
    // every option letter is present — not clipped at a) b) like the old fixed
    // 5-row body did
    const out = stripAnsi(renderToString(createElement(RequestPanel, { request, width: 80 })));
    for (const letter of ["a)", "b)", "c)", "d)"]) {
      assert.ok(out.includes(letter), `option ${letter} is rendered: ${JSON.stringify(out)}`);
    }
    assert.match(out, /OAuth 2\.0/);
    assert.match(out, /JWT bearer/);
    // the reserved height matches what actually renders, so the frame can't
    // overflow or leave a gap
    assert.equal(
      out.split("\n").length,
      requestPanelRows(request, 80, 0),
      "panel height equals its reservation",
    );
  });

  test("requestPanelRows tracks the previewed question and caps its growth", () => {
    const request = askRequest();
    const q0 = requestPanelRows(request, 80, 0);
    const q1 = requestPanelRows(request, 80, 1);
    assert.ok(q0 > q1, "the 4-option question reserves more rows than the 2-option one");
    // a pathological question can't grow the panel without bound
    const huge = {
      questions: [
        {
          question: "pick one",
          header: "x",
          options: Array.from({ length: 40 }, (_, i) => ({ label: `option ${i}` })),
        },
      ],
    };
    assert.ok(requestPanelRows(askRequest(huge), 80, 0) <= 18, "body is capped");
  });

  test("a non-question permission keeps the fixed panel height", () => {
    const request: SessionInteraction = {
      kind: "permission",
      id: "p1",
      tool: "Bash",
      input: { command: "npm publish" },
      at: 1,
    };
    assert.equal(requestPanelRows(request, 80, 0), 8);
  });

  test("askQuestionLines letters every option and returns them all", () => {
    const lines = askQuestionLines(QUESTIONS, 0, 76);
    assert.ok(lines.some((l) => /a\) OAuth 2\.0 — delegated/.test(l)));
    assert.ok(lines.some((l) => /d\) JWT bearer/.test(l)));
    // clamps out-of-range indices rather than throwing
    assert.deepEqual(askQuestionLines(QUESTIONS, 99, 76), askQuestionLines(QUESTIONS, 1, 76));
  });

  test("the answer footer says esc steps back to the panel, not cancel", () => {
    const state = reduce(initialState(), {
      t: "openPrompt",
      prompt: makePrompt({
        kind: "answerQuestion",
        sessionId: "a",
        requestId: "p1",
        label: "answer 1/2: Auth",
        qaAll: QUESTIONS,
        qaIdx: 0,
        qaAnswers: {},
      }),
    });
    const out = stripAnsi(renderToString(createElement(FooterArea, { state, width: 120 })));
    assert.match(out, /esc back/);
    assert.doesNotMatch(out, /esc cancel/);
    assert.doesNotMatch(out, /⇥/, "no tab binding is advertised");
    assert.match(out, /⌥o view/);
  });

  test("the request-panel hint offers ←/→ only for a multi-question call", () => {
    const multi = stripAnsi(
      renderToString(createElement(RequestPanel, { request: askRequest(), width: 90 })),
    );
    assert.match(multi, /←\/→ question/);
    const one = stripAnsi(
      renderToString(
        createElement(RequestPanel, {
          request: askRequest({ questions: [QUESTIONS[0]!] }),
          width: 90,
        }),
      ),
    );
    assert.doesNotMatch(one, /←\/→ question/);
  });

  test("AskUserQuestion · esc drops to the panel, ←/→ pick a question, answers land in any order", async () => {
    const { h, connect, cleanup } = await harness();
    const client = await connect();
    const snap = await client.request<SessionSnapshot>("session.create", {
      prompt: "ask me things",
      provider: "fake",
    });
    const fs = ((await h.daemon.providers.get("fake")) as FakeProvider).session(snap.id);
    const { stdout, stdin, app } = mount(client);
    try {
      await delay(150);
      fs?.emit({
        type: "permission_request",
        id: "q1",
        tool: "AskUserQuestion",
        input: { questions: QUESTIONS },
      });
      // the panel spells out every option of question 1, not just a) b)
      await waitFor(stdout, /QUESTION \(1\/2\)/);
      assert.match(stdout.last, /a\) OAuth 2\.0/);
      assert.match(stdout.last, /d\) JWT bearer/);

      stdin.feed("a"); // open the answer prompt for question 1
      await waitFor(stdout, /answer 1\/2/);
      stdin.feed("API keys");
      stdin.feed(ESC); // esc → back to the panel, keeping the typed answer
      await waitFor(stdout, (t) => /QUESTION \(1\/2\)/.test(t) && !/answer 1\/2/.test(t));

      stdin.feed("\x1b[C"); // → move the panel to question 2
      await waitFor(stdout, /QUESTION \(2\/2\)/);
      assert.match(stdout.last, /Where should sessions live\?/);

      stdin.feed("a"); // answer question 2
      await waitFor(stdout, /answer 2\/2/);
      stdin.feed("Postgres");
      stdin.feed("\r"); // question 1 already answered → this resolves the call
      await waitFor(stdout, () => (fs?.permissionResponses.length ?? 0) > 0);
      assert.equal(fs?.permissionResponses.length, 1, "resolved exactly once");
      const resolved = fs!.permissionResponses[0]!;
      assert.equal(resolved.id, "q1");
      // the daemon carries the collected answers through to the provider, keyed
      // by question text, regardless of the order they were typed in
      const decision = resolved.decision as {
        behavior: string;
        updatedInput: { answers: Record<string, string> };
      };
      assert.equal(decision.behavior, "allow");
      assert.deepEqual(decision.updatedInput.answers, {
        "Which auth method should we use for the API?": "API keys",
        "Where should sessions live?": "Postgres",
      });
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
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
});

// ---------------------------------------------------------------------------
// The handle's daemon-feed effects, driven against a client the test controls.
//
// These are about *when* the handle acts, not what it draws: a dropped
// connection is not an empty fleet, a page in flight belongs to the generation
// that asked for it, and a queued message whose send never came back is not
// re-sent on its own. A real daemon cannot hold a response open or deliver
// `pending` on cue, so these drive `mkFleetHandle` directly.
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
}

/** A {@link FleetClient} whose snapshots and RPC settlements are the test's to
 *  drive. Every request parks in `calls` until answered by hand. */
const mkFakeClient = () => {
  const snapshotFns = new Set<(s: ClientState) => void>();
  const pushFns = new Set<(f: PushFrame) => void>();
  const calls: FakeCall[] = [];
  let current: ClientState = loadableIdle;

  const client: FleetClient = {
    clientId: "test-client",
    daemonInfo: null,
    request: <T>(method: string, params?: unknown): Promise<T> => {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const p = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      calls.push({ method, params: (params ?? {}) as Record<string, unknown>, resolve, reject });
      return p as Promise<T>;
    },
    subscribe: (fn) => {
      snapshotFns.add(fn);
      fn(current);
      return () => snapshotFns.delete(fn);
    },
    onPush: (fn) => {
      pushFns.add(fn);
      return () => pushFns.delete(fn);
    },
    on: () => () => {},
    close: () => Promise.resolve(),
  };

  const events = (): FakeCall[] => calls.filter((c) => c.method === "session.events");
  return {
    client,
    calls,
    /** Publish a new authoritative state, exactly as the real client would. */
    deliver: (s: ClientState): void => {
      current = s;
      for (const fn of snapshotFns) fn(s);
    },
    of: (method: string): FakeCall[] => calls.filter((c) => c.method === method),
    /** Deliver one live push frame, as the real client would. */
    push: (frame: PushFrame): void => {
      for (const fn of pushFns) fn(frame);
    },
    /** Newest-page fetches and scroll-back fetches, told apart by the cursor. */
    heads: (): FakeCall[] => events().filter((c) => c.params["cursor"] === undefined),
    olders: (): FakeCall[] => events().filter((c) => c.params["cursor"] !== undefined),
  };
};

const fakeTerm: Term = {
  exit: () => {},
  suspendTerminal: () => Promise.resolve(),
  write: () => {},
  isTTY: true,
  getSize: () => ({ cols: 120, rows: 40 }),
  onResize: () => () => {},
};

const testDaemon: DaemonInfo = {
  pid: 1,
  version: LOOM_VERSION,
  repoRoot: "/tmp/fake-repo",
  startedAt: 0,
  epoch: "e1",
};

const testSession = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "a",
  parentId: null,
  forkTurn: null,
  provider: "fake",
  model: null,
  effort: null,
  mode: "default",
  status: stateRunning,
  title: "a task",
  comment: null,
  worktree: null,
  branch: null,
  baseBranch: null,
  inPlace: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextUsed: 0,
  contextLimit: 0,
  costUsd: 0,
  costSource: "none",
  turns: 0,
  requests: [],
  subagents: [],
  backgroundTasks: [],
  rateLimits: {},
  cache: { ttlMinutes: 0, ttlSource: "none", lastTurnAt: 0, lastRead: 0, lastWrite: 0 },
  keepWarm: false,
  canRewind: true,
  resumable: true,
  git: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const fleetOf = (...sessions: SessionSnapshot[]): ClientState =>
  loadableLoaded({ daemon: testDaemon, providers: [], sessions });

/** One page of `n` durable entries ending at `lastId`, oldest first. */
const pageOf = (
  lastId: number,
  n: number,
  olderCursor: HistoryCursor | null,
  sessionId = "a",
): HistoryPage => ({
  items: Array.from({ length: n }, (_, i) => {
    const id = lastId - n + 1 + i;
    return {
      id,
      event: { sessionId, ts: 1000 + id, type: "assistant_text" as const, text: `line-${id}` },
    };
  }),
  olderCursor,
});

/** Open `send` on the selected row, type `text`, and ⌥⏎ it into the queue. */
const queueFollowUp = (handle: FleetHandle, text: string): void => {
  handle.handleKey("", { return: true } as Key);
  for (const ch of text) handle.handleKey(ch, {} as Key);
  handle.handleKey("", { meta: true, return: true } as Key);
};

describe("tui fleet-handle effects", () => {
  test("a dropped connection is not an empty fleet: no exception, no RPCs, queue kept", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(handle.getView().state.selectedId, "a");
      assert.equal(fake.heads().length, 1, "the selected session fetched its head");

      queueFollowUp(handle, "follow up");
      assert.deepEqual(queueFor(handle.getView().state, "a"), ["follow up"]);

      const before = fake.calls.length;
      // The connection drops. The fleet is unknown, not empty — nothing about
      // it justifies stranding the queue or asking a dead socket for history.
      fake.deliver(loadablePending);

      assert.equal(fake.calls.length, before, "no RPC is issued while the fleet is unknown");
      const s = handle.getView().state;
      assert.deepEqual(queueFor(s, "a"), ["follow up"], "the queued follow-up survives");
      assert.equal(s.selectedId, "a", "the selection survives");
      assert.doesNotMatch(
        s.notice?.text ?? "",
        /not sent/,
        "and nothing about a merely unknown fleet strands it",
      );

      // Back to data: exactly one replacement head fetch, and the queue is
      // still governed by the ordinary turn-end rules (this session is running).
      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(fake.heads().length, 2, "one replacement head fetch");
      assert.equal(fake.of("session.send").length, 0, "a running session is not drained");
      assert.deepEqual(queueFor(handle.getView().state, "a"), ["follow up"]);
    } finally {
      teardown();
    }
  });

  test("history reloads across a reconnect for the same selected session", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(fake.heads().length, 1);
      fake.heads()[0]?.resolve(pageOf(3, 3, null));
      await delay(0);
      assert.equal(transcriptFor(handle.getView().state, "a").head.tag, "data");

      fake.deliver(loadablePending);
      assert.equal(fake.heads().length, 1, "no replacement fetch while the fleet is unknown");
      assert.equal(
        transcriptFor(handle.getView().state, "a").head.tag,
        "idle",
        "the cache was invalidated, not left claiming data",
      );

      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(fake.heads().length, 2, "data refetches the head, once");
      fake.heads()[1]?.resolve(pageOf(6, 3, null));
      await delay(0);
      assert.equal(transcriptFor(handle.getView().state, "a").head.tag, "data");
    } finally {
      teardown();
    }
  });

  test("an older page released after a reset moves neither entries, cursor nor viewport", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm, historyPageSize: 40 });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      fake.heads()[0]?.resolve(pageOf(100, 40, { olderThan: 61 }));
      await delay(0);

      // Scroll to the top of the log, which asks for the next older page.
      handle.handleKey("", { pageUp: true } as Key);
      const stale = fake.olders()[0];
      assert.ok(stale, "scrolling near the top asked for an older page");
      assert.ok(handle.getView().logScroll > 0, "and left the viewport pinned at the top");

      // The connection drops and returns before that page lands. The new
      // generation reads its own, longer head page.
      fake.deliver(loadablePending);
      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(fake.heads().length, 2, "the new generation fetched its own head");
      fake.heads()[1]?.resolve(pageOf(200, 80, { olderThan: 121 }));
      await delay(0);

      const before = handle.getView();
      const idsBefore = transcriptFor(before.state, "a").lines.map((l) => l.id);
      assert.equal(before.logScroll, 0, "the reset re-anchored the viewport at the live tail");

      stale.resolve(pageOf(60, 40, { olderThan: 21 }));
      await delay(0);

      const after = handle.getView();
      assert.deepEqual(
        transcriptFor(after.state, "a").lines.map((l) => l.id),
        idsBefore,
        "the obsolete page adds no entries",
      );
      assert.deepEqual(
        transcriptFor(after.state, "a").olderCursor,
        { olderThan: 121 },
        "and cannot move the cursor back to its own generation's",
      );
      assert.equal(after.logScroll, 0, "and moves no viewport");
    } finally {
      teardown();
    }
  });

  test("a failed head fetch is retried by leaving and reselecting the session", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(
        fleetOf(
          testSession({ id: "a", status: stateIdle, updatedAt: 9 }),
          testSession({ id: "b", status: stateIdle, updatedAt: 8 }),
        ),
      );
      const sel = handle.getView().state.selectedId;
      assert.ok(sel);
      fake.heads()[0]?.reject(new Error("history unavailable"));
      await delay(0);
      assert.equal(transcriptFor(handle.getView().state, sel).head.tag, "error");
      assert.equal(fake.heads().length, 1, "and nothing retries it on its own");

      // Move away and come back — an explicit user action, not a render.
      handle.handleKey("", { downArrow: true } as Key);
      assert.notEqual(handle.getView().state.selectedId, sel);
      handle.handleKey("", { upArrow: true } as Key);
      assert.equal(handle.getView().state.selectedId, sel);

      const retry = fake.heads().filter((c) => c.params["id"] === sel);
      assert.equal(retry.length, 2, "reselecting retries the failed head fetch");
      retry[1]?.resolve(pageOf(2, 2, null, sel));
      await delay(0);
      assert.equal(transcriptFor(handle.getView().state, sel).head.tag, "data");
    } finally {
      teardown();
    }
  });

  test("a queued session proven gone is reported once, with its queue cleared first", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      queueFollowUp(handle, "follow up");
      assert.deepEqual(queueFor(handle.getView().state, "a"), ["follow up"]);

      // Another client removed the session, and this snapshot proves it. Clear
      // the queue before saying so, or the notice's own dispatch re-enters the
      // drain and finds the same stranded queue again, forever.
      fake.deliver(fleetOf(testSession({ id: "b", status: stateIdle })));
      const s = handle.getView().state;
      assert.deepEqual(queueFor(s, "a"), [], "the stranded queue is cleared");
      assert.match(s.notice?.text ?? "", /not sent/);
    } finally {
      teardown();
    }
  });

  test("a send whose reply never came back is held for review, not sent again", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      queueFollowUp(handle, "follow up");

      // The turn ends, so the queue drains.
      fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle, turns: 1 })));
      const send = fake.of("session.send");
      assert.equal(send.length, 1, "the queue drained once");

      // The connection dropped before the daemon replied — it may well have run.
      send[0]?.reject(Object.assign(new Error("connection dropped"), { code: "disconnected" }));
      await delay(0);

      // No later snapshot may put it back on the wire.
      fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle, turns: 2 })));
      assert.equal(fake.of("session.send").length, 1, "no automatic second send");
      const s = handle.getView().state;
      assert.deepEqual(queueFor(s, "a"), [], "the ambiguous head left the drain queue");
      assert.match(s.notice?.text ?? "", /may already have been sent/);

      // The text is not lost: opening `send` on that session brings it back.
      handle.handleKey("", { return: true } as Key);
      assert.equal(handle.getView().state.prompt?.buffer.text, "follow up");
    } finally {
      teardown();
    }
  });
});

describe("tui transcript paging through the handle", () => {
  test("paging past the cap stops following the tail; End reloads the newest window", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm, historyPageSize: 6000 });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      fake.heads()[0]?.resolve(pageOf(20_000, 6_000, { olderThan: 14_001 }));
      await delay(0);
      assert.equal(transcriptFor(handle.getView().state, "a").following, true);

      // Home scrolls to the oldest row held, which prefetches the next older
      // page; folding it in takes the window past the cap.
      handle.handleKey("", { home: true } as Key);
      const older = fake.olders()[0];
      assert.ok(older, "the climb asked for an older page");
      assert.deepEqual(older.params["cursor"], { olderThan: 14_001 }, "using the held cursor");
      older.resolve(pageOf(14_000, 6_000, { olderThan: 8_001 }));
      await delay(0);

      const browsing = transcriptFor(handle.getView().state, "a");
      assert.equal(browsing.lines.length, TRANSCRIPT_CAP, "12,000 fetched, 10,000 retained");
      assert.equal(browsing.lines[0]?.id, 8_001, "the oldest end is the end being read");
      assert.equal(browsing.following, false, "the newest end was evicted");
      assert.deepEqual(browsing.olderCursor, { olderThan: 8_001 }, "and the cursor advanced");

      // A live event now has nowhere contiguous to go, so it stays out of the
      // window the reader is looking at.
      fake.push({
        kind: "push",
        seq: 1,
        epoch: "e1",
        type: "event",
        id: 20_001,
        event: { sessionId: "a", ts: 1, type: "assistant_text", text: "live" },
      });
      assert.equal(
        transcriptFor(handle.getView().state, "a").lines,
        browsing.lines,
        "the rows being read are untouched",
      );

      // End is the way back: drop the older window and refetch the newest.
      handle.handleKey("", { end: true } as Key);
      const reloads = fake.heads();
      assert.equal(reloads.length, 2, "jumping to latest refetched the newest page");
      reloads[1]?.resolve(pageOf(20_001, 500, { olderThan: 19_502 }));
      await delay(0);

      const followed = transcriptFor(handle.getView().state, "a");
      assert.equal(followed.following, true, "and resumed following it");
      assert.equal(followed.lines.at(-1)?.id, 20_001);
      assert.equal(handle.getView().logScroll, 0, "with the viewport back at the tail");
    } finally {
      teardown();
    }
  });
});

describe("tui interaction actions through the handle", () => {
  const permRequest = (id: string): SessionInteraction => ({
    kind: "permission",
    id,
    tool: "Bash",
    input: { command: "ls" },
    at: 1,
  });
  const parked = (...requests: SessionInteraction[]): SessionSnapshot =>
    testSession({ id: "a", status: stateAwaitingInput("permission"), requests });

  test("a batched duplicate approval key issues one RPC, with no shadow request set", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(parked(permRequest("p1"), permRequest("p2"))));
      assert.equal(handle.getView().request?.id, "p1", "oldest first");
      assert.equal(handle.getView().requestCount, 2, "and the panel knows one is queued behind");

      // Ink delivers a batched "aa" one byte at a time, before the view
      // updates — so the second press sees the same snapshot as the first.
      handle.handleKey("a", {} as Key);
      handle.handleKey("a", {} as Key);
      const calls = fake.of("session.respondPermission");
      assert.equal(calls.length, 1, "exactly one approval reached the daemon");
      assert.equal(calls[0]?.params["requestId"], "p1");

      // The authoritative list is untouched: nothing local hides p1, and the
      // panel keeps showing it until the daemon says otherwise.
      assert.deepEqual(
        requestsFor(handle.getView().state, "a").map((r) => r.id),
        ["p1", "p2"],
      );
      assert.equal(handle.getView().request?.id, "p1");

      // The daemon catches up. p2 is a different request, so it is actionable.
      calls[0]?.resolve({ alreadyResolved: false });
      fake.deliver(fleetOf(parked(permRequest("p2"))));
      assert.equal(handle.getView().request?.id, "p2");
      handle.handleKey("a", {} as Key);
      assert.equal(fake.of("session.respondPermission").length, 2);
      assert.equal(fake.of("session.respondPermission")[1]?.params["requestId"], "p2");
    } finally {
      teardown();
    }
  });

  test("loading old history changes no outstanding request", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(parked(permRequest("p1"))));
      fake.heads()[0]?.resolve({
        items: [
          {
            id: 1,
            event: {
              sessionId: "a",
              ts: 1,
              type: "permission_request" as const,
              id: "ancient",
              tool: "rm",
              input: {},
            },
          },
        ],
        olderCursor: null,
      });
      await delay(0);

      // A long-answered request in old history is transcript and nothing more.
      assert.deepEqual(
        requestsFor(handle.getView().state, "a").map((r) => r.id),
        ["p1"],
      );
      assert.equal(handle.getView().request?.id, "p1");
    } finally {
      teardown();
    }
  });
});
