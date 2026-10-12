import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test(
  "aborting a process-group worker's reader after its exit leaves no unhandled error",
  { timeout: 30_000 },
  async () => {
    // In a child process: the regression was an unhandled rejection killing its host.
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-run",
        "--allow-env",
        fileURLToPath(new URL("fixtures/worker-teardown.ts", import.meta.url)),
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(run.stderr), "");
    assert.equal(decoder.decode(run.stdout), "clean\n");
    assert.equal(run.code, 0);
  },
);
