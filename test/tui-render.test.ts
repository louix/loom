import { fleet, queueEntry, queueOf, snap } from "./tui-fixtures.ts";
import assert from "node:assert/strict";
import { outboxOf } from "@loom/tui/composer";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { stripVTControlCharacters } from "node:util";
import { render, renderToString, type Key } from "ink";
import { LoomClient } from "@loom/client";
import { RepositoryMenu } from "@loom/tui/run";
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
  Detail,
  FooterArea,
  PromptPane,
  promptPaneRows,
  promptRows,
  RequestPanel,
  requestPanelRows,
} from "@loom/tui/components";
import {
  logRowCount,
  TRANSCRIPT_CAP,
  transcriptLines,
  transcriptWindow,
} from "@loom/tui/transcript";
import {
  animationNeed,
  hitAt,
  hitKey,
  mkFleetHandle,
  type FleetClient,
  type FleetHandle,
  type Term,
} from "@loom/tui/fleet-handle";
import { initialState, fleetSessions, shownLog, reduce, sessionLog } from "@loom/tui/model";
import { openPrompt, pickerCurrent, sessionPrompt } from "@loom/tui/overlay";
import { requestsFor } from "@loom/tui/interactions";
import { MOUSE_OFF, MOUSE_ON, PASTE_OFF, PASTE_ON, mouseReport } from "@loom/tui/mouse";
import type { FakeProvider } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

const ESC = "\x1b";

/** The loaded transcript window, or null while there isn't one. */
const winOf = (s: { transcript: import("@loom/tui/transcript").Transcript }) =>
  transcriptWindow(s.transcript);
/** Every durable id the transcript is holding. */
const idsOf = (s: { transcript: import("@loom/tui/transcript").Transcript }) =>
  transcriptLines(s.transcript).map((l) => l.id);

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
  client: FleetClient,
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

