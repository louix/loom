/** Daemon-owned external MCP lifetime, tied to a single connector session. */
import type { ConnectorContext, CreateProvider } from "@loom/core/connector";
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  McpServerHandle,
  SessionRef,
} from "@loom/core/types";
import { mcpToolPreferences } from "@loom/runtime/instructions";
import { startMcpWorker, type ManagedMcp } from "./mcp-worker.ts";
import { startRuntimeMcp } from "./runtime-mcp.ts";

export const withExternalMcp = async (
  create: CreateProvider,
  context: ConnectorContext,
  start = startMcpWorker,
  startRuntime = startRuntimeMcp,
  allowRepoPrograms = false,
): Promise<AgentProvider> => {
  const base = await create(context);
  const open = async (
    input: CreateSessionOptions | SessionRef,
    resume: boolean,
  ): Promise<AgentSession> => {
    const workers: ManagedMcp[] = [];
    const cleanup = async () => {
      const results = await Promise.allSettled(workers.map((w) => w.close()));
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (errors.length)
        throw new AggregateError(
          errors,
          "MCP cleanup failed: " +
            errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; "),
        );
    };
    try {
      const mount = async (handle: McpServerHandle): Promise<McpServerHandle> => {
        if (handle.spec.transport === "stdio") return handle;
        const worker =
          handle.spec.transport === "runtime"
            ? await startRuntime(
                handle.name,
                handle.spec.runtime,
                input.cwd,
                undefined,
                undefined,
                allowRepoPrograms,
              )
            : await start(handle.name, handle.spec);
        workers.push(worker);
        return { ...handle, spec: worker.handle.spec };
      };
      const servers: McpServerHandle[] = [];
      const oneShot = "oneShot" in input && input.oneShot;
      if (!oneShot) for (const handle of input.mcpServers ?? []) servers.push(await mount(handle));
      const provider = base;
      const options = {
        ...input,
        mcpServers: servers,
        systemPromptAppend: [input.systemPromptAppend, mcpToolPreferences(servers)]
          .filter(Boolean)
          .join("\n\n"),
      };
      const session = resume
        ? await provider.resumeSession(options as SessionRef)
        : await provider.createSession(options as CreateSessionOptions);
      if (workers.length === 0) return session;
      let closing: Promise<void> | undefined;
      let failed = false;
      const close = (): Promise<void> =>
        (closing ??= (async () => {
          try {
            await session.close();
          } finally {
            await cleanup();
          }
        })().catch((error) => {
          closing = undefined;
          throw error;
        }));
      // Unexpected MCP death closes only its owning session. Never replay a tool call.
      const died = () => {
        if (!closing) failed = true;
        return close();
      };
      for (const worker of workers) void worker.exited.then(died, died).catch(() => {});
      return new Proxy(session, {
        get(target, prop) {
          if (prop === "close") return close;
          if (prop === "events")
            return async function* () {
              try {
                yield* target.events();
                if (failed)
                  yield {
                    type: "error",
                    sessionId: target.id,
                    ts: Date.now(),
                    fatal: true,
                    message: "External MCP worker exited; resume the session to reconnect.",
                  };
              } finally {
                await close();
              }
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "createSession") return (opts: CreateSessionOptions) => open(opts, false);
      if (prop === "resumeSession") return (ref: SessionRef) => open(ref, true);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
