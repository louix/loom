import assert from "node:assert/strict";
import { join } from "node:path";
import { makeHarness } from "@loom/harness";
import { FakeProvider } from "@loom/connector-mock";
import { LoomClient } from "@loom/client";
import type { ConnectorContext } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import {
  registerVm,
  stopVm,
  type VmOwner,
  type VmRecord,
} from "../runtime/src/session-vm/inventory.ts";

Deno.test("VM control stops the daemon session, preserves edits, and cannot stop its replacement", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const home = join(root, "inventory");
  let lifecycle: NonNullable<ConnectorContext["vmLifecycle"]> | undefined;
  const fake = new FakeProvider();
  const h = await makeHarness({
    connectors: {
      "@loom/connector-mock": async () => ({
        createProvider: (ctx) => {
          lifecycle = ctx.vmLifecycle;
          return fake;
        },
      }),
    },
  });
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  let owner: VmOwner | undefined;
  try {
    const created = await client.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "work",
    });
    const session = fake.session(created.id)!;
    session.emit({ type: "permission_request", id: "permission", tool: "Bash", input: {} });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await client.request<SessionSnapshot>("session.get", { id: created.id })).status.kind ===
        "awaiting_input"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Deno.writeTextFile(join(created.worktree!, "dirty"), "keep edits");
    assert(lifecycle);
    const record: VmRecord = {
      version: 1,
      id: crypto.randomUUID(),
      repo: h.repoRoot,
      kind: "session",
      sessionId: created.id,
      provider: "fake",
      workload: lifecycle.activity(created.id),
      state: "running",
      createdAt: new Date().toISOString(),
      stoppedAt: null,
      observedAt: new Date().toISOString(),
      source: "owner",
      error: null,
      paths: {
        workspace: created.worktree!,
        runtime: "/fixture",
        state: join(root, "absent"),
        session: null,
        profile: null,
        backend: null,
        base: null,
      },
    };
    owner = await registerVm(record, home);
    owner.serve(
      async () => {
        await lifecycle!.stop(created.id, () => !session.closed);
        await owner!.finish();
      },
      async () => ({ workload: lifecycle!.activity(created.id) }),
    );
    await stopVm(record.id, home, 5000);
    assert(session.closed);
    assert.equal(h.daemon.sessions.has(created.id), false);
    const stopped = await client.request<SessionSnapshot>("session.get", { id: created.id });
    assert.equal(stopped.status.kind, "interrupted");
    assert.equal(stopped.worktree, created.worktree);
    assert.equal(await Deno.readTextFile(join(created.worktree!, "dirty")), "keep edits");
    await client.request("session.resume", { id: created.id });
    const replacement = fake.session(created.id)!;
    assert.notEqual(replacement, session);
    await lifecycle.stop(created.id, () => !session.closed);
    assert.equal(replacement.closed, false);
    assert(h.daemon.sessions.has(created.id));
  } finally {
    await owner?.finish();
    await client.close();
    await h.cleanup();
    await Deno.remove(root, { recursive: true });
  }
});
