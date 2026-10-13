/**
 * The fork workflow end to end through a harness daemon: native history
 * copies vs portable handoffs in both directions between two scriptable
 * providers (`fake`, `mock`), an unavailable source provider, destination
 * failure and cancellation, the source left intact, workspace copy fidelity
 * and sharing, lineage across a daemon restart, and usage that never crosses.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import type { HistoryPage, SessionSnapshot } from "@loom/core/wire";
import type { CreateSessionOptions, SessionRef } from "@loom/core/types";
import type { FakeProvider } from "@loom/connector-mock";
import { makeHarness, type Harness } from "@loom/harness";

const CONFIG = `{ "default_provider": "fake" }`;

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const providerOf = async (hh: Harness, id: string) =>
  (await hh.daemon.providers.get(id)) as FakeProvider;

/** Every create / resume a provider is asked for. */
const spy = (p: FakeProvider): { created: CreateSessionOptions[]; resumed: SessionRef[] } => ({
  created: p.creates,
  resumed: p.resumes,
});

const withDaemon = async (
  fn: (hh: Harness, c: LoomClient) => Promise<void>,
  config = CONFIG,
): Promise<void> => {
  const hh = await makeHarness({ config });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  try {
    await fn(hh, c);
  } finally {
    await c.close();
    await hh.cleanup();
  }
};

const get = (c: LoomClient, id: string) => c.request<SessionSnapshot>("session.get", { id });
const events = (c: LoomClient, id: string) => c.request<HistoryPage>("session.events", { id });

/** A finished first turn on a `fake` session with its own worktree: text,
 *  tool activity and a provider-reported cost. */
const parentWithHistory = async (hh: Harness, c: LoomClient): Promise<SessionSnapshot> => {
  const parent = await c.request<SessionSnapshot>("session.create", {
    prompt: "Remember the blue widget",
    provider: "fake",
    worktree: true,
  });
  const s = (await providerOf(hh, "fake")).session(parent.id)!;
  s.emit({ type: "assistant_text", text: "Noted: the blue widget." });
  s.emit({ type: "assistant_text", text: "Checking notes." });
  s.emit({ type: "tool_call", id: "t1", name: "Read", input: { path: "notes.md" } });
  s.emit({ type: "tool_result", id: "t1", ok: true, output: "secret tool output" });
  s.emit({ type: "assistant_text", text: "It is in notes.md." });
  s.finishTurn({ costUsd: 0.25 });
  await waitFor(async () => (await get(c, parent.id)).status.kind === "idle");
  return get(c, parent.id);
};

