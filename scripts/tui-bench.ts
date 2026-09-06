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

const mount = (client: LoomClient, historyPageSize?: number) => {
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
      incrementalRendering: incremental,
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
  notes?: Record<string, unknown>,
): void => {
  scenarios.push({
    name,
    ...windowSince(out, renders, from, fromWrite, since),
    wallMs: +(performance.now() - since).toFixed(2),
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
    await delay(3000);
    record("idle", out, renders, from, fromWrite, since);
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
    for (let i = 0; i < 60; i++) {
      fs?.emit({ type: "assistant_text", text: `streamed chunk ${i} of sixty` });
      await delay(50);
    }
    await delay(200);
    record("stream", out, renders, from, fromWrite, since, { events: 60 });
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
    record("scroll", out, renders, from, fromWrite, since, {
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
    // `⇧⇥ mode:<label>` hint, which reads the un-acknowledged draft. The Detail
    // pane's own `[mode]` chip deliberately shows the applied snapshot instead,
    // so it moves only once the daemon has answered — both are timed.
    //
    // (a) one isolated press: keypress → local hint → RPC dispatch → settle.
    const pressAt = performance.now();
    input.feed(SHIFT_TAB);
    const hintMs = await latency(out, pressAt, /mode:plan/);
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
    const cycleHintMs = await latency(out, cycleAt, /mode:acceptEdits/); // first press
    await delay(1500);
    const cycleSettledMs = await latency(out, cycleAt, /mode:manual/, 100); // 3 presses land on manual
    input.feed(ESC);
    await delay(400);

    // (c) the same press from browse, where the transient notice — the one
    // piece of genuinely local mode feedback that exists today — is rendered.
    const browseAt = performance.now();
    input.feed(SHIFT_TAB);
    const browseNoticeMs = await latency(out, browseAt, /mode →/);
    await delay(1200);
    record("type+mode-while-streaming", out, renders, from, fromWrite, since, {
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
const out = arg("--out") ?? `references/tui-bench-${label}.json`;
await Deno.mkdir("references", { recursive: true }).catch(() => {});
await Deno.writeTextFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
console.log(`\nwrote ${out}`);
