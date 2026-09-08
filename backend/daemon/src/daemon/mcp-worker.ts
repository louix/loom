import { fileURLToPath } from "node:url";
import { MCP_WORKER_VERSION, decodeMcpBinding } from "../../../../core/src/mcp-worker.ts";
import type { McpServerHandle } from "@loom/core/types";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import {
  launchLocalWorker,
  mockLaunchSpec,
  type WorkerLauncher,
  type WorkerLaunchSpec,
} from "./worker-launch.ts";

type HttpSpec = Extract<McpServerHandle["spec"], { transport: "http" }>;

/** Network authority is chosen before launch; initialization cannot enlarge it. */
export const mcpWorkerSpec = (url: string): WorkerLaunchSpec => {
  const endpoint = new URL(url);
  decodeMcpBinding({ version: MCP_WORKER_VERSION, url, headers: {}, token: "x".repeat(32) });
  const spec = mockLaunchSpec("/");
  return {
    ...spec,
    entrypoint: fileURLToPath(new URL("../../../../runtime/src/mcp/main.ts", import.meta.url)),
    permissions: {
      read: [],
      write: [],
      env: [],
      run: [],
      net: [
        "127.0.0.1:0",
        `${endpoint.hostname}:${endpoint.port || (endpoint.protocol === "https:" ? "443" : "80")}`,
      ],
    },
  };
};

export interface ManagedMcp {
  handle: McpServerHandle;
  pid: number;
  exited: Promise<unknown>;
  close(): Promise<void>;
}

export const startMcpWorker = async (
  name: string,
  spec: HttpSpec,
  launch: WorkerLauncher = launchLocalWorker,
): Promise<ManagedMcp> => {
  const child = launch(mcpWorkerSpec(spec.url));
  const writer = new FrameWriter(child.input);
  const frames = readFrames(child.output, (value) => {
    if (!value || typeof value !== "object") throw new Error("invalid MCP worker frame");
    return value as Record<string, unknown>;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const kill = setTimeout(() => child.terminate(), 1000);
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
          hello.value.version !== MCP_WORKER_VERSION
        )
          throw new Error("MCP worker version mismatch");
        await writer.send({
          version: MCP_WORKER_VERSION,
          url: spec.url,
          headers: spec.headers ?? {},
          token,
        });
        const ready = await frames.next();
        if (
          ready.done ||
          ready.value.kind !== "ready" ||
          ready.value.version !== MCP_WORKER_VERSION ||
          !Number.isInteger(ready.value.port) ||
          Number(ready.value.port) < 1 ||
          Number(ready.value.port) > 65535
        )
          throw new Error("invalid MCP worker endpoint");
        return Number(ready.value.port);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP worker startup timed out")), 10_000);
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
  } catch {
    await close();
    throw new Error("External MCP worker failed to start");
  } finally {
    if (timer) clearTimeout(timer);
  }
};