// Each test owns its client, Ink instance and streams. Integration tests also
// own a daemon + temp repo; display-only tests use mountFleet snapshots.
// Bound concurrency so small machines don't host every daemon at once.
describe("tui-render", { concurrency: 4 }, () => {
  test("renders the fleet, tracks selection by key, and lists commands", async () => {
    const { stdout, stdin, app, settle } = await mountFleet([
      snap({ id: "running", title: "add a --json flag", status: "running" }),
      snap({
        id: "waiting",
        title: "write the release notes",
        status: "awaiting_input",
        awaitReason: "permission",
      }),
    ]);
    try {
      await settle();
      assert.match(stdout.last, /▍ loom/);
      assert.match(stdout.last, /AWAITING INPUT/);
      assert.match(stdout.last, /write the release notes/);
      assert.match(stdout.last, /approve/);
      assert.match(stdout.last, /deny/);
      // request mode: the footer drops the actions that don't resolve the request
      assert.doesNotMatch(stdout.last, /rename/);
      assert.doesNotMatch(stdout.last, /budget/);

      stdin.feed("j");
      await settle();
      assert.match(stdout.last, /add a --json flag/);
      assert.match(stdout.last, /interrupt/);
      assert.doesNotMatch(stdout.last, /approve/);

      // The Space palette is the command reference: unavailable commands are
      // listed with the reason, not hidden. `?` no longer opens a help view.
      stdin.feed("?");
      await settle();
      assert.doesNotMatch(stdout.last, /loom — keys|COMMANDS/);
      stdin.feed(" ");
      await settle();
      assert.match(stdout.last, /COMMANDS/);
      assert.match(stdout.last, /interrupt/);
      stdin.feed("approve");
      await settle();
      assert.match(stdout.last, /approve +a · No permission request pending/);
    } finally {
      app.unmount();
    }
  });

  test("esc does not quit; only overlays back out", async () => {
    const { stdout, stdin, app, settle } = await mountFleet([snap({ title: "a task" })]);
    try {
      await settle();
      stdin.feed(ESC);
      // A lone Escape is held by Ink's input parser for 20ms. This no-op has
      // no changed frame to await; let it resolve before feeding the next key.
      await delay(60);
      await settle();
      assert.match(stdout.last, /▍ loom/, "still rendering after esc — the UI did not exit");

      stdin.feed("n");
      await settle();
      assert.match(stdout.last, /new session/);
      assert.match(
        stdout.last,
        /\[manual\]/,
        "the mode chip is always shown (default reads as 'manual')",
      );
      stdin.feed(ESC);
      await waitFor(stdout, (text) => !/new session/.test(text));
      assert.doesNotMatch(stdout.last, /new session/);

      stdin.feed("\x05"); // ⌃e outside the prompt: Ctrl is editing-only, inert here
      await settle();
      assert.match(stdout.last, /▍ loom/, "still rendering — ⌃e did nothing in browse");
      assert.doesNotMatch(stdout.last, /new session/);
    } finally {
      app.unmount();
    }
  });

  const OAI_CFG = `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "oai": {
          "base_url": "http://127.0.0.1:9/v1",
          "models": [
            "m1",
            "m2"
          ]
        }
      }
    }
  }
}`;

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
      await delay(560); // clear the 500ms setMode debounce
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
      await waitFor(stdout, (t) => /the other task/.test(t) && /click target/.test(t));
      assert.match(cursorRow(), /the other task/, "the running session is selected first");

      click(at("click target"));
      await waitFor(stdout, () => /click target/.test(cursorRow()));

      await waitFor(stdout, /\[manual\]/);
      click(at("[manual]"));
      await waitFor(stdout, /\[plan\]/);
      await delay(560); // clear the 500ms setMode debounce
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
      await delay(60); // still well inside the 500ms debounce
      assert.match(stdout.last, /\[plan\]/, "the chip shows the selected mode immediately");
      await delay(560); // clear the 500ms setMode debounce
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
    const { stdout, stdin, app, settle } = await mountFleet([
      snap({ title: "busy", status: "running" }),
    ]);
    try {
      await settle();
      stdin.feed("R");
      await settle();
      assert.match(stdout.last, /Restart the daemon\?/);
      assert.match(stdout.last, /will be interrupted/);
      stdin.feed(ESC);
      await waitFor(stdout, (text) => !/Restart the daemon\?/.test(text));
      assert.doesNotMatch(stdout.last, /Restart the daemon\?/);
    } finally {
      app.unmount();
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
      assert.doesNotMatch(stdout.last, /(?:keep|delete) branch/i);

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
      assert.match(stdout.last, /Worktree will be removed\./);
      assert.match(stdout.last, /Session history will be permanently deleted\./);
      assert.match(stdout.last, /\[x\] Also delete branch/);
      assert.match(stdout.last, /b\s+toggle branch/i);

      stdin.feed("b"); // keep the branch
      await delay(80);
      assert.match(stdout.last, /\[ \] Also delete branch/);
      assert.match(stdout.last, /b\s+toggle branch/i);
      assert.match(stdout.last, /Session history will be permanently deleted\./);

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
      assert.ok(stdout.last.includes("─".repeat(stdout.columns - 6)), "menu fills terminal width");

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
      await waitFor(stdout, (text) => /loom — doctor/.test(text) && /connectors/.test(text));
      assert.match(stdout.last, /connectors/);
      assert.match(stdout.last, /No external tools selected/);
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
      const oldest = (): string =>
        sessionLog({ ...handle.getView().ui, transcript: handle.transcript.get().transcript })[0]
          ?.text ?? "";
      // Gate on the log COUNT: the fold dispatches land in the view's state
      // synchronously, while rendered-output checks race ink's delivery.
      const climbTo = async (): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (
          sessionLog({ ...handle.getView().ui, transcript: handle.transcript.get().transcript })
            .length < 9 &&
          Date.now() < deadline
        ) {
          pressPgUp(); // pins the top and pulls the next-older page
          await delay(100);
        }
      };

      await climbTo();
      assert.equal(
        sessionLog({ ...handle.getView().ui, transcript: handle.transcript.get().transcript })
          .length,
        9,
        "every page folded in",
      );
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
      const paneWidth = view.body.t === "split" ? view.rightW : view.cols;
      const top = Math.max(
        0,
        logRowCount(
          shownLog({ ...view.ui, transcript: handle.transcript.get().transcript }),
          paneWidth,
        ) - view.logPage,
      );
      assert.equal(handle.transcript.get().scroll, top, "the viewport reaches the log's top");

      // Past the start the done latch fires: further PgUp neither moves nor churns.
      pressPgUp();
      pressPgUp();
      assert.equal(
        sessionLog({ ...handle.getView().ui, transcript: handle.transcript.get().transcript })
          .length,
        9,
        "no churn past the start",
      );
      assert.equal(handle.transcript.get().scroll, top, "still pinned at the log's top");
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
      await waitFor(stdout, /Chat/);
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

      stdin.feed("\x1b[<64;10;10M"); // wheel up moves three rows into history
      await waitFor(stdout, (frame) => /pinline-27/.test(frame) && !/pinline-28/.test(frame));
      assert.doesNotMatch(stdout.last, /pinline-30/);
      stdin.feed("\x1b[<65;10;10M"); // wheel down returns to the live tail
      await waitFor(stdout, /pinline-30/);
      // Scroll back a couple of pages: the border turns accent and older lines
      // are now in view, the live tail is gone.
      stdin.feed("\x1b[5~");
      stdin.feed("\x1b[5~");
      await waitFor(stdout, (frame) => /pinline-2[0-6]/.test(frame) && !/pinline-27/.test(frame));
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

  test("a running session queues for the next boundary or, with ⌥q, turn end; the queue drains on idle", async () => {
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
      stdin.feed("\r"); // bare Enter — queued for the next tool boundary
      await delay(150);
      assert.deepEqual(fs?.sends, [], "the model is only writing: it waits in the queue");
      fs?.emit({ type: "tool_call", id: "t1", name: "Bash", input: {} });
      await waitFor(stdout, () => fs?.sends.length === 1);
      assert.deepEqual(fs?.sends, ["hold that thought"]);
      fs?.emit({ type: "tool_result", id: "t1", ok: true, output: "" });

      // queue one while still running, via ⌥⏎
      stdin.feed("\r"); // Enter opens the send prompt
      await delay(80);
      stdin.feed("and another");
      await delay(80);
      stdin.feed("\x1bq"); // ⌥q — queue for turn end
      await delay(120);
      assert.match(stdout.last, /▸ 1 queued/, "the Detail pane shows the queue");

      fs?.finishTurn(); // -> idle: the queued message goes
      await waitFor(stdout, (text) => fs?.sends.length === 2 && !/▸ \d+ queued/.test(text));
      assert.deepEqual(fs?.sends, ["hold that thought", "and another"]);
      assert.doesNotMatch(stdout.last, /▸ \d+ queued/);
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("a queue on a session whose turn fails is held, not dropped", async () => {
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
      stdin.feed("\x1bq"); // ⌥q — queue for turn end
      await delay(150);
      assert.match(stdout.last, /▸ 1 queued/);

      fs?.fail("upstream exploded"); // -> error, never goes idle
      // The daemon holds what was waiting; every client says so, and q reviews it.
      await waitFor(stdout, (text) => /▸ 1 held · q review/.test(text));
      assert.deepEqual(fs?.sends, [], "nothing goes to a failed turn by itself");
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

  test("plan review · the overlay starts on the provider's suggested implementation mode", async () => {
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
      fs?.finishTurn({ contextUsed: 10_000 });
      // Codex offers the execution choice its native Plan kept.
      fs?.emit({ type: "plan_review", id: "pr1", plan: "1. go", implementMode: "auto" });
      await delay(200);
      stdin.feed("a");
      await delay(150);
      assert.match(stdout.last, /implementation mode \[auto\]/);
      stdin.feed("i");
      await delay(200);
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

      stdin.feed("\x1b[<65;10;10M"); // wheel down, same three-row step as Chat
      await delay(120);
      assert.match(stdout.last, /↕ lines 4–/);
      stdin.feed("\x1b[<64;10;10M"); // wheel up
      await delay(120);
      assert.match(stdout.last, /↕ lines 1–/);
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

  test("→ drills into a session's children; Chat follows the focused child", async () => {
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
      assert.match(stdout.last, /Chat · ⑂ reviewer/);
      assert.match(stdout.last, /reviewing the diff/);
      assert.doesNotMatch(stdout.last, /mainline chatter/);

      stdin.feed("\x1b"); // esc — back out to the fleet
      await delay(220);
      assert.match(stdout.last, /mainline chatter/, "the full session stream returns");
      assert.doesNotMatch(stdout.last, /Chat · ⑂/, "the events header is back to plain");
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("⇥ toggles the fleet list; esc brings it back", async () => {
    const { stdout, stdin, app, settle } = await mountFleet([
      snap({ title: "look at logs", status: "running" }),
    ]);
    try {
      await settle();
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
    }
  });

  test("a narrow terminal hides detail + events until ⇥ swaps to the session pane", async () => {
    const { stdout, stdin, app } = await mountFleet(
      [snap({ id: "narrow", title: "narrow layout task", status: "running" })],
      { columns: 60 },
      [
        {
          id: 1,
          event: { sessionId: "narrow", ts: 1, type: "assistant_text", text: "one column now" },
        },
      ],
    );
    try {
      // overview: the fleet list alone — no detail, no events, no switcher bar.
      await waitFor(stdout, /FLEET/);
      assert.doesNotMatch(stdout.last, /Chat/);
      assert.doesNotMatch(stdout.last, /engine fake/);
      assert.doesNotMatch(stdout.last, /⇥ next/);

      stdin.feed("\t"); // → the session pane: detail + events, full width
      await waitFor(stdout, (t) => /Chat/.test(t) && /one column now/.test(t));
      assert.doesNotMatch(stdout.last, /FLEET/);

      stdin.feed("\t"); // → back to the fleet list
      await waitFor(stdout, (t) => /FLEET/.test(t) && !/Chat/.test(t));
    } finally {
      app.unmount();
    }
  });

  test("shrinking the terminal keeps an active reply visible and editable", async () => {
    const { stdout, stdin, app } = await mountFleet(
      [snap({ id: "resize", title: "resize layout task", status: "idle" })],
      { columns: 120 },
    );
    try {
      await waitFor(stdout, (s) => /FLEET/.test(s) && /Chat/.test(s));
      stdin.feed("\r");
      await waitFor(stdout, /send \[manual\]/);
      stdin.feed("draft survives");
      await waitFor(stdout, /draft survives/);
      assert.match(stdout.last, /FLEET/);

      stdout.columns = 60;
      stdout.emit("resize");
      await waitFor(stdout, (s) => /Chat/.test(s) && !/FLEET/.test(s));
      assert.match(stdout.last, /draft survives/);
      stdin.feed(" resizing");
      await waitFor(stdout, /draft survives resizing/);

      stdin.feed(ESC);
      await waitFor(stdout, (s) => !/send \[manual\]/.test(s));
      stdin.feed("\t");
      await waitFor(stdout, (s) => /FLEET/.test(s) && !/Chat/.test(s));
    } finally {
      app.unmount();
    }
  });

  test("→ still only drills into children — the layout zoom is on ⇥, not the arrows", async () => {
    const { stdout, stdin, app, settle } = await mountFleet(
      [
        snap({
          title: "spawn helpers",
          status: "running",
          subagents: [{ id: "t1", name: "reviewer", active: true }],
        }),
      ],
      { columns: 60 },
    );
    try {
      await settle();
      await waitFor(stdout, /⑂ reviewer/);

      // → drills into the child rows and stays on the fleet list — it does not
      // change the layout view.
      stdin.feed("\x1b[C");
      await waitFor(stdout, /▸ ⑂ reviewer/);
      assert.match(stdout.last, /FLEET/);
      assert.doesNotMatch(stdout.last, /Chat/);

      // ← backs out of the drill-down, still on the fleet list.
      stdin.feed("\x1b[D");
      await waitFor(stdout, (t) => !/▸ ⑂ reviewer/.test(t));
      assert.match(stdout.last, /FLEET/);
    } finally {
      app.unmount();
    }
  });

  test("n shows the provider / model; ⌥p opens the chooser and returns to the prompt", async () => {
    const { connect, cleanup } = await harness({
      config: `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "openai": {
          "base_url": "http://x/v1",
          "model": "gpt-5",
          "models": [
            "gpt-5",
            "gpt-5-mini",
            "o4"
          ]
        }
      }
    }
  }
}`,
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
      config: `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "oai": {
          "base_url": "http://127.0.0.1:9/v1"
        }
      }
    }
  }
}`,
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
      // A failed discovery says why and how to retry, rather than a generic "none".
      assert.match(stdout.last, /catalog request failed.*⌥r to retry/i);
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
      config: `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "openai": {
          "base_url": "http://x/v1",
          "model": "gpt-5",
          "models": [
            "gpt-5",
            "gpt-5-mini"
          ]
        }
      }
    }
  }
}`,
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
      await waitFor(stdout, /refactor the p/);
      stdin.feed("/");
      await waitFor(stdout, /type to filter/); // the inline filter line on FLEET
      assert.match(stdout.last, /refactor the p/);
      assert.match(stdout.last, /update the docs/);

      stdin.feed("parser");
      await waitFor(stdout, (s) => !/update the docs/.test(s)); // narrowed to the match
      assert.match(stdout.last, /refactor the p/);

      stdin.feed("\x15"); // ⌃u — readline kill-to-start clears the filter
      await waitFor(stdout, /update the docs/); // list un-narrows with it

      // A query matching both rows, then ↑: the selection moves — the arrows are
      // NOT swallowed by the filter — and the Detail pane follows it. Matching
      // is a round trip to the daemon now, so wait for the count to land rather
      // than for a Detail pane that may still be showing the previous answer.
      stdin.feed("the");
      await waitFor(stdout, /FLEET · 2\/2 matches/);
      assert.match(detailTitle(stdout.last), /refactor the parser/);
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
      // Filtering is one flat list, no status headers — and the match count
      // only appears once the daemon has answered.
      await waitFor(stdout, /FLEET · 2\/3 matches/);
      assert.doesNotMatch(stdout.last, /IDLE/);
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
      await waitFor(stdout, /FLEET · 1\/3 match\b/);
      assert.doesNotMatch(stdout.last, /demobilize/);
    } finally {
      app.unmount();
      await client.close();
      await cleanup();
    }
  });

  test("the filter finds message text in a session this TUI has never opened", async () => {
    const { connect, cleanup } = await harness();
    const client = await connect();
    // The message lands in the *older* session, which the TUI never selects and
    // therefore never pages a transcript for. Before the search moved to the
    // daemon this was simply unfindable: the matcher only ever saw the pages
    // this client had downloaded.
    const buried = await client.request<SessionSnapshot>("session.createStub", {
      prompt: "an ordinary title",
      status: "idle",
      provider: "fake",
    });
    await client.request("dev.emit", {
      event: {
        sessionId: buried.id,
        type: "assistant_text",
        text: "the pelican crossing is repainted",
      },
    });
    await delay(5);
    await client.request("session.createStub", {
      prompt: "something else entirely",
      status: "idle",
      provider: "fake",
    });
    const { stdout, stdin, app } = mount(client);
    try {
      // The newest session is the selected one, so the buried one's transcript
      // is never fetched.
      await waitFor(stdout, (s) => /something else entirely/.test(detailTitle(s)));
      stdin.feed("/");
      await waitFor(stdout, /type to filter/);
      stdin.feed("pelican");
      await waitFor(stdout, /FLEET · 1\/2 match\b/);
      assert.match(stdout.last, /an ordinary title/);
      assert.doesNotMatch(stdout.last, /something else entirely\s+—/);
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
      config: `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "openai": {
          "base_url": "http://127.0.0.1:9/v1",
          "model": "gpt-5"
        }
      }
    }
  }
}`,
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
      // draws on the session's Chat pane (label row, then the input line)
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
      config: `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "openai": {
          "base_url": "http://127.0.0.1:9/v1",
          "model": "gpt-5"
        }
      }
    }
  }
}`,
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
      // The wizard: provider (when there is a choice), history, workspace, confirm.
      stdin.feed("F");
      await waitFor(stdout, /fork · (provider|history)/i);
      if (/fork · provider/i.test(stdout.last)) {
        stdin.feed("\r"); // the source's own provider is preselected
        await waitFor(stdout, /fork · history/i);
      }
      assert.match(stdout.last, /native history/);
      assert.match(stdout.last, /portable handoff/);
      stdin.feed("\r");
      await waitFor(stdout, /copy workspace/);
      stdin.feed("\r");
      await waitFor(stdout, /fork with Local isolation/);
      assert.match(stdout.last, /History: native/);
      stdin.feed("\r");
      await waitFor(stdout, /forked from .* @ turn 0 · native history/); // Detail lineage line
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
    assert.equal(promptRows(state), 3, "the layout reserves the notice's row");
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
      t: "overlay",
      overlay: {
        t: "prompt",
        prompt: sessionPrompt("send", "a", "send", `${"x".repeat(36)} tail`),
      },
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
    // every option number is present — not clipped at 1) 2) like the old fixed
    // 5-row body did
    const out = stripAnsi(renderToString(createElement(RequestPanel, { request, width: 80 })));
    for (const tag of ["1)", "2)", "3)", "4)"]) {
      assert.ok(out.includes(tag), `option ${tag} is rendered: ${JSON.stringify(out)}`);
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

  test("askQuestionLines numbers every option and returns them all", () => {
    const lines = askQuestionLines(QUESTIONS, 0, 76);
    assert.ok(lines.some((l) => /1\) OAuth 2\.0 — delegated/.test(l)));
    assert.ok(lines.some((l) => /4\) JWT bearer/.test(l)));
    // clamps out-of-range indices rather than throwing
    assert.deepEqual(askQuestionLines(QUESTIONS, 99, 76), askQuestionLines(QUESTIONS, 1, 76));
  });

  test("the answer sheet footer says esc steps back to the panel, not cancel", () => {
    const blocked = snap({
      id: "a",
      status: "awaiting_input",
      awaitReason: "user_question",
      requests: [askRequest()],
    });
    const state = reduce(reduce(initialState(), fleet([blocked])), {
      t: "overlay",
      overlay: { t: "questions", sessionId: "a", requestId: "p1" },
    });
    const out = stripAnsi(renderToString(createElement(FooterArea, { state, width: 120 })));
    assert.match(out, /esc back/);
    assert.doesNotMatch(out, /esc cancel/);
    // The sheet binds ⇥ to the custom answer, where the old prompt had none.
    assert.match(out, /⇥ custom/);
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

  test("the Detail cache row drops the countdown while a turn is running", () => {
    const T0 = 1_000_000;
    const cache = {
      ttlMinutes: 60,
      ttlSource: "observed" as const,
      lastTurnAt: T0,
      lastRead: 9000,
      lastWrite: 200,
    };
    const row = (session: SessionSnapshot): string =>
      stripAnsi(
        renderToString(
          createElement(Detail, {
            session,
            fleet: loadableIdle,
            mode: null,
            width: 80,
            now: T0 + 40 * 60_000,
          }),
        ),
      )
        .split("\n")
        .find((l) => l.includes("cache")) ?? "";

    // Idle: 20 of the 60 minutes are left and the row says so.
    assert.match(row(testSession({ status: stateIdle, cache })), /⟢ warm ~20:00/);

    // Running: no number — the live turn keeps rewriting the prefix, so there
    // is nothing to count down to. The row stays, so the pane doesn't jump.
    const live = row(testSession({ status: stateRunning, cache }));
    assert.match(live, /⟢ warm {2}· {2}writing/);
    assert.doesNotMatch(live, /~\d/, "no countdown is offered for a live cache");
    assert.match(live, /last turn hit/, "the previous turn's split still reads true");
  });

  test("AskUserQuestion · the sheet keeps progress across esc, reviews, then answers once", async () => {
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
      // the panel spells out every option of question 1, not just 1) 2)
      await waitFor(stdout, /QUESTION \(1\/2\)/);
      assert.match(stdout.last, /1\) OAuth 2\.0/);
      assert.match(stdout.last, /4\) JWT bearer/);

      stdin.feed("a"); // open the answer sheet on question 1
      await waitFor(stdout, /QUESTION 1\/2 · Auth/);
      assert.match(stdout.last, /simplest, rotate manually/, "choices keep their descriptions");
      stdin.feed("2"); // choose API keys
      await waitFor(stdout, /\(•\) API keys/);
      stdin.feed(ESC); // esc → back to the panel, keeping the choice
      await waitFor(stdout, (t) => /QUESTION \(1\/2\)/.test(t) && !/Custom answer/.test(t));

      stdin.feed("\x1b[C"); // → move the panel to question 2
      await waitFor(stdout, /QUESTION \(2\/2\)/);
      assert.match(stdout.last, /Where should sessions live\?/);

      stdin.feed("a"); // the sheet resumes on question 2
      await waitFor(stdout, /QUESTION 2\/2 · Sessions/);
      stdin.feed("\t"); // edit the custom answer
      await waitFor(stdout, /Editing the custom answer/);
      stdin.feed("Postgres, pooled");
      stdin.feed("\r"); // done editing
      await waitFor(stdout, /Custom answer · Postgres, pooled/);
      stdin.feed("\r"); // continue to the review
      await waitFor(stdout, /REVIEW ANSWERS/);
      assert.match(stdout.last, /→ API keys/, "the choice made before esc survived");
      assert.match(stdout.last, /→ Postgres, pooled/);
      assert.equal(fs?.permissionResponses.length ?? 0, 0, "review does not submit");

      stdin.feed("\r"); // submit
      await waitFor(stdout, () => (fs?.permissionResponses.length ?? 0) > 0);
      stdin.feed("\r");
      await delay(100);
      assert.equal(fs?.permissionResponses.length, 1, "resolved exactly once");
      const resolved = fs!.permissionResponses[0]!;
      assert.equal(resolved.id, "q1");
      // the daemon carries the collected answers through to the provider, keyed
      // by question text: chosen labels, and custom text as typed
      const decision = resolved.decision as {
        behavior: string;
        updatedInput: { answers: Record<string, string> };
      };
      assert.equal(decision.behavior, "allow");
      assert.deepEqual(decision.updatedInput.answers, {
        "Which auth method should we use for the API?": "API keys",
        "Where should sessions live?": "Postgres, pooled",
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

test("terminal focus reports stay out of prompts, including fragmented reports and pasted literals", async () => {
  const fake = mkFakeClient();
  fake.deliver(fleetOf());
  const { stdin, stdout, app } = mount(fake.client);
  try {
    await waitFor(stdout, () => fake.of("tui.focus").length === 1);
    stdin.feed("n");
    await delay(30);
    stdin.feed(`${ESC}[`);
    stdin.feed("O");
    await waitFor(stdout, () => fake.of("tui.focus").length === 2);
    assert.equal(fake.of("tui.focus")[1]?.params["focused"], false);
    stdin.feed(`${ESC}[I`);
    await waitFor(stdout, () => fake.of("tui.focus").length === 3);
    stdin.feed(`${ESC}[200~literal [I [O${ESC}[201~`);
    await waitFor(stdout, /literal \[I \[O/);
    assert.equal(fake.of("tui.focus").length, 3);
  } finally {
    app.unmount();
  }
  assert.equal(fake.of("tui.focus").at(-1)?.params["focused"], null);
});

test("repo preparation palette action suspends and restores the terminal without session RPCs", async () => {
  for (const code of [0, 1, 130]) {
    const fake = mkFakeClient();
    const steps: string[] = [];
    const handle = mkFleetHandle({
      client: fake.client,
      term: {
        ...fakeTerm,
        suspendTerminal: async (fn) => {
          steps.push("suspend");
          try {
            await fn();
          } finally {
            steps.push("restore");
          }
        },
      },
      prepareEnvironment: async () => {
        steps.push("prepare");
        return code;
      },
    });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf());
      handle.handleKey(" ", {} as Key);
      handle.handleKey("Prepare repo environment", {} as Key);
      handle.handleKey("", { return: true } as Key);
      await delay(0);
      assert.deepEqual(steps, ["suspend", "prepare", "restore"]);
      assert.match(
        handle.getView().ui.notice?.text ?? "",
        new Map([
          [0, /prepared/],
          [130, /cancelled/],
        ]).get(code) ?? /failed/,
      );
      assert(!fake.calls.some((call) => call.method.startsWith("session.")));
    } finally {
      teardown();
    }
  }
});

const testDaemon: DaemonInfo = {
  pid: 1,
  version: LOOM_VERSION,
  repoRoot: "/tmp/fake-repo",
  startedAt: 0,
  epoch: "e1",
};

const testSession = (over: Partial<SessionSnapshot> = {}): SessionSnapshot =>
  snap({ id: "a", status: "running", createdAt: 1, updatedAt: 1, ...over });

const fleetOf = (...sessions: SessionSnapshot[]): ClientState =>
  loadableLoaded({ daemon: testDaemon, providers: [], sessions });

/** Display-only tests start from a snapshot; RPC behavior belongs to the daemon tests. */
const mountFleet = async (
  sessions: SessionSnapshot[],
  size: { columns?: number; rows?: number } = {},
  items: HistoryPage["items"] = [],
) => {
  const fake = mkFakeClient();
  fake.deliver(fleetOf(...sessions));
  const mounted = mount(fake.client, {}, size);
  const settle = async () => {
    // Let React process input/effects, then wait for Ink's pending render.
    await delay(0);
    await mounted.app.waitUntilRenderFlush();
  };
  await settle();
  for (const call of fake.heads()) call.resolve({ items, olderCursor: null });
  await settle();
  return { ...mounted, settle };
};

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

/** Open `send` on the selected row, type `text`, and ⌥q it into the queue. */
const queueFollowUp = (handle: FleetHandle, text: string): void => {
  handle.handleKey("", { return: true } as Key);
  for (const ch of text) handle.handleKey(ch, {} as Key);
  handle.handleKey("q", { meta: true } as Key);
};

describe("tui fleet-handle effects", () => {
  test("⌥⏎ is a newline even while the target is working; ⌥q is the queue", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a", status: stateRunning })));
      handle.handleKey("", { return: true } as Key); // open send
      handle.handleKey("a", {} as Key);
      handle.handleKey("", { meta: true, return: true } as Key);
      handle.handleKey("b", {} as Key);
      const overlay = handle.getView().ui.overlay;
      assert.equal(overlay.t, "prompt");
      if (overlay.t !== "prompt") return;
      assert.equal(overlay.prompt.buffer.text, "a\nb", "⌥⏎ inserted a newline, nothing was sent");
      assert.equal(fake.of("session.send").length, 0);

      handle.handleKey("q", { meta: true } as Key);
      assert.equal(handle.getView().ui.overlay.t, "browse", "⌥q closed the prompt");
      // The daemon queues it; nothing is held in this client.
      const sent = fake.of("session.send");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.params["text"], "a\nb");
      assert.equal(sent[0]?.params["delivery"], "end_of_turn", "for when the agent finishes");
      assert.equal(typeof sent[0]?.params["entryId"], "string", "under an id this client chose");
    } finally {
      teardown();
    }
  });
  test("⏎ queues for the next tool boundary; ⌥q on an idle target goes the same way", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
      handle.handleKey("", { return: true } as Key);
      for (const ch of "go") handle.handleKey(ch, {} as Key);
      handle.handleKey("", { return: true } as Key);
      assert.equal(fake.of("session.send")[0]?.params["delivery"], "next_boundary");
      await delay(110); // A new keypress, past the batched double-Enter guard.
      handle.handleKey("", { return: true } as Key);
      for (const ch of "later") handle.handleKey(ch, {} as Key);
      handle.handleKey("q", { meta: true } as Key);
      // The daemon's rule 5 makes an end-of-turn message on an idle session a
      // plain send: one RPC, on the wire immediately.
      assert.equal(fake.of("session.send").length, 2, "sent on the wire immediately");
    } finally {
      teardown();
    }
  });
  test("what is not on screen is not animation", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a", status: stateRunning })));
      fake.heads()[0]?.resolve(pageOf(3, 3, null, "a"));
      await delay(0);
      assert.equal(animationNeed(handle.getView()), "spin", "a running session spins on screen");

      // The doctor overlay owns the whole screen. The session is still
      // running; not one pixel of it is being drawn.
      handle.handleKey(" ", {} as Key);
      handle.handleKey("doctor", {} as Key);
      handle.handleKey("", { return: true } as Key);
      assert.equal(handle.getView().body.t, "doctor");
      assert.equal(animationNeed(handle.getView()), null, "nothing behind an overlay animates");

      handle.handleKey("", { escape: true } as Key);
      assert.equal(animationNeed(handle.getView()), "spin", "and it resumes when it is back");
    } finally {
      teardown();
    }
  });
  test("a dropped connection is not an empty fleet: no exception, no RPCs, queue kept", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      const queue = queueOf([queueEntry("e1", { preview: "follow up" })]);
      fake.deliver(fleetOf(testSession({ id: "a", queue })));
      assert.equal(handle.getView().ui.selectedId, "a");
      assert.equal(fake.heads().length, 1, "the selected session fetched its head");

      const before = fake.calls.length;
      // The connection drops. The fleet is unknown, not empty — nothing about
      // it justifies asking a dead socket for history.
      fake.deliver(loadablePending);

      assert.equal(fake.calls.length, before, "no RPC is issued while the fleet is unknown");
      const s = handle.getView().ui;
      assert.equal(s.selectedId, "a", "the selection survives");

      // Back to data: exactly one replacement head fetch; the queue is the
      // daemon's, so this client re-sends nothing.
      fake.deliver(fleetOf(testSession({ id: "a", queue })));
      assert.equal(fake.heads().length, 2, "one replacement head fetch");
      assert.equal(fake.of("session.send").length, 0, "nothing is re-sent");
      assert.deepEqual(
        sessionLog(handle.getView().ui)
          .map((l) => l.text)
          .at(-1),
        "next boundary · follow up · at the next tool boundary",
        "the queued message still shows, off the snapshot",
      );
    } finally {
      teardown();
    }
  });

  test("a message typed before the drop is kept, not sent, until the daemon answers", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      // Daemon-dependent input is gated once, on ClientState's discriminant,
      // rather than each action discovering the dead socket for itself.
      fake.deliver(loadablePending);
      handle.handleKey("n", {} as Key);
      assert.equal(handle.getView().ui.overlay.t, "browse", "no new-session prompt opens");

      fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
      handle.handleKey("", { return: true } as Key); // open the send prompt
      for (const ch of "half typed") handle.handleKey(ch, {} as Key);

      // The connection drops with the message half-written (an `$EDITOR`
      // handoff returning after the drop lands the same way).
      fake.deliver(loadablePending);
      handle.handleKey("x", {} as Key);
      handle.handleKey("", { return: true } as Key);
      assert.equal(fake.of("session.send").length, 0, "nothing is sent to a socket that is gone");
      assert.equal(
        openPrompt(handle.getView().ui.overlay)?.buffer.text,
        "half typed",
        "the prompt keeps what was typed",
      );

      // Reconnected: the same keypress sends the same text, once.
      fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
      handle.handleKey("", { return: true } as Key);
      const sent = fake.of("session.send");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.params["text"], "half typed");
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
      assert.equal(handle.transcript.get().transcript.t, "tailing");

      fake.deliver(loadablePending);
      assert.equal(fake.heads().length, 1, "no replacement fetch while the fleet is unknown");
      assert.equal(
        handle.transcript.get().transcript.t,
        "unloaded",
        "the window was dropped, not left claiming data",
      );

      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(fake.heads().length, 2, "data refetches the head, once");
      fake.heads()[1]?.resolve(pageOf(6, 3, null));
      await delay(0);
      assert.equal(handle.transcript.get().transcript.t, "tailing");
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
      assert.ok(handle.transcript.get().scroll > 0, "and left the viewport pinned at the top");

      // The connection drops and returns before that page lands. The new
      // generation reads its own, longer head page.
      fake.deliver(loadablePending);
      fake.deliver(fleetOf(testSession({ id: "a" })));
      assert.equal(fake.heads().length, 2, "the new generation fetched its own head");
      fake.heads()[1]?.resolve(pageOf(200, 80, { olderThan: 121 }));
      await delay(0);

      const before = handle.transcript.get();
      const idsBefore = idsOf(before);
      assert.equal(before.scroll, 0, "the reset re-anchored the viewport at the live tail");

      stale.resolve(pageOf(60, 40, { olderThan: 21 }));
      await delay(0);

      const after = handle.transcript.get();
      assert.deepEqual(idsOf(after), idsBefore, "the obsolete page adds no entries");
      assert.deepEqual(
        winOf(after)?.olderCursor,
        { olderThan: 121 },
        "and cannot move the cursor back to its own generation's",
      );
      assert.equal(after.scroll, 0, "and moves no viewport");
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
      const sel = handle.getView().ui.selectedId;
      assert.ok(sel);
      fake.heads()[0]?.reject(new Error("history unavailable"));
      await delay(0);
      assert.equal(handle.transcript.get().transcript.t, "failed");
      assert.equal(fake.heads().length, 1, "and nothing retries it on its own");

      // Move away and come back — an explicit user action, not a render.
      handle.handleKey("", { downArrow: true } as Key);
      assert.notEqual(handle.getView().ui.selectedId, sel);
      handle.handleKey("", { upArrow: true } as Key);
      assert.equal(handle.getView().ui.selectedId, sel);

      const retry = fake.heads().filter((c) => c.params["id"] === sel);
      assert.equal(retry.length, 2, "reselecting retries the failed head fetch");
      retry[1]?.resolve(pageOf(2, 2, null, sel));
      await delay(0);
      assert.equal(handle.transcript.get().transcript.t, "tailing");
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
      const send = fake.of("session.send");
      assert.equal(send.length, 1, "queued with the daemon at once");

      // The connection dropped before the daemon replied — it may well be queued.
      send[0]?.reject(Object.assign(new Error("connection dropped"), { code: "disconnected" }));
      await delay(0);

      // No later snapshot may put it back on the wire.
      fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle, turns: 2 })));
      assert.equal(fake.of("session.send").length, 1, "no automatic second send");
      assert.equal(outboxOf(handle.composer.get(), "a").t, "held");
      assert.match(handle.getView().ui.notice?.text ?? "", /No confirmation/);

      // The text is not lost: opening `send` on that session brings it back,
      // and sending it unchanged quotes the same entry id — a retry the daemon
      // answers rather than queues twice.
      await delay(110); // A new keypress, past the batched double-Enter guard.
      handle.handleKey("", { return: true } as Key);
      assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "follow up");
      handle.handleKey("", { return: true } as Key);
      const again = fake.of("session.send");
      assert.equal(again.length, 2);
      assert.equal(again[1]?.params["entryId"], again[0]?.params["entryId"]);
    } finally {
      teardown();
    }
  });

  test("q opens the selected session's queue; ↑↓ select by id; its keys act on the entry", () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      const entries = [
        queueEntry("e1", { preview: "first", revision: 2 }),
        queueEntry("e2", { preview: "second", revision: 5 }),
      ];
      fake.deliver(fleetOf(testSession({ id: "a", queue: queueOf(entries) })));
      handle.handleKey("q", {} as Key);
      const view = handle.getView();
      assert.equal(view.ui.overlay.t, "queue", "q no longer quits: it opens the queue");
      assert.equal(view.body.t, "queue");
      handle.handleKey("", { downArrow: true } as Key);
      const o = handle.getView().ui.overlay;
      assert.equal(o.t === "queue" && o.selected, "e2");
      // An arrival above it does not move the selection.
      fake.deliver(
        fleetOf(testSession({ id: "a", queue: queueOf([queueEntry("e0"), ...entries]) })),
      );
      const after = handle.getView().ui.overlay;
      assert.equal(after.t === "queue" && after.selected, "e2");
      // x removes the selected entry at the revision on screen.
      handle.handleKey("x", {} as Key);
      const removed = fake.of("session.queueRemove");
      assert.deepEqual(removed[0]?.params["entries"], [{ entryId: "e2", revision: 5 }]);
      // K moves it up within its group.
      handle.handleKey("K", {} as Key);
      assert.equal(fake.of("session.queueMove")[0]?.params["direction"], "up");
      // c asks first, over the ids on screen only.
      handle.handleKey("c", {} as Key);
      const confirm = handle.getView().ui.overlay;
      assert.equal(confirm.t === "confirm" && confirm.confirm.action, "clearQueue");
      assert.deepEqual(
        confirm.t === "confirm" && confirm.confirm.action === "clearQueue"
          ? confirm.confirm.entryIds
          : null,
        ["e0", "e1", "e2"],
      );
      // A message arriving while the confirm is up is not swept with them.
      fake.deliver(
        fleetOf(
          testSession({
            id: "a",
            queue: queueOf([queueEntry("e0"), ...entries, queueEntry("late")]),
          }),
        ),
      );
      handle.handleKey("", { return: true } as Key);
      assert.deepEqual(fake.of("session.queueClear")[0]?.params["entryIds"], ["e0", "e1", "e2"]);
      assert.equal(handle.getView().ui.overlay.t, "queue", "and it returns to the queue");
      handle.handleKey("", { escape: true } as Key);
      assert.equal(handle.getView().ui.overlay.t, "browse");
    } finally {
      teardown();
    }
  });

  test("e edits a queued message in the composer; a conflict keeps the text and says why", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      const entry = queueEntry("e1", { preview: "draft", revision: 3 });
      fake.deliver(fleetOf(testSession({ id: "a", queue: queueOf([entry]) })));
      handle.handleKey("q", {} as Key);
      fake
        .of("session.queueEntry")
        .at(-1)
        ?.resolve({ ...entry, text: "draft in full", createdAt: 0 });
      await delay(0);
      handle.handleKey("e", {} as Key);
      const p = openPrompt(handle.getView().ui.overlay);
      assert.equal(p?.buffer.text, "draft in full", "the full text, not the preview");
      assert.deepEqual(p?.t === "session" ? p.edit : null, { entryId: "e1", revision: 3 });
      for (const ch of " now") handle.handleKey(ch, {} as Key);
      handle.handleKey("", { return: true } as Key);
      const edit = fake.of("session.queueEdit");
      assert.equal(edit[0]?.params["text"], "draft in full now");
      assert.equal(edit[0]?.params["revision"], 3);
      assert.equal(fake.of("session.send").length, 0, "an edit sends nothing");
      edit[0]?.reject(
        Object.assign(new Error("The message changed since you looked; review it and retry."), {
          code: "conflict",
        }),
      );
      await delay(0);
      const reopened = openPrompt(handle.getView().ui.overlay);
      assert.equal(reopened?.buffer.text, "draft in full now", "the losing edit is kept");
      assert.match(reopened?.feedback?.text ?? "", /changed since you looked/);
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
      assert.equal(handle.transcript.get().transcript.t, "tailing");

      // Home scrolls to the oldest row held, which prefetches the next older
      // page; folding it in takes the window past the cap.
      handle.handleKey("", { home: true } as Key);
      const older = fake.olders()[0];
      assert.ok(older, "the climb asked for an older page");
      assert.deepEqual(older.params["cursor"], { olderThan: 14_001 }, "using the held cursor");
      older.resolve(pageOf(14_000, 6_000, { olderThan: 8_001 }));
      await delay(0);

      const browsing = winOf(handle.transcript.get())!;
      assert.equal(browsing.lines.length, TRANSCRIPT_CAP, "12,000 fetched, 10,000 retained");
      assert.equal(browsing.lines[0]?.id, 8_001, "the oldest end is the end being read");
      assert.equal(handle.transcript.get().transcript.t, "detached", "the newest end was evicted");
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
        winOf(handle.transcript.get())?.lines,
        browsing.lines,
        "the rows being read are untouched",
      );

      // End is the way back: drop the older window and refetch the newest.
      handle.handleKey("", { end: true } as Key);
      const reloads = fake.heads();
      assert.equal(reloads.length, 2, "jumping to latest refetched the newest page");
      reloads[1]?.resolve(pageOf(20_001, 500, { olderThan: 19_502 }));
      await delay(0);

      const followed = winOf(handle.transcript.get())!;
      assert.equal(handle.transcript.get().transcript.t, "tailing", "and resumed following it");
      assert.equal(followed.lines.at(-1)?.id, 20_001);
      assert.equal(handle.transcript.get().scroll, 0, "with the viewport back at the tail");
    } finally {
      teardown();
    }
  });

  test("selecting another session loads that one, and the page it left cannot come back", async () => {
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
      assert.equal(handle.getView().ui.selectedId, "a");
      const forA = fake.heads()[0];
      assert.ok(forA, "the selected session fetched its head");

      // Move to `b` before `a`'s page lands. There is no cache to fall back on:
      // the resource is the selected session's, so it starts loading again.
      handle.handleKey("", { downArrow: true } as Key);
      assert.equal(handle.getView().ui.selectedId, "b");
      assert.equal(handle.transcript.get().transcript.t, "loading");
      const forB = fake.heads()[1];
      assert.ok(forB, "and `b` asked for its own newest page");
      assert.equal(forB.params["id"], "b");

      // `a`'s response finally arrives. It belongs to a lifetime that is over.
      forA.resolve(pageOf(50, 5, null, "a"));
      await delay(0);
      assert.equal(
        handle.transcript.get().transcript.t,
        "loading",
        "the abandoned page installs nothing, not even under the wrong session",
      );

      forB.resolve(pageOf(9, 3, null, "b"));
      await delay(0);
      const win = winOf(handle.transcript.get());
      assert.equal(win?.sessionId, "b");
      assert.deepEqual(
        win?.lines.map((l) => l.id),
        [7, 8, 9],
      );
    } finally {
      teardown();
    }
  });

  test("a live frame at the tail keeps the rows being read where they are", async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm, historyPageSize: 40 });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      fake.heads()[0]?.resolve(pageOf(100, 40, null));
      await delay(0);

      handle.handleKey("", { pageUp: true } as Key);
      const scrolled = handle.transcript.get().scroll;
      assert.ok(scrolled > 0, "the viewport is back in history");

      // One more line at the tail. The offset counts up from the tail, so it has
      // to grow by the rows the log gained or the reader's window slides older.
      fake.push({
        kind: "push",
        seq: 1,
        epoch: "e1",
        type: "event",
        id: 101,
        event: { sessionId: "a", ts: 1, type: "assistant_text", text: "live" },
      });
      assert.equal(
        handle.transcript.get().scroll,
        scrolled + 1,
        "the one row it added is absorbed by the offset, not by the window",
      );
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
        requestsFor(fleetSessions(handle.getView().ui), "a").map((r) => r.id),
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
        requestsFor(fleetSessions(handle.getView().ui), "a").map((r) => r.id),
        ["p1"],
      );
      assert.equal(handle.getView().request?.id, "p1");
    } finally {
      teardown();
    }
  });
});

