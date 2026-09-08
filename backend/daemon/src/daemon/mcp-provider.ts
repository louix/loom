/** Daemon-owned external MCP lifetime, tied to a single connector session. */
import type { ConnectorContext, CreateProvider } from "@loom/core/connector";
import type {
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  McpServerHandle,
  SessionRef,
} from "@loom/core/types";
import { isClaudeId } from "@loom/core/provider-id";
import { startMcpWorker, type ManagedMcp } from "./mcp-worker.ts";

export const withExternalMcp = async (
  create: CreateProvider,
  context: ConnectorContext,
  start = startMcpWorker,
): Promise<AgentProvider> => {
  const { search, ...withoutSearch } = context;
  const kagi = search?.backend === "kagi" ? search : undefined;
  // Catalog/title providers never receive an external MCP credential.
  const baseContext: ConnectorContext = kagi ? withoutSearch : context;
  const base = await create(baseContext);
  const open = async (
    input: CreateSessionOptions | SessionRef,
    resume: boolean,
  ): Promise<AgentSession> => {
    const workers: ManagedMcp[] = [];
    const cleanup = async () => {
      await Promise.allSettled(workers.map((w) => w.close()));
    };
    try {
      const mount = async (handle: McpServerHandle): Promise<McpServerHandle> => {
        if (handle.spec.transport !== "http") return handle;
        const worker = await start(handle.name, handle.spec);
        workers.push(worker);
        return worker.handle;
      };
      const servers: McpServerHandle[] = [];
      const oneShot = "oneShot" in input && input.oneShot;
      if (!oneShot) for (const handle of input.mcpServers ?? []) servers.push(await mount(handle));
      let scopedContext = baseContext;
      if (kagi && !oneShot) {
        const handle = await mount({
          name: "kagi",
          spec: {
            transport: "http",
            url: `${(kagi.apiBase || "https://mcp.kagi.com").replace(/\/$/, "")}/mcp`,
            headers: { Authorization: `Bearer ${kagi.apiKey}` },
          },
        });
        if (handle.spec.transport !== "http") throw new Error("invalid Kagi worker handle");
        if (isClaudeId(context.id)) {
          if (servers.some((s) => s.name === "kagi"))
            throw new Error("Kagi MCP name is already configured");
          servers.push(handle);
        } else {
          scopedContext = {
            ...baseContext,
            search: {
              ...kagi,
              apiBase: handle.spec.url.replace(/\/mcp$/, ""),
              apiKey: handle.spec.headers!.Authorization!.replace(/^Bearer /, ""),
            },
          };
        }
      }
      const provider = scopedContext === baseContext ? base : await create(scopedContext);
      const session = resume
        ? await provider.resumeSession({ ...input, mcpServers: servers } as SessionRef)
        : await provider.createSession({ ...input, mcpServers: servers } as CreateSessionOptions);
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
        })());
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
