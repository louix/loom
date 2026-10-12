/**
 * Sessions in private clones. A Loom agent whose supervisor's branch is
 * renamed: the clone has the host's branches only as `origin/*`, as its syncs
 * fetch them, so its agent is told the new name only once a sync has fetched
 * it — never a ref that does not resolve there. And a live clone session's
 * queue is not released into a workspace operation that holds its commands.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness, type Harness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("condition did not settle: " + what);
};

interface Env {
  fake: FakeProvider;
  cwds: Map<string, string>;
  h: Harness;
  c: LoomClient;
  get: (id: string) => Promise<SessionSnapshot>;
  /** Park every guest command (or each that `only` picks) until the returned fn is called. */
  blockGuest: (only?: (command: string) => boolean) => {
    entered: () => boolean;
    release: () => void;
  };
  /** Runs as a resume launches, before it reads the clone's refs; `fetch`
   *  false: the launch succeeds without its checkout fetching. */
  hooks: { beforeLaunch?: (id: string) => Promise<void>; fetch?: boolean };
  /** A launch that reads its checkout policy, then fails before its checkout runs. */
  failedLaunch: (id: string) => void;
}

const withClones = async (fn: (env: Env) => Promise<void>): Promise<void> => {
  const fake = new FakeProvider();
  const cwds = new Map<string, string>();
  const hooks: Env["hooks"] = {};
  let gate: {
    promise: Promise<void>;
    entered: boolean;
    only: ((command: string) => boolean) | undefined;
  } | null = null;
  let readPolicy: (id: string) => void = () => {};
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => ({
        id: ctx.id,
        capabilities: fake.capabilities,
        listPersistedSessions: () => fake.listPersistedSessions(),
        createSession: async (opts) => {
          readPolicy = (id) => void ctx.vmLifecycle!.clone!(id);
          const clone = ctx.vmLifecycle!.clone!(opts.sessionId);
          if (clone) {
            const repo = ctx.config.sessionVm!.repoRoot;
            execFileSync("git", ["clone", "-q", "--no-local", "-b", clone.branch, repo, opts.cwd]);
            git(opts.cwd, "config", "user.name", "test");
            git(opts.cwd, "config", "user.email", "test@localhost");
            cwds.set(opts.sessionId, opts.cwd);
          }
          return fake.createSession(opts);
        },
        resumeSession: async (opts) => {
          await hooks.beforeLaunch?.(opts.sessionId);
          // As the guest's checkout does on every launch: fetch what the
          // policy shows, the base by its stored name.
          const clone = ctx.vmLifecycle!.clone!(opts.sessionId);
          const cwd = cwds.get(opts.sessionId);
          if (clone && cwd && hooks.fetch !== false) git(cwd, "fetch", "-q", "--prune", "origin");
          return fake.resumeSession(opts);
        },
      }),
    }),
  };
  const h = await makeHarness({
    connectors,
    guestCommand: async (s, command, _timeout, signal) => {
      if (gate && (!gate.only || gate.only(command))) {
        gate.entered = true;
        await gate.promise;
      }
      const r = await new Deno.Command("sh", {
        args: ["-c", command],
        cwd: cwds.get(s.id) ?? s.worktree!,
        signal,
      }).output();
      return {
        code: r.code,
        output: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
        timedOut: false,
      };
    },
    config: JSON.stringify({
      session: {
        auto_resume: false,
        auto_rebase: "rebase",
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
  const blockGuest = (only?: (command: string) => boolean) => {
    let release!: () => void;
    const g = {
      promise: new Promise<void>((resolve) => (release = resolve)),
      entered: false,
      only,
    };
    gate = g;
    return {
      entered: () => g.entered,
      release: () => {
        gate = null;
        release();
      },
    };
  };
  try {
    await fn({
      fake,
      cwds,
      h,
      c,
      get: (id) => c.request<SessionSnapshot>("session.get", { id }),
      blockGuest,
      hooks,
      failedLaunch: (id) => readPolicy(id),
    });
  } finally {
    c.close();
    await h.cleanup();
  }
};

test("a clone child is told its supervisor's renamed branch only once its clone has it", () =>
  withClones(async ({ fake, cwds, h, c, get }) => {
    // The supervisor works in a host worktree; its child in a private clone
    // off its branch (stage 1 starts children in worktrees; the tree allows
    // a clone child all the same).
    const lead = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "lead",
      workspace: "worktree",
    });
    const before = lead.branch!;
    const kid = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "kid",
      base: before,
    });
    assert.equal(kid.checkout, "clone");
    h.daemon.registry.setFields(kid.id, { supervisorId: lead.id });
    const kidFs = fake.session(kid.id)!;
    assert.equal(fake.creates.find((o) => o.sessionId === kid.id)?.base, `origin/${before}`);

    await c.request("session.setTitle", { id: lead.id, title: "Lead work" });
    const renamed = (await get(lead.id)).branch!;
    assert.notEqual(renamed, before);
    assert.equal((await get(kid.id)).baseBranch, renamed, "stored for its next start");
    await delay(50);
    assert.deepEqual(kidFs.bases, [], `origin/${renamed} is not in the clone yet`);

    // Its turn ends; the sync fetches the base by its new name.
    kidFs.finishTurn();
    await until(() => kidFs.bases.length > 0, "base pushed after the sync");
    assert.deepEqual(kidFs.bases, [`origin/${renamed}`]);
    const clone = cwds.get(kid.id)!;
    assert.ok(git(clone, "rev-parse", "--verify", `refs/remotes/origin/${renamed}`));
  }));