test("an unchanged memoized header reads the new palette when the theme changes", async () => {
  const { Header, PaletteContext } = await import("@loom/tui/components");
  const { PALETTES } = await import("@loom/tui/theme");
  const colors: string[] = [];
  const palette = (p: typeof PALETTES.dark) => ({
    ...p,
    get accent() {
      colors.push(p.accent);
      return p.accent;
    },
  });
  const child = createElement(Header, {
    width: 80,
    view: {
      connection: "live",
      version: "test",
      repo: "repo",
      sessions: 0,
      waiting: 0,
      running: 0,
      background: 0,
    },
  });
  const stdout = new FakeOut();
  const stdin = new FakeIn();
  const tree = (p: typeof PALETTES.dark) =>
    createElement(PaletteContext.Provider, { value: palette(p) }, child);
  const app = render(tree(PALETTES.dark), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    assert.ok(colors.includes(PALETTES.dark.accent));
    colors.length = 0;
    app.rerender(tree(PALETTES.light));
    await app.waitUntilRenderFlush();
    assert.ok(
      colors.includes(PALETTES.light.accent),
      "the header must request its new colour despite unchanged view props",
    );
  } finally {
    app.unmount();
  }
});

test("the palette fits short and narrow viewports and keeps the last command reachable", async () => {
  const { Picker } = await import("@loom/tui/components");
  const { paletteActions } = await import("@loom/tui/commands");
  const { makePicker } = await import("@loom/tui/overlay");
  const state = reduce(initialState(), { t: "state", state: fleetOf(testSession({ id: "a" })) });
  const items = paletteActions(state, "a").map((a) => ({
    id: a.id,
    label: a.label,
    hint: a.keys,
    ...(a.disabled ? { disabled: a.disabled } : {}),
  }));
  for (const [width, height] of [
    [96, 38],
    [28, 12],
  ]) {
    const at = (index: number) =>
      stripVTControlCharacters(
        renderToString(
          createElement(Picker, {
            picker: makePicker({
              step: "command",
              title: "commands",
              items,
              index,
              dest: { t: "command", target: "a" },
            }),
            width: width!,
            height: height!,
          }),
          { columns: width! },
        ),
      );
    assert.ok(at(0).split("\n").length <= height!);
    assert.match(at(0), /COMMANDS/);
    const last = items.at(-1)!;
    const end = at(items.length - 1);
    assert.ok(end.split("\n").length <= height!);
    assert.match(end, new RegExp(last.label.slice(0, 8)));
    // The highlighted row's reason replaces the key hints when it can't run.
    if (last.disabled && width! > 40) assert.match(end, new RegExp(last.disabled.slice(0, 12)));
  }
});

