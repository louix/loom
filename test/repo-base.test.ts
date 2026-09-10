import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { publishRepoBase } from "../runtime/src/session-vm/repo-base.ts";

test("base publication preserves the previous selection on cancellation and waits for readers", async () => {
  const home = await Deno.realPath(await Deno.makeTempDir());
  const first = join(home, "base-first"),
    next = join(home, "base-next");
  let reader: Deno.FsFile | undefined;
  try {
    await Deno.mkdir(first);
    await Deno.mkdir(next);
    const signal = new AbortController().signal;
    await publishRepoBase(home, first, signal);
    const selected = await Deno.readTextFile(join(home, "current.json"));
    await assert.rejects(publishRepoBase(home, next, AbortSignal.abort()));
    assert.equal(await Deno.readTextFile(join(home, "current.json")), selected);
    assert((await Deno.stat(first)).isDirectory);
    reader = await Deno.open(join(home, "publication.lock"), { read: true, write: true });
    await reader.lock(false);
    let published = false;
    const pending = publishRepoBase(home, next, signal).then(() => {
      published = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(published, false);
    assert.equal(await Deno.readTextFile(join(home, "current.json")), selected);
    reader.close();
    reader = undefined;
    await pending;
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(home, "current.json"))).directory,
      "base-next",
    );
    await assert.rejects(Deno.stat(first), Deno.errors.NotFound);
  } finally {
    reader?.close();
    await Deno.remove(home, { recursive: true });
  }
});
