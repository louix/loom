import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvironmentOutput } from "../runtime/src/session-vm/environment-protocol.ts";
import { readStartupProgress } from "../runtime/src/session-vm/progress.ts";
import type { VmTermination } from "../core/src/vm-termination.ts";
import { launchSessionVm } from "@loom/runtime/session-vm";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const waitForFile = async (path: string) => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + path);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

Deno.test("standalone supervisor gates readiness, retains ownership, and cleans failed/cancelled starts", async () => {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-environment-test-" });
  const backend = join(root, "backend");
  const fixture = fileURLToPath(new URL("./fixtures/environment-backend.ts", import.meta.url));
  await Deno.writeTextFile(
    backend,
    `#!/bin/sh\nexec ${quote(Deno.execPath())} run -A ${quote(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  await Deno.mkdir(join(root, "workspace"));
  const children: Deno.ChildProcess[] = [];
  const tasks: Promise<unknown>[] = [];
  const start = async (
    name: string,
    mode: string,
    sessionDirectory = join(root, name + "-profile"),
  ) => {
    const state = join(root, name);
    const token = crypto.randomUUID();
    await Deno.mkdir(state);
    await Deno.writeTextFile(join(state, "mode"), mode);
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        fileURLToPath(new URL("../runtime/src/session-vm/supervisor.ts", import.meta.url)),
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    children.push(child);
    const writer = child.stdin.getWriter();
    const records: VmTermination[] = [];
    const failures: string[] = [];
    const diagnostics = readStartupProgress(
      child.stderr,
      () => {},
      (code) => failures.push(code),
      (record) => {
        records.push(record);
      },
    );
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const output = readEnvironmentOutput(child.stdout, () => {
      ready.resolve();
    });
    void output.catch(ready.reject);
    tasks.push(
      diagnostics,
      output.catch(() => {}),
    );
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({
          binding: {
            version: 1,
            artifact: root,
            smolvm: backend,
            workspace: join(root, "workspace"),
            state,
            token,
            sessionDirectory,
            environmentOnly: true,
            manifest: {
              version: 1,
              backend: "smolvm",
              system: Deno.build.arch + "-linux",
              entrypoint: "/nix/store/" + "a".repeat(32) + "-fixture/bin/fixture",
              args: [],
            },
          },
          auth: {},
          providerHosts: [],
        }) + "\n",
      ),
    );
    return {
      state,
      token,
      sessionDirectory,
      child,
      writer,
      ready: ready.promise,
      output,
      diagnostics,
      records,
      failures,
    };
  };
  const timer = setTimeout(() => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }
  }, 30_000);
  try {
    for (const mode of ["ready", "failure", "diagnostic", "invalid", "parent", "signal"] as const) {
      const vm = await start(mode, mode);
      try {
        await waitForFile(join(vm.state, "entered"));
        assert.equal(
          JSON.parse(await Deno.readTextFile(join(vm.state, "status.json"))).phase,
          "starting",
        );
        assert.equal(
          JSON.parse(await Deno.readTextFile(join(vm.sessionDirectory, "active.json"))).recovery
            .ready,
          false,
        );
        if (mode === "parent") await vm.writer.close();
        else if (mode === "signal") vm.child.kill("SIGTERM");
        else {
          await Deno.writeTextFile(join(vm.state, "release"), "");
          if (mode === "ready") {
            await vm.ready;
            const active = JSON.parse(
              await Deno.readTextFile(join(vm.sessionDirectory, "active.json")),
            );
            assert.equal(active.recovery.ready, true);
            assert.equal(
              JSON.parse(await Deno.readTextFile(join(vm.state, "status.json"))).phase,
              "running",
            );
            const duplicate = await start("duplicate", "ready", vm.sessionDirectory);
            try {
              await assert.rejects(duplicate.ready);
              await duplicate.child.status;
              await duplicate.diagnostics;
              assert.equal(
                JSON.parse(await Deno.readTextFile(join(vm.sessionDirectory, "active.json"))).token,
                vm.token,
              );
            } finally {
              await duplicate.writer.close().catch(() => {});
            }
            await vm.writer.close();
          }
        }
        if (mode !== "ready") await assert.rejects(vm.ready);
        await vm.child.status;
        await vm.diagnostics;
        await vm.output.catch(() => {});
        assert.equal(vm.records.length, 1);
        assert.equal(vm.records[0]!.phase, mode === "ready" ? "running" : "starting");
        // A guest's specific preparation diagnostic crosses the supervisor intact.
        assert.deepEqual(vm.failures, mode === "diagnostic" ? ["sessionCheckoutFailed"] : []);
        await assert.rejects(Deno.stat(vm.state), Deno.errors.NotFound);
        await assert.rejects(
          Deno.stat(join(vm.sessionDirectory, "active.json")),
          Deno.errors.NotFound,
        );
        assert((await Deno.stat(join(vm.sessionDirectory, "profile"))).isDirectory);
      } finally {
        await vm.writer.close().catch(() => {});
      }
    }
  } finally {
    clearTimeout(timer);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }
    await Promise.all(children.map((child) => child.status));
    await Promise.allSettled(tasks);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("environment launches cannot also be repo preparation", async () => {
  await assert.rejects(
    launchSessionVm({
      workspace: "/nonexistent",
      artifact: "/nonexistent",
      smolvm: "/nonexistent",
      preparationOnly: true,
      environmentOnly: true,
    }),
    /preparation or an environment/,
  );
});
