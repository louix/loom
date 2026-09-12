import { sessionStartupTimeout } from "../../../../core/src/session-environment.ts";
import { refreshOnAuthFailure } from "./auth-failure-refresh.ts";
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
import { ClaudeAuthOwner } from "./claude-auth.ts";
import { createSessionVmLauncher, sessionVmGeneration } from "./session-vm-worker.ts";
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
export const withClaudeVmSessions = async <T extends AgentProvider>(
  base: T,
  ctx: ConnectorContext,
): Promise<T> => {
  const vm = ctx.config.sessionVm!;
  const launches = createSessionVmLauncher();
  const smolvm = await executable(vm.smolvm);
  const cli = await executable(ctx.config.cliPath || "claude");
  const profile =
    ctx.config.configDir || Deno.env.get("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const oauth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
  const owner =
    apiKey || oauth
      ? undefined
      : new ClaudeAuthOwner({
          profile,
          cli,
          report: (code) => ctx.logger.warn("Claude VM authentication", { code }),
        });
  const start = async (input: CreateSessionOptions | SessionRef, resume: boolean) => {
    const sessionDirectory = sessionVmDirectory(vm.repoRoot, input.sessionId);
    await stoppedSessionVm(vm.repoRoot, input.sessionId);
    if (resume) {
      const ref = (input as SessionRef).providerRef;
      if (!/^[0-9a-f-]{36}$/i.test(ref)) throw new Error("Invalid Claude resume reference");
      try {
        await Deno.stat(join(sessionDirectory, "profile/projects/loom-session", `${ref}.jsonl`));
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
      ...(owner
        ? { authOwner: owner }
        : { auth: apiKey ? { ANTHROPIC_API_KEY: apiKey } : { CLAUDE_CODE_OAUTH_TOKEN: oauth! } }),
    });
    try {
      const { session } = await RemoteWorkerSession.connect(
        input.sessionId,
        ctx.id,
        mockLaunchSpec(input.cwd),
        () => worker,
        { startupMs: sessionStartupTimeout(vm.environment), requestMs: 120_000 },
        {
          connector: "@loom/connector-claude",
          config: {
            cliPath: "",
            configDir: "/tmp/loom-home/.claude",
            promptCacheTtl: ctx.config.promptCacheTtl ?? "",
          },
          ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
        },
      );
      const options = { ...input, mcpServers: servers };
      session.onStartupProgress = (message) => ctx.onStartupProgress?.(input.sessionId, message);
      await session.start(
        resume
          ? { method: "resume", args: [options as SessionRef] }
          : { method: "create", args: [options as CreateSessionOptions] },
      );
      ctx.onVmStarted?.(input.sessionId, await sessionVmGeneration(worker.binding.state));
      ctx.onStartupProgress?.(input.sessionId, "Session ready.");
      return owner ? refreshOnAuthFailure(session, () => owner.current(true)) : session;
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
