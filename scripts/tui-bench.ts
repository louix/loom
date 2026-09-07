/**
 * Opt-in TUI rendering benchmark (tui-reduction-plan §0).
 *
 * Mounts the real `App` against a real daemon harness on a simulated TTY and
 * records, per scenario: React render count and time (Ink's `onRender`), the
 * bytes and number of writes Ink pushes at the terminal, and key-to-visible-
 * feedback latency. `session.setMode` is timed separately across its three
 * legs — keypress → local chip feedback → RPC dispatch → RPC settlement — so
 * the 300ms cycle debounce is never mistaken for socket latency.
 *
 * Diagnostics go to a file and to this process's stdout; the TUI under test
 * writes to a fake stream, so nothing here pollutes a live terminal.
 *
 *   deno run -A scripts/tui-bench.ts --label before [--out references/x.json]
 *   deno run -A scripts/tui-bench.ts --label after --incremental
 *
 * Temporary instrumentation: delete once the plan's before/after comparison is
 * reported. Not part of the test suite.
 */
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { App } from "@loom/tui/app";
import { makeHarness } from "@loom/harness";
import type { FakeProvider } from "@loom/connector-mock";

const COLUMNS = 120;
const ROWS = 40;
const ESC = "\x1b";
const SHIFT_TAB = "\x1b[Z";
const PGUP = "\x1b[5~";
const END = "\x1b[F";

const enc = new TextEncoder();

/** A write-only stream that keeps every chunk Ink emits, with arrival times. */
class BenchOut extends EventEmitter {
  columns = COLUMNS;
  rows = ROWS;
  isTTY = true;
  writes: { at: number; bytes: number; text: string }[] = [];
  write = (s: string): boolean => {
    this.writes.push({ at: performance.now(), bytes: enc.encode(s).length, text: s });
    return true;
  };
  get last(): string {
    return this.writes.at(-1)?.text ?? "";
  }
}

class BenchIn extends EventEmitter {
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

interface Window {
  renders: number;
  renderMs: number;
  writes: number;
  bytes: number;
}

interface Scenario extends Window {
  name: string;
  wallMs: number;
  /** Process CPU (user+system) burnt inside the window. The idle scenario is
   *  the one this exists for: renders and bytes are both zero either way, and
   *  what a periodic timer costs shows up only here. */
  cpuMs: number;
  notes?: Record<string, unknown>;
}

/** Renders counted by Ink's `onRender`, sampled so a window can be sliced out. */
class Renders {
  n = 0;
  ms = 0;
  mark(): { n: number; ms: number } {
    return { n: this.n, ms: this.ms };
  }
}

const windowSince = (
  out: BenchOut,
  renders: Renders,
  from: { n: number; ms: number },
  fromWrite: number,
  since: number,
): Window => {
  const w = out.writes.slice(fromWrite).filter((x) => x.at >= since);
  return {
    renders: renders.n - from.n,
    renderMs: +(renders.ms - from.ms).toFixed(2),
    writes: w.length,
    bytes: w.reduce((a, x) => a + x.bytes, 0),
  };
};

/** First write after `since` whose text matches — i.e. when the user could see it. */
const latency = async (
  out: BenchOut,
  since: number,
  re: RegExp,
  timeoutMs = 2000,
): Promise<number | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = out.writes.find((w) => w.at >= since && re.test(w.text));
    if (hit) return +(hit.at - since).toFixed(2);
    await delay(5);
  }
  return null;
};

const waitFor = async (out: BenchOut, re: RegExp, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (re.test(out.last)) return true;
    await delay(20);
  }
  return false;
};

const args = new Set(Deno.args);
const arg = (flag: string): string | undefined => {
  const i = Deno.args.indexOf(flag);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};
const incremental = args.has("--incremental");
const label = arg("--label") ?? (incremental ? "after" : "before");

