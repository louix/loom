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
import { startOAuthMcp } from "./mcp-oauth-owner.ts";
import type { LoomConfig } from "../config/config.ts";
import { startRuntimeMcp } from "./runtime-mcp.ts";

export const withExternalMcp = async (
  create: CreateProvider,
  context: ConnectorContext,
  start = startMcpWorker,
  startRuntime = startRuntimeMcp,
  repoRoot?: string,
  httpDefinitions: LoomConfig["httpMcp"] = [],
): Promise<AgentProvider> => {
  const base = await create(context);
  const open = async (
    input: CreateSessionOptions | SessionRef,
    resume: boolean,
  ): Promise<AgentSession> => {
    const workers: ManagedMcp[] = [];
    const notices: string[] = [];
    let wake: (() => void) | undefined;
    const notice = (message: string) => {
      if (!notices.includes(message)) notices.push(message);
      wake?.();
    };
    // Reject incompatible selections before starting any external MCP workers.
    if (context.config.sessionVm && !("oneShot" in input && input.oneShot)) {
      const host = input.mcpServers?.find((h) => h.spec.transport === "stdio");
      if (host)
        throw new Error(
          `Host tool ${host.name} cannot be used by a VM agent; select vm_tools or remote_tools instead.`,
        );
    }
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
        const definition = httpDefinitions.find(
          (m) =>
            m.name === handle.name && handle.spec.transport === "http" && m.url === handle.spec.url,
        );
        let worker: ManagedMcp;
        if (handle.spec.transport === "runtime")
          worker = await startRuntime(handle.name, handle.spec.runtime, input.cwd, undefined, {
            sessionId: input.sessionId,
            provider: context.id,
            repo: repoRoot ?? context.config.sessionVm?.repoRoot,
            ...(handle.spec.grants ? { grants: handle.spec.grants } : {}),
          });
        else if (definition?.oauth)
          worker = await startOAuthMcp(
            handle.name,
            handle.spec.url,
            definition.oauth,
            start,
            notice,
          );
        else worker = await start(handle.name, handle.spec);
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
              const events = target.events()[Symbol.asyncIterator]();
              try {
                let next = events.next();
                void next.catch(() => {});
                while (true) {
                  if (notices.length) {
                    yield {
                      type: "error" as const,
                      sessionId: target.id,
                      ts: Date.now(),
                      fatal: false,
                      message: notices.shift()!,
                    };
                    continue;
                  }
                  const result = await Promise.race([
                    next.then((event) => ({ event })),
                    new Promise<{ notice: true }>((resolve) => {
                      wake = () => resolve({ notice: true });
                    }),
                  ]);
                  wake = undefined;
                  if ("notice" in result) continue;
                  if (result.event.done) break;
                  yield result.event.value;
                  next = events.next();
                  void next.catch(() => {});
                }
                if (failed)
                  yield {
                    type: "error",
                    sessionId: target.id,
                    ts: Date.now(),
                    fatal: true,
                    message: "External MCP worker exited; resume the session to reconnect.",
                  };
              } finally {
                wake = undefined;
                try {
                  await close();
                } finally {
                  await events.return?.();
                }
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
