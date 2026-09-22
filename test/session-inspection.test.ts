import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { gitFixture } from "../scripts/lib/git-fixture.ts";
import {
  changesCommand,
  hostMonitorText,
} from "../backend/daemon/src/daemon/session-inspection.ts";
import { executeShellHook } from "../core/src/shell-hook.ts";

test("Changes includes committed, staged, unstaged and untracked files without altering Git state", async () => {
  const f = await gitFixture();
  try {
    await Deno.writeTextFile(join(f.workspace, "committed.txt"), "committed content\n");
    await f.git("-C", f.workspace, "add", ".");
    await f.git("-C", f.workspace, "commit", "-m", "session work");
    await Deno.writeTextFile(join(f.workspace, "staged.txt"), "staged content\n");
    await f.git("-C", f.workspace, "add", "staged.txt");
    await Deno.writeTextFile(join(f.workspace, "file.txt"), "unstaged content\n");
    await Deno.writeTextFile(join(f.workspace, "untracked.txt"), "untracked content\n");
    const before = await f.git("-C", f.workspace, "status", "--porcelain");
    for (const patch of [false, true]) {
      const result = await executeShellHook(
        changesCommand("main", patch),
        f.workspace,
        Deno.env.toObject(),
        15000,
        new AbortController().signal,
      );
      assert.equal(result.code, 0, result.output);
      for (const name of ["committed.txt", "staged.txt", "file.txt", "untracked.txt"])
        assert.ok(result.output.includes(name));
      if (patch) assert.match(result.output, /\+committed content/);
    }
    assert.equal(await f.git("-C", f.workspace, "status", "--porcelain"), before);
    const fallback = await executeShellHook(
      changesCommand("missing-ref", true),
      f.workspace,
      Deno.env.toObject(),
      15000,
      new AbortController().signal,
    );
    assert.equal(fallback.code, 0);
    assert.match(fallback.output, /against HEAD/);
    assert.doesNotMatch(fallback.output, /\+committed content/);
  } finally {
    await f.close();
  }
});

test("Monitor labels host scope and exposes real resource counters", () => {
  const text = hostMonitorText();
  assert.match(text, /DAEMON HOST/);
  assert.match(text, /CPU cores\s+\d+/);
  assert.match(text, /Resident RAM\s+\d+ MiB/);
  assert.match(text, /not this session's VM/);
});
