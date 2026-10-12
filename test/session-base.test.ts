import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness, type Harness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider, type FakeSession } from "@loom/connector-mock";
import type { ConnectorContext, ConnectorManifest } from "@loom/core/connector";
import type { BaseChoices, SessionSnapshot } from "@loom/core/wire";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { statusInWorktree } from "../core/src/status.ts";
import { prepareCheckout } from "../runtime/src/session-vm/checkout.ts";

const quiet = { session: { auto_resume: { enabled: false } } };

const gitIn =
  (cwd: string) =>
  (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

const connect = (h: Harness) =>
  LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });

/** Commit `file` in `cwd`, returning the new tip. */
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file);
  // Only the file: the daemon's own state lives in the repository too.
  gitIn(cwd)("add", file);
  gitIn(cwd)("commit", "-q", "-m", file);
  return gitIn(cwd)("rev-parse", "HEAD");
};

/** The `status` tool's branch line in `cwd`, measured against the base the agent was handed. */
const statusLine = (cwd: string, base: string | undefined) =>
  statusInWorktree(cwd, base ? { base } : {}).text.split("\n")[0] ?? "";

test("a new session starts from what is checked out and keeps that base", async () => {
  const h = await makeHarness({ config: JSON.stringify(quiet) });
  const git = gitIn(h.repoRoot);
  let c = await connect(h);
  try {
    const main = git("rev-parse", "main");
    git("checkout", "-q", "-b", "feature-x");
    const feature = commit(h.repoRoot, "feature.txt");
    assert.deepEqual(await c.request<BaseChoices>("session.baseChoices"), {
      current: { ref: "feature-x", detached: false },
      default: { ref: "main" },
    });

    const onFeature = await c.request<SessionSnapshot>("session.create", {
      prompt: "on the branch",
      provider: "fake",
    });
    assert.equal(onFeature.baseBranch, "feature-x");
    assert.equal(gitIn(onFeature.worktree!)("rev-parse", "HEAD"), feature);

    const onMain = await c.request<SessionSnapshot>("session.create", {
      prompt: "on the default branch",
      provider: "fake",
      base: "main",
    });
    assert.equal(onMain.baseBranch, "main");
    assert.equal(gitIn(onMain.worktree!)("rev-parse", "HEAD"), main);

    // The repository moves on: the session's base does not follow HEAD.
    const moved = commit(h.repoRoot, "more.txt");
    git("checkout", "-q", "main");
    const r = await c.request<{ outcome: string; base: string }>("session.rebase", {
      id: onFeature.id,
    });
    assert.equal(r.outcome, "updated");
    assert.equal(gitIn(onFeature.worktree!)("rev-parse", "HEAD"), moved);
    assert.equal(
      (await c.request<SessionSnapshot>("session.get", { id: onFeature.id })).baseBranch,
      "feature-x",
    );

    // Detached: the full commit, shown short by clients.
    git("checkout", "-q", "--detach", feature);
    const choices = await c.request<BaseChoices>("session.baseChoices");
    assert.deepEqual(choices.current, { ref: feature, detached: true });
    const detached = await c.request<SessionSnapshot>("session.create", {
      prompt: "detached",
      provider: "fake",
    });
    assert.equal(detached.baseBranch, feature);
    assert.equal(gitIn(detached.worktree!)("rev-parse", "HEAD"), feature);

    await assert.rejects(
      c.request("session.create", { prompt: "nowhere", provider: "fake", base: "no-such" }),
      /base "no-such" does not resolve/,
    );

    // A restart re-reads nothing: every session keeps its stored base. A row
    // from before bases were stored keeps the old fallback, `main`.
    git("checkout", "-q", "-b", "later");
    const legacy = await c.request<SessionSnapshot>("session.create", {
      prompt: "legacy",
      provider: "fake",
    });
    h.daemon.db.prepare("UPDATE sessions SET base_branch = NULL WHERE id = ?").run(legacy.id);
    await c.close();
    await h.restart();
    c = await connect(h);
    const baseOf = (id: string) => h.daemon.registry.get(id)?.baseBranch;
    assert.equal(baseOf(onFeature.id), "feature-x");
    assert.equal(baseOf(onMain.id), "main");
    assert.equal(baseOf(detached.id), feature);
    assert.equal(baseOf(legacy.id), null);
    git("checkout", "-q", "main");
    const mainTip = commit(h.repoRoot, "late.txt");
    const legacyRebase = await c.request<{ outcome: string; base: string }>("session.rebase", {
      id: legacy.id,
    });
    assert.equal(legacyRebase.base, "main");
    assert.equal(gitIn(legacy.worktree!)("merge-base", "HEAD", "main"), mainTip);
  } finally {
    await c.close();
    await h.cleanup();
  }
});

