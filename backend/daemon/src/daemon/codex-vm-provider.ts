import { sessionStartupTimeout } from "../../../../core/src/session-environment.ts";
/** Session-only VM routing; discovery/title utilities retain their host worker. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConnectorContext } from "@loom/core/connector";
import type {
  AgentProvider,
  CreateSessionOptions,
  SessionRef,
  McpServerHandle,
} from "@loom/core/types";
import { CodexAuthOwner } from "./codex-auth.ts";
import { createSessionVmLauncher } from "./session-vm-worker.ts";
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
export const withCodexVmSessions = async <T extends AgentProvider>(
  base: T,
  ctx: ConnectorContext,
): Promise<T> => {
  const vm = ctx.config.sessionVm!;
  const launches = createSessionVmLauncher();
  const smolvm = await executable(vm.smolvm);
  const cli = await executable(ctx.config.codexCliPath || "codex");
  const profile =
    ctx.config.configDir ||
    (ctx.config.authPath ? resolve(ctx.config.authPath, "..") : Deno.env.get("CODEX_HOME")) ||
    join(homedir(), ".codex");
  const owner = new CodexAuthOwner({
    profile,
    cli,
    report: (code) => ctx.logger.warn("Codex VM authentication", { code }),
  });
  const start = async (input: CreateSessionOptions | SessionRef, resume: boolean) => {
    const sessionDirectory = sessionVmDirectory(vm.repoRoot, input.sessionId);
    await stoppedSessionVm(vm.repoRoot, input.sessionId);
    if (resume) {
      const ref = (input as SessionRef).providerRef;
      if (!/^[0-9a-f-]{36}$/i.test(ref)) throw new Error("Invalid Codex resume reference");
      try {
        if ((await Deno.readTextFile(join(sessionDirectory, "codex-ref"))) !== ref)
          throw new Error("different thread");
        await Deno.stat(join(sessionDirectory, "profile/sessions"));
      } catch {
        throw new Error(
          "No saved VM history for this session; host-worker sessions cannot yet be imported into a VM",
        );
      }
    }
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
    const worker = await launches.launch({
      onProgress: (message) => ctx.onStartupProgress?.(input.sessionId, message),
      workspace: input.cwd,
      artifact: vm.artifact,
      smolvm,
      sessionDirectory,
      repoRoot: vm.repoRoot,
      mcpRelays: relays,
      ...(vm.extraAllowedHosts ? { extraAllowedHosts: vm.extraAllowedHosts } : {}),
      ...(vm.environment ? { environment: vm.environment } : {}),
      authOwner: owner,
      providerHosts: ["chatgpt.com"],
    });
    try {
      const { session } = await RemoteWorkerSession.connect(
        input.sessionId,
        ctx.id,
        mockLaunchSpec(input.cwd),
        () => worker,
        { startupMs: sessionStartupTimeout(vm.environment), requestMs: 120_000 },
        {
          connector: "@loom/connector-chatgpt",
          config: {
            codexCliPath: "codex",
            configDir: "/tmp/loom-home/.codex",
            sdk: "chatgpt",
            model: ctx.config.model ?? "",
            models: ctx.config.models ?? [],
            codexBuiltinWebSearch: ctx.config.codexBuiltinWebSearch ?? false,
          },
          ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
        },
      );
      const options = { ...input, mcpServers: servers };
      await session.start(
        resume
          ? { method: "resume", args: [options as SessionRef] }
          : { method: "create", args: [options as CreateSessionOptions] },
      );
      await Deno.writeTextFile(join(sessionDirectory, "codex-ref"), session.providerRef!, {
        mode: 0o600,
      });
      ctx.onStartupProgress?.(input.sessionId, "Session ready.");
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
          await launches.close();
          await owner?.close();
          await target.close?.();
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
