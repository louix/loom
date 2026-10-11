/**
 * A Loom agent in a private clone whose supervisor's branch is renamed: the
 * clone has the host's branches only as `origin/*`, as its syncs fetch them,
 * so its agent is told the new name only once a sync has fetched it — never
 * a ref that does not resolve there.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("condition did not settle: " + what);
};

test("a clone child is told its supervisor's renamed branch only once its clone has it", async () => {
  const fake = new FakeProvider();
  const cwds = new Map<string, string>();
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => ({
        id: ctx.id,
        capabilities: fake.capabilities,
        listPersistedSessions: () => fake.listPersistedSessions(),
        createSession: async (opts) => {
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
        resumeSession: (opts) => fake.resumeSession(opts),
      }),
    }),
  };
  const h = await makeHarness({
    connectors,
    guestCommand: async (s, command, _timeout, signal) => {
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
        auto_resume: { enabled: false },
        auto_rebase: { enabled: true },
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
  const get = (id: string) => c.request<SessionSnapshot>("session.get", { id });
  try {
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
  } finally {
    c.close();
    await h.cleanup();
  }
});