test("the default branch is configured, else origin's, else init.defaultBranch, else main", async () => {
  const h = await makeHarness({ config: JSON.stringify(quiet) });
  const git = gitIn(h.repoRoot);
  let c = await connect(h);
  const defaultOf = async () => (await c.request<BaseChoices>("session.baseChoices")).default;
  try {
    git("config", "init.defaultBranch", "trunk");
    assert.deepEqual(await defaultOf(), {
      ref: "trunk",
      unavailableReason: 'The default branch "trunk" does not exist in this repository.',
    });
    git("branch", "trunk");
    assert.deepEqual(await defaultOf(), { ref: "trunk" });

    git("update-ref", "refs/remotes/origin/develop", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    assert.match((await defaultOf()).unavailableReason ?? "", /"develop" does not exist/);
    git("branch", "develop");
    assert.deepEqual(await defaultOf(), { ref: "develop" });

    git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    git("config", "--unset", "init.defaultBranch");
    // The developer's own init.defaultBranch may still apply; pin the last resort.
    git("config", "init.defaultBranch", "");
    assert.deepEqual(await defaultOf(), { ref: "main" });

    // Configured: that branch, and what a session without a base starts from.
    git("checkout", "-q", "-b", "elsewhere");
    git("branch", "release", "main");
    commit(h.repoRoot, "elsewhere.txt");
    await c.close();
    writeFileSync(h.configPath, JSON.stringify({ ...quiet, base_branch: "release" }));
    await h.restart();
    c = await connect(h);
    assert.deepEqual(await c.request<BaseChoices>("session.baseChoices"), {
      current: { ref: "elsewhere", detached: false },
      default: { ref: "release" },
    });
    const configured = await c.request<SessionSnapshot>("session.create", {
      prompt: "configured",
      provider: "fake",
    });
    assert.equal(configured.baseBranch, "release");
    const current = await c.request<SessionSnapshot>("session.create", {
      prompt: "chosen",
      provider: "fake",
      base: "elsewhere",
    });
    assert.equal(current.baseBranch, "elsewhere");

    // Configured but missing: unavailable, and sessions start from HEAD's branch.
    await c.close();
    writeFileSync(h.configPath, JSON.stringify({ ...quiet, base_branch: "gone" }));
    await h.restart();
    c = await connect(h);
    assert.match(
      (await defaultOf()).unavailableReason ?? "",
      /base_branch "gone" does not resolve/,
    );
    const fallback = await c.request<SessionSnapshot>("session.create", {
      prompt: "fallback",
      provider: "fake",
    });
    assert.equal(fallback.baseBranch, "elsewhere");
  } finally {
    await c.close();
    await h.cleanup();
  }
});

test("a private clone starts from a non-main branch, and needs a branch", async () => {
  const state = mkdtempSync(join(tmpdir(), "loom-base-clone-"));
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", state);
  let lifecycle: ConnectorContext["vmLifecycle"];
  /** The base each start handed the agent, in order. */
  const handed = new Map<string, Array<string | undefined>>();
  const hand = (id: string, base: string | undefined) =>
    handed.set(id, [...(handed.get(id) ?? []), base]);
  const live = new Map<string, FakeSession>();
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
        lifecycle = ctx.vmLifecycle ?? lifecycle;
        const fake = new FakeProvider();
        const ready = async (id: string, session: ReturnType<FakeProvider["createSession"]>) => {
          const s = await session;
          Object.defineProperty(s, "providerRef", { value: id });
          live.set(id, s as FakeSession);
          if (ctx.config.sessionVm) {
            const history = join(
              sessionVmDirectory(ctx.config.sessionVm.repoRoot, id),
              "profile/projects/loom-session",
            );
            mkdirSync(history, { recursive: true });
            writeFileSync(join(history, `${id}.jsonl`), "saved VM history");
          }
          return s;
        };
        return {
          id: ctx.id,
          capabilities: fake.capabilities,
          listPersistedSessions: () => fake.listPersistedSessions(),
          createSession: (opts) => {
            hand(opts.sessionId, opts.base);
            return ready(opts.sessionId, fake.createSession(opts));
          },
          resumeSession: (opts) => {
            hand(opts.sessionId, opts.base);
            return ready(opts.sessionId, fake.resumeSession(opts));
          },
        };
      },
    }),
  };
  const h = await makeHarness({
    connectors,
    config: JSON.stringify({
      session: {
        ...quiet.session,
        isolation: {
          enabled: true,
          claude: { artifact: "/test-runtime" },
          checkout: { mode: "clone" },
        },
      },
    }),
  });
  const git = gitIn(h.repoRoot);
  let c = await connect(h);
  try {
    git("checkout", "-q", "-b", "feature/y");
    const tip = commit(h.repoRoot, "y.txt");
    const clone = await c.request<SessionSnapshot>("session.create", {
      prompt: "clone",
      provider: "claude",
    });
    assert.equal(clone.checkout, "clone");
    assert.equal(clone.baseBranch, "feature/y");
    assert.equal(git("rev-parse", clone.branch!), tip);
    // What the relay advertises and the guest checks out against.
    assert.equal(lifecycle?.clone?.(clone.id)?.base, "feature/y");
    assert.ok(existsSync(join(sessionVmDirectory(h.repoRoot, clone.id))));
    // The agent sees the host's branches as `origin/*`: measure from a checkout
    // prepared the way the guest prepares it, with the host as its remote.
    assert.deepEqual(handed.get(clone.id), ["origin/feature/y"]);
    const guest = join(state, "guest-checkout");
    await prepareCheckout(
      {
        path: guest,
        branch: clone.branch!,
        base: "feature/y",
        identity: { name: "Guest", email: "guest@localhost" },
      },
      { remote: h.repoRoot },
    );
    commit(guest, "guest.txt");
    assert.match(statusLine(guest, "origin/feature/y"), /\[\+1 -0 vs origin\/feature\/y\]$/);
    // The provider-wide fallback names a branch the clone does not have locally.
    assert.doesNotMatch(statusLine(guest, "main"), /vs main/);

    // A restart resumes it with the same base.
    live.get(clone.id)!.finishTurn();
    for (let i = 0; i < 200; i++) {
      const s = await c.request<SessionSnapshot>("session.get", { id: clone.id });
      if (s.status.kind === "idle") break;
      await delay(5);
    }
    await c.close();
    await h.restart();
    c = await connect(h);
    await c.request("session.send", { id: clone.id, text: "continue" });
    assert.deepEqual(handed.get(clone.id), ["origin/feature/y", "origin/feature/y"]);

    git("checkout", "-q", "--detach", tip);
    await assert.rejects(
      c.request("session.create", { prompt: "sha", provider: "claude", base: tip }),
      /private clone needs a branch/,
    );
    // Unspecified while detached: the default branch, which a clone can be served.
    const fallback = await c.request<SessionSnapshot>("session.create", {
      prompt: "detached clone",
      provider: "claude",
    });
    assert.equal(fallback.baseBranch, "main");
    // A worktree takes the commit itself.
    const worktree = await c.request<SessionSnapshot>("session.create", {
      prompt: "detached worktree",
      provider: "claude",
      workspace: "worktree",
    });
    assert.equal(worktree.baseBranch, tip);
    // A VM session on a mounted worktree resolves the commit itself.
    assert.deepEqual(handed.get(worktree.id), [tip]);
  } finally {
    await c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    rmSync(state, { recursive: true, force: true });
  }
});

