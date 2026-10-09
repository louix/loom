import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

Deno.test("isolation execution ownership works outside the Loom workspace", async () => {
  const root = await Deno.makeTempDir({ prefix: "loom-isolation-consumer-" });
  try {
    await cp(fileURLToPath(new URL("../isolation", import.meta.url)), join(root, "isolation"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ workspace: ["./isolation"] }),
    );
    // Check type-only exports too: references back into Loom must fail here.
    const checked = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", "deno.json", "--no-remote", "--no-npm", "isolation"],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(checked.code, 0, new TextDecoder().decode(checked.stderr));
    await Deno.writeTextFile(
      join(root, "consumer.ts"),
      `
import assert from "node:assert/strict";
import { ExecutionLeases } from "@loom/isolation/execution-leases";
import { IsolationError } from "@loom/isolation/errors";
import { EnvironmentCoordinator } from "@loom/isolation/coordinator";

const leases = new ExecutionLeases();
const owner = new AbortController();
const lease = leases.acquire("environment", owner);
assert.throws(() => leases.assertIdle("environment"), (error) =>
  error instanceof IsolationError && error.code === "busy");
assert.throws(() => leases.close(lease.token, new AbortController()), (error) =>
  error instanceof IsolationError && error.code === "bad_request");
owner.abort();
assert(lease.signal.aborted);
assert(leases.has("environment"));
let drained = false;
const cleanup = leases.cancel("environment").then(() => { drained = true; });
await Promise.resolve();
assert.equal(drained, false);
lease.release();
await cleanup;
assert.equal(leases.has("environment"), false);
assert.throws(() => leases.acquire("environment", owner), (error) =>
  error instanceof IsolationError && error.code === "disconnected");

let launches = 0;
let initialized = 0;
const reasons: string[] = [];
const coordinator = new EnvironmentCoordinator<{}, string, { command: string }>(
  {
    directory: (id) => "/consumer-state/" + id,
    withStopped: async (_id, action) => await action(),
  },
  async ({ directory }) => {
    assert.equal(directory, "/consumer-state/example");
    launches++;
    const exited = Promise.withResolvers<void>();
    return {
      ready: Promise.resolve(),
      exited: exited.promise,
      initialize: async () => { initialized++; },
      close: async (reason) => { reasons.push(reason); exited.resolve(); },
      command: async (command) => ({ code: 7, output: command, timedOut: false }),
      execution: (command) => ({ command }),
    };
  },
);
await Promise.all([coordinator.start("example", {}), coordinator.start("example", {})]);
assert.equal(launches, 1);
assert.equal(initialized, 1);
const executionOwner = new AbortController();
assert.equal((await coordinator.command("example", "sample", 1000, executionOwner)).code, 7);
const execution = coordinator.openExecution("example", "literal argv", executionOwner);
assert.equal(execution.command, "literal argv");
assert.throws(() => coordinator.stop("example"), (error) =>
  error instanceof IsolationError && error.code === "busy");
coordinator.closeExecution(execution.token, executionOwner);
await coordinator.stop("example");
assert.equal(coordinator.inspect("example").phase, "stopped");
await coordinator.start("example", {});
await coordinator.close();
assert.equal(launches, 2);
assert.deepEqual(reasons, ["user_stop", "owner_shutdown"]);
`,
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", "deno.json", "--no-remote", "--no-npm", "consumer.ts"],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
