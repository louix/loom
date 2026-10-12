import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { FakeProvider, FakeSession } from "../connectors/mock/src/fake.ts";
import { makeHarness } from "@loom/harness";
import { setLogFile, setLogLevel, setLogStderr } from "@loom/core/logger";

const waitFor = async (pred: () => boolean | Promise<boolean>) => {
  const until = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error("naming did not settle");
    await delay(5);
  }
};

const setup = async (config?: string) => {
  const h = await makeHarness(config === undefined ? {} : { config });
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

test("a title still generating at shutdown is abandoned before the store closes", async () => {
  const t = await setup();
  const logFile = await Deno.makeTempFile();
  try {
    // given a titler that has not answered
    const pending = new FakeSession("pending-title", { mode: "auto" });
    let started = false;
    t.fake.createSession = async () => {
      started = true;
      return pending;
    };
    t.session.finishTurn();
    await waitFor(() => started);
    await t.c.close();
    setLogStderr(false);
    setLogFile(logFile);
    setLogLevel("warn");
    // when the daemon stops, and the titler answers only afterwards
    const begun = Date.now();
    await t.h.daemon.stop("test-stop");
    const stopped_millis = Date.now() - begun;
    pending.emit({ type: "assistant_text", text: "Too late to use this title" });
    pending.finishTurn();
    pending.endStream();
    await delay(20);
    // then the job gave up at once, and never read the closed store
    assert.equal(pending.closed, true);
    assert.ok(stopped_millis < 2_000, `stop waited ${stopped_millis}ms for the titler`);
    assert.doesNotMatch(await Deno.readTextFile(logFile), /auto-title failed/);
  } finally {
    setLogLevel("error");
    setLogFile(null);
    setLogStderr(true);
    await Deno.remove(logFile);
    await t.cleanup();
  }
});

test("a nested branch prefix names the generic and the titled branch", async () => {
  const t = await setup(JSON.stringify({ session: { branch_prefix: "me/x" } }));
  try {
    assert.equal(t.s.branch, `me/x/${t.s.id.slice(0, 8)}`);
    t.fake.titleReply = "Repair automatic session naming";
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).branch === "me/x/repair-automatic-session-naming");
  } finally {
    await t.cleanup();
  }
});

test("no branch prefix names bare branches and suffixes a title slug that is taken", async () => {
  const t = await setup(JSON.stringify({ session: { branch_prefix: "" } }));
  try {
    assert.equal(t.s.branch, t.s.id.slice(0, 8));
    execFileSync("git", ["-C", t.h.repoRoot, "branch", "repair-automatic-session-naming"]);
    t.fake.titleReply = "Repair automatic session naming";
    t.session.finishTurn();
    await waitFor(async () => (await t.get()).branch !== t.s.branch);
    assert.match((await t.get()).branch!, /^repair-automatic-session-naming-[0-9a-f]{6}$/);
    assert.equal(
      execFileSync("git", ["-C", t.s.worktree!, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
      (await t.get()).branch,
    );
  } finally {
    await t.cleanup();
  }
});

test("a changed branch prefix renames an existing session under the prefix it was created with", async () => {
  const t = await setup();
  try {
    // given a session still on its generic loom/<id> branch
    assert.equal(t.s.branch, `loom/${t.s.id.slice(0, 8)}`);
    // when the prefix changes before it is titled
    writeFileSync(t.h.configPath, JSON.stringify({ session: { branch_prefix: "" } }));
    await t.c.close();
    await t.h.restart();
    const c = await LoomClient.connect({
      repoRoot: t.h.repoRoot,
      sockPath: t.h.sockPath,
      autospawn: false,
    });
    try {
      const renamed = await c.request<SessionSnapshot>("session.setTitle", {
        id: t.s.id,
        title: "User chosen label",
      });
      // then it keeps loom, while a new session takes the new prefix
      assert.equal(renamed.branch, "loom/user-chosen-label");
      const fresh = await c.request<SessionSnapshot>("session.create", {
        provider: "fake",
        prompt: "another task",
      });
      assert.equal(fresh.branch, fresh.id.slice(0, 8));
    } finally {
      await c.close();
    }
  } finally {
    await t.h.cleanup();
  }
});
