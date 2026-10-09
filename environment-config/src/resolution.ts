/**
 * Pure resolution of project intent against trusted user configuration.
 *
 * Environment layers apply in order: user defaults, the selected profile, the
 * project, then the matching `repos[]` entry as final host overrides. Each field
 * replaces the previous layer's value; resources merge field by field; hook
 * arrays replace earlier arrays rather than appending to them.
 *
 * A project only requests. Setup (Nix activation, a command prefix or hooks)
 * needs `repos[].grants.setup`, and every requested host must be granted or
 * already applied by the host. Host layers grant themselves: they are the
 * authority. Resolution never changes the user configuration it reads.
 */
import { parse, type ParseError } from "jsonc-parser";
import type { z } from "zod";
import type { InitHook } from "../../core/src/init-hook.ts";
import type { SessionEnvironment } from "../../core/src/session-environment.ts";
import {
  expandNetworkPresets,
  normalizeExtraHosts,
} from "../../runtime/src/session-vm/network-policy.ts";
import {
  environmentUserSchema,
  projectEnvironmentSchema,
  type EnvironmentIntent,
  type EnvironmentUserConfig,
  type ProjectEnvironmentConfig,
} from "./schema.ts";

const validate = <T>(schema: z.ZodType<T>, input: unknown, source: string): T => {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      source +
        ": " +
        result.error.issues
          .map((issue) => (issue.path.join(".") || "config") + ": " + issue.message)
          .join("; "),
    );
  return result.data;
};

/** Project files are strict JSON. */
export const parseProjectEnvironment = (text: string, source = "loom.json") => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(source + ": expected strict JSON");
  }
  return validate(projectEnvironmentSchema, raw, source);
};

/** User files accept JSONC comments and trailing commas. */
export const parseEnvironmentUser = (text: string, source = "environment.jsonc") => {
  const errors: ParseError[] = [];
  const raw: unknown = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(source + ": invalid JSONC at offset " + errors[0]!.offset);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !("version" in raw))
    throw new Error(
      source +
        ": expected version: 1. Loom's own config.jsonc is a different format; " +
        "`loom config convert` prints its environment settings in this one.",
    );
  return validate(environmentUserSchema, raw, source);
};

export type ConfigLayer = "default" | "user" | `profile ${string}` | "project" | "repository";
export const ENVIRONMENT_FIELDS = [
  "nix",
  "commandPrefix",
  "timeoutSeconds",
  "cpus",
  "memoryMiB",
  "prepare",
  "start",
] as const;
export type EnvironmentField = (typeof ENVIRONMENT_FIELDS)[number];

const field = (intent: EnvironmentIntent | undefined, name: EnvironmentField) =>
  name === "cpus" || name === "memoryMiB" ? intent?.resources?.[name] : intent?.[name];
const hooks = (kind: string, entries: EnvironmentIntent["prepare"]): InitHook[] =>
  (entries ?? []).map((entry, index) => ({
    name: entry.name ?? kind + " " + (index + 1),
    run: entry.run,
    timeoutMs: entry.timeoutSeconds * 1000,
  }));
const hosts = (network?: { presets?: string[]; hosts?: string[] }) =>
  normalizeExtraHosts([...(network?.hosts ?? []), ...expandNetworkPresets(network?.presets ?? [])]);

export interface ResolvedEnvironmentConfig {
  version: 1;
  /** The matching `repos[].path`; null when no entry matches, so nothing is granted. */
  repository: string | null;
  profile: { name: string; entrypoint: string[]; artifact?: string } | null;
  backend: EnvironmentUserConfig["backend"] | null;
  environment: SessionEnvironment;
  prepare: InitHook[];
  start: InitHook[];
  /** Every allowed HTTPS destination, host-applied first. */
  extraAllowedHosts: string[];
  network: Array<{ host: string; source: ConfigLayer }>;
  lifecycle: NonNullable<EnvironmentUserConfig["lifecycle"]>;
  /** Project requests no consumer satisfies yet; ignoring them grants nothing. */
  unsupported: string[];
  /** The layer that supplied each environment field. */
  sources: Record<EnvironmentField, ConfigLayer>;
}

/**
 * Resolve against the first of `repositories` that has a `repos[]` entry; the
 * caller lists the workspace's identities most specific first.
 */
