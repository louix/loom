/** Read environment configuration for a host workspace. Resolution itself is pure. */
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tryFindRepoRoot } from "../../core/src/paths.ts";
import {
  environmentUserConfigPath,
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_MAX_BYTES,
} from "./paths.ts";
import {
  parseEnvironmentUser,
  parseProjectEnvironment,
  resolveEnvironmentConfig,
  type ResolvedEnvironmentConfig,
} from "./resolution.ts";
import type { EnvironmentUserConfig } from "./schema.ts";

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const git = (cwd: string, args: string[]): string | null => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
};

/**
 * Where the project file lives (the checkout root, else the directory itself)
 * and the identities `repos[]` may name, most specific first: that checkout,
 * Loom's repository identity, then a linked worktree's main worktree.
 */
export const workspaceIdentity = (directory: string) => {
  const cwd = realpathSync(directory);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const checkout = top ? realpathSync(top) : cwd;
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const main = common && basename(common) === ".git" ? dirname(common) : common;
  const identities = [checkout, tryFindRepoRoot(cwd), main && realpathSync(main)];
  return {
    checkout,
    identities: [...new Set(identities.filter((path): path is string => !!path))],
  };
};

/** A `repos[].path` names its repository, however deep inside it points. */
const canonicalRepository = (path: string) => {
  try {
    const real = realpathSync(path);
    return workspaceIdentity(real).identities.at(-1) ?? real;
  } catch (error) {
    if (missing(error)) return resolve(path);
    throw error;
  }
};

/** Trusted host configuration; an absent file means no additions. */
export const loadEnvironmentUser = (file = environmentUserConfigPath()) => {
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const config = parseEnvironmentUser(text ?? '{"version":1}', file);
  const repos = config.repos.map((entry) => ({ ...entry, path: canonicalRepository(entry.path) }));
  return {
    config: { ...config, repos } as EnvironmentUserConfig,
    file,
    present: text !== undefined,
  };
};

/** The checkout's project file, which must stay inside the checkout. */
const readProject = (checkout: string): string | undefined => {
  const file = join(checkout, PROJECT_CONFIG_FILE);
  try {
    lstatSync(file);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const target = realpathSync(file);
  if (!within(checkout, target))
    throw new Error(PROJECT_CONFIG_FILE + " must remain within the checkout.");
  const info = statSync(target);
  if (!info.isFile() || info.size > PROJECT_CONFIG_MAX_BYTES)
    throw new Error(
      `${file}: must be a regular file of at most ${PROJECT_CONFIG_MAX_BYTES} bytes.`,
    );
  return readFileSync(target, "utf8");
};

export interface LoadedEnvironmentConfig extends ResolvedEnvironmentConfig {
  checkout: string;
  sources: ResolvedEnvironmentConfig["sources"] & {
    userFile: { path: string; present: boolean };
    projectFile: { path: string; present: boolean; ignored: boolean };
  };
}

/** Resolve a host workspace's project intent against the user's grants. */
export const loadEnvironmentConfig = (
  workspace: string,
  options: { userFile?: string; profile?: string; ignoreProject?: boolean } = {},
): LoadedEnvironmentConfig => {
  const { checkout, identities } = workspaceIdentity(workspace);
  const user = loadEnvironmentUser(options.userFile);
  const projectFile = join(checkout, PROJECT_CONFIG_FILE);
  const text = options.ignoreProject ? undefined : readProject(checkout);
  const project = parseProjectEnvironment(text ?? '{"version":1}', projectFile);
  const resolved = resolveEnvironmentConfig(project, user.config, identities, options.profile);
  return {
    ...resolved,
    checkout,
    sources: {
      ...resolved.sources,
      userFile: { path: user.file, present: user.present },
      projectFile: {
        path: projectFile,
        present: text !== undefined,
        ignored: !!options.ignoreProject,
      },
    },
  };
};

/** Trusted host configuration only: never search paths a project supplied. */
export const resolveExecutable = (executable: string): string => {
  const paths = executable.includes("/")
    ? [resolve(executable)]
    : (Deno.env.get("PATH") ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, executable));
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  throw new Error("Configured executable was not found or is not executable: " + executable);
};
