import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { canonicalHostPath } from "../core/src/host-path.ts";

test("host paths canonicalize system aliases without following session symlinks", async () => {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-path-" });
  try {
    const actual = await Deno.realPath(root);
    assert.equal(canonicalHostPath(root), actual);
    const link = join(root, "substituted");
    await Deno.symlink("/", link);
    assert.equal(canonicalHostPath(link), join(actual, "substituted"));
    assert.notEqual(canonicalHostPath(link), await Deno.realPath(link));
    assert.equal(canonicalHostPath(join(root, "not-created")), join(actual, "not-created"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
