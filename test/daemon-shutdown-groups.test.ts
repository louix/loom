// A process group SIGTERMed while the daemon stops keeps its grace, even one a
// session close outlasting the shutdown drain ends: the exit
// after `whenClosed()` SIGKILLs whatever escalation is still pending, which
// gives a `git` in the group no chance to drop the index.lock it holds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import { escalateProcessGroup } from "@loom/core/process-group";
import type { SessionSnapshot } from "@loom/core/wire";

const GRACE_MS = 600;

test("a group a titler ends after the providers have closed still gets its grace before the daemon stops", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loom-shutdown-group-" });
  const marker = join(dir, "term");
  // Records the SIGTERM and keeps running: only the escalation's SIGKILL ends it.
  const group = spawn(
    "sh",
    ["-c", `trap 'echo term >> "${marker}"' TERM; while :; do sleep 0.05; done`],
    { detached: true, stdio: "ignore" },
  );
  const exited = new Promise<string | null>((resolve) =>
    group.once("exit", (_code, signal) => resolve(signal)),
  );
  let terminatedAt = 0;
  let titlers = 0;
  const providerClosed = Promise.withResolvers<void>();
  const fake = new FakeProvider();
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => ({
        id: ctx.id,
        capabilities: fake.capabilities,
        listPersistedSessions: () => fake.listPersistedSessions(),
        resumeSession: (ref) => fake.resumeSession(ref),
        close: () => {
          providerClosed.resolve();
          return Promise.resolve();
        },
        createSession: async (opts) => {
          if (!opts.oneShot) return await fake.createSession(opts);
          // The titler: answers only once shutdown is past the providers, and
          // its close ends a process group the way a worker's terminate does.
          titlers++;
          await fake.createSession({ ...opts, oneShot: false });
          const titler = fake.session(opts.sessionId)!;
          void providerClosed.promise.then(async () => {
            await delay(50);
            titler.emit({ type: "assistant_text", text: "a fake title" });
            titler.emit({ type: "result", kind: "ok", summary: "a fake title" });
            titler.endStream();
          });
          titler.close = () => {
            terminatedAt = Date.now();
            Deno.kill(-group.pid!, "SIGTERM");
            void escalateProcessGroup(group.pid!, GRACE_MS);
            return Promise.resolve();
          };
          return titler;
        },
      }),
    }),
  };
  const h = await makeHarness({
    connectors,
    config: JSON.stringify({
      session: { auto_resume: false },
    }),
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "name this session please",
    });
    // The turn's result sets off the auto-title job, whose titler waits.
    fake.session(s.id)!.finishTurn();
    for (let i = 0; i < 500 && titlers === 0; i++) await delay(10);
    assert.equal(titlers, 1, "the titler started");
    c.close();
    await h.daemon.stop("test");
    const stoppedAt = Date.now();
    assert.ok(terminatedAt > 0, "the titler closed within the title window");
    assert.equal((await Deno.readTextFile(marker)).trim(), "term", "the group was sent SIGTERM");
    assert.equal(await exited, "SIGKILL", "the escalation ended the TERM-proof group");
    assert.ok(
      stoppedAt - terminatedAt >= GRACE_MS - 50,
      `the group had its grace before the daemon stopped (${stoppedAt - terminatedAt} ms)`,
    );
  } finally {
    try {
      Deno.kill(-group.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await h.cleanup();
    await Deno.remove(dir, { recursive: true });
  }
});

test("a session close outlasting the shutdown drain still gives its group a grace before the daemon stops", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loom-shutdown-group-" });
  const marker = join(dir, "term");
  const group = spawn(
    "sh",
    ["-c", `trap 'echo term >> "${marker}"' TERM; while :; do sleep 0.05; done`],
    { detached: true, stdio: "ignore" },
  );
  const exited = new Promise<string | null>((resolve) =>
    group.once("exit", (_code, signal) => resolve(signal)),
  );
  let terminatedAt = 0;
  const fake = new FakeProvider();
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => ({
        id: ctx.id,
        capabilities: fake.capabilities,
        listPersistedSessions: () => fake.listPersistedSessions(),
        resumeSession: (ref) => fake.resumeSession(ref),
        createSession: async (opts) => {
          const session = await fake.createSession(opts);
          // A worker whose close request times out just past the daemon's
          // drain bound, then ends its process group as a worker's terminate does.
          session.close = async () => {
            await delay(5_300);
            terminatedAt = Date.now();
            Deno.kill(-group.pid!, "SIGTERM");
            void escalateProcessGroup(group.pid!, GRACE_MS);
          };
          return session;
        },
      }),
    }),
  };
  const h = await makeHarness({
    connectors,
    config: JSON.stringify({
      session: { auto_resume: false },
    }),
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "work slowly",
    });
    fake.session(s.id)!.finishTurn();
    c.close();
    await h.daemon.stop("test");
    const stoppedAt = Date.now();
    assert.ok(terminatedAt > 0, "the slow close ended its group before the daemon stopped");
    assert.equal((await Deno.readTextFile(marker)).trim(), "term", "the group was sent SIGTERM");
    assert.equal(await exited, "SIGKILL", "the escalation ended the TERM-proof group");
    assert.ok(
      stoppedAt - terminatedAt >= GRACE_MS - 50,
      `the group had its grace before the daemon stopped (${stoppedAt - terminatedAt} ms)`,
    );
  } finally {
    try {
      Deno.kill(-group.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await h.cleanup();
    await Deno.remove(dir, { recursive: true });
  }
});