const mount = (client: LoomClient, historyPageSize?: number, inc = incremental) => {
  const out = new BenchOut();
  const input = new BenchIn();
  const renders = new Renders();
  const app = render(
    createElement(App, {
      client,
      ...(historyPageSize !== undefined ? { historyPageSize } : {}),
    }),
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // Force interactive so Ink emits the erase/cursor sequences a real
      // terminal would receive; `debug: true` would make bytes meaningless.
      interactive: true,
      incrementalRendering: inc,
      onRender: (m) => {
        renders.n += 1;
        renders.ms += m.renderTime;
      },
    },
  );
  return { out, input, app, renders };
};

const scenarios: Scenario[] = [];

const record = (
  name: string,
  out: BenchOut,
  renders: Renders,
  from: { n: number; ms: number },
  fromWrite: number,
  since: number,
  cpuFrom: NodeJS.CpuUsage,
  notes?: Record<string, unknown>,
): void => {
  const cpu = process.cpuUsage(cpuFrom);
  scenarios.push({
    name,
    ...windowSince(out, renders, from, fromWrite, since),
    wallMs: +(performance.now() - since).toFixed(2),
    cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2),
    ...(notes ? { notes } : {}),
  });
};

/** Scenario 1 — idle fleet, no input, no provider activity. */
const idleScenario = async (): Promise<void> => {
  const h = await makeHarness();
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
  });
  for (const prompt of ["add a --json flag", "write release notes", "fix the flaky test"]) {
    await client.request("session.createStub", { prompt, status: "idle", provider: "fake" });
  }
  const { out, app, renders } = mount(client);
  try {
    await waitFor(out, /add a --json flag/);
    await delay(300);
    const from = renders.mark();
    const fromWrite = out.writes.length;
    const since = performance.now();
    const cpuFrom = process.cpuUsage();
    await delay(3000);
    record("idle", out, renders, from, fromWrite, since, cpuFrom);
  } finally {
    app.unmount();
    await client.close();
    await h.cleanup();
  }
};

/** Scenario 2 — one session streaming assistant text at ~20 events/sec. */
const streamScenario = async (): Promise<void> => {
  const h = await makeHarness();
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
  });
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "busy worker",
    provider: "fake",
  });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);
  const { out, app, renders } = mount(client);
  try {
    await waitFor(out, /busy worker/);
    await delay(300);
    const from = renders.mark();
    const fromWrite = out.writes.length;
    const since = performance.now();
    const cpuFrom = process.cpuUsage();
    for (let i = 0; i < 60; i++) {
      fs?.emit({ type: "assistant_text", text: `streamed chunk ${i} of sixty` });
      await delay(50);
    }
    await delay(200);
    record("stream", out, renders, from, fromWrite, since, cpuFrom, { events: 60 });
  } finally {
    app.unmount();
    await client.close();
    await h.cleanup();
  }
};

/** Scenario 3 — paging back through a long transcript. */
const scrollScenario = async (): Promise<void> => {
  const h = await makeHarness();
  const connect = () =>
    LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
      reconnect: true,
    });
  const first = await connect();
  const snap = await first.request<SessionSnapshot>("session.createStub", {
    prompt: "a session with a long back-history",
    status: "running",
    provider: "fake",
  });
  for (let i = 1; i <= 200; i++) {
    await first.request("dev.emit", {
      event: {
        sessionId: snap.id,
        type: "assistant_text",
        text: `history line ${i} — a reasonably long line so wrapping and layout work is exercised`,
      },
    });
  }
  await delay(200);
  await first.close();

  const client = await connect();
  const { out, input, app, renders } = mount(client);
  try {
    await waitFor(out, /history line 200/);
    await delay(300);
    const from = renders.mark();
    const fromWrite = out.writes.length;
    const since = performance.now();
    const cpuFrom = process.cpuUsage();
    const keyLatencies: number[] = [];
    for (let i = 0; i < 12; i++) {
      const at = performance.now();
      input.feed(PGUP);
      const ms = await latency(out, at, /history line/);
      if (ms !== null) keyLatencies.push(ms);
      await delay(120);
    }
    input.feed(END); // back to the live tail
    await delay(400);
    record("scroll", out, renders, from, fromWrite, since, cpuFrom, {
      pageUps: 12,
      keyLatencyMs: summarize(keyLatencies),
    });
  } finally {
    app.unmount();
    await client.close();
    await h.cleanup();
  }
};