test("a clone child resumed as its supervisor's branch is renamed is told the name its launch fetched", () =>
  withClones(async ({ fake, cwds, h, c, get, hooks }) => {
    const lead = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "lead",
      workspace: "worktree",
    });
    const before = lead.branch!;
    const kid = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "kid",
      base: before,
    });
    h.daemon.registry.setFields(kid.id, { supervisorId: lead.id });
    const first = fake.session(kid.id)!;
    first.finishTurn();
    await until(async () => (await get(kid.id)).status.kind === "idle", "kid idle");
    // Its adapter goes away: the kid is cold.
    first.endStream();
    await until(() => !h.daemon.sessions.has(kid.id) || h.daemon.sessions.isEnded(kid.id), "cold");
    // Its turn-end sync is done: the user's send is not refused as busy.
    await until(() => !h.daemon.sessions.isBusy(kid.id), "turn-end sync done");

    // The supervisor's branch is renamed while the kid's resume launches,
    // after the resume read its base and before its checkout fetched.
    let renamed = "";
    hooks.beforeLaunch = async (id) => {
      if (id !== kid.id || renamed) return;
      await c.request("session.setTitle", { id: lead.id, title: "Lead work" });
      renamed = (await get(lead.id)).branch!;
    };
    // The rename republishes the kid's refs meanwhile, which may refuse the
    // send as busy; the resume stands either way.
    await c.request("session.send", { id: kid.id, text: "go on" }).catch(() => {});
    await until(() => fake.session(kid.id) !== first, "resumed");
    const resumed = fake.session(kid.id)!;
    assert.notEqual(renamed, before);
    assert.equal(fake.resumes.find((o) => o.sessionId === kid.id)?.base, `origin/${before}`);
    assert.ok(git(cwds.get(kid.id)!, "rev-parse", "--verify", `refs/remotes/origin/${renamed}`));
    // The launch fetched the new name: the kid is told it, with no sync.
    await until(() => resumed.bases.length > 0, "base pushed after the resume");
    assert.deepEqual(resumed.bases, [`origin/${renamed}`]);
  }));

test("a base counts as fetched only when a launch succeeded and its clone has the ref", () =>
  withClones(async ({ fake, cwds, h, c, get, hooks, failedLaunch }) => {
    const lead = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "lead",
      workspace: "worktree",
    });
    const before = lead.branch!;
    const kid = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "kid",
      base: before,
    });
    h.daemon.registry.setFields(kid.id, { supervisorId: lead.id });
    const first = fake.session(kid.id)!;
    first.finishTurn();
    await until(async () => (await get(kid.id)).status.kind === "idle", "kid idle");
    // Queued behind its turn-end sync: once this answers, that sync is done.
    await c.request("session.rebase", { id: kid.id });
    await c.request("session.setTitle", { id: lead.id, title: "Lead work" });
    const renamed = (await get(lead.id)).branch!;
    assert.notEqual(renamed, before);

    // A launch reads its policy (the new name) and fails before its checkout.
    failedLaunch(kid.id);
    first.endStream();
    await until(() => !h.daemon.sessions.has(kid.id) || h.daemon.sessions.isEnded(kid.id), "cold");
    // The rename republishes the kid's base under its guest Git, during which a
    // send answers busy (H7); under load it can outlast the failed launch.
    await until(() => !h.daemon.sessions.isBusy(kid.id), "renamed base republished");
    // The next launch succeeds, but its checkout did not fetch the new name.
    hooks.fetch = false;
    await c.request("session.send", { id: kid.id, text: "go on" });
    await until(() => fake.session(kid.id) !== first, "resumed");
    const resumed = fake.session(kid.id)!;
    const clone = cwds.get(kid.id)!;
    assert.throws(() => git(clone, "rev-parse", "--verify", `refs/remotes/origin/${renamed}`));
    assert.equal(
      fake.resumes.at(-1)?.base,
      `origin/${renamed}`,
      "the launch named the stored base",
    );
    // Told the base its clone does have, not the one neither launch fetched.
    await until(() => resumed.bases.length > 0, "base corrected after the launch");
    assert.deepEqual(resumed.bases, [`origin/${before}`]);

    // Its turn ends; the sync fetches the new name, and it is told that.
    resumed.finishTurn();
    await until(() => resumed.bases.length > 1, "base pushed after the sync");
    assert.deepEqual(resumed.bases, [`origin/${before}`, `origin/${renamed}`]);
  }));