test("cold send dismisses the prompt for startup and recovers an unaccepted draft on rejection", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("hello", {} as Key);
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    fake.deliver(fleetOf(testSession({ id: "a", status: { kind: "starting" } })));
    assert.equal(handle.getView().sel?.status.kind, "starting");
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    assert.equal(fake.of("session.send").length, 1);
    fake.of("session.send")[0]!.reject(new Error("Could not resume session: history missing"));
    await delay(0);
    const ui = handle.getView().ui;
    assert.equal(openPrompt(ui.overlay), null);
    assert.equal(ui.drafts.last, "hello");
    assert.match(ui.notice?.text ?? "", /history missing.*draft saved/);
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    await delay(110); // A new keypress, past the batched double-Enter guard.
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "hello");
    assert.equal(fake.of("session.send").length, 1);
  } finally {
    teardown();
  }
});

test("startup progress reaches Chat while the session is still starting", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: { kind: "starting" } })));
    fake.heads()[0]?.resolve({ items: [], olderCursor: null });
    await delay(0);
    fake.push({
      kind: "push",
      seq: 1,
      epoch: "e1",
      type: "event",
      id: 1,
      event: { type: "startup_progress", sessionId: "a", ts: 1, message: "Starting VM…" },
    });
    assert.equal(handle.getView().sel?.status.kind, "starting");
    assert.equal(winOf(handle.transcript.get())?.lines.at(-1)?.text, "Starting VM…");
  } finally {
    teardown();
  }
});

test("a pending send does not silently block a later prompt", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("first", {} as Key);
    handle.handleKey("", { return: true } as Key);
    assert.equal(fake.of("session.send").length, 1);
    // The daemon can publish activity while the earlier RPC is still pending.
    fake.deliver(fleetOf(testSession({ id: "a", status: stateRunning })));
    await delay(110);
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("follow-up", {} as Key);
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    assert.deepEqual(
      fake.of("session.send").map((call) => call.params.text),
      ["first", "follow-up"],
    );
    for (const call of fake.of("session.send")) call.resolve({ injected: true });
    await delay(0);
  } finally {
    teardown();
  }
});

test("an ambiguous send saves the draft and warns without retrying automatically", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("hello", {} as Key);
    handle.handleKey("", { return: true } as Key);
    fake.of("session.send")[0]!.reject(Object.assign(new Error("timeout"), { code: "timeout" }));
    await delay(0);
    const ui = handle.getView().ui;
    assert.equal(openPrompt(ui.overlay), null);
    assert.equal(ui.drafts.last, "hello");
    assert.match(ui.notice?.text ?? "", /No confirmation.*Check the session before retrying/);
    assert.doesNotMatch(ui.notice?.text ?? "", /Press Esc/);
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle, turns: 1 })));
    await delay(110); // Deliberately reopening the draft, not a repeated submit.
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "hello");
    assert.equal(fake.of("session.send").length, 1);
    handle.handleKey("", { escape: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
  } finally {
    teardown();
  }
});

