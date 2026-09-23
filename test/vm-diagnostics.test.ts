import assert from "node:assert/strict";
import { FakeSession } from "../connectors/mock/src/fake.ts";
import { withVmDiagnostics } from "../backend/daemon/src/daemon/vm-diagnostics.ts";
import { isFileLimitError, fileLimitDiagnostic } from "../runtime/src/session-vm/file-limit.ts";
import { classifyStartupFailure, readStartupProgress } from "../runtime/src/session-vm/progress.ts";
import { vmCommand } from "../runtime/src/session-vm/command.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";

Deno.test("VM diagnostics require explicit descriptor-exhaustion evidence", () => {
  for (const text of ["EMFILE: open", "Too many open files", "readfile: os error 24"]) {
    assert(isFileLimitError(text));
    assert.equal(classifyStartupFailure(new Error(text)), "files");
  }
  for (const text of [
    "ESTALE",
    "Stale file handle",
    "authentication_failed",
    "Not logged in",
    "Error 24",
    "EMFILE_example",
    "ENFILE: Too many open files in system",
  ])
    assert.equal(isFileLimitError(text), false, text);
});

Deno.test("VM failed tools keep their payload and emit one nonfatal diagnostic", async () => {
  const base = new FakeSession("vm", { mode: "default" });
  const session = withVmDiagnostics(base);
  const events = session.events()[Symbol.asyncIterator]();
  try {
    base.emit({
      type: "tool_result",
      id: "read",
      ok: true,
      output: "documentation mentions EMFILE",
    });
    assert.equal((await events.next()).value?.type, "tool_result");
    const output = [{ type: "text", text: "Bash: Too many open files" }];
    base.emit({ type: "tool_result", id: "bash", ok: false, output });
    const warning = (await events.next()).value;
    assert.equal(warning?.type, "error");
    if (warning?.type === "error") {
      assert.equal(warning.fatal, false);
      assert.equal(warning.message, fileLimitDiagnostic);
    }
    const original = (await events.next()).value;
    assert.equal(original?.type, "tool_result");
    if (original?.type === "tool_result") {
      assert.equal(original.id, "bash");
      assert.deepEqual(original.output, output);
    }
    base.emit({ type: "tool_result", id: "again", ok: false, output: "EMFILE" });
    assert.equal((await events.next()).value?.type, "tool_result");
    base.emit({ type: "error", message: "open library: EMFILE", fatal: true });
    const fatal = (await events.next()).value;
    assert.equal(fatal?.type, "error");
    if (fatal?.type === "error") {
      assert(fatal.fatal);
      assert(fatal.message.startsWith("open library: EMFILE"));
      assert(fatal.message.includes(fileLimitDiagnostic));
    }
    base.emit({ type: "result", kind: "error", error: "spawn: os error 24" });
    const result = (await events.next()).value;
    assert(result?.type === "result" && result.kind === "error");
    assert(result.error.startsWith("spawn: os error 24"));
    assert(result.error.includes(fileLimitDiagnostic));
    base.emit({ type: "error", message: "authentication_failed", fatal: false });
    const auth = (await events.next()).value;
    assert(auth?.type === "error");
    assert.equal(auth.message, "authentication_failed");
  } finally {
    await session.close();
    await events.return?.();
  }
});

Deno.test("split and long backend stderr reports only a safe file-limit category", async () => {
  const source = "secret-token " + "x".repeat(300) + " Too many open files\nEMFILE again\n";
  const failures: string[] = [];
  await readStartupProgress(
    new ReadableStream({
      start(controller) {
        for (const char of source) controller.enqueue(new TextEncoder().encode(char));
        controller.close();
      },
    }),
    () => assert.fail("Raw stderr must not become startup progress"),
    (code) => failures.push(code),
  );
  assert.deepEqual(failures, ["files"]);
});

Deno.test("failed VM command preserves exit and output, including exhaustion beyond output cap", async () => {
  const directory = await Deno.makeTempDir();
  const executable = directory + "/smolvm";
  const binding = { smolvm: executable, workspace: directory, state: directory } as VmBinding;
  try {
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\nprintf 'load library: Too many open files' >&2\nexit 17\n",
      { mode: 0o700 },
    );
    const failed = await vmCommand(binding, "ignored", 5000, new AbortController().signal);
    assert.equal(failed.code, 17);
    assert.equal(failed.output, "load library: Too many open files\n\n" + fileLimitDiagnostic);
    await Deno.writeTextFile(executable, "#!/bin/sh\nprintf 'documentation: EMFILE'\n");
    const ok = await vmCommand(binding, "ignored", 5000, new AbortController().signal);
    assert.equal(ok.output, "documentation: EMFILE");
    assert.equal(ok.code, 0);
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\ni=0\nwhile [ \"$i\" -lt 7000 ]; do printf 0123456789; i=$((i+1)); done\nprintf 'Too many open files'\nexit 1\n",
    );
    const clipped = await vmCommand(binding, "ignored", 5000, new AbortController().signal);
    assert.equal(clipped.code, 1);
    assert(clipped.output.endsWith(fileLimitDiagnostic));
    assert(clipped.output.length < 66000);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("stderr chunk boundaries do not turn ENFILE or identifiers into EMFILE", async () => {
  for (const source of ["ENFILE: Too many open files in system", "EMFILE_example"]) {
    const failures: string[] = [];
    await readStartupProgress(
      new ReadableStream({
        start(controller) {
          for (const char of source) controller.enqueue(new TextEncoder().encode(char));
          controller.close();
        },
      }),
      () => {},
      (code) => failures.push(code),
    );
    assert.deepEqual(failures, []);
  }
});
