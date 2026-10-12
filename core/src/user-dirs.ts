import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Per-user base directories, resolved per the XDG base directory spec. */
export type UserDirectoryKind = "state" | "data" | "cache" | "config";

const XDG: Record<UserDirectoryKind, [variable: string, fallback: string]> = {
  state: ["XDG_STATE_HOME", ".local/state"],
  data: ["XDG_DATA_HOME", ".local/share"],
  cache: ["XDG_CACHE_HOME", ".cache"],
  config: ["XDG_CONFIG_HOME", ".config"],
};

/**
 * Set by the test runners (`scripts/lib/test-home.ts`) to the run's throwaway
 * home. While set, every per-user directory must resolve inside it or inside a
 * temporary directory (tests' own fixture roots), so a test that escapes
 * isolation fails instead of writing into the developer's real state.
 */
export const TEST_HOME_VARIABLE = "LOOM_TEST_HOME";

const inside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Temporary roots, also by their real paths: fixtures are often realpath'd, and on
 * macOS /tmp and the per-user temporary directory are behind symlinks (/private).
 */
export const temporaryRoots = (): string[] => {
  const roots = [tmpdir(), "/tmp"];
  const real = (root: string) => {
    try {
      return [Deno.realPathSync(root)];
    } catch {
      return []; // A missing temporary directory has no other name.
    }
  };
  return [...roots, ...roots.flatMap(real)];
};

/** Throw if a test run resolves a per-user path outside its throwaway roots. */
export const assertTestHome = (
  path: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string => {
  const root = env[TEST_HOME_VARIABLE];
  if (root && ![root, ...temporaryRoots()].some((allowed) => inside(allowed, path)))
    throw new Error(`Test run resolved ${path} outside ${TEST_HOME_VARIABLE}=${root}`);
  return path;
};

/** `$XDG_<KIND>_HOME`, or its `~/` default when unset or relative. */
export const userDirectory = (
  kind: UserDirectoryKind,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string => {
  const [variable, fallback] = XDG[kind];
  const xdg = env[variable]?.trim();
  const dir = xdg && isAbsolute(xdg) ? xdg : join(env["HOME"] || homedir(), fallback);
  return assertTestHome(dir, env);
};

/**
 * Loom's base for sockets: `$XDG_RUNTIME_DIR/loom`, or `/tmp/loom-<uid>`
 * where the variable is unset (macOS). Not `$TMPDIR`: macOS's per-user one is long
 * enough to push a socket path past the sun_path limit.
 */
export const loomRuntimeDirectory = (
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string => {
  const xdg = env["XDG_RUNTIME_DIR"]?.trim();
  return assertTestHome(
    xdg && isAbsolute(xdg) ? join(xdg, "loom") : `/tmp/loom-${Deno.uid() ?? 0}`,
    env,
  );
};
