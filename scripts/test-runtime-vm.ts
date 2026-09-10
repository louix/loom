/** Opt-in VM acceptance test. Prepare tilth first; uses only disposable workspaces. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { startRuntimeMcp } from "../backend/daemon/src/daemon/runtime-mcp.ts";
import {
  launchLocalWorker,
  type WorkerProcess,
} from "../backend/daemon/src/daemon/worker-launch.ts";
import { resolveRuntime } from "../runtime/src/packaged/artifact.ts";
import { checkRuntimeIsolation } from "./runtime-vm-isolation.ts";
const runtime = Deno.args[0] ?? "tilth";
const prepared = await resolveRuntime(runtime);
const scratch = await Deno.realPath(
  await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-accept-" }),
);
const report = [];
let completed = false;
await Deno.writeTextFile(join(scratch, "host-only"), "outside-workspace-sentinel");
try {
  for (const mode of ["close", "parent-eof", "worker-kill", "startup-eof"] as const) {
    console.error(`Testing ${mode}...`);
    const workspace = join(scratch, mode);
    await Deno.mkdir(workspace);
    await Deno.writeTextFile(join(workspace, "code.ts"), "export const before = true;\n");
    await Deno.symlink(join(scratch, "host-only"), join(workspace, "outside-link"));
    if (mode === "close") {
      console.error("Testing guest network and filesystem isolation...");
      report.push(await checkRuntimeIsolation(prepared, workspace, join(scratch, "host-only")));
    }
    let child: WorkerProcess | undefined;
    let input: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let state = "";
    const launching = startRuntimeMcp("tilth", runtime, workspace, (spec) => {
      state = spec.cwd;
      child = launchLocalWorker(spec);
      input = child.input.getWriter();
      const sink = input;
      return {
        ...child,
        input: new WritableStream({
          write: async (chunk) => {
            await sink.write(chunk);
            // The first write is the binding. EOF here exercises daemon death during boot.
            if (mode === "startup-eof") await sink.close();
          },
          close: () => sink.close(),
        }),
      };
    });
    if (mode === "startup-eof") {
      await assert.rejects(launching);
      await assert.rejects(Deno.stat(state), Deno.errors.NotFound);
      report.push({ mode, passed: true });
      continue;
    }
    const worker = await launching;
    try {
      assert.equal(worker.handle.spec.transport, "http");
      const s = worker.handle.spec as { url: string; headers: Record<string, string> };
      let id = 0;
      const rpc = async (method: string, params: unknown = {}) => {
        const r = await fetch(s.url, {
          method: "POST",
          headers: { ...s.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        assert.equal(r.status, 200);
        const frame = await r.json();
        assert.ok(!frame.error);
        return frame.result;
      };
      const read = await rpc("tools/call", {
        name: "tilth_read",
        arguments: { path: join(workspace, "code.ts") },
      });
      assert.match(JSON.stringify(read), /before = true/);
      if (mode === "close") {
        const listed = await rpc("tools/list");
        for (const name of ["tilth_read", "tilth_write", "tilth_search"])
          assert.ok(listed.tools.some((tool: { name: string }) => tool.name === name));
        const text = read.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");
        const anchor = text.match(/\b(1:[a-zA-Z0-9]+)\|/);
        assert.ok(anchor, `Missing hashline anchor: ${text}`);
        const edited = await rpc("tools/call", {
          name: "tilth_write",
          arguments: {
            files: [
              {
                path: join(workspace, "code.ts"),
                mode: "hash",
                edits: [{ start: anchor[1], content: "export const before = false;" }],
              },
            ],
          },
        });
        assert.ok(!edited.isError);
        assert.equal(
          await Deno.readTextFile(join(workspace, "code.ts")),
          "export const before = false;\n",
        );
        const search = await rpc("tools/call", {
          name: "tilth_search",
          arguments: { query: "before", kind: "content", root: workspace },
        });
        assert.ok(!search.isError);
        assert.match(JSON.stringify(search), /before = false/);
      }
      for (const path of [join(scratch, "host-only"), join(workspace, "outside-link")]) {
        const denied = await rpc("tools/call", { name: "tilth_read", arguments: { path } });
        assert.equal(denied.isError, true);
        assert.ok(!JSON.stringify(denied).includes("outside-workspace-sentinel"));
      }
      const write = await rpc("tools/call", {
        name: "tilth_write",
        arguments: {
          files: [
            {
              path: join(workspace, "created.ts"),
              mode: "overwrite",
              content: "export const created = true;\n",
            },
          ],
        },
      });
      assert.ok(!write.isError);
      assert.equal(
        await Deno.readTextFile(join(workspace, "created.ts")),
        "export const created = true;\n",
      );
      if (mode === "parent-eof") await input!.close();
      if (mode === "worker-kill") Deno.kill(worker.pid, "SIGKILL");
      if (mode !== "close") {
        const timer = setTimeout(() => child!.terminate(), 20_000);
        try {
          await worker.exited;
        } finally {
          clearTimeout(timer);
        }
        // Actual parent-death reaping without daemon fallback is exercised by
        // test-session-git-vm.ts. Here automatic cleanup may already remove state.
      }
      await worker.close();
      await assert.rejects(fetch(s.url));
      await assert.rejects(Deno.stat(state), Deno.errors.NotFound);
      report.push({ mode, passed: true });
    } finally {
      await worker.close();
    }
  }
  console.log(JSON.stringify(report, null, 2));
  completed = true;
} finally {
  // Preserve fixtures on failure in case cleanup could not stop a mounted guest.
  if (completed) await Deno.remove(scratch, { recursive: true });
  else console.error(`Acceptance test failed; fixtures retained at ${scratch}`);
}
