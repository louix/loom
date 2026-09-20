import {
  attachDiskTemplates,
  retainDiskTemplates,
} from "../../../../runtime/src/packaged/disk-templates.ts";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { resolveRuntime, requireVmHost } from "../../../../runtime/src/packaged/artifact.ts";
import { vmMaintenanceLock } from "../../../../runtime/src/packaged/maintenance.ts";
import { vmArguments, reapVm, type VmBinding } from "../../../../runtime/src/packaged/vm.ts";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import { launchLocalWorker, mockLaunchSpec, type WorkerLauncher } from "./worker-launch.ts";
import type { ManagedMcp } from "./mcp-worker.ts";
import { workspaceMounts } from "../../../../runtime/src/packaged/workspace.ts";
import { findRepoRoot } from "@loom/core/paths";
import { registerVm, type VmOwner } from "../../../../runtime/src/session-vm/inventory.ts";
import { sessionCloneRoot } from "./session-vm-state.ts";

export interface McpVmIdentity {
  sessionId: string;
  provider: string;
  repo?: string | undefined;
}

/**
 * workspaceMounts runs Git in the workspace. A session clone is agent-written, so host
 * Git never opens it: the tool VM gets the clone and nothing of the repository.
 */
export const mcpWorkspaceMounts = async (cwd: string, repo?: string): Promise<string[]> =>
  repo !== undefined && cwd.startsWith(sessionCloneRoot(repo) + "/")
    ? [cwd]
    : await workspaceMounts(cwd);

const startRuntimeMcpOwned = async (
  name: string,
  runtime: string,
  workspace: string,
  launch: WorkerLauncher = launchLocalWorker,
  identity?: McpVmIdentity,
): Promise<ManagedMcp> => {
  requireVmHost();
  const { lock, manifest } = await resolveRuntime(runtime);
  const cwd = await Deno.realPath(resolve(workspace));
  if (!(await Deno.stat(cwd)).isDirectory) throw new Error("VM workspace must be a directory");
  const mounts = await mcpWorkspaceMounts(cwd, identity?.repo);
  const state = await Deno.realPath(await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" }));
  const binding: VmBinding = {
    version: 1,
    artifact: lock.artifact,
    smolvm: lock.smolvm,
    manifest,
    workspace: cwd,
    mounts,
    state,
    token: crypto.randomUUID() + crypto.randomUUID(),
  };
  let owner: VmOwner | undefined;
  let child: ReturnType<WorkerLauncher>;
  try {
    let repo = identity?.repo;
    if (!repo) {
      try {
        repo = findRepoRoot(cwd);
      } catch {
        repo = cwd;
      }
    }
    const now = new Date().toISOString();
    owner = await registerVm({
      version: 1,
      id: crypto.randomUUID(),
      repo,
      kind: "mcp",
      sessionId: identity?.sessionId ?? null,
      provider: identity?.provider ?? null,
      workload: name,
      state: "starting",
      createdAt: now,
      stoppedAt: null,
      observedAt: now,
      source: "owner",
      error: null,
      paths: {
        workspace: cwd,
        runtime: lock.artifact,
        state,
        session: null,
        profile: null,
        backend: null,
        base: null,
      },
    });
    vmArguments(binding);
    for (const dir of ["home", "cache", "data", "config"])
      await Deno.mkdir(join(state, dir), { mode: 0o700 });
    await attachDiskTemplates(state, lock.smolvm);
    const base = mockLaunchSpec(state);
    child = launch({
      ...base,
      processGroup: true,
      entrypoint: fileURLToPath(
        new URL("../../../../runtime/src/packaged/main.ts", import.meta.url),
      ),
      permissions: {
        read: [state, lock.artifact, ...(binding.mounts ?? [cwd])],
        write: [state],
        env: [],
        run: [lock.smolvm],
        net: ["127.0.0.1:0"],
      },
    });
  } catch (error) {
    try {
      await Deno.remove(state, { recursive: true });
      await owner?.finish();
    } catch (cleanupError) {
      await owner?.finish(cleanupError);
      throw cleanupError;
    }
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
        await owner?.finish();
      }
    })().catch(async (error) => {
      await owner?.finish(error);
      throw error;
    }));
  let ready = false;
  owner!.serve(close, async () => ({ state: ready ? "running" : "starting" }));
  // Supervisor death revokes the session capability and reaps its VM.
  void child.exited
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
    if (closing) {
      await closing;
      throw new Error("MCP VM stopped during startup");
    }
    ready = true;
    await owner!.update({ state: "running" });
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

export const startRuntimeMcp = async (...args: Parameters<typeof startRuntimeMcpOwned>) => {
  const lease = (await vmMaintenanceLock())!;
  try {
    const worker = await startRuntimeMcpOwned(...args);
    void worker.exited.then(
      () => lease.close(),
      () => lease.close(),
    );
    return worker;
  } catch (error) {
    lease.close();
    throw error;
  }
};
