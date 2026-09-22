import { startWorker, signalOf } from "./startup.ts";
import { sessionStartupTimeout } from "../../../../core/src/session-environment.ts";
import { refreshOnAuthFailure } from "./auth-failure-refresh.ts";
/** Session-only VM routing; discovery/title utilities retain their host worker. */
import { workspaceMount } from "../../../../runtime/src/session-vm/workspace.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConnectorContext } from "@loom/core/connector";
import type { WorkerProfile } from "../../../../core/src/worker.ts";
import type {
  AgentProvider,
  CreateSessionOptions,
  SessionRef,
  McpServerHandle,
} from "@loom/core/types";
import { CodexAuthOwner } from "./codex-auth.ts";
import type { ConnectorConfig } from "@loom/core/connector";
import type { SessionVmOptions } from "./session-vm-worker.ts";
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
export const withVmSessions = async <T extends AgentProvider>(
  base: T,
  ctx: ConnectorContext,
  kind: "claude" | "codex" | "aisdk",
  createLauncher = createSessionVmLauncher,
): Promise<T> => {
  const vm = ctx.config.sessionVm!;
  const launches = createLauncher();
  const smolvm = await executable(vm.smolvm);
  let owner: ClaudeAuthOwner | CodexAuthOwner | undefined;
  let auth: SessionVmOptions["auth"] = {};
  let providerHosts: string[] | undefined;
  let config: ConnectorConfig;
  let connector: WorkerProfile["connector"];
  if (kind === "aisdk") {
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
    config = {
      model: ctx.config.model ?? "",
      models: ctx.config.models ?? [],
      baseUrl: ctx.config.baseUrl ?? "",
      apiKey: ctx.config.apiKey ?? "",
      sdk: sdk ?? "openai",
      includeUsage: ctx.config.includeUsage ?? true,
      modelContext: ctx.config.modelContext ?? {},
      maxSteps: ctx.config.maxSteps ?? 50,
      promptCacheTtl: ctx.config.promptCacheTtl ?? "",
    };
    connector = sdk === "google" ? "@loom/connector-gemini" : "@loom/connector-generic";
    providerHosts = [endpoint.hostname];
  } else if (kind === "codex") {
    const cli = await executable(ctx.config.codexCliPath || "codex");
    const profile = ctx.config.configDir || Deno.env.get("CODEX_HOME") || join(homedir(), ".codex");
    owner = new CodexAuthOwner({
      profile,
      cli,
      report: (code) => ctx.logger.warn("Codex VM authentication", { code }),
    });
    config = {
      codexCliPath: "codex",
      configDir: "/tmp/loom-home/.codex",
      sdk: "chatgpt",
      model: ctx.config.model ?? "",
      models: ctx.config.models ?? [],
      codexBuiltinWebSearch: ctx.config.codexBuiltinWebSearch ?? false,
    };
    connector = "@loom/connector-chatgpt";
    providerHosts = ["chatgpt.com"];
  } else {
    const cli = await executable(ctx.config.cliPath || "claude");
    const profile =
      ctx.config.configDir || Deno.env.get("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude");
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const oauth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
    owner =
      apiKey || oauth
        ? undefined
        : new ClaudeAuthOwner({
            profile,
            cli,
            report: (code) => ctx.logger.warn("Claude VM authentication", { code }),
          });
    config = {
      cliPath: "",
      configDir: "/tmp/loom-home/.claude",
      promptCacheTtl: ctx.config.promptCacheTtl ?? "",
    };
    connector = "@loom/connector-claude";
    auth = apiKey ? { ANTHROPIC_API_KEY: apiKey } : { CLAUDE_CODE_OAUTH_TOKEN: oauth! };
  }
  const start = async (input: CreateSessionOptions | SessionRef, resume: boolean) =>
    startWorker(input, async (own) => {
      const sessionDirectory = sessionVmDirectory(vm.repoRoot, input.sessionId);
      await stoppedSessionVm(vm.repoRoot, input.sessionId);
      if (resume && kind !== "aisdk") {
        const ref = (input as SessionRef).providerRef;
        if (!/^[0-9a-f-]{36}$/i.test(ref)) throw new Error(`Invalid ${kind} resume reference`);
        try {
          if (kind === "claude") {
            await Deno.stat(
              join(sessionDirectory, "profile/projects/loom-session", `${ref}.jsonl`),
            );
          } else {
            if ((await Deno.readTextFile(join(sessionDirectory, "codex-ref"))) !== ref)
              throw new Error("different thread");
            await Deno.stat(join(sessionDirectory, "profile/sessions"));
          }
        } catch {
          throw new Error(
            "No saved VM history for this session; host-worker sessions cannot yet be imported into a VM",
          );
        }
      }
      const clone = ctx.vmLifecycle?.clone?.(input.sessionId);
      const guestCwd = clone ? workspaceMount(input.cwd).checkout : input.cwd;
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
      signalOf(input)?.throwIfAborted();
      const worker = own(
        await launches.launch({
          onProgress: (message) => ctx.onStartupProgress?.(input.sessionId, message),
          workspace: input.cwd,
          sessionId: input.sessionId,
          provider: ctx.id,
          ...(ctx.vmLifecycle
            ? {
                onStop: (isCurrent: () => boolean) =>
                  ctx.vmLifecycle!.stop(input.sessionId, isCurrent),
                activity: () => ctx.vmLifecycle!.activity(input.sessionId),
              }
            : {}),
          artifact: vm.artifact,
          smolvm,
          sessionDirectory,
          repoRoot: vm.repoRoot,
          mcpRelays: relays,
          ...(ctx.vmLifecycle?.clone?.(input.sessionId)
            ? { clone: ctx.vmLifecycle.clone(input.sessionId)! }
            : {}),
          ...(vm.extraAllowedHosts ? { extraAllowedHosts: vm.extraAllowedHosts } : {}),
          ...(vm.environment ? { environment: vm.environment } : {}),
          ...(owner ? { authOwner: owner } : { auth }),
          ...(providerHosts ? { providerHosts } : {}),
        }),
      );
      try {
        const { session } = await RemoteWorkerSession.connect(
          input.sessionId,
          ctx.id,
          mockLaunchSpec(guestCwd),
          () => worker,
          { startupMs: sessionStartupTimeout(vm.environment), requestMs: 120_000 },
          {
            connector,
            config,
            ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
          },
        );
        if (kind === "aisdk") await session.attachTranscript(ctx.transcript!);
        const options = {
          ...input,
          cwd: guestCwd,
          ...(input.workspaceRoot ? { workspaceRoot: guestCwd } : {}),
          ...(clone && input.initHooks
            ? {
                initHooks: {
                  ...input.initHooks,
                  env: {
                    ...input.initHooks.env,
                    LOOM_REPO_ROOT: guestCwd,
                    LOOM_WORKTREE: guestCwd,
                  },
                },
              }
            : {}),
          ...(input.systemPromptAppend
            ? { systemPromptAppend: input.systemPromptAppend.replaceAll(input.cwd, guestCwd) }
            : {}),
          mcpServers: servers,
        };
        session.onStartupProgress = (message) => ctx.onStartupProgress?.(input.sessionId, message);
        await session.start(
          resume
            ? { method: "resume", args: [options as SessionRef] }
            : { method: "create", args: [options as CreateSessionOptions] },
        );
        if (kind === "codex")
          await Deno.writeTextFile(join(sessionDirectory, "codex-ref"), session.providerRef!, {
            mode: 0o600,
          });
        else if (kind === "aisdk")
          await Deno.writeTextFile(join(sessionDirectory, "aisdk"), "1", { mode: 0o600 });
        ctx.onVmStarted?.(input.sessionId, await sessionVmGeneration(worker.binding.state));
        ctx.onStartupProgress?.(input.sessionId, "Session ready.");
        return kind === "claude" && owner
          ? refreshOnAuthFailure(session, () => owner!.current(true))
          : session;
      } catch (error) {
        worker.terminate();
        await worker.cleanup?.();
        throw error;
      }
    });
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
