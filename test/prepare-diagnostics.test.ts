import assert from "node:assert/strict";
import { test } from "node:test";
import {
  preparationConsoleTail,
  hostPreparationResources,
  monitorPreparation,
} from "../runtime/src/session-vm/prepare-diagnostics.ts";

test("resource monitoring stops without waiting for a blocked sample", async () => {
  let finish!: (text: string) => void;
  const stop = monitorPreparation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  stop();
  finish("late sample must not schedule another timer");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("host sampling follows the original VM process after it exits", async () => {
  if (Deno.build.os !== "linux") return;
  const directory = await Deno.makeTempDir();
  const child = new Deno.Command("/bin/sh", {
    args: ["-c", "read value"],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await Deno.writeTextFile(directory + "/agent.pid", String(child.pid));
    const sample = await hostPreparationResources(directory);
    assert.match(await sample(), /RSS_kB=/);
    await child.stdin.close();
    await child.status;
    assert.match(await sample(), /process gone/);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    await child.status;
    await Deno.remove(directory, { recursive: true });
  }
});

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