test("the agent is handed its session's own base: create, fork, switch, restart", async () => {
  const h = await makeHarness({ config: JSON.stringify(quiet) });
  const git = gitIn(h.repoRoot);
  let c = await connect(h);
  const fake = async (id = "fake") => (await h.daemon.providers.get(id)) as FakeProvider;
  const createdWith = async (id: string) => (await fake()).creates.find((o) => o.sessionId === id);
  const resumedWith = async (id: string, provider = "fake") =>
    (await fake(provider)).resumes.findLast((r) => r.sessionId === id);
  /** End the session's turn, which also records its provider ref for a later revive. */
  const settle = async (id: string, provider = "fake") => {
    (await fake(provider)).session(id)!.finishTurn();
    for (let i = 0; i < 200; i++) {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      if (s.status.kind === "idle") return;
      await delay(5);
    }
    throw new Error("session did not become idle");
  };
  try {
    git("checkout", "-q", "-b", "feature-x");
    commit(h.repoRoot, "feature.txt");
    const onFeature = await c.request<SessionSnapshot>("session.create", {
      prompt: "on the branch",
      provider: "fake",
    });
    // One commit of the session's own on top of feature-x, two on top of main.
    commit(onFeature.worktree!, "work.txt");
    const base = (await createdWith(onFeature.id))?.base;
    assert.equal(base, "feature-x");
    assert.match(statusLine(onFeature.worktree!, base), /\[\+1 -0 vs feature-x\]$/);

    // A commit works as a base too.
    const tip = git("rev-parse", "HEAD");
    const onCommit = await c.request<SessionSnapshot>("session.create", {
      prompt: "on a commit",
      provider: "fake",
      base: tip,
    });
    commit(onCommit.worktree!, "detached-work.txt");
    const commitBase = (await createdWith(onCommit.id))?.base;
    assert.equal(commitBase, tip);
    assert.match(
      statusLine(onCommit.worktree!, commitBase),
      new RegExp(`\\[\\+1 -0 vs ${tip}\\]$`),
    );

    // A fork is handed the fork's own stored base.
    await settle(onFeature.id);
    const fork = await c.request<SessionSnapshot>("session.fork", { id: onFeature.id });
    assert.ok(fork.baseBranch);
    assert.equal((await createdWith(fork.id))?.base, fork.baseBranch);

    // A provider switch re-hands it.
    (await fake()).capabilities.ownsTranscript = true;
    (await fake("mock")).capabilities.ownsTranscript = true;
    await c.request("session.setProvider", { id: onFeature.id, provider: "mock", model: "fake-1" });
    assert.equal((await resumedWith(onFeature.id, "mock"))?.base, "feature-x");

    // Legacy: a row stored without a base hands none; the provider-wide `main` applies.
    const legacy = await c.request<SessionSnapshot>("session.create", {
      prompt: "legacy",
      provider: "fake",
    });
    h.daemon.db.prepare("UPDATE sessions SET base_branch = NULL WHERE id = ?").run(legacy.id);
    await settle(onCommit.id);
    await settle(legacy.id);

    // A restart revives each from its row.
    await c.close();
    await h.restart();
    c = await connect(h);
    for (const id of [onFeature.id, onCommit.id, legacy.id])
      await c.request("session.send", { id, text: "continue" });
    assert.equal((await resumedWith(onFeature.id, "mock"))?.base, "feature-x");
    assert.equal((await resumedWith(onCommit.id))?.base, tip);
    const legacyRef = await resumedWith(legacy.id);
    assert.ok(legacyRef);
    assert.equal(legacyRef.base, undefined);
  } finally {
    await c.close();
    await h.cleanup();
  }
});