export const resolveEnvironmentConfig = (
  project: ProjectEnvironmentConfig,
  user: EnvironmentUserConfig,
  repositories: readonly string[],
  profileName?: string,
): ResolvedEnvironmentConfig => {
  const profile = profileName ? user.profiles[profileName] : undefined;
  if (profileName && (!profile || !Object.hasOwn(user.profiles, profileName)))
    throw new Error("Unknown launch profile: " + profileName);
  for (const path of new Set(user.repos.map((entry) => entry.path)))
    if (user.repos.filter((entry) => entry.path === path).length > 1)
      throw new Error("Duplicate repository configuration: " + path);
  const repo = repositories
    .map((path) => user.repos.find((entry) => entry.path === path))
    .find((entry) => entry !== undefined);

  const layers: Array<readonly [ConfigLayer, EnvironmentIntent | undefined]> = [
    ["user", user.environment],
    ...(profile ? [[`profile ${profileName}`, profile.environment] as const] : []),
    ["project", project.environment],
    ["repository", repo?.environment],
  ];
  const sources = Object.fromEntries(ENVIRONMENT_FIELDS.map((name) => [name, "default"])) as Record<
    EnvironmentField,
    ConfigLayer
  >;
  const intent: EnvironmentIntent = {};
  for (const [layer, values] of layers)
    for (const name of ENVIRONMENT_FIELDS) {
      const value = field(values, name);
      if (value === undefined) continue;
      sources[name] = layer;
      if (name === "cpus" || name === "memoryMiB")
        intent.resources = { ...intent.resources, [name]: value };
      else Object.assign(intent, { [name]: value });
    }

  // Check what the project asked for, even where a host layer overrides it later.
  const requested = project.environment;
  const setup = [
    requested?.nix?.auto && "environment.nix.auto",
    requested?.commandPrefix && "environment.commandPrefix",
    requested?.prepare?.length && "environment.prepare",
    requested?.start?.length && "environment.start",
  ].filter((name): name is string => typeof name === "string");
  if (setup.length && !repo?.grants.setup)
    throw new Error(
      `The project requests ${setup.join(", ")}, which needs repos[].grants.setup in the user config` +
        (repo ? " for " + repo.path : "; no repos entry matches " + repositories[0]) +
        ".",
    );
  const autoNix = intent.nix?.auto ?? false;
  if (autoNix && intent.commandPrefix?.length)
    throw new Error(
      `Choose environment.nix.auto (${sources.nix}) or environment.commandPrefix (${sources.commandPrefix}).`,
    );
  const cpus = intent.resources?.cpus ?? 1;
  const memoryMiB = intent.resources?.memoryMiB ?? 2048;
  if (cpus > (user.limits?.cpus ?? 64) || memoryMiB > (user.limits?.memoryMiB ?? 65536))
    throw new Error("Requested environment.resources exceed user limits.");

  // Host fields replace the user-level field individually; the project adds requests.
  const network: Array<{ host: string; source: ConfigLayer }> = [];
  for (const key of ["hosts", "presets"] as const) {
    const [source, value] =
      repo?.access?.network?.[key] !== undefined
        ? (["repository", repo.access.network[key]] as const)
        : (["user", user.access?.network?.[key]] as const);
    for (const host of hosts({ [key]: value }))
      if (!network.some((entry) => entry.host === host)) network.push({ host, source });
  }
  const granted = new Set(hosts(repo?.grants.network));
  for (const host of hosts(project.access?.network)) {
    if (network.some((entry) => entry.host === host)) continue;
    if (!granted.has(host))
      throw new Error(
        "Network host is not granted: " +
          host +
          (repo ? " (add it to repos[].grants.network for " + repo.path + ")" : ""),
      );
    network.push({ host, source: "project" });
  }

  const unsupported = [
    ...(project.access?.mcp?.length ? ["access.mcp: " + project.access.mcp.join(", ")] : []),
    ...(project.skills?.length ? ["skills: " + project.skills.join(", ")] : []),
  ];
  return {
    version: 1,
    repository: repo?.path ?? null,
    profile:
      profile && profileName
        ? {
            name: profileName,
            entrypoint: profile.entrypoint,
            ...(profile.artifact ? { artifact: profile.artifact } : {}),
          }
        : null,
    backend: user.backend ?? null,
    environment: {
      autoNix,
      commandPrefix: intent.commandPrefix ?? [],
      timeoutMs: (intent.timeoutSeconds ?? 900) * 1000,
      cpus,
      memoryMiB,
    },
    prepare: hooks("prepare", intent.prepare),
    start: hooks("start", intent.start),
    extraAllowedHosts: network.map((entry) => entry.host),
    network,
    lifecycle: { ...user.lifecycle, ...repo?.lifecycle },
    unsupported,
    sources,
  };
};