test("an accepted send failure stays on the session without restoring a duplicate draft", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("hello", {} as Key);
    handle.handleKey("", { return: true } as Key);
    // Repeated Enter in the same input burst must not reopen or resend.
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    assert.equal(fake.of("session.send").length, 1);
    fake.deliver(
      fleetOf(
        testSession({
          id: "a",
          status: {
            kind: "error",
            message: "Provider startup failed",
          },
        }),
      ),
    );
    fake.of("session.send")[0]!.reject(
      Object.assign(new Error("Provider startup failed"), {
        data: { sessionId: "a" },
      }),
    );
    await delay(0);
    const view = handle.getView();
    assert.equal(view.ui.selectedId, "a");
    assert.equal(view.sel?.status.kind, "error");
    assert.equal(openPrompt(view.ui.overlay), null);
    assert.equal(view.ui.drafts.last, "");
    assert.equal(fake.of("session.send").length, 1);
  } finally {
    teardown();
  }
});

test("isolation-incompatible Claude session is read-only with a visible reason and fork action", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    const session = testSession({
      id: "a",
      provider: "claude",
      status: stateIdle,
      resumable: false,
      resumeBlockedReason: "No VM history. Fork to continue.",
    });
    fake.deliver(fleetOf(session));
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    assert.equal(fake.of("session.send").length, 0);
    const frame = renderToString(
      createElement(Detail, {
        session,
        fleet: fleetOf(session),
        mode: null,
        width: 70,
        now: Date.now(),
      }),
    );
    assert.match(frame, /Read-only: No VM history/);
    // A read-only session can only hand off: model (its catalogue is empty
    // here), workspace, confirm.
    handle.handleKey("F", {} as Key);
    const first = handle.getView().ui.overlay;
    assert(first.t === "picker" && first.picker.step === "model");
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("", { return: true } as Key);
    assert.equal(fake.of("session.fork").length, 1);
    assert.equal(fake.of("session.fork")[0]?.params["history"], "handoff");
  } finally {
    teardown();
  }
});

test("server-pending modes stay grey in Detail and the reply prompt until applied", async () => {
  const { PaletteContext } = await import("@loom/tui/components");
  const { PALETTES } = await import("@loom/tui/theme");
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  let warnings = 0;
  const palette = {
    ...PALETTES.dark,
    get warn() {
      warnings++;
      return PALETTES.dark.warn;
    },
  };
  const draw = () => {
    const view = handle.getView();
    warnings = 0;
    const frame = renderToString(
      createElement(
        PaletteContext.Provider,
        { value: palette },
        view.detail.render(Date.now()),
        createElement(PromptPane, { state: view.ui, width: 80 }),
      ),
    );
    assert.equal((frame.match(/\[acceptEdits\]/g) ?? []).length, 2);
    return warnings;
  };
  try {
    // This selection came from the server, without any local keypress.
    fake.deliver(
      fleetOf(
        testSession({
          id: "a",
          status: stateRunning,
          mode: "acceptEdits",
          pendingMode: "acceptEdits",
        }),
      ),
    );
    handle.handleKey("", { return: true } as Key);
    const pendingWarnings = draw();
    fake.deliver(fleetOf(testSession({ id: "a", status: stateRunning, mode: "acceptEdits" })));
    assert.equal(draw(), pendingWarnings + 2, "both chips regain their normal colour");
  } finally {
    teardown();
  }
});

test("mode chips in new and reply prompts are clickable without losing the draft", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  const clickChip = () => {
    const chip = handle.getView().hits.find((hit) => hit.kind === "promptMode");
    assert.ok(chip);
    handle.handleKey(`[<0;${chip.x0};${chip.y}M`, {} as Key);
  };
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle, mode: "default" })));
    handle.handleKey("n", {} as Key);
    handle.handleKey("new draft", {} as Key);
    const before = openPrompt(handle.getView().ui.overlay);
    assert.equal(before?.t, "new");
    clickChip();
    const after = openPrompt(handle.getView().ui.overlay);
    assert.equal(after?.buffer.text, "new draft");
    assert(after?.t === "new" && before?.t === "new");
    assert.notEqual(after.settings.mode, before.settings.mode);
    assert.equal(fake.of("session.setMode").length, 0);
    handle.handleKey("", { escape: true } as Key);
    handle.handleKey("", { return: true } as Key);
    clickChip();
    assert.equal(handle.modes.get()["a"]?.t, "choosing");
    assert.ok(openPrompt(handle.getView().ui.overlay));
  } finally {
    teardown();
  }
});

test("cold send closes the composer and selects the session on a durable rejection", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("hello", {} as Key);
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    assert.equal(fake.of("session.send").length, 1);
    fake
      .of("session.send")[0]!
      .reject(Object.assign(new Error("history missing"), { data: { sessionId: "a" } }));
    await delay(0);
    const ui = handle.getView().ui;
    assert.equal(openPrompt(ui.overlay), null);
    assert.equal(ui.selectedId, "a");
    assert.equal(ui.drafts.last, "");
  } finally {
    teardown();
  }
});

test("reply recall queries user messages independently of transcript loading", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    handle.handleKey("", { return: true } as Key);
    fake.of("session.messages")[0]!.resolve(["opening", "failed follow-up"]);
    await delay(0);
    handle.handleKey("", { upArrow: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "failed follow-up");
  } finally {
    teardown();
  }
});

test("Detail keeps ChatGPT model limits visible on separate rows", async () => {
  const { stripVTControlCharacters: stripAnsi } = await import("node:util");
  const session = snap({
    rateLimits: {
      "codex 5h": { status: "allowed", utilization: 20, resetsAt: 2_000_000_000_000 },
      "codex 7d": { status: "allowed_warning", utilization: 85, resetsAt: 2_000_000_000_000 },
      "gpt-6-astra 5h": { status: "rejected", utilization: 100, resetsAt: 2_000_000_000_000 },
    },
  });
  const frame = stripAnsi(
    renderToString(
      createElement(Detail, {
        session,
        fleet: loadableIdle,
        mode: null,
        width: 50,
        now: 1_999_999_000_000,
      }),
      { columns: 50 },
    ),
  );
  const rows = frame.split("\n");
  for (const label of ["codex 5h 20%", "codex 7d 85%", "gpt-6-astra 5h 100%"])
    assert.ok(
      rows.some((row) => row.includes(label)),
      frame,
    );
  assert.equal(rows.filter((row) => /codex|gpt-6-astra/.test(row)).length, 3);
});

test("v cycles Chat verbosity and the palette can change it too", async () => {
  const { stdout, stdin, app, settle } = await mountFleet([snap({ title: "filter test" })]);
  try {
    assert.match(stdout.last, /Chat[^\n]*full/);
    for (const tag of ["chat", "chat+tools", "full"]) {
      stdin.feed("v");
      await settle();
      const header = stdout.last
        .split("\n")
        .find((line) => /Chat\s+(chat\+tools|chat|full)\b/.test(line));
      assert.equal(header?.match(/Chat\s+(chat\+tools|chat|full)\b/)?.[1], tag, header);
    }
    stdin.feed(" ");
    await settle();
    stdin.feed("verbosity");
    await settle();
    stdin.feed("\r");
    await settle();
    assert.match(stdout.last, /Chat[^\n]*chat/);
    assert.doesNotMatch(stdout.last, /COMMANDS/);
  } finally {
    app.unmount();
  }
});

test("environment checks do not block input or history loading", async () => {
  const fake = mkFakeClient();
  fake.deliver(fleetOf(snap({ id: "a", title: "responsive session" })));
  const check = Promise.withResolvers<string | null>();
  const mounted = mount(fake.client, { checkEnvironment: () => check.promise });
  try {
    await waitFor(mounted.stdout, /loading history/);
    assert.doesNotMatch(mounted.stdout.last, /\(quiet\)/);
    mounted.stdin.feed(" ");
    await waitFor(mounted.stdout, /COMMANDS/);
    mounted.stdin.feed(ESC);
    fake.heads()[0]!.resolve({ items: [], olderCursor: null });
    await waitFor(mounted.stdout, /\(quiet\)/);
    check.resolve("Environment image missing or out of date.");
    await waitFor(mounted.stdout, /Environment image missing/);
  } finally {
    check.resolve(null);
    mounted.app.unmount();
  }
});

test("a late startup check cannot replace the environment preparation recheck", async () => {
  const fake = mkFakeClient();
  fake.deliver(fleetOf());
  const first = Promise.withResolvers<string | null>();
  let checks = 0;
  const handle = mkFleetHandle({
    client: fake.client,
    term: {
      ...fakeTerm,
      suspendTerminal: async (fn) => {
        await fn();
      },
    },
    prepareEnvironment: async () => 0,
    checkEnvironment: () => (++checks === 1 ? first.promise : Promise.resolve(null)),
  });
  const stop = handle.effectStart();
  try {
    handle.handleKey(" ", {} as Key);
    handle.handleKey("Prepare repo environment", {} as Key);
    handle.handleKey("", { return: true } as Key);
    await delay(0);
    assert.equal(checks, 2);
    first.resolve("stale environment warning");
    await delay(0);
    assert.equal(handle.getView().environmentWarning, null);
  } finally {
    first.resolve(null);
    stop();
  }
});

test("runtime warning stays in the frame until a compatibility recheck succeeds", async () => {
  for (const code of [0, 1, 130]) {
    const fake = mkFakeClient();
    fake.deliver(fleetOf());
    const warning = "Environment image missing or out of date.";
    const mounted = mount(
      fake.client,
      {
        environmentWarning: warning,
        prepareEnvironment: async () => code,
        checkEnvironment: async () => (code === 0 ? null : warning),
      },
      { columns: 100, rows: 24 },
    );
    try {
      await waitFor(mounted.stdout, /Environment image missing/);
      assert.match(mounted.stdout.last, /Upgrade Loom or rebuild the configured runtime/);
      assert(mounted.stdout.last.trimEnd().split("\n").length <= 24);
    } finally {
      mounted.app.unmount();
    }
    const handle = mkFleetHandle({
      client: fake.client,
      term: {
        ...fakeTerm,
        suspendTerminal: async (fn) => {
          await fn();
        },
      },
      environmentWarning: warning,
      prepareEnvironment: async () => code,
      checkEnvironment: async () => (code === 0 ? null : warning),
    });
    const stop = handle.effectStart();
    try {
      fake.deliver(fleetOf());
      assert.equal(handle.getView().environmentWarning, warning);
      handle.handleKey(" ", {} as Key);
      handle.handleKey("Prepare repo environment", {} as Key);
      handle.handleKey("", { return: true } as Key);
      await delay(0);
      assert.equal(handle.getView().environmentWarning, code === 0 ? null : warning);
      assert.equal(handle.getView().rows, code === 0 ? 40 : 38);
    } finally {
      stop();
    }
  }
});

test("new-session isolation follows the provider default and can be overridden without losing the draft", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      loadableLoaded({
        daemon: testDaemon,
        sessions: [],
        providers: [
          {
            id: "claude",
            models: ["fixture"],
            defaultModel: "fixture",
            defaultEffort: "",
            defaultMode: "default",
            defaultIsolation: "vm",
            tag: "Claude",
            color: "",
            isDefault: true,
          },
        ],
      }),
    );
    handle.handleKey("n", {} as Key);
    handle.handleKey("keep this draft", {} as Key);
    handle.handleKey("i", { meta: true } as Key);
    const p = openPrompt(handle.getView().ui.overlay);
    assert.equal(p?.buffer.text, "keep this draft");
    assert(p?.t === "new");
    assert.equal(p.settings.isolation, "local");
    handle.handleKey("", { return: true } as Key);
    assert.equal(fake.of("session.create")[0]?.params["isolation"], "local");
  } finally {
    teardown();
  }
});

test("unavailable VM choice explains why and leaves the local session draft intact", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      loadableLoaded({
        daemon: testDaemon,
        sessions: [],
        providers: [
          {
            id: "claude",
            models: ["fixture"],
            defaultModel: "fixture",
            defaultEffort: "",
            defaultMode: "default",
            defaultIsolation: "local",
            vmUnavailableReason: "No VM runtime is configured",
            tag: "Claude",
            color: "",
            isDefault: true,
          },
        ],
      }),
    );
    handle.handleKey("n", {} as Key);
    handle.handleKey("draft", {} as Key);
    handle.handleKey("i", { meta: true } as Key);
    const p = openPrompt(handle.getView().ui.overlay);
    assert(p?.t === "new");
    assert.equal(p.settings.isolation, undefined);
    assert.equal(p.buffer.text, "draft");
    assert.equal(p.feedback?.text, "No VM runtime is configured");
    assert.equal(p.feedback?.pending, false);
  } finally {
    teardown();
  }
});

