import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ConnectorContext } from "../../../../core/src/connector.ts";
import type { WorkerRole } from "../../../../core/src/worker.ts";
import { mockLaunchSpec, type WorkerLaunchSpec } from "./worker-launch.ts";
import { withClaudeVmSessions } from "./claude-vm-provider.ts";
import { WorkerProvider } from "./worker-provider.ts";

// Native descendants are not constrained by these Deno host grants. Keep this
// operator-controlled list explicit for the SDK and the future VM launcher.
export const CLAUDE_WORKER_HOSTS = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "registry.npmjs.org",
  "npmjs.com",
];
const ENV = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
];

/** Resolve launch inputs without importing the connector or SDK in the daemon. */
export const claudeWorkerSpec = (
  ctx: ConnectorContext,
  cwd: string,
  role: WorkerRole,
): WorkerLaunchSpec => {
  const base = mockLaunchSpec(cwd);
  const scratch = Deno.makeTempDirSync({ prefix: "loom-claude-worker-" });
  const env: Record<string, string> = {
    HOME: homedir(),
    NO_COLOR: "1",
    TMPDIR: scratch,
    DENO_DIR: join(scratch, "deno"),
  };
  for (const key of ENV) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  const home = env.HOME!;
  const profile = ctx.config.configDir || env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const profileConfig =
    ctx.config.configDir || env.CLAUDE_CONFIG_DIR
      ? join(profile, ".claude.json")
      : join(home, ".claude.json");
  if (ctx.config.configDir) env.CLAUDE_CONFIG_DIR = profile;
  const paths = (env.PATH ?? "").split(delimiter).filter((p) => p && isAbsolute(p));
  // Resolve relative explicit CLI paths against daemon cwd, never a utility cwd.
  const cliPath = ctx.config.cliPath ? resolve(ctx.config.cliPath) : undefined;
  const read = [
    ...base.permissions.read,
    profile,
    profileConfig,
    scratch,
    ...paths.flatMap((p) => ["claude", "node", "deno", "git", "bash"].map((bin) => join(p, bin))),
  ];
  if (cliPath) read.push(cliPath);
  const write = [profile, profileConfig, scratch];
  if (role === "session") {
    read.push(cwd);
    write.push(cwd);
  }
  for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
    if (env[key]) read.push(env[key]!);
  return {
    ...base,
    cwd: role === "session" ? cwd : scratch,
    env,
    processGroup: true,
    cleanupPaths: [scratch],
    permissions: {
      read: [...new Set(read)],
      write: [...new Set(write)],
      net: ctx.config.workerAllowedHosts ?? CLAUDE_WORKER_HOSTS,
      // SDK internals enumerate process.env. It contains only the allowlist above.
      env: true,
      // CLI + existing Loom Git tools retain subprocess execution for this phase.
      run: true,
      sys: ["homedir", "hostname", "osRelease", "systemMemoryInfo", "uid", "gid", "cpus"],
    },
  };
};

export const createClaudeWorkerProvider = async (ctx: ConnectorContext) => {
  const base = await WorkerProvider.create(
    ctx.id,
    (cwd, role = "session") => claudeWorkerSpec(ctx, cwd, role),
    undefined,
    {
      connector: "@loom/connector-claude",
      config: {
        cliPath: ctx.config.cliPath ? resolve(ctx.config.cliPath) : "",
        configDir: ctx.config.configDir ?? "",
        promptCacheTtl: ctx.config.promptCacheTtl ?? "",
      },
      ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
    },
  );

  return ctx.config.sessionVm ? withClaudeVmSessions(base, ctx) : base;
};
