import assert from "node:assert/strict";
import {
  VmTerminationError,
  vmTerminationSchema,
  type VmTermination,
} from "../core/src/vm-termination.ts";
import { harnessEventSchema } from "../core/src/events.ts";
import { readStartupProgress } from "../runtime/src/session-vm/progress.ts";

Deno.test("termination diagnostics survive fragmented stderr and exclude vendor data", async () => {
  const info: VmTermination = {
    reason: "guest_exit",
    at: 110000,
    phase: "running",
    guestExit: { code: 17, signal: null },
  };
  const frames =
    [
      "raw secret-token",
      JSON.stringify({ loomTermination: { ...info, reason: "secret-token" } }),
      JSON.stringify({
        loomTermination: { ...info, guestExit: { code: 1, signal: "secret-token" } },
      }),
      JSON.stringify({
        loomTermination: {
          ...info,
          stderr: "secret-token",
          guestExit: { ...info.guestExit, token: "secret-token" },
        },
      }),
      "x".repeat(3000),
    ].join("\n") + "\n";
  const records: VmTermination[] = [];
  await readStartupProgress(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < frames.length; i += 7)
          controller.enqueue(new TextEncoder().encode(frames.slice(i, i + 7)));
        controller.close();
      },
    }),
    () => assert.fail("not progress"),
    undefined,
    (record) => records.push(record),
  );
  assert.deepEqual(records, [info]);
  assert(!JSON.stringify(records).includes("secret-token"));
});

Deno.test("a historical network warning remains context, not the termination reason", () => {
  const termination: VmTermination = {
    reason: "stdout_closed",
    phase: "running",
    at: 110000,
    activity: "idle",
    guestExit: { code: 1, signal: null },
    lastNetworkWarning: { host: "mcp-proxy.anthropic.com:443", at: 7000 },
  };
  const error = new VmTerminationError(termination);
  assert.match(error.message, /stdout closed while idle/);
  assert.match(error.message, /code 1/);
  assert.match(error.message, /103s earlier \(not an established cause\)/);
  const event = harnessEventSchema.parse({
    type: "error",
    sessionId: "s",
    ts: 110000,
    fatal: true,
    message: error.message,
    termination,
  });
  assert.deepEqual("termination" in event && event.termination, termination);
  assert.deepEqual(vmTerminationSchema.parse(JSON.parse(JSON.stringify(termination))), termination);
});

Deno.test("host-requested stops retain both intent and observed process exit", () => {
  for (const hostReason of [
    "idle_suspension",
    "credential_expired",
    "user_stop",
    "daemon_shutdown",
  ] as const) {
    const termination: VmTermination = {
      reason: "signal",
      signal: "SIGTERM",
      phase: "running",
      at: 1000,
      hostReason,
      guestExit: { code: 137, signal: "SIGKILL" },
    };
    const error = new VmTerminationError(termination);
    assert(error.message.includes(hostReason.replaceAll("_", " ")));
    assert.equal(error.termination.reason, "signal");
    assert.equal(error.termination.guestExit?.signal, "SIGKILL");
    const event = harnessEventSchema.parse({
      type: "startup_progress",
      sessionId: "s",
      ts: 1000,
      message: error.message,
      termination,
    });
    assert.deepEqual("termination" in event && event.termination, termination);
  }
});

Deno.test("supervisor records exit, stdout EOF, parent EOF and signals before cleanup", async () => {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-stop-test-" });
  try {
    await Deno.mkdir(root + "/workspace");
    for (const mode of ["exit", "stdout", "parent", "signal"] as const) {
      const state = root + "/" + mode;
      await Deno.mkdir(state);
      const script = root + "/backend-" + mode;
      const behavior = {
        exit: "exit 17",
        stdout: "exec 1>&-; while read -r line; do :; done",
        parent: "while read -r line; do :; done",
        signal: "while read -r line; do :; done",
      }[mode];
      await Deno.writeTextFile(
        script,
        `#!/bin/sh
case "$2" in
  ls) echo '[]';;
  data-dir) echo "${state}/machine";;
  exec)
    echo '{"loomStartup":"ready"}' >&2
    echo ready
    ${behavior}
    ;;
esac
`,
        { mode: 0o700 },
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("../runtime/src/session-vm/supervisor.ts", import.meta.url).pathname,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      const records: VmTermination[] = [];
      const [safe, raw] = child.stderr.tee();
      const rawText = new Response(raw).text();
      const diagnostics = readStartupProgress(
        safe,
        () => {},
        undefined,
        (info) => records.push(info),
      );
      const reader = child.stdout.getReader();
      try {
        await writer.write(
          new TextEncoder().encode(
            JSON.stringify({
              binding: {
                version: 1,
                artifact: root,
                smolvm: script,
                workspace: root + "/workspace",
                state,
                token: crypto.randomUUID(),
                manifest: {
                  version: 1,
                  backend: "smolvm",
                  system: Deno.build.arch + "-linux",
                  entrypoint: "/nix/store/" + "a".repeat(32) + "-fixture/bin/fixture",
                  args: [],
                },
              },
              auth: {},
            }) + "\n",
          ),
        );
        const ready = await reader.read();
        assert.match(
          new TextDecoder().decode(ready.value),
          /ready/,
          ready.done ? await rawText : mode,
        );
        if (mode === "parent") await writer.close();
        if (mode === "signal") child.kill("SIGTERM");
        while (!(await reader.read()).done) {
          /* drain */
        }
        await child.status;
        await diagnostics;
        assert.equal(records.length, 1);
        const info = records[0]!;
        assert.equal(info.phase, "running");
        if (mode === "exit") {
          assert(["guest_exit", "stdout_closed"].includes(info.reason));
          assert.deepEqual(info.guestExit, { code: 17, signal: null });
        } else {
          assert.equal(
            info.reason,
            { stdout: "stdout_closed", parent: "parent_disconnected", signal: "signal" }[mode],
          );
          assert.equal(
            info.guestExit,
            undefined,
            "cleanup SIGKILL must not be recorded as the cause",
          );
          if (mode === "signal") assert.equal(info.signal, "SIGTERM");
        }
        await assert.rejects(Deno.stat(state), Deno.errors.NotFound);
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          /* exited */
        }
        await child.status;
        await diagnostics;
        await writer.close().catch(() => {});
        reader.releaseLock();
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