/** Scenario 4 — typing and cycling mode while a session streams. */
const typeModeScenario = async (): Promise<void> => {
  const h = await makeHarness();
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
  });
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "busy worker",
    provider: "fake",
  });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);

  // Time `session.setMode` at the transport boundary, separately from the
  // debounce that precedes it.
  const dispatches: number[] = [];
  const settles: number[] = [];
  const realRequest = client.request.bind(client);
  (client as unknown as { request: LoomClient["request"] }).request = ((
    method: string,
    params?: unknown,
  ) => {
    if (method !== "session.setMode") return realRequest(method, params as never);
    const at = performance.now();
    dispatches.push(at);
    const p = realRequest(method, params as never);
    void p.finally(() => settles.push(performance.now() - at)).catch(() => {});
    return p;
  }) as LoomClient["request"];

  const { out, input, app, renders } = mount(client);
  const streaming = (async () => {
    for (let i = 0; i < 140; i++) {
      fs?.emit({ type: "assistant_text", text: `background chunk ${i}` });
      await delay(75);
    }
  })();
  try {
    await waitFor(out, /busy worker/);
    await delay(300);
    const from = renders.mark();
    const fromWrite = out.writes.length;
    const since = performance.now();
    const cpuFrom = process.cpuUsage();

    // Typing: one keypress at a time, measuring when the character appears.
    input.feed("\r"); // open the send prompt
    await delay(200);
    const typeLatencies: number[] = [];
    const word = "benchmark typing latency";
    let typed = "";
    for (const ch of word) {
      typed += ch;
      const at = performance.now();
      input.feed(ch);
      const ms = await latency(out, at, new RegExp(escapeRe(typed.slice(-8))));
      if (ms !== null) typeLatencies.push(ms);
      await delay(45);
    }

    // Mode: the prompt footer suppresses notices, so the local feedback is the
    // `⇧⇥ mode:<applied> → <target>` hint, which names the chosen target beside
    // the mode the session is still in. The Detail pane's `[mode]` chip does the
    // same; a bare `[plan]` means the daemon has taken it — both are timed.
    //
    // (a) one isolated press: keypress → local hint → RPC dispatch → settle.
    const pressAt = performance.now();
    input.feed(SHIFT_TAB);
    const hintMs = await latency(out, pressAt, /mode:manual → plan/);
    const appliedMs = await latency(out, pressAt, /\[plan\]/, 3000);
    const dispatchMs = dispatches[0] === undefined ? -1 : +(dispatches[0] - pressAt).toFixed(2);
    const settleMs = +(settles[0] ?? -1).toFixed(2);

    // (b) a rapid cycle: three presses inside the debounce window should reach
    // the daemon as one application of the settled target.
    await delay(400);
    const callsBefore = dispatches.length;
    const cycleAt = performance.now();
    for (let i = 0; i < 3; i++) {
      input.feed(SHIFT_TAB);
      await delay(60);
    }
    const cycleHintMs = await latency(out, cycleAt, /mode:plan → acceptEdits/); // first press
    await delay(1500);
    // `mode:manual` with nothing before it is the applied label — the pending one
    // reads `mode:plan → manual`.
    const cycleSettledMs = await latency(out, cycleAt, /mode:manual/, 100);
    input.feed(ESC);
    await delay(400);

    // piece of local mode feedback that predates step 4 — is rendered.
    // piece of genuinely local mode feedback that exists today — is rendered.
    const browseAt = performance.now();
    input.feed(SHIFT_TAB);
    const browseNoticeMs = await latency(out, browseAt, /mode →/);
    await delay(1200);
    record("type+mode-while-streaming", out, renders, from, fromWrite, since, cpuFrom, {
      typeLatencyMs: summarize(typeLatencies),
      modeKeypressToLocalHintMs: hintMs,
      modeKeypressToDispatchMs: dispatchMs,
      modeDispatchToSettleMs: settleMs,
      modeKeypressToAppliedChipMs: appliedMs,
      rapidCycleHintMs: cycleHintMs,
      rapidCycleSettledHintMs: cycleSettledMs,
      rapidCycleSetModeCalls: dispatches.length - callsBefore,
      rapidCyclePresses: 3,
      browseKeypressToNoticeMs: browseNoticeMs,
    });
  } finally {
    await streaming;
    app.unmount();
    await client.close();
    await h.cleanup();
  }
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const summarize = (xs: number[]): Record<string, number> | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: xs.length,
    min: +(sorted[0] ?? 0).toFixed(2),
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +(sorted.at(-1) ?? 0).toFixed(2),
  };
};