test("fork selector inherits isolation and sends an explicit override", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      fleetOf(
        testSession({
          status: stateIdle,
          isolation: "vm",
          nativeForkBlockedReason: "Native history forks need Local isolation.",
        }),
      ),
    );
    handle.handleKey("F", {} as Key);
    handle.handleKey("", { return: true } as Key); // model: the provider default
    handle.handleKey("", { return: true } as Key); // workspace: copy
    const overlay = handle.getView().ui.overlay;
    assert(overlay.t === "confirm" && overlay.confirm.action === "forkSession");
    assert.equal(overlay.confirm.fork.isolation, "vm");
    handle.handleKey("i", {} as Key);
    handle.handleKey("", { return: true } as Key);
    assert.equal(fake.of("session.fork")[0]?.params["isolation"], "local");
  } finally {
    teardown();
  }
});
/** Two providers, each with its own catalogue; Claude's models take effort. */
const forkProviders = [
  {
    id: "claude",
    models: ["claude-opus-5"],
    modelChoices: [
      {
        id: "claude-opus-5",
        label: "Opus",
        supportsEffort: true,
        effortLevels: ["low", "high"],
        defaultEffort: "high",
      },
    ],
    defaultModel: "claude-opus-5",
    defaultEffort: "",
    defaultMode: "default" as const,
    tag: "Claude",
    color: "",
    isDefault: true,
  },
  {
    id: "codex",
    models: ["gpt-6"],
    modelChoices: [
      {
        id: "gpt-6",
        label: "GPT-6",
        supportsEffort: true,
        effortLevels: ["low", "medium"],
        defaultEffort: "low",
      },
    ],
    defaultModel: "gpt-6",
    defaultEffort: "",
    defaultMode: "default" as const,
    tag: "Codex",
    color: "",
    isDefault: false,
  },
];

const forkFleet = (...sessions: SessionSnapshot[]): ClientState =>
  loadableLoaded({ daemon: testDaemon, providers: forkProviders, sessions });

const overlayOf = (handle: ReturnType<typeof mkFleetHandle>) => handle.getView().ui.overlay;
const stepOf = (handle: ReturnType<typeof mkFleetHandle>) => {
  const o = overlayOf(handle);
  return o.t === "picker" ? o.picker.step : o.t;
};
const enter = (handle: ReturnType<typeof mkFleetHandle>) =>
  handle.handleKey("", { return: true } as Key);
const down = (handle: ReturnType<typeof mkFleetHandle>) =>
  handle.handleKey("", { downArrow: true } as Key);

test("fork wizard: a handoff to another provider takes that catalogue's model and effort", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      forkFleet(testSession({ status: stateIdle, provider: "claude", model: "claude-opus-5" })),
    );
    handle.handleKey("F", {} as Key);
    const providers = overlayOf(handle);
    assert(providers.t === "picker" && providers.picker.step === "provider");
    // The source's provider is preselected and says what it can carry.
    assert.equal(pickerCurrent(providers.picker)?.id, "claude");
    assert.match(providers.picker.items[0]!.hint ?? "", /native history or handoff/);
    assert.match(providers.picker.items[1]!.hint ?? "", /handoff/);
    down(handle);
    enter(handle);
    // Another provider can only be a handoff: straight to its catalogue.
    const models = overlayOf(handle);
    assert(models.t === "picker" && models.picker.step === "model");
    assert.equal(models.picker.title, "fork · model · Codex");
    assert.deepEqual(
      models.picker.items.map((i) => i.label),
      ["GPT-6"],
    );
    enter(handle);
    const efforts = overlayOf(handle);
    assert(efforts.t === "picker" && efforts.picker.step === "effort");
    assert.deepEqual(
      efforts.picker.items.map((i) => i.id),
      ["low", "medium"],
    );
    down(handle);
    enter(handle);
    assert.equal(stepOf(handle), "forkWorkspace");
    enter(handle); // copy
    const confirm = overlayOf(handle);
    assert(confirm.t === "confirm" && confirm.confirm.action === "forkSession");
    assert.match(
      confirm.confirm.body ?? "",
      /History: handoff — a fresh Codex session \(gpt-6 · medium\)/,
    );
    assert.match(confirm.confirm.body ?? "", /provider state are not carried/);
    enter(handle);
    const params = fake.of("session.fork")[0]?.params;
    assert.equal(params?.["history"], "handoff");
    assert.equal(params?.["provider"], "codex");
    assert.equal(params?.["model"], "gpt-6");
    assert.equal(params?.["effort"], "medium");
    assert.equal(params?.["workspace"], "copy");
    assert.match(String(params?.["forkId"]), /^[0-9a-f-]{36}$/);
  } finally {
    teardown();
  }
});

test("fork wizard: native history on the source's provider, sharing its worktree", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      forkFleet(
        testSession({
          status: stateIdle,
          provider: "claude",
          model: "claude-opus-5",
          isolation: "local",
          worktree: "/tmp/wt/a",
          branch: "loom/a",
        }),
      ),
    );
    handle.handleKey("F", {} as Key);
    enter(handle); // claude
    const history = overlayOf(handle);
    assert(history.t === "picker" && history.picker.step === "forkHistory");
    assert.deepEqual(
      history.picker.items.map((i) => i.label),
      ["native history", "portable handoff"],
    );
    assert.match(history.picker.items[0]!.hint ?? "", /resumes a copy of its own session/);
    assert.match(history.picker.items[1]!.hint ?? "", /hidden provider state is not carried/);
    enter(handle); // native: no model step
    const workspace = overlayOf(handle);
    assert(workspace.t === "picker" && workspace.picker.step === "forkWorkspace");
    assert.equal(workspace.picker.items[1]!.disabled, undefined);
    // Esc steps back one step, not out of the wizard.
    handle.handleKey("", { escape: true } as Key);
    assert.equal(stepOf(handle), "forkHistory");
    enter(handle);
    down(handle);
    enter(handle); // share
    const confirm = overlayOf(handle);
    assert(confirm.t === "confirm" && confirm.confirm.action === "forkSession");
    assert.match(confirm.confirm.body ?? "", /History: native/);
    assert.match(confirm.confirm.body ?? "", /Workspace: shared/);
    // Isolation is fixed for native history.
    handle.handleKey("i", {} as Key);
    const still = overlayOf(handle);
    assert(still.t === "confirm" && still.confirm.action === "forkSession");
    assert.equal(still.confirm.fork.isolation, "local");
    enter(handle);
    const params = fake.of("session.fork")[0]?.params;
    assert.equal(params?.["history"], "native");
    assert.equal(params?.["workspace"], "share");
    assert.equal(params?.["model"], undefined);
  } finally {
    teardown();
  }
});

test("fork wizard: blocked choices say why, and a starting fork can be cancelled", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    const source = testSession({
      status: stateIdle,
      provider: "claude",
      isolation: "vm",
      worktree: "/tmp/wt/a",
      nativeForkBlockedReason: "Native history forks need Local isolation.",
    });
    fake.deliver(forkFleet(source));
    handle.handleKey("F", {} as Key);
    const providers = overlayOf(handle);
    assert(providers.t === "picker");
    assert.match(
      providers.picker.items[0]!.hint ?? "",
      /handoff · Native history forks need Local/,
    );
    enter(handle); // claude: no native choice, so the catalogue
    assert.equal(stepOf(handle), "model");
    enter(handle);
    enter(handle); // effort
    const workspace = overlayOf(handle);
    assert(workspace.t === "picker" && workspace.picker.step === "forkWorkspace");
    assert.match(workspace.picker.items[1]!.disabled ?? "", /Local isolation/);
    handle.handleKey("", { escape: true } as Key);
    handle.handleKey("", { escape: true } as Key);
    handle.handleKey("", { escape: true } as Key);
    handle.handleKey("", { escape: true } as Key);
    assert.equal(overlayOf(handle).t, "browse");

    // While a fork of this session is starting, F cancels it.
    const starting = testSession({
      id: "b",
      parentId: "a",
      forkTurn: 0,
      status: snap({ status: "starting" }).status,
      provider: "claude",
    });
    fake.deliver(forkFleet(source, starting));
    handle.handleKey("F", {} as Key);
    assert.equal(fake.of("session.interrupt")[0]?.params["id"], "b");
    assert.equal(fake.of("session.fork").length, 0);
  } finally {
    teardown();
  }
});

test("archiving locks only its session and clears on success or failure", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      fleetOf(
        testSession({ id: "a", status: stateIdle }),
        testSession({ id: "b", status: stateIdle }),
      ),
    );
    handle.handleKey("x", {} as Key);
    assert.deepEqual(handle.getView().ui.archiving, ["a"]);
    assert.match(
      renderToString(createElement(FooterArea, { state: handle.getView().ui, width: 100 })),
      /archiving…/,
    );
    const before = fake.calls.length;
    for (const key of ["x", "i", "e", "X", "c"]) {
      handle.handleKey(key, {} as Key);
    }
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("", { tab: true, shift: true } as Key);
    assert.equal(fake.calls.length, before);
    assert.equal(handle.getView().ui.overlay.t, "browse");
    handle.handleKey("", { downArrow: true } as Key);
    assert.equal(handle.getView().ui.selectedId, "b");
    handle.handleKey("x", {} as Key);
    assert.deepEqual(handle.getView().ui.archiving, ["a", "b"]);
    fake.of("session.markDone")[0]!.reject(new Error("cleanup failed"));
    await delay(0);
    assert.deepEqual(handle.getView().ui.archiving, ["b"]);
    assert.match(handle.getView().ui.notice!.text, /cleanup failed/);
    fake.of("session.markDone")[1]!.resolve({});
    await delay(0);
    assert.deepEqual(handle.getView().ui.archiving, []);
  } finally {
    teardown();
  }
});

test("confirmed dirty archives show pending state and reject duplicate input", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    fake.deliver(
      fleetOf(
        testSession({
          id: "a",
          status: stateIdle,
          git: { dirty: true } as SessionSnapshot["git"],
        }),
      ),
    );
    handle.handleKey("x", {} as Key);
    assert.equal(handle.getView().ui.overlay.t, "confirm");
    assert.deepEqual(handle.getView().ui.archiving, []);
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("", { return: true } as Key);
    handle.handleKey("x", {} as Key);
    assert.deepEqual(handle.getView().ui.archiving, ["a"]);
    assert.equal(fake.of("session.markDone").length, 1);
    assert.equal(fake.of("session.markDone")[0]!.params.force, true);
    fake.of("session.markDone")[0]!.resolve({});
    await delay(0);
    assert.deepEqual(handle.getView().ui.archiving, []);
  } finally {
    teardown();
  }
});

for (const includeEventLogInEditor of [undefined, false, true]) {
  test(`Alt+E includes the event log only when enabled (${includeEventLogInEditor ?? "default"})`, async () => {
    const fake = mkFakeClient();
    const calls: Array<{ text: string; aside?: { name: string; body: string } }> = [];
    const handle = mkFleetHandle({
      client: fake.client,
      term: fakeTerm,
      ...(includeEventLogInEditor === undefined ? {} : { includeEventLogInEditor }),
      openEditorOverride: async (text, opts) => {
        calls.push({ text, ...(opts?.aside ? { aside: opts.aside } : {}) });
        return "edited input\n";
      },
    });
    const teardown = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ id: "a" })));
      fake.heads()[0]?.resolve(pageOf(3, 3, null, "a"));
      await delay(0);
      handle.handleKey("", { return: true } as Key);
      handle.handleKey("draft", {} as Key);
      handle.handleKey("e", { meta: true } as Key);
      await delay(0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.text, "draft");
      if (includeEventLogInEditor) {
        assert.equal(calls[0]?.aside?.name, "events.log");
        assert.match(calls[0]?.aside?.body ?? "", /line-3/);
      } else {
        assert.equal(calls[0]?.aside, undefined);
      }
      assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "edited input");
      assert.equal(fake.of("session.send").length, 0, "editing does not submit the prompt");
    } finally {
      teardown();
    }
  });
}

