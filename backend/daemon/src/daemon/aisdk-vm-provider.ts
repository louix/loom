import { sessionStartupTimeout } from "../../../../core/src/session-environment.ts";
/** Session-only VM routing; discovery/title utilities retain their host worker. */
import { join, resolve } from "node:path";
import type { ConnectorContext } from "@loom/core/connector";
import type {
  AgentProvider,
  CreateSessionOptions,
  SessionRef,
  McpServerHandle,
} from "@loom/core/types";
import { launchSessionVm } from "./session-vm-worker.ts";
import { sessionVmDirectory, stoppedSessionVm } from "./session-vm-state.ts";
import { RemoteWorkerSession } from "./worker-provider.ts";
import { mockLaunchSpec } from "./worker-launch.ts";
const executable = async (name: string) => {
  for (const path of name.includes("/")
    ? [resolve(name)]
    : (Deno.env.get("PATH") ?? "")
        .split(":")
        .filter(Boolean)
        .map((dir) => join(dir, name)))
    try {
      if ((await Deno.stat(path)).isFile) return await Deno.realPath(path);
    } catch {
      /*next candidate*/
    }
  throw new Error(`Executable not found: ${name}`);
};
export const withAisdkVmSessions = async <T extends AgentProvider>(
  base: T,
  ctx: ConnectorContext,
): Promise<T> => {
  const vm = ctx.config.sessionVm!;
  const smolvm = await executable(vm.smolvm);
  const sdk = ctx.config.sdk;
  const defaultEndpoint = {
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    openai: "https://api.openai.com",
    chatgpt: "https://chatgpt.com",
  };
  const endpoint = new URL(ctx.config.baseUrl || defaultEndpoint[sdk ?? "openai"]);
  if (
    endpoint.protocol !== "https:" ||
    (endpoint.port && endpoint.port !== "443") ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("AISDK VM endpoints must use HTTPS port 443");
  if (ctx.search)
    throw new Error(
      "AISDK VM search requires an HTTP MCP mount instead of legacy search credentials",
    );
  if (!ctx.transcript) throw new Error("AISDK VM needs host transcript persistence");
  const start = async (input: CreateSessionOptions | SessionRef, resume: boolean) => {
    const sessionDirectory = sessionVmDirectory(vm.repoRoot, input.sessionId);
    await stoppedSessionVm(vm.repoRoot, input.sessionId);
    const relays: Array<{ port: number; guestPort: number }> = [];
    const servers = (input.mcpServers ?? []).map((server): McpServerHandle => {
      if (server.spec?.transport !== "http")
        throw new Error(
          `MCP ${server.name}: VM sessions require a daemon-managed HTTP or packaged runtime endpoint`,
        );
      const url = new URL(server.spec.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password
      )
        throw new Error("VM MCP endpoints must be daemon-managed loopback HTTP servers");
      if (relays.length >= 32) throw new Error("Too many session MCP endpoints");
      const guestPort = 3130 + relays.length;
      relays.push({ port: Number(url.port), guestPort });
      url.port = String(guestPort);
      return { ...server, spec: { ...server.spec, url: url.toString() } };
    });
    const worker = await launchSessionVm({
      workspace: input.cwd,
      artifact: vm.artifact,
      smolvm,
      sessionDirectory,
      repoRoot: vm.repoRoot,
      mcpRelays: relays,
      ...(vm.extraAllowedHosts ? { extraAllowedHosts: vm.extraAllowedHosts } : {}),
      ...(vm.environment ? { environment: vm.environment } : {}),
      allowRepoPrograms: vm.allowRepoPrograms,
      providerHosts: [endpoint.hostname],
      auth: {},
    });
    try {
      const { session } = await RemoteWorkerSession.connect(
        input.sessionId,
        ctx.id,
        mockLaunchSpec(input.cwd),
        () => worker,
        { startupMs: sessionStartupTimeout(vm.environment), requestMs: 120_000 },
        {
          connector: sdk === "google" ? "@loom/connector-gemini" : "@loom/connector-generic",
          config: {
            model: ctx.config.model ?? "",
            models: ctx.config.models ?? [],
            baseUrl: ctx.config.baseUrl ?? "",
            apiKey: ctx.config.apiKey ?? "",
            sdk: sdk ?? "openai",
            includeUsage: ctx.config.includeUsage ?? true,
            modelContext: ctx.config.modelContext ?? {},
            maxSteps: ctx.config.maxSteps ?? 50,
            promptCacheTtl: ctx.config.promptCacheTtl ?? "",
          },
          ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
        },
      );
      await session.attachTranscript(ctx.transcript!);
      const options = { ...input, mcpServers: servers };
      await session.start(
        resume
          ? { method: "resume", args: [options as SessionRef] }
          : { method: "create", args: [options as CreateSessionOptions] },
      );
      await Deno.writeTextFile(join(sessionDirectory, "aisdk"), "1", { mode: 0o600 });
      return session;
    } catch (error) {
      worker.terminate();
      await worker.cleanup?.();
      throw error;
    }
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "createSession")
        return (options: CreateSessionOptions) =>
          options.oneShot ? target.createSession(options) : start(options, false);
      if (prop === "resumeSession") return (ref: SessionRef) => start(ref, true);
      if (prop === "close")
        return async () => {
          await target.close?.();
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
