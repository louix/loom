import assert from "node:assert/strict";
import { type RelayDiagnostic } from "../core/src/relay-diagnostic.ts";
import { readStartupProgress } from "../runtime/src/session-vm/progress.ts";
import { VmTerminationError, vmTerminationSchema } from "../core/src/vm-termination.ts";

Deno.test("relay diagnostics survive fragmented stderr without arbitrary error details", async () => {
  const info: RelayDiagnostic = {
    kind: "git",
    index: 0,
    event: "accept_exhausted",
    at: 123,
    incident: 1,
    error: "NotConnected",
    consecutive: 100,
    failures: 100,
    active: 2,
    elapsedMs: 24000,
    stopping: false,
    suppressed: 0,
  };
  const wire =
    [
      { loomRelay: { ...info, error: "secret-token" } },
      { loomRelay: { ...info, path: "/secret-token", message: "secret-token" } },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n") + "\n";
  const records: RelayDiagnostic[] = [];
  await readStartupProgress(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < wire.length; i += 7)
          controller.enqueue(new TextEncoder().encode(wire.slice(i, i + 7)));
        controller.close();
      },
    }),
    () => {},
    undefined,
    undefined,
    undefined,
    (info) => records.push(info),
  );
  assert.deepEqual(records, [info]);
  const termination = vmTerminationSchema.parse({
    reason: "guest_exit",
    phase: "running",
    at: 124,
    relayFailure: { ...records[0], hostStopping: false },
  });
  assert.match(
    new VmTerminationError(termination).message,
    /git\[0\] accept_exhausted: NotConnected/,
  );
  assert(!JSON.stringify(termination).includes("secret-token"));
});