test("s hands off the selected session and restores the TUI after shell exit or failure", async () => {
  for (const outcome of [0, 7, new Error("VM is not running")]) {
    const fake = mkFakeClient();
    const steps: string[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = mkFleetHandle({
      client: fake.client,
      term: {
        ...fakeTerm,
        write: (text) => steps.push(text),
        exit: () => steps.push("quit"),
        suspendTerminal: async (fn) => {
          steps.push("suspend");
          try {
            await fn();
          } finally {
            steps.push("restore");
          }
        },
      },
      openShell: async (id) => {
        steps.push("shell:" + id);
        await gate;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
    const stop = handle.effectStart();
    try {
      fake.deliver(fleetOf(testSession({ inPlace: true })));
      handle.handleKey("", { return: true } as Key);
      handle.handleKey("s", {} as Key);
      const prompt = handle.getView().ui.overlay;
      assert.equal(prompt.t, "prompt");
      if (prompt.t === "prompt") assert.equal(prompt.prompt.buffer.text, "s");
      assert.deepEqual(steps, [], "s is ordinary text while composing");
      handle.handleKey("", { escape: true } as Key);
      const before = handle.getView();
      handle.handleKey("s", {} as Key);
      handle.handleKey("s", {} as Key);
      handle.handleKey("c", { ctrl: true } as Key);
      assert.deepEqual(steps, ["suspend", MOUSE_OFF + PASTE_OFF, "shell:a"]);
      finish();
      await delay(0);
      assert.deepEqual(steps.slice(-2), ["restore", PASTE_ON + MOUSE_ON]);
      assert.equal(handle.getView().sel?.id, before.sel?.id);
      assert.equal(handle.getView().layoutView, before.layoutView);
      assert.equal(handle.getView().ui.overlay.t, "browse");
      if (outcome !== 0)
        assert.match(handle.getView().ui.notice?.text ?? "", /status 7|VM is not running/);
      handle.handleKey("", { return: true } as Key);
      const restored = handle.getView().ui.overlay;
      assert.equal(restored.t, "prompt");
      if (restored.t === "prompt") assert.equal(restored.prompt.buffer.text, "s");
    } finally {
      finish();
      stop();
    }
  }
});

test("repository palette filters full paths, cancels, and switches without stopping sessions", async () => {
  const fake = mkFakeClient();
  fake.deliver(fleetOf(snap({ title: "running task", status: "running" })));
  const switched: string[] = [];
  const { stdout, stdin, app } = mount(fake.client, {
    repositories: () => ["/work/one/project", "/work/two/project"],
    switchRepository: (path) => switched.push(path),
  });
  const feed = async (input: string) => {
    stdin.feed(input);
    await delay(30);
    await app.waitUntilRenderFlush();
  };
  const open = async () => {
    await feed(" ");
    await feed("switch repository");
    await feed("\r");
  };
  try {
    await delay(40);
    await open();
    assert.match(stdout.last, /SWITCH REPOSITORY/);
    await feed(ESC);
    assert.deepEqual(switched, []);
    assert.match(stdout.last, /running task/);
    await open();
    await feed("/two/");
    await feed("\r");
    assert.deepEqual(switched, ["/work/two/project"]);
    assert.ok(
      !fake.calls.some((call) => ["daemon.stop", "session.interrupt"].includes(call.method)),
    );
  } finally {
    app.unmount();
  }
});

test("startup repository menu selects and cancels without a daemon", async () => {
  for (const repositories of [[], ["/work/one", "/work/two"]]) {
    const stdout = new FakeOut();
    const stdin = new FakeIn();
    const results: Array<string | null> = [];
    const app = render(
      createElement(RepositoryMenu, {
        repositories,
        onDone: (path) => results.push(path),
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    const feed = async (input: string) => {
      stdin.feed(input);
      await delay(30);
      await app.waitUntilRenderFlush();
    };
    try {
      await delay(40);
      assert.match(stdout.last, /SWITCH REPOSITORY/);
      if (repositories.length) {
        await feed("\x1b[B");
        await feed("\r");
        assert.deepEqual(results, ["/work/two"]);
      } else {
        assert.match(stdout.last, /No recent repositories/);
        await feed("\r");
        assert.deepEqual(results, []);
      }
      await feed(ESC);
      assert.equal(results.at(-1), null);
    } finally {
      app.unmount();
    }
  }
});

test("a palette pick acts on the session it opened for, revalidated when it runs", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const stop = handle.effectStart();
  const press = (input: string, key = {}) => handle.handleKey(input, key as Key);
  const current = () => {
    const o = handle.getView().ui.overlay;
    return o.t === "picker" ? pickerCurrent(o.picker) : null;
  };
  try {
    const a = testSession({ id: "a", status: stateIdle, title: "first" });
    const b = testSession({ id: "b", status: stateIdle, title: "second" });
    fake.deliver(fleetOf(a, b));
    const opened = handle.getView().ui.selectedId!;
    const other = opened === "a" ? b : a;
    press(" ");
    press("rename");
    assert.equal(current()?.id, "title");
    assert.equal(current()?.disabled, undefined);

    // The palette's session leaves; the selection moves on, the palette does not.
    fake.deliver(fleetOf(other));
    assert.equal(handle.getView().ui.selectedId, other.id);
    assert.equal(current()?.disabled, "That session is no longer in the fleet.");
    press("", { return: true });
    assert.equal(handle.getView().ui.overlay.t, "picker", "a disabled row is inert");
    assert.ok(!fake.calls.some((c) => c.method === "session.setTitle"));
    press("", { escape: true });

    // A state change while open re-describes the row, and a pick runs on the
    // palette's own session once it can.
    press(" ");
    press("rename");
    fake.deliver(fleetOf({ ...other, status: stateAwaitingInput("permission") }));
    assert.equal(current()?.disabled, "Approve or deny the pending request first.");
    fake.deliver(fleetOf(other));
    press("", { return: true });
    const prompt = openPrompt(handle.getView().ui.overlay);
    assert.equal(prompt?.t === "session" ? prompt.sessionId : null, other.id);

    // A key whose command can't run says why instead of doing nothing.
    press("", { escape: true });
    press("a");
    assert.equal(handle.getView().ui.notice?.text, "No permission request pending.");
  } finally {
    stop();
  }
});

test("the key bar projects the command model, and its chips run their commands", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const stop = handle.effectStart();
  const press = (input: string, key = {}) => handle.handleKey(input, key as Key);
  const chips = () => handle.getView().bar.map((item) => item.label);
  const click = (id: string) => {
    const hit = handle.getView().hits.find((h) => h.kind === "bar" && h.command.id === id);
    assert.ok(hit, `no ${id} chip in ${chips().join(" · ")}`);
    press(`[<0;${hit.x0};${hit.y}M`);
  };
  try {
    fake.deliver(fleetOf(testSession({ id: "a", status: stateRunning })));
    // The browse bar is the enabled bar commands, in the model's order.
    assert.deepEqual(chips(), [
      "interrupt",
      "queue · next tool boundary",
      "new",
      "find",
      "quit",
      "more",
    ]);
    const hits = handle.getView().hits.filter((h) => h.kind === "bar");
    assert.ok(
      hits.every((h) => h.y === 40),
      "the bar is the frame's last row",
    );
    assert.ok(
      hits.every((h, i) => i === 0 || h.x0 > hits[i - 1]!.x1 + 1),
      "chips don't overlap",
    );

    // The composer offers the same session commands, under its own keys.
    press("", { return: true });
    press("draft");
    assert.ok(chips().includes("interrupt"));
    assert.ok(handle.getView().bar.some((i) => i.keys === "⌥i" && i.command?.target === "a"));
    assert.ok(!chips().includes("provider"), "a running turn can't switch provider here either");
    click("interrupt");
    assert.equal(fake.of("session.interrupt").length, 1);
    assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "draft", "draft kept");
    press("", { escape: true });

    // A chip's click is revalidated: an idle session no longer offers interrupt,
    // and a click on the fleet bar opens the palette for the selection.
    fake.deliver(fleetOf(testSession({ id: "a", status: stateIdle })));
    assert.ok(!chips().includes("interrupt"));
    click("palette");
    const o = handle.getView().ui.overlay;
    assert.deepEqual(o.t === "picker" ? o.picker.dest : null, { t: "command", target: "a" });
  } finally {
    stop();
  }
});

test("mouse motion and drags are never clicks", () => {
  assert.equal(mouseReport("[<35;10;3M")?.kind, "move");
  assert.equal(mouseReport("[<32;10;3M")?.kind, "move", "a drag is motion with a button held");
  assert.deepEqual(mouseReport("[<0;10;3M"), {
    button: 0,
    x: 10,
    y: 3,
    kind: "button",
    pressed: true,
  });
  assert.equal(mouseReport("[<0;10;3m")?.pressed, false);
  assert.equal(mouseReport("[<64;10;3M")?.kind, "wheel");
  assert.equal(mouseReport("[<68;10;3M")?.button, 64, "modifier bits are not buttons");
  assert.equal(mouseReport("hello"), null);
  assert.ok(MOUSE_ON.includes("?1003h") && MOUSE_OFF.includes("?1003l"));
});

test("hover follows the pointer over enabled targets and never activates them", () => {
  const fake = mkFakeClient();
  let size = { cols: 120, rows: 40 };
  let resized = () => {};
  let renders = 0;
  const handle = mkFleetHandle({
    client: fake.client,
    term: {
      ...fakeTerm,
      getSize: () => size,
      onResize: (fn) => {
        resized = fn;
        return () => {};
      },
    },
  });
  const stop = handle.effectStart();
  const off = handle.subscribe(() => renders++);
  const press = (input: string, key = {}) => handle.handleKey(input, key as Key);
  const move = (x: number, y: number) => press(`[<35;${x};${y}M`);
  const target = (key: string) => {
    const hit = handle.getView().hits.find((h) => hitKey(h) === key);
    assert.ok(hit, `${key} is not a target`);
    return hit;
  };
  try {
    const a = testSession({ id: "a", status: stateIdle, title: "first", updatedAt: 2 });
    const b = testSession({ id: "b", status: stateIdle, title: "second", updatedAt: 1 });
    fake.deliver(fleetOf(a, b));
    const selected = handle.getView().ui.selectedId;
    const other = selected === "a" ? "b" : "a";
    const row = target(`session:${other}`);
    const calls = fake.calls.length;

    // Motion shows the target under the pointer, and only redraws on a change
    // of target, not for every cell crossed.
    move(row.x0 + 1, row.y);
    assert.equal(handle.getView().hover, `session:${other}`);
    const before = renders;
    for (const x of [row.x0 + 2, row.x0 + 3, row.x0 + 4]) move(x, row.y);
    assert.equal(renders, before);
    // …and does nothing else: no selection, no request, a drag included.
    press(`[<32;${row.x0 + 5};${row.y}M`);
    assert.equal(handle.getView().ui.selectedId, selected);
    assert.equal(fake.calls.length, calls);

    // A stationary pointer over a layout that changed under it: the row it
    // pointed at went away, and the feedback follows what is there now.
    fake.deliver(fleetOf(testSession({ id: selected!, status: stateIdle, title: "kept" })));
    assert.notEqual(handle.getView().hover, `session:${other}`);
    fake.deliver(fleetOf(a, b));
    assert.equal(
      handle.getView().hover,
      hitKey(hitAt(handle.getView().hits, { x: row.x0 + 4, y: row.y })!),
    );

    // A resize re-hit-tests too: the bar moves to the new last row.
    const chip = target("bar:new");
    move(chip.x0, chip.y);
    assert.equal(handle.getView().hover, "bar:new");
    size = { cols: 120, rows: 30 };
    resized();
    assert.equal(handle.getView().hover, null, "the old last row is body now");
    move(target("bar:new").x0, 30);
    assert.equal(handle.getView().hover, "bar:new");

    // A key takes the feedback away until the mouse moves again.
    press("v");
    assert.equal(handle.getView().hover, null);

    // A modal owns the pointer: nothing under it is a target.
    move(target("bar:palette").x0, 30);
    press(`[<0;${target("bar:palette").x0};30M`);
    assert.equal(handle.getView().ui.overlay.t, "picker");
    assert.equal(handle.getView().hover, null);
    press("", { escape: true });

    // A target that can't run is not offered: an awaiting session's mode chip.
    fake.deliver(
      fleetOf(
        testSession({ id: "a", status: stateAwaitingInput("permission"), updatedAt: 2 }),
        testSession({ id: "b", status: stateAwaitingInput("permission"), updatedAt: 1 }),
      ),
    );
    assert.ok(!handle.getView().hits.some((h) => h.kind === "mode"));
  } finally {
    off();
    stop();
  }
});

test("the wheel over the answer sheet scrolls the sheet, not the hidden transcript", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({
    client: fake.client,
    term: { ...fakeTerm, getSize: () => ({ cols: 80, rows: 16 }) },
  });
  const stop = handle.effectStart();
  const press = (input: string, key = {}) => handle.handleKey(input, key as Key);
  try {
    const options = Array.from({ length: 9 }, (_, i) => ({
      label: `option ${i + 1}`,
      description: "a reason that takes up a row of its own in a narrow sheet",
    }));
    const request: SessionInteraction = {
      kind: "user_question",
      id: "p1",
      tool: "AskUserQuestion",
      input: { questions: [{ question: "Which?", header: "Pick", options }] },
      at: 1,
    };
    fake.deliver(
      fleetOf(
        testSession({ id: "a", status: stateAwaitingInput("user_question"), requests: [request] }),
      ),
    );
    press("a");
    assert.equal(handle.getView().ui.overlay.t, "questions");
    const scroll = handle.transcript.get().scroll;
    press("[<65;10;8M");
    assert.ok((handle.getView().ui.qnav?.offset ?? 0) > 0, "the sheet scrolled");
    assert.equal(handle.transcript.get().scroll, scroll, "the transcript behind it did not");
    press("[<64;10;8M");
    assert.equal(handle.getView().ui.qnav?.offset, 0);
  } finally {
    stop();
  }
});

test("with a child row focused, ⏎ and i do not reach the parent session", () => {
  const fake = mkFakeClient();
  fake.deliver(
    fleetOf(
      snap({
        id: "a",
        status: "running",
        subagents: [{ id: "child", name: "Scout", active: true }],
      }),
    ),
  );
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const stop = handle.effectStart();
  const press = (input: string, key = {}) => handle.handleKey(input, key as Key);
  const chips = () => handle.getView().bar.map((i) => i.command?.id);
  try {
    press("", { rightArrow: true });
    assert.equal(handle.getView().ui.selectedChild, "sub:child");
    assert.ok(!chips().includes("send") && !chips().includes("interrupt"));
    press("i");
    assert.equal(fake.of("session.interrupt").length, 0, "i stops nothing");
    assert.match(handle.getView().ui.notice?.text ?? "", /session row.*interrupt/);
    press("", { return: true });
    assert.equal(openPrompt(handle.getView().ui.overlay), null, "⏎ opens no composer");
    assert.match(handle.getView().ui.notice?.text ?? "", /session row.*talk to/);
    press("", { leftArrow: true });
    assert.ok(chips().includes("send") && chips().includes("interrupt"));
    press("i");
    assert.equal(fake.of("session.interrupt")[0]?.params["id"], "a");
  } finally {
    stop();
  }
});

test("number tabs preserve navigation, isolate scroll, and leave text editing alone", async () => {
  const fake = mkFakeClient();
  fake.deliver(
    fleetOf(snap({ id: "a", subagents: [{ id: "child", name: "Scout", active: true }] })),
  );
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const stop = handle.effectStart();
  const press = (input: string, key = {}) => handle.handleKey(input, key as Key);
  try {
    assert.equal(handle.getView().ui.sessionTab, "chat");
    press("2", { meta: true });
    assert.equal(handle.getView().ui.sessionTab, "chat");
    press("2");
    assert.equal(handle.getView().ui.sessionTab, "changes");
    fake
      .of("session.inspect")
      .at(-1)!
      .resolve({
        text: Array.from({ length: 60 }, (_, i) => "file " + i).join("\n"),
        sampledAt: 1,
      });
    await delay(0);
    press("", { pageDown: true });
    assert.ok(handle.getView().inspectionScroll > 0);
    const offset = handle.getView().inspectionScroll;
    press("3");
    assert.equal(handle.getView().inspectionScroll, 0);
    press("2");
    assert.equal(handle.getView().inspectionScroll, offset);
    press("", { rightArrow: true });
    assert.ok(handle.getView().ui.selectedChild);
    press("", { leftArrow: true });
    assert.equal(handle.getView().ui.selectedChild, null);
    press("", { return: true });
    assert.equal(handle.getView().ui.sessionTab, "chat");
    press("123");
    assert.equal(openPrompt(handle.getView().ui.overlay)?.buffer.text, "123");
    press("", { escape: true });
    press("/");
    press("2");
    assert.equal(handle.searches.get()?.buffer.text, "2");
    assert.equal(handle.getView().ui.sessionTab, "chat");
    press("", { escape: true });
    press(" ");
    press("3");
    assert.equal(handle.getView().ui.sessionTab, "chat");
  } finally {
    stop();
  }
});

test("inspection responses cannot leak across sessions and Changes opens a patch", async () => {
  const fake = mkFakeClient();
  fake.deliver(fleetOf(snap({ id: "a" }), snap({ id: "b" })));
  const opened: string[] = [];
  const handle = mkFleetHandle({
    client: fake.client,
    term: fakeTerm,
    openEditorOverride: async (text) => {
      opened.push(text);
      return null;
    },
  });
  const stop = handle.effectStart();
  try {
    handle.handleKey("2", {} as Key);
    const old = fake.of("session.inspect").at(-1)!;
    const before = handle.getView().ui.selectedId;
    handle.handleKey("", { downArrow: true } as Key);
    if (handle.getView().ui.selectedId === before) handle.handleKey("", { upArrow: true } as Key);
    const next = fake.of("session.inspect").at(-1)!;
    assert.notEqual(old.params["id"], next.params["id"]);
    next.resolve({ text: "new session changes", sampledAt: 1 });
    await delay(0);
    old.resolve({ text: "wrong session changes", sampledAt: 1 });
    await delay(0);
    assert.match(handle.getView().inspectionText, /new session changes/);
    assert.doesNotMatch(handle.getView().inspectionText, /wrong session/);
    handle.handleKey("o", {} as Key);
    const patch = fake.of("session.inspect").at(-1)!;
    assert.equal(patch.params["patch"], true);
    patch.resolve({ text: "diff --git a/file b/file", sampledAt: 1 });
    await delay(0);
    assert.deepEqual(opened, ["diff --git a/file b/file"]);
  } finally {
    stop();
  }
});

test("tabs render in overview and narrow session panes", async () => {
  for (const columns of [60, 120]) {
    const fake = mkFakeClient();
    fake.deliver(fleetOf(snap({ id: "tabs" })));
    const { app, stdin, stdout } = mount(fake.client, {}, { columns });
    try {
      stdin.feed("2");
      await waitFor(stdout, /2 CHANGES/);
      fake.of("session.inspect").at(-1)!.resolve({ text: "changed-file.ts", sampledAt: 1 });
      await waitFor(stdout, /changed-file.ts/);
      assert.match(stdout.last, /1 CHAT/);
      assert.match(stdout.last, /3 VM MONITOR/);
      stdin.feed("1");
      await waitFor(stdout, /\[1 CHAT\]/);
    } finally {
      app.unmount();
    }
  }
});

test("clicking rendered tabs switches views in overview and narrow session panes", async () => {
  for (const columns of [60, 120]) {
    const fake = mkFakeClient();
    fake.deliver(fleetOf(snap({ id: "tabs" })));
    const { app, stdin, stdout } = mount(fake.client, {}, { columns });
    try {
      stdin.feed("1");
      await waitFor(stdout, /\[1 CHAT\]/);
      const clickLabel = async (label: string, button = 0, ending = "M") => {
        const lines = stripVTControlCharacters(stdout.last).split("\n");
        const y = lines.findIndex((line) => line.includes(label));
        assert.ok(y >= 0, label);
        const x = lines[y]!.indexOf(label);
        stdin.feed(`\x1b[<${button};${x + 1};${y + 1}${ending}`);
        await delay(30);
        await app.waitUntilRenderFlush();
      };
      await clickLabel("2 CHANGES", 0, "m");
      assert.match(stdout.last, /\[1 CHAT\]/);
      await clickLabel("2 CHANGES", 32);
      assert.match(stdout.last, /\[1 CHAT\]/);
      await clickLabel("2 CHANGES");
      await waitFor(stdout, /\[2 CHANGES\]/);
      assert.equal(fake.of("session.inspect").at(-1)!.params["tab"], "changes");
      await clickLabel("3 VM MONITOR");
      await waitFor(stdout, /\[3 VM MONITOR\]/);
      assert.equal(fake.of("session.inspect").at(-1)!.params["tab"], "monitor");
      await clickLabel("1 CHAT");
      await waitFor(stdout, /\[1 CHAT\]/);
    } finally {
      app.unmount();
    }
  }
});
test("session inspection RPC reads the selected local checkout and reports missing worktrees", async () => {
  const { h, connect, cleanup } = await harness();
  const client = await connect();
  try {
    const s = await client.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "inspect local files",
      worktree: false,
    });
    writeFileSync(join(h.repoRoot, "inspection-file.txt"), "local edit");
    const changes = await client.request<{ text: string }>("session.inspect", {
      id: s.id,
      tab: "changes",
    });
    assert.match(changes.text, /inspection-file.txt/);
    const monitor = await client.request<{ text: string }>("session.inspect", {
      id: s.id,
      tab: "monitor",
    });
    assert.equal(monitor.text, "No VMs running for this session.");
    await assert.rejects(client.request("session.inspect", { id: "missing", tab: "changes" }));
    const stub = await client.request<SessionSnapshot>("session.createStub", {
      provider: "fake",
      prompt: "no checkout",
    });
    await assert.rejects(
      client.request("session.inspect", { id: stub.id, tab: "changes" }),
      /no working directory/,
    );
  } finally {
    await client.close();
    await cleanup();
  }
});

for (const outcome of ["success", "cancelled", "failure"] as const) {
  test(`new-session ${outcome} never takes focus from an existing reply prompt`, async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      const a = testSession({ id: "a", status: stateIdle });
      const b = snap({ id: "b", status: "starting", createdAt: 2 });
      fake.deliver(fleetOf(a));
      handle.handleKey("n", {} as Key);
      handle.handleKey("new work", {} as Key);
      handle.handleKey("", { return: true } as Key);
      const create = fake.of("session.create")[0]!;
      assert.ok(create);
      assert.equal(handle.getView().ui.selectedId, "a");
      assert.equal(handle.getView().ui.overlay.t, "browse");
      fake.deliver(fleetOf(b, a));
      assert.equal(handle.getView().ui.selectedId, "a");
      await delay(110); // A deliberate new interaction after the submit latch.
      handle.handleKey("", { return: true } as Key);
      handle.handleKey("reply in progress", {} as Key);
      const overlay = handle.getView().ui.overlay;
      assert.equal(openPrompt(overlay)?.buffer.text, "reply in progress");

      if (outcome === "failure") {
        create.reject(
          Object.assign(new Error("Provider startup failed"), { data: { sessionId: "b" } }),
        );
      } else {
        create.resolve(
          snap({ id: "b", status: outcome === "success" ? "running" : "interrupted" }),
        );
      }
      await delay(0);
      assert.equal(handle.getView().ui.selectedId, "a");
      assert.equal(handle.getView().ui.overlay, overlay);
      assert.match(
        handle.getView().ui.notice?.text ?? "",
        { success: /started/, cancelled: /cancelled/, failure: /Provider startup failed/ }[outcome],
      );
    } finally {
      teardown();
    }
  });
}

