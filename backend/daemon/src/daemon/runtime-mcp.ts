import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { resolveRuntime } from "../../../../runtime/src/packaged/artifact.ts";
import { vmArguments, reapVm, type VmBinding } from "../../../../runtime/src/packaged/vm.ts";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import { launchLocalWorker, mockLaunchSpec, type WorkerLauncher } from "./worker-launch.ts";
import type { ManagedMcp } from "./mcp-worker.ts";

export const startRuntimeMcp = async (
  name: string,
  runtime: string,
  workspace: string,
  launch: WorkerLauncher = launchLocalWorker,
): Promise<ManagedMcp> => {
  if (Deno.build.os !== "linux")
    throw new Error("Packaged MCP VMs currently require Linux with KVM");
  const { lock, manifest } = await resolveRuntime(runtime);
  const cwd = resolve(workspace);
  if (!(await Deno.stat(cwd)).isDirectory) throw new Error("VM workspace must be a directory");
  const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" });
  const binding: VmBinding = {
    version: 1,
    artifact: lock.artifact,
    smolvm: lock.smolvm,
    manifest,
    workspace: cwd,
    state,
    token: crypto.randomUUID() + crypto.randomUUID(),
  };
  let child: ReturnType<WorkerLauncher>;
  try {
    vmArguments(binding);
    // A symlink to / or /tmp must not bypass mount exclusions or expose the supervisor.
    vmArguments({ ...binding, workspace: await Deno.realPath(cwd) });
    for (const dir of ["home", "cache", "data", "config"])
      await Deno.mkdir(join(state, dir), { mode: 0o700 });
    const base = mockLaunchSpec(state);
    child = launch({
      ...base,
      processGroup: true,
      entrypoint: fileURLToPath(
        new URL("../../../../runtime/src/packaged/main.ts", import.meta.url),
      ),
      permissions: {
        read: [state, lock.artifact, cwd],
        write: [state],
        env: [],
        run: [lock.smolvm],
        net: ["127.0.0.1:0"],
      },
    });
  } catch (error) {
    await Deno.remove(state, { recursive: true });
    throw error;
  }
  const writer = new FrameWriter(child.input);
  const frames = readFrames(
    child.output,
    (v) => v as { kind: string; version: number; port?: number; message?: string },
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const kill = setTimeout(() => child.terminate(), 15_000);
      try {
        await writer.close().catch(() => {});
        await child.exited.catch(() => {});
      } finally {
        clearTimeout(kill);
        child.terminate();
        await frames.return(undefined).catch(() => {});
        // Covers SIGKILL/crash of the Deno supervisor as well as normal cleanup.
        await reapVm(binding);
        await Deno.remove(state, { recursive: true });
      }
    })());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([
      (async () => {
        const hello = await frames.next();
        if (hello.done || hello.value.kind !== "hello" || hello.value.version !== 1)
          throw new Error("VM worker version mismatch");
        await writer.send(binding);
        const ready = await frames.next();
        if (ready.value?.kind === "error")
          throw new Error(ready.value.message ?? "VM startup failed");
        if (
          ready.done ||
          ready.value.kind !== "ready" ||
          ready.value.version !== 1 ||
          !Number.isInteger(ready.value.port) ||
          ready.value.port! < 1 ||
          ready.value.port! > 65535
        )
          throw new Error("Invalid VM worker endpoint");
        return ready.value.port!;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Packaged MCP startup timed out; check smolvm and /dev/kvm")),
          75_000,
        );
      }),
    ]);
    return {
      handle: {
        name,
        spec: {
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${binding.token}` },
        },
      },
      pid: child.pid,
      exited: child.exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
