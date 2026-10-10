import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  hostProcesses,
  processesUsing,
  ptyCommand,
  supervisorPid,
} from "../scripts/lib/host-processes.ts";

// Real-VM scripts' leak checks must work on macOS, which has no /proc.
test("finds a live child by argv, environment or open files, and working directory", async () => {
  const cwd = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-host-processes-" }));
  const marker = `loom-marker-${crypto.randomUUID()}`;
  // macOS hides environments, so there a held file is the searchable reference.
  const reference = Deno.build.os === "darwin" ? join(cwd, "held") : marker;
  const child = new Deno.Command("/bin/sh", {
    // A loop, so the shell stays the process rather than exec-ing sleep, and leaves
    // no long-lived sleep behind when killed.
    args: ["-c", "exec 3>held; while :; do sleep 0.1; done", "session-vm/supervisor.ts"],
    cwd,
    env: { LOOM_MARKER: marker },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    let found: Awaited<ReturnType<typeof hostProcesses>>[number] | undefined;
    for (let i = 0; i < 50 && !found?.text.includes(reference); i++) {
      found = (await hostProcesses({ environment: true, cwd: true })).find(
        (process) => process.pid === child.pid,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(found, "the child is listed");
    assert(found.argv.includes("session-vm/supervisor.ts"), found.argv.join(" "));
    assert(found.text.includes(reference), "its reference is searchable");
    assert.equal(found.cwd, cwd);
    // The shell and its sleep both carry the reference and the directory.
    const owns = (found: string[]) => found.some((entry) => entry.startsWith(`${child.pid} `));
    assert(owns(await processesUsing([reference])));
    assert(owns(await processesUsing([cwd], { cwd: true })));
    assert.equal(await supervisorPid(cwd), child.pid);
    assert(
      (await hostProcesses()).every((process) => process.pid !== Deno.pid),
      "the caller is excluded",
    );
  } finally {
    child.kill("SIGKILL");
    await child.status;
  }
  for (let i = 0; (await processesUsing([reference])).length; i++) {
    assert(i < 50, "the child and its sleep exited");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await Deno.remove(cwd, { recursive: true });
});

test("runs a command line on a PTY with this platform's script(1)", () => {
  const { command, args } = ptyCommand("true");
  if (Deno.build.os === "darwin") {
    assert.equal(command, "/usr/bin/script");
    assert.deepEqual(args, ["-q", "/dev/null", "/bin/sh", "-c", "true"]);
  } else {
    assert.match(command, /\/script$/);
    assert.deepEqual(args, ["-q", "-e", "-c", "true", "/dev/null"]);
  }
});