test("overlapping creates completing in reverse order never change a manual selection", async () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    const a = testSession({ id: "a", status: stateIdle });
    const b = snap({ id: "b", status: "starting", createdAt: 2 });
    const c = snap({ id: "c", status: "starting", createdAt: 3 });
    fake.deliver(fleetOf(a));
    for (const text of ["first", "second"]) {
      handle.handleKey("n", {} as Key);
      handle.handleKey(text, {} as Key);
      handle.handleKey("", { return: true } as Key);
      await delay(110);
    }
    assert.equal(fake.of("session.create").length, 2);
    fake.deliver(fleetOf(a, b, c));
    handle.handleKey("k", {} as Key); // Select b above a.
    assert.equal(handle.getView().ui.selectedId, "b");
    fake.of("session.create")[1]!.resolve(c);
    await delay(0);
    assert.equal(handle.getView().ui.selectedId, "b");
    fake.of("session.create")[0]!.resolve(b);
    await delay(0);
    assert.equal(handle.getView().ui.selectedId, "b");
  } finally {
    teardown();
  }
});

test("failed cancellation explains retry and restores messaging after a successful stop", () => {
  const fake = mkFakeClient();
  const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
  const teardown = handle.effectStart();
  try {
    const session = testSession({
      id: "a",
      status: { kind: "error", message: "worker interrupt failed" },
      stopFailed: true,
    });
    fake.deliver(fleetOf(session));
    const frame = renderToString(
      createElement(Detail, {
        session,
        fleet: fleetOf(session),
        mode: null,
        width: 90,
        now: Date.now(),
      }),
    );
    assert.match(frame, /stop failed — press i to retry/);
    handle.handleKey("", { return: true } as Key);
    assert.equal(openPrompt(handle.getView().ui.overlay), null);
    handle.handleKey("i", {} as Key);
    assert.equal(fake.of("session.interrupt").length, 1);
    const { stopFailed: _, ...stopped } = session;
    fake.deliver(fleetOf({ ...stopped, status: { kind: "interrupted", by: "user" } }));
    handle.handleKey("", { return: true } as Key);
    assert.ok(openPrompt(handle.getView().ui.overlay));
  } finally {
    teardown();
  }
});

for (const failure of [false, true]) {
  test(`compact submission allows navigation and preserves a new prompt on ${failure ? "failure" : "completion"}`, async () => {
    const fake = mkFakeClient();
    const handle = mkFleetHandle({ client: fake.client, term: fakeTerm });
    const teardown = handle.effectStart();
    try {
      const a = testSession({
        id: "a",
        status: stateIdle,
        contextUsed: 80_000,
        contextLimit: 100_000,
      });
      const b = testSession({ id: "b", status: stateIdle });
      fake.deliver(fleetOf(a, b));
      handle.handleKey("c", {} as Key);
      assert.equal(openPrompt(handle.getView().ui.overlay)?.t, "session");
      handle.handleKey("keep the plan", {} as Key);
      handle.handleKey("", { return: true } as Key);
      const call = fake.of("session.compact")[0]!;
      assert.ok(call);
      assert.deepEqual(call.params, { id: "a", instructions: "keep the plan" });
      assert.equal(openPrompt(handle.getView().ui.overlay), null);
      fake.deliver(fleetOf({ ...a, status: { kind: "starting" } }, b));
      handle.handleKey("j", {} as Key);
      assert.equal(handle.getView().sel?.id, "b");
      await delay(110);
      handle.handleKey("", { return: true } as Key);
      handle.handleKey("another task", {} as Key);
      const prompt = openPrompt(handle.getView().ui.overlay);
      assert.equal(prompt?.buffer.text, "another task");
      if (failure) call.reject(new Error("Could not resume session"));
      else call.resolve({});
      await delay(0);
      assert.equal(handle.getView().sel?.id, "b");
      assert.equal(openPrompt(handle.getView().ui.overlay), prompt);
      if (failure) {
        assert.equal(handle.getView().ui.drafts.last, "keep the plan");
        assert.match(handle.getView().ui.notice?.text ?? "", /Could not resume session/);
      }
    } finally {
      teardown();
    }
  });
}
