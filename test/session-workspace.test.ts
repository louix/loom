// test-run: own-process — points XDG_STATE_HOME at its fixture for daemon code that reads Deno.env.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { sessionCheckoutPath } from "../runtime/src/session-vm/clone.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

const config = (o: { clone: boolean; worktree: boolean }) =>
  JSON.stringify({
    session: {
      auto_resume: false,
      worktree: { enabled: o.worktree },
      isolation: {
        enabled: true,
        claude: { artifact: "/test-runtime" },
        checkout: { mode: o.clone ? "clone" : "mount" },
      },
    },
  });

test("a chosen workspace overrides the configured one and survives restart and fork", async () => {
  const state = mkdtempSync(join(tmpdir(), "loom-workspace-"));
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", state);
  const cwds: Array<{ id: string; cwd: string; operation: "create" | "resume" }> = [];
  const fakes = new Map<string, FakeProvider>();
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
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
            cwds.push({ id: opts.sessionId, cwd: opts.cwd, operation: "create" });
            return ready(opts.sessionId, fake.createSession(opts));
          },
          resumeSession: (opts) => {
            cwds.push({ id: opts.sessionId, cwd: opts.cwd, operation: "resume" });
            return ready(opts.sessionId, fake.resumeSession(opts));
          },
        };
      },
    }),
  };
  const h = await makeHarness({ connectors, config: config({ clone: false, worktree: true }) });
  let c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const cwdOf = (id: string) => cwds.filter((x) => x.id === id).at(-1)?.cwd;
  const idle = async (s: SessionSnapshot) => {
    fakes.get(s.id)!.session(s.id)!.finishTurn();
    for (let i = 0; i < 200; i++) {
      if ((await c.request<SessionSnapshot>("session.get", { id: s.id })).status.kind === "idle")
        return;
      await delay(5);
    }
    throw new Error("session did not become idle");
  };
  const create = (params: Record<string, unknown>) =>
    c.request<SessionSnapshot>("session.create", { prompt: "go", provider: "claude", ...params });
  const defaults = async () =>
    (await c.request<ProviderInfo[]>("providers.list")).find((p) => p.id === "claude")!;
  const worktrees = () =>
    execFileSync("git", ["-C", h.repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).match(/^worktree /gm)?.length ?? 0;
  try {
    const before = await defaults();
    assert.deepEqual(before.defaultWorkspace, { none: "worktree", vm: "worktree" });
    assert.equal(before.inPlaceUnavailableReason, undefined);

    // Unspecified: today's default — a VM with a mounted worktree.
    const plain = await create({});
    assert.equal(plain.isolation, "vm");
    assert.equal(plain.inPlace, false);
    assert.equal(plain.checkout, undefined);
    assert.ok(plain.worktree);
    assert.equal(cwdOf(plain.id), plain.worktree);

    const clone = await create({ workspace: "clone" });
    const clonePath = sessionCheckoutPath(sessionVmDirectory(h.repoRoot, clone.id));
    assert.equal(clone.checkout, "clone");
    assert.equal(clone.worktree, clonePath);
    assert.equal(cwdOf(clone.id), clonePath);
    assert.equal(clone.branch, `loom/${clone.id.slice(0, 8)}`);

    const inPlace = await create({ workspace: "in-place", isolation: "none" });
    assert.equal(inPlace.inPlace, true);
    assert.equal(inPlace.worktree, null);
    assert.equal(cwdOf(inPlace.id), h.repoRoot);

    const local = await create({ workspace: "worktree", isolation: "none" });
    assert.equal(local.inPlace, false);
    assert.equal(local.checkout, undefined);
    assert.equal(cwdOf(local.id), local.worktree);
    assert.equal(worktrees(), 3, "the repository plus the two worktrees; a clone is no worktree");

    // Refused before anything exists.
    const count = (await c.request<SessionSnapshot[]>("session.list")).length;
    await assert.rejects(
      create({ workspace: "clone", isolation: "none" }),
      /private clone runs only in a VM/,
    );
    await assert.rejects(
      create({ workspace: "in-place", worktree: true }),
      /contradicts workspace/,
    );
    await assert.rejects(create({ workspace: "elsewhere" }), /invalid parameters/);
    assert.equal((await c.request<SessionSnapshot[]>("session.list")).length, count);

    for (const s of [plain, clone, inPlace, local]) await idle(s);

    // The config now says clones on a VM; existing sessions keep what they
    // were made with.
    await c.close();
    writeFileSync(h.configPath, config({ clone: true, worktree: true }));
    await h.restart();
    c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
    assert.deepEqual((await defaults()).defaultWorkspace, { none: "worktree", vm: "clone" });
    for (const s of [plain, clone, inPlace, local]) {
      const resumed = await c.request<SessionSnapshot>("session.resume", { id: s.id });
      assert.equal(resumed.inPlace, s.inPlace);
      assert.equal(resumed.checkout, s.checkout);
      assert.equal(resumed.worktree, s.worktree);
      assert.equal(cwdOf(s.id), s.worktree ?? h.repoRoot);
      await idle(s);
    }

    // A VM fork copies its source's kind of checkout, not the new default.
    const mountedFork = await c.request<SessionSnapshot>("session.fork", { id: plain.id });
    assert.equal(mountedFork.isolation, "vm");
    assert.equal(mountedFork.checkout, undefined);
    assert.equal(cwdOf(mountedFork.id), mountedFork.worktree);
    const cloneFork = await c.request<SessionSnapshot>("session.fork", { id: clone.id });
    assert.equal(cloneFork.checkout, "clone");

    // Unspecified follows the new config; a choice still overrides it.
    const vmDefault = await create({});
    assert.equal(vmDefault.checkout, "clone");
    const legacy = await create({ worktree: true });
    assert.equal(legacy.checkout, "clone", "the old flag keeps meaning the configured kind");
    const hostDefault = await create({ isolation: "none" });
    assert.equal(hostDefault.checkout, undefined);
    assert.equal(hostDefault.inPlace, false);
    const chosen = await create({ workspace: "worktree" });
    assert.equal(chosen.isolation, "vm");
    assert.equal(chosen.checkout, undefined);
    assert.equal(cwdOf(chosen.id), chosen.worktree);

    // With worktrees off, unspecified works in place on either isolation.
    await c.close();
    writeFileSync(h.configPath, config({ clone: true, worktree: false }));
    await h.restart();
    c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
    assert.deepEqual((await defaults()).defaultWorkspace, { none: "in-place", vm: "in-place" });
    const inPlaceDefault = await create({ isolation: "none" });
    assert.equal(inPlaceDefault.inPlace, true);
    const cloneChosen = await create({ workspace: "clone" });
    assert.equal(cloneChosen.checkout, "clone");
  } finally {
    await c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    rmSync(state, { recursive: true, force: true });
  }
});
