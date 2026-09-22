import assert from "node:assert/strict";
import { runWorkspacePrepare } from "../core/src/workspace-prepare.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";

Deno.test("preparation hooks run in order with their event and stop on failure", async () => {
  const cwd = await Deno.makeTempDir();
  const hook = (name: string, run: string) => ({ name, run, timeoutMs: 1000 });
  try {
    const hooks = [
      hook(
        "first",
        'test "$LOOM_HOOK_EVENT" = workspace_prepare && test "$LOOM_WORKTREE" = "$PWD" && echo first > order',
      ),
      hook("fail", "echo failed >> order; exit 7"),
      hook("never", "echo never >> order"),
    ];
    await assert.rejects(
      runWorkspacePrepare(hooks, cwd, new AbortController().signal, Deno.env.toObject(), () => {}),
      /fail failed/,
    );
    assert.equal(await Deno.readTextFile(cwd + "/order"), "first\nfailed\n");
    await assert.rejects(
      runWorkspacePrepare(
        [{ ...hook("async", "true"), async: true }],
        cwd,
        new AbortController().signal,
      ),
      /must block/,
    );
    await assert.rejects(
      runWorkspacePrepare(
        [hook("slow", "sleep 30")],
        cwd,
        new AbortController().signal,
        undefined,
        () => {},
      ),
      /timed out/,
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("workspace lifecycle configuration rejects removed commands and async preparation", () => {
  for (const environment of [{ prepare: "install" }, { init: "install" }])
    assert.throws(() => normalizeConfig({ session: { isolation: { environment } } }));
  assert.throws(() => normalizeConfig({ hooks: [{ on: "init", run: "install" }] }));
  assert.throws(
    () =>
      normalizeConfig({
        hooks: [{ on: ["workspace_prepare", "workspace_start"], run: "install", async: true }],
      }),
    /async/,
  );
  const config = normalizeConfig({
    hooks: [{ on: ["workspace_prepare", "workspace_start"], run: "install", timeout: 3600 }],
  });
  assert.equal(config.hooks[0]?.timeoutMs, 3_600_000);
});