test("handoff forks cross providers in both directions without nesting or charging history", async () => {
  await withDaemon(async (hh, c) => {
    const fake = await providerOf(hh, "fake");
    const mock = await providerOf(hh, "mock");
    const toMock = spy(mock);
    const toFake = spy(fake);
    const parent = await parentWithHistory(hh, c);
    const before = (await events(c, parent.id)).items.length;

    const fork = await c.request<SessionSnapshot>("session.fork", {
      id: parent.id,
      provider: "mock",
      model: "mock-large",
      effort: "high",
      history: "handoff",
    });
    assert.equal(fork.provider, "mock");
    assert.equal(fork.model, "mock-large");
    assert.equal(fork.effort, "high");
    assert.equal(fork.forkKind, "handoff");
    assert.equal(fork.parentId, parent.id);
    assert.equal(fork.forkTurn, 1);
    assert.notEqual(fork.worktree, parent.worktree);
    assert.equal(toMock.resumed.length, 0, "a handoff starts a fresh provider session");
    const prompt = toMock.created.at(-1)!.prompt;
    assert.match(prompt, /Remember the blue widget/);
    // Adjacent reply blocks are one message; tool activity separates them.
    const carried = JSON.parse(
      prompt.slice(prompt.indexOf("\n\n[") + 2, prompt.lastIndexOf("]") + 1),
    );
    assert.deepEqual(carried, [
      { role: "user", text: "Remember the blue widget" },
      { role: "assistant", text: "Noted: the blue widget.\n\nChecking notes." },
      { role: "assistant", text: "It is in notes.md." },
    ]);
    assert.match(prompt, /not a native provider history/);
    assert.match(prompt, /Omitted content: tool-activity/);
    assert.doesNotMatch(prompt, /secret tool output/);
    // The opening prompt is the fork's first user message, as sent.
    const opening = (await events(c, fork.id)).items.find((e) => e.event.type === "user_message");
    assert.equal((opening!.event as { text: string }).text, prompt);

    // Usage never crosses: the fork starts at zero and is charged only its own.
    assert.equal(fork.costUsd, 0);
    assert.deepEqual(fork.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    mock.session(fork.id)!.finishTurn({ costUsd: 0.01 });
    await waitFor(async () => (await get(c, fork.id)).status.kind === "idle");
    assert.equal((await get(c, fork.id)).costUsd, 0.01);

    // The source is left exactly as it was.
    const after = await get(c, parent.id);
    assert.equal(after.status.kind, "idle");
    assert.equal(after.provider, "fake");
    assert.equal(after.costUsd, 0.25);
    assert.equal(after.turns, 1);
    assert.equal((await events(c, parent.id)).items.length, before);

    // And back: a fork of the handoff carries the original messages, not the
    // first handoff's prompt wrapped inside another.
    const back = await c.request<SessionSnapshot>("session.fork", {
      id: fork.id,
      provider: "fake",
      history: "handoff",
      prompt: "Now paint it red",
    });
    assert.equal(back.provider, "fake");
    assert.equal(back.forkKind, "handoff");
    const second = toFake.created.at(-1)!.prompt;
    assert.equal(second.match(/Context from another conversation/g)?.length, 1);
    assert.equal(second.match(/Remember the blue widget/g)?.length, 1);
    assert.match(second, /Next message:\nNow paint it red$/);
  });
});

test("a native fork resumes a provider copy, records its ref and survives a restart", async () => {
  await withDaemon(async (hh, c) => {
    const fake = await providerOf(hh, "fake");
    fake.capabilities.forking = true;
    const calls = spy(fake);
    const parent = await parentWithHistory(hh, c);
    assert.equal(parent.nativeForkBlockedReason, undefined);
    const parentRef = hh.daemon.registry.store.providerRef(parent.id);

    const fork = await c.request<SessionSnapshot>("session.fork", { id: parent.id });
    assert.equal(fork.forkKind, "native");
    assert.equal(fork.provider, "fake");
    assert.equal(fork.status.kind, "idle");
    assert.equal(calls.created.length, 1, "only the parent was created fresh");
    const ref = calls.resumed.at(-1)!;
    assert.equal(ref.forkHistory, true);
    assert.equal(ref.providerRef, `fake-${parent.id}`);
    // The copy's own ref is on the row before the copy ever speaks.
    assert.equal(hh.daemon.registry.store.providerRef(fork.id), `fake-fork-${fork.id}`);
    assert.equal(hh.daemon.registry.store.providerRef(parent.id), parentRef);
    assert.equal(fork.costUsd, 0, "the copy's history is not charged again");

    // A handoff of the same source, for the lineage check below.
    const handoff = await c.request<SessionSnapshot>("session.fork", {
      id: parent.id,
      history: "handoff",
    });

    // Asking for native history on another provider is refused, not downgraded.
    await assert.rejects(
      c.request("session.fork", { id: parent.id, provider: "mock", history: "native" }),
      /Native history is unavailable/,
    );
    // A native fork keeps the source's settings.
    await assert.rejects(
      c.request("session.fork", { id: parent.id, history: "native", model: "other" }),
      /keeps the source's model/,
    );

    await c.close();
    await hh.restart();
    const c2 = await LoomClient.connect({
      repoRoot: hh.repoRoot,
      sockPath: hh.sockPath,
      autospawn: false,
    });
    try {
      const n = await get(c2, fork.id);
      assert.equal(n.forkKind, "native");
      assert.equal(n.parentId, parent.id);
      assert.equal(n.forkTurn, 1);
      const h = await get(c2, handoff.id);
      assert.equal(h.forkKind, "handoff");
      assert.equal(h.parentId, parent.id);
      // The copy, never the source, is what a revive resumes.
      const again = spy(await providerOf(hh, "fake"));
      await c2.request("session.send", { id: fork.id, text: "continue" });
      assert.equal(again.resumed.at(-1)?.providerRef, `fake-fork-${fork.id}`);
      assert.equal(again.resumed.at(-1)?.forkHistory, undefined);
    } finally {
      await c2.close();
    }
  });
});

test("an unavailable source provider still forks, by handoff from Loom's stored history", async () => {
  await withDaemon(async (hh, c) => {
    const created = spy(await providerOf(hh, "fake")).created;
    const parent = await c.request<SessionSnapshot>("session.createStub", {
      provider: "claude",
      status: "idle",
      prompt: "old",
    });
    hh.daemon.registry.setFields(parent.id, { providerRef: parent.id });
    hh.daemon.emitEvent({
      type: "user_message",
      sessionId: parent.id,
      ts: Date.now(),
      text: "Remember the green gadget",
      injected: false,
    });
    const snap = await get(c, parent.id);
    assert.match(snap.nativeForkBlockedReason ?? "", /disabled/);
    await assert.rejects(
      c.request("session.fork", { id: parent.id, history: "native" }),
      /Native history is unavailable/,
    );
    const fork = await c.request<SessionSnapshot>("session.fork", { id: parent.id });
    assert.equal(fork.provider, "fake");
    assert.equal(fork.forkKind, "handoff");
    assert.match(created.at(-1)!.prompt, /Remember the green gadget/);
  }, `{ "default_provider": "fake", "session": { "provider_access": { "deny": ["claude"] } } }`);
});

test("a destination that fails to start leaves no fork, worktree or branch behind", async () => {
  await withDaemon(async (hh, c) => {
    const fake = await providerOf(hh, "fake");
    const mock = await providerOf(hh, "mock");
    const parent = await parentWithHistory(hh, c);
    const rows = hh.daemon.registry.list().length;
    const branches = git(hh.repoRoot, "branch", "--list");
    const trees = git(hh.repoRoot, "worktree", "list");

    mock.createSession = async () => {
      throw new Error("fixture: destination refused");
    };
    await assert.rejects(
      c.request("session.fork", { id: parent.id, provider: "mock" }),
      /could not start the fork: fixture: destination refused/,
    );
    fake.capabilities.forking = true;
    fake.resumeSession = async () => {
      throw new Error("fixture: no copy");
    };
    await assert.rejects(
      c.request("session.fork", { id: parent.id, history: "native" }),
      /could not start the fork: fixture: no copy/,
    );

    assert.equal(hh.daemon.registry.list().length, rows);
    assert.equal(git(hh.repoRoot, "branch", "--list"), branches);
    assert.equal(git(hh.repoRoot, "worktree", "list"), trees);
    const after = await get(c, parent.id);
    assert.equal(after.status.kind, "idle");
    assert.equal(after.costUsd, 0.25);
  });
});

test("cancelling a starting fork removes everything it created", async () => {
  await withDaemon(async (hh, c) => {
    const mock = await providerOf(hh, "mock");
    const parent = await parentWithHistory(hh, c);
    const branches = git(hh.repoRoot, "branch", "--list");
    const release = mock.blockCreate();
    const forkId = crypto.randomUUID();
    const pending = c.request("session.fork", { id: parent.id, provider: "mock", forkId });
    const outcome = pending.then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    await waitFor(() => hh.daemon.registry.get(forkId)?.status.kind === "starting");
    const worktree = hh.daemon.registry.get(forkId)!.worktree!;
    assert.ok(existsSync(worktree));
    await c.request("session.interrupt", { id: forkId });
    release();
    const err = await outcome;
    assert.equal(err?.code, "cancelled");
    assert.equal(hh.daemon.registry.get(forkId), null);
    assert.equal(existsSync(worktree), false);
    assert.equal(git(hh.repoRoot, "branch", "--list"), branches);
    assert.equal((await get(c, parent.id)).status.kind, "idle");
  });
});

test("a copied workspace keeps staged, unstaged and untracked work apart", async () => {
  await withDaemon(async (hh, c) => {
    const parent = await parentWithHistory(hh, c);
    const src = parent.worktree!;
    writeFileSync(join(src, "tracked.txt"), "v1\n");
    git(src, "add", "tracked.txt");
    git(src, "commit", "-q", "-m", "tracked");
    writeFileSync(join(src, "tracked.txt"), "v2 unstaged\n");
    writeFileSync(join(src, "staged.txt"), "staged\n");
    git(src, "add", "staged.txt");
    writeFileSync(join(src, "untracked.txt"), "untracked\n");
    const status = git(src, "status", "--porcelain");

    const fork = await c.request<SessionSnapshot>("session.fork", {
      id: parent.id,
      provider: "mock",
      workspace: "copy",
    });
    const dst = fork.worktree!;
    assert.notEqual(dst, src);
    assert.equal(git(dst, "rev-parse", "HEAD"), git(src, "rev-parse", "HEAD"));
    assert.equal(git(dst, "diff", "--cached", "--name-only"), "staged.txt");
    assert.equal(git(dst, "diff", "--name-only"), "tracked.txt");
    assert.equal(git(dst, "ls-files", "--others", "--exclude-standard"), "untracked.txt");
    for (const f of ["tracked.txt", "staged.txt", "untracked.txt"])
      assert.equal(readFileSync(join(dst, f), "utf8"), readFileSync(join(src, f), "utf8"));
    assert.equal(git(src, "status", "--porcelain"), status, "the source is untouched");
  });
});

test("a sharing fork works in the source's worktree and never removes it", async () => {
  await withDaemon(async (hh, c) => {
    const parent = await parentWithHistory(hh, c);
    await assert.rejects(
      c.request("session.fork", {
        id: parent.id,
        provider: "mock",
        workspace: "share",
        isolation: "vm",
      }),
      /Local isolation/,
    );
    const fork = await c.request<SessionSnapshot>("session.fork", {
      id: parent.id,
      provider: "mock",
      workspace: "share",
    });
    assert.equal(fork.worktree, parent.worktree);
    assert.equal(fork.branch, parent.branch);
    assert.equal(fork.worktreeOwner, parent.id);
    (await providerOf(hh, "mock")).session(fork.id)!.finishTurn();
    await waitFor(async () => (await get(c, fork.id)).status.kind === "idle");

    // The owner cannot pull the tree out from under the fork…
    await assert.rejects(
      c.request("session.remove", { id: parent.id, force: true }),
      /shares this worktree/,
    );
    await assert.rejects(c.request("session.markDone", { id: parent.id }), /shares this worktree/);
    // …and the fork lets go of it without touching it.
    await c.request("session.remove", { id: fork.id, deleteBranch: true });
    assert.ok(existsSync(parent.worktree!));
    assert.ok(git(hh.repoRoot, "branch", "--list", parent.branch!));
    await c.request("session.remove", { id: parent.id, force: true });
    assert.equal(existsSync(parent.worktree!), false);
  });
});

test("a sharing fork revived while its owner is cold relinks the owner's pruned tree", async () => {
  await withDaemon(async (hh, c) => {
    const parent = await parentWithHistory(hh, c);
    const fork = await c.request<SessionSnapshot>("session.fork", {
      id: parent.id,
      provider: "mock",
      workspace: "share",
    });
    const forked = (await providerOf(hh, "mock")).session(fork.id)!;
    forked.finishTurn();
    await waitFor(async () => (await get(c, fork.id)).status.kind === "idle");
    (await providerOf(hh, "fake")).session(parent.id)!.endStream();
    forked.endStream();
    await delay(50);
    const tree = parent.worktree!;
    rmSync(git(tree, "rev-parse", "--path-format=absolute", "--git-dir"), { recursive: true });

    await c.request("session.send", { id: fork.id, text: "carry on" });
    await waitFor(async () => (await providerOf(hh, "mock")).session(fork.id) !== forked);

    assert.equal(git(tree, "rev-parse", "--abbrev-ref", "HEAD"), parent.branch);
    const entry = git(hh.repoRoot, "worktree", "list", "--porcelain")
      .split("\n\n")
      .find((e) => e.startsWith(`worktree ${Deno.realPathSync(tree)}\n`));
    assert.match(entry ?? "", new RegExp(`\\nlocked loom session ${parent.id}$`));
  });
});
