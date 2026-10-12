/**
 * loom-isolate's view of the versioned environment configuration: the
 * workspace's `loom.json` resolved against the user's environment.jsonc.
 * Loom's own config.jsonc is never read here.
 */
import {
  loadEnvironmentConfig,
  loadEnvironmentUser,
  resolveExecutable,
  type LoadedEnvironmentConfig,
} from "@loom/environment-config/load";

export type IsolateConfig = LoadedEnvironmentConfig;

export interface ConfigFlags {
  "user-config"?: string | undefined;
  "ignore-project"?: boolean | undefined;
}

export const loadIsolateConfig = (workspace: string, flags: ConfigFlags, profile?: string) =>
  loadEnvironmentConfig(workspace, {
    ...(flags["user-config"] ? { userFile: flags["user-config"] } : {}),
    ...(profile ? { profile } : {}),
    ...(flags["ignore-project"] ? { ignoreProject: true } : {}),
  });

/** The runtime trusted configuration selects; explicit flags still win. */
export const configuredRuntime = (
  config: Pick<IsolateConfig, "backend" | "profile"> | null,
): { artifact?: string; smolvm?: string } => {
  const artifact = config?.profile?.artifact ?? config?.backend?.artifact;
  const executable = config?.backend?.executable;
  return {
    ...(artifact ? { artifact } : {}),
    ...(executable ? { smolvm: resolveExecutable(executable) } : {}),
  };
};

/** The user backend alone, for commands that span workspaces. */
export const userRuntime = (flags: ConfigFlags) =>
  configuredRuntime({
    backend: loadEnvironmentUser(flags["user-config"]).config.backend ?? null,
    profile: null,
  });

const seconds = (ms: number) => ms / 1000 + "s";

/** Human-readable resolution, with where each value came from. */
export const formatConfig = (config: IsolateConfig): string => {
  const { sources, environment } = config;
  const file = (entry: { path: string; present: boolean }, ignored = false) => {
    if (ignored) return entry.path + " (ignored)";
    return entry.path + (entry.present ? "" : " (absent)");
  };
  const backend = config.backend;
  let runtime = "not configured";
  if (config.profile?.artifact) runtime = config.profile.artifact + " (profile)";
  else if (backend?.artifact) runtime = backend.artifact + " (user)";
  const lifecycle = Object.entries(config.lifecycle).map(([key, value]) => `${key}=${value}`);
  const hooks = (kind: "prepare" | "start") =>
    config[kind].length
      ? [
          `${kind} hooks (${sources[kind]})`,
          ...config[kind].map(
            (hook) => `  ${hook.name}: ${hook.run}  [${seconds(hook.timeoutMs)}]`,
          ),
        ]
      : [`${kind} hooks  none`];
  return (
    [
      `user config     ${file(sources.userFile)}`,
      `project config  ${file(sources.projectFile, sources.projectFile.ignored)}`,
      `checkout        ${config.checkout}`,
      `repository      ${config.repository ?? "no repos entry (nothing granted)"}`,
      `profile         ${config.profile ? config.profile.name + ": " + config.profile.entrypoint.join(" ") : "none"}`,
      `runtime         ${runtime}`,
      `smolvm          ${backend?.executable ?? "not configured"}`,
      `lifecycle       ${lifecycle.length ? lifecycle.join(" ") : "not configured"} (not used by loom-isolate)`,
      "environment",
      `  nix.auto        ${environment.autoNix} (${sources.nix})`,
      `  commandPrefix   ${environment.commandPrefix.length ? JSON.stringify(environment.commandPrefix) : "none"} (${sources.commandPrefix})`,
      `  timeout         ${seconds(environment.timeoutMs)} (${sources.timeoutSeconds})`,
      `  cpus            ${environment.cpus} (${sources.cpus})`,
      `  memory          ${environment.memoryMiB} MiB (${sources.memoryMiB})`,
      config.network.length ? "network" : "network  denied",
      ...config.network.map((entry) => `  ${entry.host} (${entry.source})`),
      ...hooks("prepare"),
      ...hooks("start"),
      ...(config.unsupported.length
        ? ["unsupported (ignored)", ...config.unsupported.map((entry) => "  " + entry)]
        : []),
      ...(config.deprecated.length
        ? ["deprecated", ...config.deprecated.map((entry) => "  " + entry)]
        : []),
    ].join("\n") + "\n"
  );
};
