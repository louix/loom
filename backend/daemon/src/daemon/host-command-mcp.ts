/** A host command MCP server one VM session opted into: run on the host, served on loopback. */
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  HOST_COMMAND_WORKER_VERSION,
  MCP_REQUEST_TIMEOUT_DEFAULT_MS,
} from "../../../../core/src/mcp-worker.ts";
import { PROCESS_GROUP_GRACE_MS } from "@loom/core/process-group";
import type { McpServerHandle } from "@loom/core/types";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import { launchLocalWorker, mockLaunchSpec, type WorkerLauncher } from "./worker-launch.ts";
import type { ManagedMcp } from "./mcp-worker.ts";
import { sessionCloneRoot } from "./session-vm-state.ts";

/** The worker's own bootstrap allowance, on top of the command's first response. */
const STARTUP_MARGIN_ms = 10_000;
/** The HTTP relay's response cap (runtime/src/mcp/main.ts): a browser's inline screenshot fits. */
const MAX_SERVER_FRAME_BYTES = 8 * 1024 * 1024;

type StdioSpec = Extract<McpServerHandle["spec"], { transport: "stdio" }> &
  Pick<McpServerHandle, "requestTimeoutMs">;

/**
 * Where a relayed command starts without a configured cwd: the session's host worktree, or
 * the user's home when there is none — a private clone is the guest's, not a host worktree.
 */
export const hostCommandCwd = async (cwd: string, repo: string | undefined): Promise<string> => {
  if (repo !== undefined && cwd.startsWith(sessionCloneRoot(repo) + "/")) return homedir();
  try {
    if ((await Deno.stat(cwd)).isDirectory) return cwd;
  } catch {
    // No host worktree.
  }
  return homedir();
};

export const startHostCommandMcp = async (
  name: string,
  spec: StdioSpec,
  cwd: string,
  launch: WorkerLauncher = launchLocalWorker,
): Promise<ManagedMcp> => {
  const requestTimeoutMs = spec.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_DEFAULT_MS;
  const child = launch({
    ...mockLaunchSpec("/"),
    // exitWorker watches its group with ps, Deno granting /proc only to --allow-all:
    // without it the command would get a quarter of a second to stop, not the grace.
    env: { PATH: Deno.env.get("PATH") ?? "" },
    entrypoint: fileURLToPath(
      new URL("../../../../runtime/src/mcp/host-command.ts", import.meta.url),
    ),
    processGroup: true,
    permissions: {
      read: [],
      write: [],
      env: [],
      // The command is unconfined and inherits the daemon's environment: Deno refuses
      // LD_* and DYLD_* variables to a child under anything short of a blanket grant.
      run: true,
      net: ["127.0.0.1:0"],
    },
  });
  const writer = new FrameWriter(child.input);
  const frames = readFrames(child.output, (value) => {
    if (!value || typeof value !== "object") throw new Error("invalid host command worker frame");
    return value as { kind?: unknown; version?: unknown; port?: unknown; message?: unknown };
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      // EOF first: the worker ends its own group, SIGTERM then SIGKILL after the grace.
      const kill = setTimeout(() => child.terminate(), PROCESS_GROUP_GRACE_MS + 1000);
      try {
        await writer.close().catch(() => {});
        await child.exited.catch(() => {});
      } finally {
        clearTimeout(kill);
        child.terminate();
        await frames.return(undefined).catch(() => {});
        await child.cleanup?.();
      }
    })());
  const token = crypto.randomUUID() + crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([
      (async () => {
        const hello = await frames.next();
        if (
          hello.done ||
          hello.value.kind !== "hello" ||
          hello.value.version !== HOST_COMMAND_WORKER_VERSION
        )
          throw new Error("host command worker version mismatch");
        await writer.send({
          version: HOST_COMMAND_WORKER_VERSION,
          command: spec.command,
          args: spec.args ?? [],
          env: { ...Deno.env.toObject(), ...spec.env },
          cwd,
          token,
          requestTimeoutMs,
          maxServerFrameBytes: MAX_SERVER_FRAME_BYTES,
        });
        const ready = await frames.next();
        if (!ready.done && ready.value.kind === "error")
          throw new Error(String(ready.value.message));
        if (
          ready.done ||
          ready.value.kind !== "ready" ||
          ready.value.version !== HOST_COMMAND_WORKER_VERSION ||
          !Number.isInteger(ready.value.port) ||
          Number(ready.value.port) < 1 ||
          Number(ready.value.port) > 65535
        )
          throw new Error("invalid host command worker endpoint");
        return Number(ready.value.port);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out waiting for it to initialize")),
          requestTimeoutMs + STARTUP_MARGIN_ms,
        );
      }),
    ]);
    return {
      handle: {
        name,
        spec: {
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
      pid: child.pid,
      exited: child.exited,
      close,
    };
  } catch (error) {
    await close();
    throw new Error(
      `MCP server ${name}: host command ${spec.command} failed to start for the VM session: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
};
