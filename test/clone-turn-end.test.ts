// A clone session's Git state is probed in its VM, which can be slow. Two races:
// a turn-end probe that outlasts the idle spell must not remind a later turn to
// commit, and idle suspension must not stop the VM under a running probe (a
// guest `git` killed mid-command is how a stale `index.lock` is left behind).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("condition did not settle: " + what);
};

const REMINDER = /This turn ended with uncommitted changes/;

const setup = async () => {
  const fake = new FakeProvider();
  let cwd = "";
  const gate = { held: undefined as PromiseWithResolvers<void> | undefined, waiting: 0 };
  const probes = { running: 0, duringClose: 0 };
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => ({
        id: ctx.id,
        capabilities: fake.capabilities,
        listPersistedSessions: () => fake.listPersistedSessions(),
        createSession: async (opts) => {
          cwd = opts.cwd;
          const repo = ctx.config.sessionVm!.repoRoot;
          const branch = ctx.vmLifecycle!.clone!(opts.sessionId)!.branch;
          execFileSync("git", ["clone", "-q", "--no-local", "-b", branch, repo, cwd]);
          const session = await fake.createSession(opts);
          const close = session.close.bind(session);
          session.close = async (...args) => {
            probes.duringClose += probes.running;
            await close(...args);
          };
          return session;
        },
        resumeSession: (opts) => fake.resumeSession(opts),
      }),
    }),
  };
  const h = await makeHarness({
    connectors,
    guestCommand: async (_s, command, _timeout, signal) => {
      const probe = command.includes("status --porcelain");
      if (probe) probes.running++;
      try {
        if (probe && gate.held) {
          gate.waiting++;
          await gate.held.promise;
          gate.waiting--;
        }
        const r = await new Deno.Command("sh", { args: ["-c", command], cwd, signal }).output();
        return { code: r.code, output: new TextDecoder().decode(r.stdout), timedOut: false };
      } finally {
        if (probe) probes.running--;
      }
    },
    config: JSON.stringify({
      session: {
        auto_resume: false,
        auto_rebase: "off",
        isolation: {
          enabled: true,
          claude: { artifact: "/test-runtime" },
          checkout: { mode: "clone" },
        },
      },
    }),
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const messages: string[] = [];
  c.onPush((f) => {
    if (f.type === "event" && (f.event as { type?: string }).type === "user_message")
      messages.push((f.event as { text: string }).text);
  });
  const s = await c.request<SessionSnapshot>("session.create", {
    provider: "claude",
    prompt: "go",
  });
  const session = fake.session(s.id)!;
  const status = () => h.daemon.registry.get(s.id)?.status.kind;
  return {
    h,
    c,
    s,
    session,
    gate,
    probes,
    messages,
    status,
    cwd: () => cwd,
    hold: () => {
      gate.held = Promise.withResolvers<void>();
    },
    release: () => {
      gate.held?.resolve();
      gate.held = undefined;
    },
    close: async () => {
      c.close();
      await h.cleanup();
    },
  };
};

test("a turn-end Git probe that outlasts the idle spell does not remind the next turn", async () => {
  const t = await setup();
  try {
    t.hold();
    t.session.finishTurn();
    await until(() => t.gate.waiting > 0, "turn-end probe started");
    // The next turn starts and leaves work behind while the first turn's probe is held.
    t.session.emit({ type: "assistant_text", text: "next" });
    await until(() => t.status() === "running", "next turn running");
    await Deno.writeTextFile(join(t.cwd(), "work.txt"), "in progress");
    t.release();
    await until(() => t.probes.running === 0, "probes settled");
    await delay(50);
    assert.deepEqual(
      t.messages.filter((m) => REMINDER.test(m)),
      [],
      "a reminder for the first turn",
    );
    // The turn the work belongs to is reminded when it ends.
    t.session.finishTurn();
    await until(() => t.messages.some((m) => REMINDER.test(m)), "reminder for the next turn");
  } finally {
    t.release();
    await t.close();
  }
});

test("idle suspension waits for a guest Git probe instead of stopping its VM under it", async () => {
  const t = await setup();
  try {
    t.session.finishTurn();
    await until(() => t.status() === "idle", "idle");
    await until(() => t.probes.running === 0, "turn-end probes settled");
    assert.equal(git(t.cwd(), "status", "--porcelain"), "");
    t.hold();
    // Any publication re-probes the clone; hold that probe in the VM.
    await Deno.writeTextFile(join(t.cwd(), "scratch.txt"), "x");
    await t.c.request("session.setComment", { id: t.s.id, comment: "probe me" });
    await until(() => t.gate.waiting > 0, "probe held");
    // The sweep skips a session with anything on its queue, and under load the
    // startup can still be there; a queued request settles after it.
    await t.c.request("session.setMode", { id: t.s.id, mode: t.s.mode });
    const now = Date.now();
    await t.h.daemon.sweepIdleVms(now);
    const sweep = t.h.daemon.sweepIdleVms(now + 11 * 60_000);
    await delay(100);
    assert.equal(t.session.closed, false, "suspension waits for the running probe");
    t.release();
    await sweep;
    assert.equal(t.session.closed, true, "suspended once the probe finished");
    assert.equal(t.probes.duringClose, 0, "no probe was running when the VM stopped");
  } finally {
    t.release();
    await t.close();
  }
});
