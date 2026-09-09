/** Host connector processes for non-VM sessions and short-lived utilities. */
import { homedir } from "node:os";
import { join, delimiter, isAbsolute, resolve } from "node:path";
import type { ConnectorContext } from "@loom/core/connector";
import type { WorkerProfile, WorkerRole } from "@loom/core/worker";
import { WorkerProvider } from "./worker-provider.ts";
import { mockLaunchSpec } from "./worker-launch.ts";

export const createProviderWorker = (
  connector: WorkerProfile["connector"],
  ctx: ConnectorContext,
) => {
  const native = ctx.config.sdk === "chatgpt";
  const config = { ...ctx.config };
  if (config.codexCliPath?.includes("/")) config.codexCliPath = resolve(config.codexCliPath);
  const endpoints = {
    chatgpt: "https://chatgpt.com",
    google: "https://generativelanguage.googleapis.com",
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  };
  const endpoint = new URL(config.baseUrl || endpoints[config.sdk ?? "openai"]);
  return WorkerProvider.create(
    ctx.id,
    (cwd, role: WorkerRole = "session") => {
      const base = mockLaunchSpec(cwd);
      const scratch = Deno.makeTempDirSync({ prefix: "loom-provider-worker-" });
      const env: Record<string, string> = {
        HOME: homedir(),
        TMPDIR: scratch,
        DENO_DIR: join(scratch, "deno"),
        NO_COLOR: "1",
      };
      for (const key of [
        "PATH",
        "LANG",
        "TZ",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
      ])
        if (Deno.env.get(key)) env[key] = Deno.env.get(key)!;
      const profile = config.configDir || Deno.env.get("CODEX_HOME") || join(homedir(), ".codex");
      if (native) env.CODEX_HOME = profile;
      const read = [...base.permissions.read, scratch];
      const write = [scratch];
      if (role === "session") {
        read.push(cwd);
        write.push(cwd);
      }
      if (native) {
        read.push(profile);
        write.push(profile);
        if (config.authPath) read.push(config.authPath);
        if (config.codexCliPath?.includes("/")) read.push(config.codexCliPath);
        for (const dir of (env.PATH ?? "").split(delimiter).filter(isAbsolute))
          read.push(join(dir, "codex"));
      }
      for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
        if (env[key]) read.push(env[key]!);
      return {
        ...base,
        cwd: role === "session" ? cwd : scratch,
        env,
        cleanupPaths: [scratch],
        processGroup: true,
        permissions: {
          read,
          write,
          net: [endpoint.host],
          env: true as const,
          run: true as const,
          sys: ["homedir", "hostname", "osRelease", "systemMemoryInfo", "uid", "gid", "cpus"],
        },
      };
    },
    undefined,
    { connector, config, ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}) },
    ctx.transcript,
  );
};