test("a launch's late base probe never overwrites the base a newer sync fetched", () =>
  withClones(async ({ fake, h, c, get, blockGuest }) => {
    const lead = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "lead",
      workspace: "worktree",
    });
    const before = lead.branch!;
    const kid = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "kid",
      base: before,
    });
    h.daemon.registry.setFields(kid.id, { supervisorId: lead.id });
    const first = fake.session(kid.id)!;
    first.finishTurn();
    await until(async () => (await get(kid.id)).status.kind === "idle", "kid idle");
    await c.request("session.rebase", { id: kid.id });
    first.endStream();
    await until(() => !h.daemon.sessions.has(kid.id) || h.daemon.sessions.isEnded(kid.id), "cold");

    // The resume's probe of what its checkout fetched is slow.
    const probe = blockGuest((command) => command.startsWith("git rev-parse --verify --quiet"));
    try {
      await c.request("session.resume", { id: kid.id });
      await until(probe.entered, "the launch's probe is under way");
      const resumed = fake.session(kid.id)!;
      // Meanwhile the base is renamed and a sync fetches the new name.
      await c.request("session.setTitle", { id: lead.id, title: "Lead work" });
      const renamed = (await get(lead.id)).branch!;
      await c.request("session.rebase", { id: kid.id });
      await until(() => resumed.bases.length > 0, "the sync's base pushed");
      assert.deepEqual(resumed.bases, [`origin/${renamed}`]);
      // The older probe lands after it, and records nothing.
      probe.release();
      await delay(100);
      assert.deepEqual(resumed.bases, [`origin/${renamed}`]);
    } finally {
      probe.release();
    }
  }));

test("a launch's probe from before an archive records nothing after the session is resumed", () =>
  withClones(async ({ fake, h, c, get, blockGuest, hooks }) => {
    const lead = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "lead",
      workspace: "worktree",
    });
    const before = lead.branch!;
    // The create's probe of what its checkout fetched hangs.
    const probe = blockGuest((command) => command.startsWith("git rev-parse --verify --quiet"));
    try {
      const kid = await c.request<SessionSnapshot>("session.create", {
        provider: "claude",
        prompt: "kid",
        base: before,
      });
      h.daemon.registry.setFields(kid.id, { supervisorId: lead.id });
      await until(probe.entered, "the create's probe is under way");
      const first = fake.session(kid.id)!;
      // Archived (its caches forgotten), the base renamed, and resumed from
      // its saved VM history.
      await c.request("session.markDone", { id: kid.id });
      const history = join(sessionVmDirectory(h.repoRoot, kid.id), "profile/projects/loom-session");
      await Deno.mkdir(history, { recursive: true });
      await Deno.writeTextFile(join(history, `${kid.id}.jsonl`), "saved VM history");
      h.daemon.registry.setFields(kid.id, { providerRef: kid.id });
      await c.request("session.setTitle", { id: lead.id, title: "Lead work" });
      const renamed = (await get(lead.id)).branch!;
      assert.notEqual(renamed, before);
      // Its launch fetches nothing: the old name is still in the clone.
      hooks.fetch = false;
      await c.request("session.resume", { id: kid.id });
      await until(() => fake.session(kid.id) !== first, "resumed");
      const resumed = fake.session(kid.id)!;
      await until(
        async () => !["starting", "done"].includes((await get(kid.id)).status.kind),
        "launched",
      );
      // The probe from before the archive lands first, and records nothing.
      probe.release();
      await delay(150);
      assert.ok(!resumed.bases.includes(`origin/${before}`), JSON.stringify(resumed.bases));
    } finally {
      probe.release();
    }
  }));

test("releasing a live clone session's queue mid workspace operation is refused as busy, as a send is", () =>
  withClones(async ({ fake, c, get, blockGuest }) => {
    const s = await c.request<SessionSnapshot>("session.create", {
      provider: "claude",
      prompt: "work",
    });
    assert.equal(s.checkout, "clone");
    const fs = fake.session(s.id)!;
    fs.emit({ type: "assistant_text", text: "busy" });
    await until(async () => (await get(s.id)).status.kind === "running", "running");
    await c.request("session.send", { id: s.id, text: "later", delivery: "end_of_turn" });
    await c.request("session.interrupt", { id: s.id });
    assert.equal((await get(s.id)).queue?.hold, "interrupt");

    // A rebase holds the session's commands while its guest Git runs.
    const guest = blockGuest();
    const rebasing = c.request("session.rebase", { id: s.id });
    await until(guest.entered, "the rebase is under way");
    try {
      // No turn starts under the guest's Git: refused, and still held.
      await assert.rejects(
        c.request("session.queueRelease", { id: s.id }),
        /completing a workspace operation/,
      );
      await delay(50);
      assert.equal((await get(s.id)).queue?.hold, "interrupt");
      assert.ok(!fs.sends.includes("later"));
    } finally {
      guest.release();
      await rebasing.catch(() => {});
    }
    // Once the operation is done, the release goes through.
    await c.request("session.queueRelease", { id: s.id });
    await until(() => fs.sends.includes("later"), "the released message went");
  }));
