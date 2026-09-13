import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { FakeProvider, FakeSession } from "../connectors/mock/src/fake.ts";
import { makeHarness } from "@loom/harness";

const waitFor = async (pred: () => boolean | Promise<boolean>) => {
  const until = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error("naming did not settle");
    await delay(5);
  }
};

const setup = async () => {
  const h = await makeHarness();
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const fake = (await h.daemon.providers.get("fake")) as FakeProvider;
  const s = await c.request<SessionSnapshot>("session.create", {
    provider: "fake",
    prompt: "fix broken naming",
  });
  await waitFor(() => !!fake.session(s.id));
  const session = fake.session(s.id)!;
  const get = () => c.request<SessionSnapshot>("session.get", { id: s.id });
  return {
    h,
    c,
    fake,
    s,
    session,
    get,
    cleanup: async () => {
      await c.close();
      await h.cleanup();
    },
  };
};

test("failed title generation names the branch and retries on a later turn", async () => {
  const t = await setup();
  try {
    t.fake.titleReply = "Could you describe the task?";
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).branch === "loom/fix-broken-naming");
    assert.equal((await t.get()).title, "fix broken naming");
    t.fake.titleReply = "Repair automatic session naming";
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).title === t.fake.titleReply);
    assert.equal(
      (await t.get()).branch,
      "loom/fix-broken-naming",
      "descriptive branches stay stable",
    );
    t.fake.titleReply = "Never use this later title";
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).turns === 3);
    assert.equal((await t.get()).title, "Repair automatic session naming");
    await t.c.close();
    await t.h.restart();
    assert.equal(t.h.daemon.registry.store.autoTitleDone(t.s.id), true);
    assert.equal(t.h.daemon.registry.store.titleLocked(t.s.id), false);
  } finally {
    await t.cleanup();
  }
});

test("a failed first turn does not permanently miss naming", async () => {
  const t = await setup();
  try {
    t.fake.titleReply = "Repair automatic session naming";
    t.session.emit({ type: "result", kind: "error", error: "failed" });
    await waitFor(async () => (await t.get()).turns === 1);
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).branch === "loom/repair-automatic-session-naming");
    assert.equal(
      execFileSync("git", ["-C", t.s.worktree!, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
      "loom/repair-automatic-session-naming",
    );
  } finally {
    await t.cleanup();
  }
});

test("manual title wins a delayed generation and names the generic branch", async () => {
  const t = await setup();
  try {
    const pending = new FakeSession("pending-title", { mode: "auto" });
    let calls = 0;
    t.fake.createSession = async () => {
      calls++;
      return pending;
    };
    t.session.finishTurn();
    await waitFor(() => calls === 1);
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).turns === 2);
    assert.equal(calls, 1, "only one naming request may be in flight");
    const renamed = await t.c.request<SessionSnapshot>("session.setTitle", {
      id: t.s.id,
      title: "User chosen label",
    });
    assert.equal(renamed.branch, "loom/user-chosen-label");
    pending.emit({ type: "assistant_text", text: "Discard this generated title" });
    pending.finishTurn();
    pending.endStream();
    await delay(20);
    assert.equal((await t.get()).title, "User chosen label");
    assert.equal((await t.get()).branch, "loom/user-chosen-label");
  } finally {
    await t.cleanup();
  }
});

test("branch rename failures retry without generating another title", async () => {
  const t = await setup();
  try {
    // Hide the generic ref temporarily to force git branch -m to fail.
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", t.s.worktree!, ...args], { encoding: "utf8" }).trim();
    git("branch", "-m", "temporary-test-name");
    t.fake.titleReply = "Repair automatic session naming";
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).title === t.fake.titleReply);
    assert.equal((await t.get()).branch, t.s.branch);
    git("branch", "-m", t.s.branch!);
    t.fake.createSession = async () => {
      throw new Error("must not regenerate");
    };
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).branch === "loom/repair-automatic-session-naming");
  } finally {
    await t.cleanup();
  }
});

test("removal during generation does not rename the retained branch", async () => {
  const t = await setup();
  try {
    const pending = new FakeSession("pending-title", { mode: "auto" });
    let started = false;
    t.fake.createSession = async () => {
      started = true;
      return pending;
    };
    t.session.finishTurn();
    await waitFor(() => started);
    await t.c.request("session.remove", { id: t.s.id });
    pending.emit({ type: "assistant_text", text: "Discard this generated title" });
    pending.finishTurn();
    pending.endStream();
    await delay(20);
    const refs = execFileSync("git", ["-C", t.h.repoRoot, "branch", "--list", t.s.branch!], {
      encoding: "utf8",
    }).trim();
    assert.equal(refs, t.s.branch);
  } finally {
    await t.cleanup();
  }
});
