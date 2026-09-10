import assert from "node:assert/strict";
import { test } from "node:test";
import { preparationConsoleTail } from "../runtime/src/session-vm/prepare-diagnostics.ts";

test("preparation diagnostics survive missing logs and bound guest-controlled console output", async () => {
  const directory = await Deno.makeTempDir();
  const path = directory + "/agent-console.log";
  try {
    assert.match(await preparationConsoleTail(directory), /unavailable/);
    await Deno.writeTextFile(path, "");
    assert.match(await preparationConsoleTail(directory), /empty/);
    await Deno.writeTextFile(
      path,
      "old boot output\n" + "x".repeat(20000) + "\nOut of memory: Killed process\n\x1b[2J",
    );
    const result = await preparationConsoleTail(directory);
    assert.match(result, /last 16 KiB/);
    assert.match(result, /Out of memory: Killed process/);
    assert(!result.includes("old boot output"));
    assert(!result.includes("\x1b"));
    assert(result.includes("\\x1b[2J"));
    assert(result.length < 17000);
    await Deno.remove(path);
    await Deno.symlink(directory + "/missing", path);
    assert.match(await preparationConsoleTail(directory), /unavailable/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
