import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import { builtRuntimePath, type RuntimeBuild } from "../runtime/src/packaged/artifact.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

/**
 * An Apple Silicon package without a pinned runtime builds one on first use,
 * which takes 15–60 minutes. A held provider start stands in for that build.
 */
test("every RPC that starts a VM session replies before an on-demand runtime build", async () => {
  const build: RuntimeBuild = {
    version: 1,
    identity: "f".repeat(32),
    builder: `/nix/store/${"b".repeat(32)}-loom-build-runtime/bin/loom-build-runtime`,
  };
  const bundle = join(await Deno.makeTempDir({ prefix: "loom-runtime-bundle-" }), "bundle.json");
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
          createSession: (opts) => ready(opts.sessionId, fake.createSession(opts)),
          resumeSession: (ref) => ready(ref.sessionId, fake.resumeSession(ref)),
        };
      },
    }),
  };
  const h = await makeHarness({
    connectors,
    config: JSON.stringify({
      session: {
        titles: { enabled: false },
        auto_resume: { enabled: false },
        isolation: { enabled: true, claude: { artifact: builtRuntimePath(build) } },
      },
    }),
  });
  let c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  /** The reply, which must not wait for the (held) start. */
  const prompt = async <T>(reply: Promise<T>): Promise<T> => {
    const late = Symbol("late");
    const result = await Promise.race([reply, delay(5_000).then(() => late)]);
    if (result === late) throw new Error("the reply waited for the runtime build");
    return result as T;
  };
  const status = async (id: string) =>
    (await c.request<SessionSnapshot>("session.get", { id })).status.kind;
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await delay(10);
    }
    throw new Error("condition did not settle");
  };
  const idle = async (id: string) => {
    fake.session(id)!.finishTurn();
    await until(async () => (await status(id)) === "idle");
  };
  const restart = async () => {
    await c.close();
    await h.restart();
    c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
  };
  try {
    const release = fake.blockCreate();
    const s = await prompt(
      c.request<SessionSnapshot>("session.create", { prompt: "first", provider: "claude" }),
    );
    assert.equal(s.status.kind, "starting");
    release();
    await idle(s.id);

    // A message to a cold session is queued while its start builds the runtime.
    await restart();
    let resume = fake.blockResume();
    const sent = await prompt(
      c.request<SessionSnapshot & { state: string }>("session.send", { id: s.id, text: "hello" }),
    );
    assert.equal(sent.status.kind, "starting");
    assert.equal(sent.state, "queued");
    resume();
    await until(async () => fake.session(s.id)?.sends.includes("hello") ?? false);

    // An explicit resume reports the session starting.
    await idle(s.id);
    await restart();
    resume = fake.blockResume();
    const resumed = await prompt(c.request<SessionSnapshot>("session.resume", { id: s.id }));
    assert.equal(resumed.status.kind, "starting");
    // Operations that need the running session say so rather than wait.
    await assert.rejects(
      prompt(c.request("session.compact", { id: s.id })),
      /builds the VM runtime/,
    );
    resume();
    await until(async () => (await status(s.id)) === "idle");

    // A VM fork replies once its row exists.
    const create = fake.blockCreate();
    const fork = await prompt(c.request<SessionSnapshot>("session.fork", { id: s.id }));
    assert.equal(fork.isolation, "vm");
    assert.equal(fork.status.kind, "starting");
    create();
    await until(async () => fake.session(fork.id) !== undefined);
  } finally {
    await c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", previous);
    await Deno.remove(join(bundle, ".."), { recursive: true });
  }
});
