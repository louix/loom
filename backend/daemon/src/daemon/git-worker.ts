/** Host-selected Git capability, kept out of the VM and connector workers. */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { discoverGitWorktree } from "../../../../runtime/src/git-bridge/layout.ts";
import { prepareGitBridge } from "../../../../runtime/src/git-bridge/service.ts";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import { launchLocalWorker, mockLaunchSpec } from "./worker-launch.ts";

export const startSessionGit = async (workspace: string, state: string, artifact: string) => {
  const layout = await discoverGitWorktree(workspace);
  if (!layout) return undefined;
  try {
    if (
      (await Deno.readTextFile(join(artifact, "git-bridge-version"))).trim() !== "1" ||
      !(await Deno.stat(join(artifact, "bin/git"))).isFile
    )
      throw new Error("missing shim");
  } catch {
    throw new Error(
      "Prepared runtime lacks the Git bridge shim. Run loom runtime update for this runtime.",
    );
  }
  let git = "";
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!directory) continue;
    const path = join(directory, "git");
    try {
      if ((await Deno.stat(path)).isFile) {
        git = await Deno.realPath(path);
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  if (!git) throw new Error("Host Git is required for VM worktree sessions; install Git on PATH");
  const prepared = await prepareGitBridge({ workspace, state, git, ...layout });
  const socket = join(prepared.dir, "git.sock");
  const child = launchLocalWorker({
    ...mockLaunchSpec(state),
    processGroup: true,
    entrypoint: fileURLToPath(
      new URL("../../../../runtime/src/git-bridge/worker.ts", import.meta.url),
    ),
    permissions: {
      read: [state, workspace, git, layout.gitDir, layout.commonDir],
      write: [state],
      run: [git],
      env: [],
      net: [`unix:${socket}`],
    },
  });
  const writer = new FrameWriter(child.input);
  const frames = readFrames(
    child.output,
    (v) => v as { kind: string; version: number; socket?: string; message?: string },
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const timer = setTimeout(() => child.terminate(), 7000);
      try {
        await writer.close().catch(() => {});
        await child.exited.catch(() => {});
      } finally {
        clearTimeout(timer);
        child.terminate();
        await frames.return(undefined).catch(() => {});
      }
    })());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const hello = await frames.next();
        if (hello.value?.kind !== "hello" || hello.value.version !== 1)
          throw new Error("Git worker version mismatch");
        await writer.send(prepared);
        const ready = await frames.next();
        if (ready.value?.kind === "error")
          throw new Error(ready.value.message ?? "Git bridge startup failed");
        if (
          ready.value?.kind !== "ready" ||
          ready.value.version !== 1 ||
          ready.value.socket !== socket
        )
          throw new Error("Invalid Git worker endpoint");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Git bridge startup timed out")), 10_000);
      }),
    ]);
    return { socket, close, exited: child.exited, pid: child.pid };
  } catch (error) {
    await close();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
