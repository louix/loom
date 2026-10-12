// While a VM runtime build is pending, a message that needs the session started
// replies at once and the start goes on in the background. That shortcut is
// for what may build the runtime, a start or an environment refresh: an idle
// shutdown under way is waited out, as usual, and a clone's workspace
// operation still refuses the message.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { HarnessEvent } from "@loom/core/events";
import { repoBaseDirectory } from "../runtime/src/session-vm/repo-base.ts";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import { builtRuntimePath, type RuntimeBuild } from "../runtime/src/packaged/artifact.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("condition did not settle: " + what);
};

test("with a runtime build pending, a send waits out an idle shutdown and respects a clone's workspace operation", async () => {
  const build: RuntimeBuild = {
    version: 1,
    identity: "e".repeat(32),
    builder: `/nix/store/${"b".repeat(32)}-loom-build-runtime/bin/loom-build-runtime`,
  };
  const bundleDir = await Deno.makeTempDir({ prefix: "loom-runtime-bundle-" });
  const bundle = join(bundleDir, "bundle.json");
  await Deno.writeTextFile(
    bundle,
    JSON.stringify({
      claude: {
        version: 1,
        source: "claude",
        smolvm: `/nix/store/${"c".repeat(32)}-smolvm/bin/smolvm`,
        preparedAt: "on-demand",
        build,
      },
    }),
  );
  const previous = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  Deno.env.set("LOOM_BUNDLED_RUNTIMES", bundle);

  const fake = new FakeProvider();
  let cwd = "";
  /** Holds guest Git status probes, or (`all`) every guest command. */
  const gate = {
    held: undefined as PromiseWithResolvers<void> | undefined,
    all: false,
    waiting: 0,
    running: 0,
  };
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
        // The saved VM history a VM session resumes from.
        const ready = async (id: string, session: Promise<unknown>) => {
          const s = await session;
          Object.defineProperty(s, "providerRef", { value: id });
          const history = join(
            sessionVmDirectory(ctx.config.sessionVm!.repoRoot, id),
            "profile/projects/loom-session",
          );
          await Deno.mkdir(history, { recursive: true });
          await Deno.writeTextFile(join(history, `${id}.jsonl`), "saved VM history");
          return s as Awaited<ReturnType<FakeProvider["createSession"]>>;
        };
        return {
          id: ctx.id,
          capabilities: fake.capabilities,
          listPersistedSessions: () => fake.listPersistedSessions(),
          createSession: (opts) => {
            cwd = opts.cwd;
            const repo = ctx.config.sessionVm!.repoRoot;
            const branch = ctx.vmLifecycle!.clone!(opts.sessionId)!.branch;
            execFileSync("git", ["clone", "-q", "--no-local", "-b", branch, repo, cwd]);
            return ready(opts.sessionId, fake.createSession(opts));
          },
          resumeSession: (ref) => ready(ref.sessionId, fake.resumeSession(ref)),
        };
      },
    }),
  };
  const h = await makeHarness({
    connectors,
    guestCommand: async (_s, command, _timeout, signal) => {
      gate.running++;
      try {
        if (gate.held && (gate.all || command.includes("status --porcelain"))) {
          gate.waiting++;
          await gate.held.promise;
          gate.waiting--;
        }
        const r = await new Deno.Command("sh", { args: ["-c", command], cwd, signal }).output();
        return { code: r.code, output: new TextDecoder().decode(r.stdout), timedOut: false };
      } finally {
        gate.running--;
      }
    },
    config: JSON.stringify({
      session: {
        auto_resume: { enabled: false },
        auto_rebase: { enabled: false },
        commit_reminder: { enabled: false },
        isolation: {
          enabled: true,
          claude: { artifact: builtRuntimePath(build) },
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
  const status = (id: string) => h.daemon.registry.get(id)?.status.kind;
  /** No guest command for a while: a turn end's Git probe has come and gone. */
  const quiet = async (what: string) => {
    for (let calm = 0; calm < 5; calm = gate.running === 0 ? calm + 1 : 0)
      await until(() => gate.running === 0, what).then(() => delay(10));
  };
  const release = () => {
    gate.held?.resolve();
    gate.held = undefined;
    gate.all = false;
  };
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "go",
    });
    await until(() => fake.session(s.id) !== undefined, "session started");
    // Named now, while nothing else runs: an auto-title after the turn would
    // rename the branch, a workspace operation, in the middle of what follows.
    await c.request("session.setTitle", { id: s.id, title: "runtime build" });
    const first = fake.session(s.id)!;
    first.finishTurn();
    await until(() => status(s.id) === "idle", "idle");
    await quiet("turn-end probes settled");

    // An idle shutdown, held in the guest probe it waits for.
    gate.held = Promise.withResolvers<void>();
    await Deno.writeTextFile(join(cwd, "scratch.txt"), "x");
    await c.request("session.setComment", { id: s.id, comment: "probe me" });
    await until(() => gate.waiting > 0, "probe held");
    const now = Date.now();
    await h.daemon.sweepIdleVms(now);
    const sweep = h.daemon.sweepIdleVms(now + 11 * 60_000);

    let replied = false;
    const resume = fake.blockResume();
    const sent = c
      .request<SessionSnapshot & { state: string }>("session.send", { id: s.id, text: "hello" })
      .finally(() => {
        replied = true;
      });
    await delay(200);
    assert.equal(replied, false, "the send waits for the idle shutdown");
    release();
    await sweep;
    assert.equal(first.closed, true, "the idle shutdown stopped the VM");
    // The session is cold now: its start builds the runtime, so the reply comes at once.
    const reply = await sent;
    assert.equal(reply.status.kind, "starting");
    assert.equal(reply.state, "queued");
    assert.deepEqual(first.sends, [], "nothing went to the VM being stopped");
    resume();
    await until(() => fake.session(s.id)?.sends.includes("hello") ?? false, "message delivered");
    const second = fake.session(s.id)!;
    assert.notEqual(second, first);
    second.finishTurn();
    await until(() => status(s.id) === "idle", "idle again");
    await quiet("probes settled again");

    // A clone rebase holds the command queue in the guest; the session's VM goes away.
    gate.held = Promise.withResolvers<void>();
    gate.all = true;
    const rebase = c.request("session.rebase", { id: s.id }).catch((error: unknown) => error);
    await until(() => gate.waiting > 0, "rebase held in the guest");
    second.endStream();
    await until(() => h.daemon.sessions.isEnded(s.id), "session ended");
    await assert.rejects(
      c.request("session.send", { id: s.id, text: "too soon" }),
      /completing a workspace operation/,
    );
    release();
    await rebase;
  } finally {
    release();
    c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", previous);
    await Deno.remove(bundleDir, { recursive: true });
  }
});

test("with a runtime build pending, a send during an environment refresh replies at once and waits for it", async () => {
  const build: RuntimeBuild = {
    version: 1,
    identity: "d".repeat(32),
    builder: `/nix/store/${"b".repeat(32)}-loom-build-runtime/bin/loom-build-runtime`,
  };
  const bundleDir = await Deno.makeTempDir({ prefix: "loom-runtime-bundle-" });
  const bundle = join(bundleDir, "bundle.json");
  await Deno.writeTextFile(
    bundle,
    JSON.stringify({
      claude: {
        version: 1,
        source: "claude",
        smolvm: `/nix/store/${"c".repeat(32)}-smolvm/bin/smolvm`,
        preparedAt: "on-demand",
        build,
      },
    }),
  );
  const previous = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  Deno.env.set("LOOM_BUNDLED_RUNTIMES", bundle);
  // The runtime's link resolves (prepared environments are found by it) but to
  // no usable runtime: its build is still pending.
  const artifact = builtRuntimePath(build);
  const unusable = join(bundleDir, "unusable");
  await Deno.mkdir(unusable);
  await Deno.mkdir(join(artifact, ".."), { recursive: true });
  await Deno.symlink(unusable, artifact);

  const fake = new FakeProvider();
  /** The prepared environment a VM starting now runs on. */
  let generation = "base-first";
  /** Holds a resume, standing in for the runtime build a refresh's start runs. */
  let building: PromiseWithResolvers<void> | undefined;
  let failBuild = false;
  let resumes = 0;
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
        const ready = async (id: string, session: Promise<unknown>) => {
          const s = await session;
          Object.defineProperty(s, "providerRef", { value: id });
          const history = join(
            sessionVmDirectory(ctx.config.sessionVm!.repoRoot, id),
            "profile/projects/loom-session",
          );
          await Deno.mkdir(history, { recursive: true });
          await Deno.writeTextFile(join(history, `${id}.jsonl`), "saved VM history");
          ctx.onVmStarted?.(id, generation);
          return s as Awaited<ReturnType<FakeProvider["createSession"]>>;
        };
        return {
          id: ctx.id,
          capabilities: fake.capabilities,
          listPersistedSessions: () => fake.listPersistedSessions(),
          createSession: (opts) => ready(opts.sessionId, fake.createSession(opts)),
          resumeSession: async (ref) => {
            resumes++;
            await building?.promise;
            if (failBuild) throw new Error("the VM runtime build failed");
            return await ready(ref.sessionId, fake.resumeSession(ref));
          },
        };
      },
    }),
  };
  const h = await makeHarness({
    connectors,
    config: JSON.stringify({
      session: {
        auto_resume: { enabled: false },
        auto_rebase: { enabled: false },
        commit_reminder: { enabled: false },
        isolation: { enabled: true, claude: { artifact } },
      },
    }),
  });
  const errors: string[] = [];
  const emit = h.daemon.emitEvent.bind(h.daemon);
  h.daemon.emitEvent = (event: HarnessEvent) => {
    if (event.type === "error") errors.push(event.message);
    return emit(event);
  };
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const status = (id: string) => h.daemon.registry.get(id)?.status.kind;
  /** Publish a new prepared environment: idle VM sessions refresh onto it. */
  const publish = async (directory: string) => {
    const home = repoBaseDirectory(h.repoRoot);
    await Deno.mkdir(join(home, directory), { recursive: true });
    const identity = createHash("sha256")
      .update(await Deno.realPath(artifact))
      .digest("hex")
      .slice(0, 32);
    await Deno.writeTextFile(join(home, `current-${identity}.json`), JSON.stringify({ directory }));
    generation = directory;
  };
  /** The reply, which must not wait for the (held) build. */
  const prompt = async <T>(reply: Promise<T>): Promise<T> => {
    const late = Symbol("late");
    const result = await Promise.race([reply, delay(3_000).then(() => late)]);
    if (result === late) throw new Error("the reply waited for the runtime build");
    return result as T;
  };
  try {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "go",
    });
    await until(() => fake.session(s.id) !== undefined, "session started");
    // Named now, while nothing else runs: an auto-title after the turn would
    // rename the branch, a workspace operation, in the middle of what follows.
    await c.request("session.setTitle", { id: s.id, title: "runtime build" });
    const first = fake.session(s.id)!;
    first.finishTurn();
    await until(() => status(s.id) === "idle", "idle");

    // A refresh stops the VM and starts it again, building the runtime first.
    building = Promise.withResolvers<void>();
    await publish("base-second");
    await until(() => first.closed && resumes === 1, "refresh building");
    const reply = await prompt(
      c.request<SessionSnapshot & { state: string }>("session.send", { id: s.id, text: "hello" }),
    );
    assert.equal(reply.status.kind, "starting");
    assert.equal(reply.state, "queued");
    building.resolve();
    building = undefined;
    await until(() => fake.session(s.id)?.sends.includes("hello") ?? false, "message delivered");
    const second = fake.session(s.id)!;
    assert.notEqual(second, first);
    assert.equal(resumes, 1, "the refresh's start was the only one");
    second.finishTurn();
    await until(() => status(s.id) === "idle", "idle again");

    // A refresh whose build fails reports it once; the message waits.
    building = Promise.withResolvers<void>();
    failBuild = true;
    errors.length = 0;
    await publish("base-third");
    await until(() => second.closed && resumes === 2, "second refresh building");
    const queued = await prompt(
      c.request<SessionSnapshot & { state: string }>("session.send", { id: s.id, text: "again" }),
    );
    assert.equal(queued.state, "queued");
    building.resolve();
    await until(() => status(s.id) === "error", "refresh failed");
    await delay(300);
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0]!, /^Environment update failed: .*the VM runtime build failed/);
    assert.equal(resumes, 2, "nothing started again after the failed refresh");
  } finally {
    building?.resolve();
    c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", previous);
    await Deno.remove(artifact).catch(() => {});
    await Deno.remove(bundleDir, { recursive: true });
  }
});
