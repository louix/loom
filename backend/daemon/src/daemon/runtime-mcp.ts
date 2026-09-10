import {
  attachDiskTemplates,
  retainDiskTemplates,
} from "../../../../runtime/src/packaged/disk-templates.ts";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { resolveRuntime, requireVmHost } from "../../../../runtime/src/packaged/artifact.ts";
import { vmArguments, reapVm, type VmBinding } from "../../../../runtime/src/packaged/vm.ts";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import { launchLocalWorker, mockLaunchSpec, type WorkerLauncher } from "./worker-launch.ts";
import type { ManagedMcp } from "./mcp-worker.ts";
import { startSessionGit } from "./git-worker.ts";

export const startRuntimeMcp = async (
  name: string,
  runtime: string,
  workspace: string,
  launch: WorkerLauncher = launchLocalWorker,
  startGit = startSessionGit,
  allowRepoPrograms = false,
): Promise<ManagedMcp> => {
  requireVmHost();
  const { lock, manifest } = await resolveRuntime(runtime);
  const cwd = await Deno.realPath(resolve(workspace));
  if (!(await Deno.stat(cwd)).isDirectory) throw new Error("VM workspace must be a directory");
  const state = await Deno.realPath(await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" }));
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
  let git: Awaited<ReturnType<typeof startSessionGit>>;
  try {
    vmArguments(binding);
    for (const dir of ["home", "cache", "data", "config"])
      await Deno.mkdir(join(state, dir), { mode: 0o700 });
    await attachDiskTemplates(state, lock.smolvm);
    git = await startGit(cwd, state, lock.artifact, allowRepoPrograms);
    if (git) binding.gitSocket = git.socket;
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
    await git?.close();
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
        try {
          await reapVm(binding);
        } finally {
          await git?.close();
        }
        await Deno.remove(state, { recursive: true });
      }
    })());
  // Either worker dying revokes the entire session capability; do not leave a
  // persistent VM or native Git child behind after supervisor SIGKILL.
  void child.exited
    .then(
      () => close(),
      () => close(),
    )
    .catch(() => {});
  void git?.exited
    .then(
      () => close(),
      () => close(),
    )
    .catch(() => {});
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
    await retainDiskTemplates(state, lock.smolvm);
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
