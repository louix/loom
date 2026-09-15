import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { basename, join } from "node:path";
import { makeHarness, type Harness } from "@loom/harness";
import { FakeProvider } from "@loom/connector-mock";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import {
  currentRepoBase,
  publishRepoBase,
  repoBaseDirectory,
} from "../runtime/src/session-vm/repo-base.ts";
import { loadPreparedEnvironment } from "../runtime/src/session-vm/environment.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";

const waitFor = async (fn: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await delay(10);
  }
};

test("base updates wait for idle, preserve the session, and queue messages through replacement", async () => {
  const fake = new FakeProvider();
  let h: Harness;
  let resumeCount = 0;
  const resumeGate = Promise.withResolvers<void>();
  h = await makeHarness({
    config: `{
  "hooks": [
    {
      "on": "init",
      "run": "echo initialized >> init-count"
    }
  ],
  "session": {
    "commit_reminder": {
      "enabled": false
    },
    "auto_rebase": {
      "enabled": false
    }
  }
}`,
    connectors: {
      "@loom/connector-mock": async () => ({
        createProvider: async (ctx) => {
          const generation = async (id: string) =>
            ctx.onVmStarted?.(
              id,
              basename((await currentRepoBase(repoBaseDirectory(h.repoRoot)))!),
            );
          const create = fake.createSession.bind(fake);
          const resume = fake.resumeSession.bind(fake);
          fake.createSession = async (opts) => {
            const s = await create(opts);
            await generation(s.id);
            return s;
          };
          fake.resumeSession = async (ref) => {
            resumeCount++;
            await resumeGate.promise;
            const s = await resume(ref);
            await generation(s.id);
            return s;
          };
          return fake;
        },
      }),
    },
  });
  const home = repoBaseDirectory(h.repoRoot);
  const publish = async (name: string, signal = new AbortController().signal) => {
    const path = join(home, `base-${name}`);
    await Deno.mkdir(join(path, "disks"), { recursive: true });
    for (const stem of ["storage", "overlay"])
      await Deno.writeTextFile(join(path, "disks", `${stem}.raw`), "fixture");
    await publishRepoBase(home, path, signal);
  };
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    await publish("first");
    const created = await c.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "work",
    });
    const id = created.id;
    const old = fake.session(id)!;
    await Deno.writeTextFile(join(created.worktree!, "dirty"), "unfinished edits");
    await assert.rejects(publish("failed", AbortSignal.abort()));
    await delay(1100);
    assert.equal(resumeCount, 0, "failed publication leaves running sessions alone");
    await publish("next");
    await delay(1100);
    assert.equal(resumeCount, 0, "a running turn stays on its original image");
    old.emit({ type: "permission_request", id: "permission", tool: "Bash", input: {} });
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id })).status.kind === "awaiting_input",
    );
    await delay(1100);
    assert.equal(resumeCount, 0, "pending user interactions are preserved");
    await c.request("session.respondPermission", {
      id,
      requestId: "permission",
      decision: "allow",
    });
    old.finishTurn();
    await waitFor(() => resumeCount === 1);
    assert(old.closed);
    assert.equal((await c.request<SessionSnapshot>("session.get", { id })).status.kind, "starting");
    const sending = c.request("session.send", { id, text: "arrived during refresh" });
    await delay(40);
    assert.equal(fake.session(id), old, "message waits for resume");
    resumeGate.resolve();
    await sending;
    const resumed = fake.session(id)!;
    assert.notEqual(resumed, old);
    assert.deepEqual(resumed.sends, ["arrived during refresh"]);
    assert.equal(await Deno.readTextFile(join(created.worktree!, "dirty")), "unfinished edits");
    assert.equal(
      await Deno.readTextFile(join(created.worktree!, "init-count")),
      "initialized\n",
      "VM replacement does not rerun init",
    );
    resumed.finishTurn();
    await delay(1100);
    assert.equal(resumeCount, 1, "current generation is not restarted again");
  } finally {
    resumeGate.resolve();
    await c.close();
    await h.cleanup();
    await Deno.remove(home, { recursive: true });
  }
});

test("init failures reach non-VM agents before the first turn and do not block creation", async () => {
  let openingPrompt = "";
  const h = await makeHarness({
    connectors: {
      "@loom/connector-mock": async () => ({
        createProvider: async () => {
          const fake = new FakeProvider();
          const create = fake.createSession.bind(fake);
          fake.createSession = (opts) => {
            openingPrompt = opts.prompt;
            return create(opts);
          };
          return fake;
        },
      }),
    },
    config: `{
  "hooks": [
    {
      "kind": "check",
      "on": "init",
      "run": "echo broken-package >&2; exit 7"
    }
  ]
}`,
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const progress: string[] = [];
  c.onPush((f) => {
    if (f.type === "event" && f.event.type === "startup_progress") progress.push(f.event.message);
  });
  try {
    const created = await c.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "fix project",
    });
    assert.ok(created.id);
    assert.match(openingPrompt, /fix project[\s\S]*broken-package/);
    assert(progress.some((p) => p.includes("exited 7")));
  } finally {
    await c.close();
    await h.cleanup();
  }
});

