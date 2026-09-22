import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorContext, ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import { sessionCheckoutPath } from "../runtime/src/session-vm/clone.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

test("clone sessions live on host refs and the daemon never runs Git in the clone", async () => {
  const state = mkdtempSync(join(tmpdir(), "loom-clone-"));
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", state);
  const fakes = new Map<string, FakeProvider>();
  const cwds = new Map<string, string>();
  let lifecycle: ConnectorContext["vmLifecycle"];
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
        lifecycle = ctx.vmLifecycle ?? lifecycle;
        const fake = new FakeProvider();
        const ready = async (id: string, session: ReturnType<FakeProvider["createSession"]>) => {
          const s = await session;
          Object.defineProperty(s, "providerRef", { value: id });
          fakes.set(id, fake);
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
            cwds.set(opts.sessionId, opts.cwd);
            return ready(opts.sessionId, fake.createSession(opts));
          },
          resumeSession: (opts) => {
            cwds.set(opts.sessionId, opts.cwd);
            return ready(opts.sessionId, fake.resumeSession(opts));
          },
        };
      },
    }),
  };
  const h = await makeHarness({
    connectors,
    config: `{
  "session": {
    "titles": { "enabled": false },
    "auto_resume": { "enabled": false },
    "auto_rebase": { "enabled": true },
    "isolation": {
      "enabled": true,
      "claude": { "artifact": "/test-runtime" },
      "checkout": { "mode": "clone" }
    }
  }
}`,
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", h.repoRoot, ...args], { encoding: "utf8" }).trim();
  const marker = join(state, "ran-on-host");
  /** What an agent can leave in its clone: a repository whose config runs a command. */
  const plantHostileClone = (path: string) => {
    mkdirSync(path, { recursive: true });
    execFileSync("git", ["init", "-q", path]);
    execFileSync("git", ["-C", path, "config", "core.fsmonitor", `touch ${marker}; false`]);
    writeFileSync(join(path, "uncommitted.txt"), "work\n");
  };
  /** The guest publishes by pushing through the relay; stand in by moving the host ref. */
  const publish = (branch: string, subject: string) => {
    const tip = git("commit-tree", "-p", branch, "-m", subject, `${branch}^{tree}`);
    git("update-ref", `refs/heads/${branch}`, tip);
    return tip;
  };
  const endTurn = async (id: string) => {
    fakes.get(id)!.session(id)!.finishTurn();
    for (let i = 0; i < 200; i++) {
      const s = await c.request<SessionSnapshot>("session.get", { id });
      if (s.status.kind === "idle") return s;
      await delay(5);
    }
    throw new Error("session did not become idle");
  };
  try {
    const created = await c.request<SessionSnapshot>("session.create", {
      prompt: "work in a clone",
      provider: "claude",
    });
    const clonePath = sessionCheckoutPath(sessionVmDirectory(h.repoRoot, created.id));
    assert.equal(created.checkout, "clone");
    assert.equal(created.worktree, clonePath);
    assert.equal(created.branch, `loom/${created.id.slice(0, 8)}`);
    assert.equal(created.baseBranch, "main");
    assert.equal(cwds.get(created.id), clonePath);
    // Tool VMs resolve the path before the session VM launches, so it exists already.
    assert.ok(existsSync(clonePath));
    assert.equal(git("rev-parse", created.branch!), git("rev-parse", "main"));
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    assert.deepEqual(lifecycle?.clone?.(created.id), {
      branch: created.branch,
      base: "main",
      visible: [],
      identity: { name: `Loom (${created.model})`, email: `loom+${created.model}@localhost` },
      maxPushBytes: 512 * 1024 * 1024,
    });

    plantHostileClone(clonePath);
    // The base moves too, so an auto-rebase would be due for a host worktree.
    git("commit", "-q", "--allow-empty", "-m", "base moved");
    const tip = publish(created.branch!, "published by the guest");
    const idle = await endTurn(created.id);
    assert.deepEqual(idle.git, {
      branch: created.branch,
      commits: 2,
      aheadOfBase: 1,
      behindBase: 1,
      dirty: false,
      lastCommitSubject: "published by the guest",
    });
    assert.equal(git("rev-parse", created.branch!), tip, "the host never moves a clone's branch");
    const checkpoints = await c.request<Array<{ turn: number; headSha?: string }>>(
      "session.checkpoints",
      { id: created.id },
    );
    assert.ok(checkpoints.length > 0);

    await assert.rejects(c.request("session.rebase", { id: created.id }), /private clone/);
    await assert.rejects(
      c.request("session.rewind", { id: created.id, toTurn: 0, restoreWorktree: true }),
      /private clone|no such|turn/,
    );

    const fork = await c.request<SessionSnapshot>("session.fork", { id: created.id });
    assert.equal(fork.checkout, "clone");
    assert.notEqual(fork.worktree, clonePath);
    assert.equal(fork.baseBranch, "main", "a fork inherits a base branch, not a SHA");
    assert.equal(git("rev-parse", fork.branch!), tip);
    assert.equal(lifecycle?.clone?.(fork.id)?.base, "main");

    const done = await c.request<SessionSnapshot>("session.markDone", { id: created.id });
    assert.equal(done.worktree, null);
    assert.ok(existsSync(join(clonePath, "uncommitted.txt")), "archiving keeps unpublished work");
    await c.request("session.send", { id: created.id, text: "continue" });
    const resumed = await c.request<SessionSnapshot>("session.get", { id: created.id });
    assert.equal(resumed.worktree, clonePath);
    assert.equal(cwds.get(created.id), clonePath);

    const running = fakes.get(created.id)!.session(created.id)!;
    const now = Date.now();
    await h.daemon.sweepIdleVms(now);
    await h.daemon.sweepIdleVms(now + 11 * 60_000);
    assert.equal(running.closed, false, "active turns are not reaped");
    await endTurn(created.id);
    h.daemon.sessions.setKeepWarm(created.id, true);
    await h.daemon.sweepIdleVms(now);
    await h.daemon.sweepIdleVms(now + 11 * 60_000);
    assert.equal(running.closed, false, "keep-warm pins the VM");
    h.daemon.sessions.setKeepWarm(created.id, false);
    await h.daemon.sweepIdleVms(now);
    await h.daemon.sweepIdleVms(now + 11 * 60_000);
    assert.equal(running.closed, true, "idle runtime is closed");
    assert.equal(h.daemon.sessions.has(created.id), false);
    assert.ok(existsSync(join(clonePath, "uncommitted.txt")));
    await c.request("session.send", { id: created.id, text: "wake after idle" });
    assert.notEqual(fakes.get(created.id)!.session(created.id), running);
    assert.equal(cwds.get(created.id), clonePath);

    await assert.rejects(
      c.request("session.remove", { id: created.id }),
      /uncommitted or unpublished/,
    );
    await c.request("session.remove", { id: created.id, force: true });
    assert.ok(!existsSync(clonePath), "removing the session removes its clone");
    assert.equal(git("rev-parse", created.branch!), tip, "the branch outlives the session");
    assert.ok(!existsSync(marker), "the clone's Git config ran on the host");
  } finally {
    c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    rmSync(state, { recursive: true, force: true });
  }
});