const runScenarios = async (): Promise<void> => {
  await idleScenario();
  await streamScenario();
  await scrollScenario();
  await typeModeScenario();

  const report = {
    label,
    head: new TextDecoder()
      .decode(new Deno.Command("git", { args: ["rev-parse", "HEAD"] }).outputSync().stdout)
      .trim(),
    incrementalRendering: incremental,
    terminal: { columns: COLUMNS, rows: ROWS },
    scenarios,
  };
  const path = arg("--out") ?? `references/tui-bench-${label}.json`;
  await Deno.mkdir("references", { recursive: true }).catch(() => {});
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nwrote ${path}`);
};

/* ------------------------------------------------------------------ *
 * `--exercise`: correctness pass for incremental rendering (plan §1).
 *
 * Ink's incremental writer emits only the lines that changed, addressed by
 * relative cursor motion. A stale row it forgets to erase is invisible to a
 * "does the newest write contain X" check, so this mode replays Ink's own
 * escape vocabulary — cursorUp/NextLine/To, eraseEndLine/Line/Down — into a
 * plain-text screen and asserts against that reconstruction instead.
 * ------------------------------------------------------------------ */

/** The subset of ANSI Ink's `log-update` writer emits, replayed into rows. */
class Screen {
  rows: string[] = [];
  row = 0;
  col = 0;
  feed(chunk: string): void {
    for (let i = 0; i < chunk.length;) {
      const ch = chunk[i]!;
      if (ch === "\x1b" && chunk[i + 1] === "[") {
        // oxlint-disable-next-line no-control-regex
        const m = /^\u001B\[([?0-9;]*)([A-Za-z])/.exec(chunk.slice(i));
        if (m) {
          this.#csi(m[1] ?? "", m[2] ?? "");
          i += m[0].length;
          continue;
        }
      }
      if (ch === "\x1b") {
        // OSC / other escapes: skip to the terminator, they don't move the cursor.
        const end = chunk.indexOf("\x07", i);
        i = end === -1 ? i + 1 : end + 1;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        this.#put(ch);
      }
      i += 1;
    }
  }
  #line(r: number): string {
    while (this.rows.length <= r) this.rows.push("");
    return this.rows[r]!;
  }
  #set(r: number, s: string): void {
    this.#line(r);
    this.rows[r] = s;
  }
  #put(ch: string): void {
    const line = this.#line(this.row).padEnd(this.col, " ");
    this.#set(this.row, line.slice(0, this.col) + ch + line.slice(this.col + 1));
    this.col += 1;
  }
  #csi(params: string, final: string): void {
    const n = Number.parseInt(params, 10);
    const arg = Number.isNaN(n) ? 1 : n;
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - arg);
        return;
      case "B":
        this.row += arg;
        return;
      case "C":
        this.col += arg;
        return;
      case "D":
        this.col = Math.max(0, this.col - arg);
        return;
      case "E":
        this.row += arg;
        this.col = 0;
        return;
      case "F":
        this.row = Math.max(0, this.row - arg);
        this.col = 0;
        return;
      case "G":
        this.col = Math.max(0, arg - 1);
        return;
      case "H":
      case "f": {
        const [r, c] = params.split(";").map((x) => Number.parseInt(x, 10) || 1);
        this.row = Math.max(0, (r ?? 1) - 1);
        this.col = Math.max(0, (c ?? 1) - 1);
        return;
      }
      case "K": {
        const line = this.#line(this.row);
        if (params === "2") this.#set(this.row, "");
        else if (params === "1") this.#set(this.row, " ".repeat(this.col) + line.slice(this.col));
        else this.#set(this.row, line.slice(0, this.col));
        return;
      }
      case "J":
        if (params === "" || params === "0") this.rows = this.rows.slice(0, this.row + 1);
        else this.rows = [];
        return;
      default:
        return; // SGR, cursor show/hide, mouse/paste modes — no layout effect
    }
  }
  get text(): string {
    return this.rows.join("\n").replace(/[ \t]+$/gm, "");
  }
  get height(): number {
    // Trailing blank rows are cursor parking, not content.
    let last = this.rows.length;
    while (last > 0 && (this.rows[last - 1] ?? "").trim() === "") last -= 1;
    return last;
  }
}

const exercise = async (): Promise<void> => {
  const failures: string[] = [];
  const h = await makeHarness();
  const connect = () =>
    LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
      reconnect: true,
    });
  const first = await connect();
  const snap = await first.request<SessionSnapshot>("session.createStub", {
    prompt: "a session with a long back-history",
    status: "running",
    provider: "fake",
  });
  await first.request("session.createStub", {
    prompt: "second session",
    status: "idle",
    provider: "fake",
  });
  for (let i = 1; i <= 60; i++) {
    await first.request("dev.emit", {
      event: {
        sessionId: snap.id,
        type: "assistant_text",
        text: `history line ${i} — deliberately long so that it wraps at narrow widths and exercises the wrapped-row path in the transcript renderer`,
      },
    });
  }
  await delay(200);
  await first.close();

  const client = await connect();
  const screen = new Screen();
  const editorCalls: string[] = [];
  const out = new BenchOut();
  const input = new BenchIn();
  const realWrite = out.write;
  out.write = (s: string): boolean => {
    screen.feed(s);
    return realWrite(s);
  };
  const app = render(
    createElement(App, {
      client,
      logs: { daemon: "/dev/null", tui: "/dev/null" },
      openEditor: async (text: string) => {
        editorCalls.push(text);
        await delay(50);
        return null;
      },
    }),
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: input as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
      incrementalRendering: !args.has("--full"),
    },
  );

  const check = (name: string, want: RegExp[], notWant: RegExp[] = []): void => {
    const t = screen.text;
    for (const re of want) {
      if (!re.test(t)) failures.push(`${name}: expected ${re} on the reconstructed screen`);
    }
    for (const re of notWant) {
      if (re.test(t)) failures.push(`${name}: stale ${re} left on the reconstructed screen`);
    }
    if (screen.height > out.rows) {
      const stripped = (s: string) =>
        s
          // oxlint-disable-next-line no-control-regex
          .replace(/\x1b\[[?0-9;]*[A-Za-z]/g, "")
          .split("\n")
          .filter((l) => l.trim() !== "").length;
      const raw = Math.max(0, ...out.writes.slice(-6).map((w) => stripped(w.text)));
      failures.push(
        `${name}: ${screen.height} rows rendered into a ${out.rows}-row terminal (last write held ${raw} non-blank lines)`,
      );
    }
  };
  const resize = async (columns: number, rows: number): Promise<void> => {
    out.columns = columns;
    out.rows = rows;
    out.emit("resize");
    await delay(400);
  };

  try {
    await waitFor(out, /history line 60/);
    await delay(300);
    check("initial", [/loom/, /history line 60/, /second session/]);

    input.feed("?");
    await delay(300);
    check("help overlay", [/loom — keys/]);
    input.feed(ESC);
    await delay(300);
    check("help closed", [/second session/], [/loom — keys/]);

    input.feed("n");
    await delay(300);
    check("new-session prompt", [/new session/]);
    input.feed(ESC);
    await delay(300);
    check("prompt closed", [/second session/], [/new session/]);

    for (let i = 0; i < 5; i++) {
      input.feed(PGUP);
      await delay(180);
    }
    check("scrolled back", [/history line/]);
    input.feed(END);
    await delay(600);
    check("back to the tail", [/history line 60/]);

    await resize(60, 20);
    check("narrow 60x20", [/loom/]);
    await resize(200, 50);
    check("wide 200x50", [/loom/]);
    await resize(120, 40);
    check("back to 120x40", [/loom/, /history line/]);

    input.feed(" ");
    await delay(250);
    input.feed("view logs");
    await delay(200);
    input.feed("\r");
    await delay(600);
    if (editorCalls.length === 0) failures.push("editor handoff: openEditor was never called");
    check("after $EDITOR return", [/loom/], [/view logs/]);
  } finally {
    app.unmount();
    await delay(200);
    await client.close();
    await h.cleanup();
  }

  console.log(`\nincremental-rendering exercise: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length > 0) Deno.exitCode = 1;
};
/**
 * `--micro`: the plan's spinner-only vs appended-event byte comparison, run
 * once with incremental rendering off and once with it on. Phase A is pure
 * animation (the 120ms tick, no daemon traffic); phase B adds one transcript
 * event every 250ms on top of that same animation, so B's own cost is the
 * excess over A's rate.
 */