test("session activation restores a base snapshot without evaluating broken worktree setup", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const snapshot = join(directory, "environment.json");
    await Deno.writeTextFile(
      snapshot,
      JSON.stringify({
        PATH: "/deleted-prepare-worktree/node_modules/.bin:/nix/store/prepared/bin",
        PROJECT_ROOT: "/deleted-prepare-worktree",
        SIBLING: "/deleted-prepare-worktree-other/bin",
        PWD: "/deleted-prepare-worktree",
        LOOM_PREPARATION_ONLY: "1",
      }),
    );
    const config = normalizeSessionEnvironment({
      command_prefix: ["/missing-command"],
      prepare: "exit 99",
    });
    assert.deepEqual(await loadPreparedEnvironment(config, snapshot, "/session-worktree"), {
      PATH: "/session-worktree/node_modules/.bin:/nix/store/prepared/bin",
      PROJECT_ROOT: "/session-worktree",
      SIBLING: "/deleted-prepare-worktree-other/bin",
    });
    await assert.rejects(
      loadPreparedEnvironment(config, join(directory, "missing")),
      /loom environment prepare/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("a fork initializes its new worktree once even when its transcript is resumed", async () => {
  const fake = new FakeProvider();
  Object.defineProperty(fake, "capabilities", {
    value: { ...fake.capabilities, ownsTranscript: true },
  });
  const h = await makeHarness({
    config: `{
  "hooks": [
    {
      "on": "init",
      "run": "echo init >> initialized"
    }
  ],
  "session": {
    "commit_reminder": {
      "enabled": false
    }
  }
}`,
    connectors: { "@loom/connector-mock": async () => ({ createProvider: async () => fake }) },
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const parent = await c.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "work",
    });
    fake.session(parent.id)!.finishTurn();
    await waitFor(
      async () =>
        (await c.request<SessionSnapshot>("session.get", { id: parent.id })).status.kind === "idle",
    );
    const fork = await c.request<SessionSnapshot>("session.fork", { id: parent.id });
    assert.equal(await Deno.readTextFile(join(fork.worktree!, "initialized")), "init\ninit\n");
    assert.equal(await Deno.readTextFile(join(parent.worktree!, "initialized")), "init\n");
    await h.daemon.sessions.close(fork.id);
    await c.request("session.resume", { id: fork.id });
    assert.equal(await Deno.readTextFile(join(fork.worktree!, "initialized")), "init\ninit\n");
  } finally {
    await c.close();
    await h.cleanup();
  }
});

test("queued operations make an otherwise idle session ineligible for VM replacement", async () => {
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const gate = Promise.withResolvers<void>();
  try {
    const created = await c.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "work",
    });
    const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
    const session = fake.session(created.id)!;
    session.finishTurn();
    await waitFor(() => h.daemon.sessions.canRefresh(created.id));
    const send = session.send.bind(session);
    session.send = async (text) => {
      await gate.promise;
      await send(text);
    };
    const sending = h.daemon.sessions.send(created.id, "next turn");
    assert.equal(h.daemon.sessions.canRefresh(created.id), false);
    assert.equal(await h.daemon.sessions.suspendIdle(created.id), false);
    gate.resolve();
    await sending;
    assert.equal(session.closed, false);
  } finally {
    gate.resolve();
    await c.close();
    await h.cleanup();
  }
});

test("provider startup failure preserves files written by init", async () => {
  const h = await makeHarness({
    config: `{
  "hooks": [
    {
      "on": "init",
      "run": "echo keep-me > initialized"
    }
  ]
}`,
    connectors: {
      "@loom/connector-mock": async () => ({
        createProvider: async () => {
          const fake = new FakeProvider();
          fake.createSession = () => Promise.reject(new Error("provider unavailable"));
          return fake;
        },
      }),
    },
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    await assert.rejects(
      c.request("session.create", { provider: "fake", prompt: "work" }),
      /provider unavailable/,
    );
    const [failed] = await c.request<SessionSnapshot[]>("session.list");
    assert.equal(failed?.status.kind, "error");
    assert(failed?.worktree);
    assert.equal(await Deno.readTextFile(join(failed.worktree, "initialized")), "keep-me\n");
  } finally {
    await c.close();
    await h.cleanup();
  }
});