const microScenario = async (inc: boolean): Promise<Record<string, unknown>> => {
  const h = await makeHarness();
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect: true,
  });
  const snap = await client.request<SessionSnapshot>("session.create", {
    prompt: "spinner subject",
    provider: "fake",
  });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const fs = fake.session(snap.id);
  for (let i = 0; i < 6; i++) fs?.emit({ type: "assistant_text", text: `warmup line ${i}` });
  const { out, app, renders } = mount(client, undefined, inc);
  try {
    await waitFor(out, /spinner subject/);
    await delay(400);

    const aFrom = renders.mark();
    const aWrite = out.writes.length;
    const aSince = performance.now();
    await delay(2000);
    const a = windowSince(out, renders, aFrom, aWrite, aSince);
    const aMs = performance.now() - aSince;

    const bFrom = renders.mark();
    const bWrite = out.writes.length;
    const bSince = performance.now();
    for (let i = 0; i < 10; i++) {
      fs?.emit({ type: "assistant_text", text: `appended event ${i}` });
      await delay(250);
    }
    const b = windowSince(out, renders, bFrom, bWrite, bSince);
    const bMs = performance.now() - bSince;

    const spinnerRate = a.bytes / aMs;
    return {
      incrementalRendering: inc,
      spinnerOnly: {
        ...a,
        ms: +aMs.toFixed(0),
        bytesPerWrite: Math.round(a.bytes / (a.writes || 1)),
      },
      withAppendedEvents: {
        ...b,
        ms: +bMs.toFixed(0),
        events: 10,
        bytesPerWrite: Math.round(b.bytes / (b.writes || 1)),
        bytesAboveSpinnerBaseline: Math.round(b.bytes - spinnerRate * bMs),
      },
    };
  } finally {
    app.unmount();
    await client.close();
    await h.cleanup();
  }
};

if (args.has("--micro")) {
  const micro = [await microScenario(false), await microScenario(true)];
  console.log(JSON.stringify(micro, null, 2));
} else if (args.has("--exercise")) await exercise();
else await runScenarios();
