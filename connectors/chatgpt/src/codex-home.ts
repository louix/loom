/**
 * Resolve which Codex directory (`~/.codex`-shaped: `auth.json`, `config.toml`)
 * a ChatGPT provider instance should use, and validate the two ways of naming
 * one explicitly don't disagree.
 */
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface CodexHome {
  /** The Codex home directory — passed to spawned `codex` processes as `CODEX_HOME`. */
  dir: string;
  /** Where `auth.json` lives inside it. */
  authJsonPath: string;
}

/**
 * Precedence: explicit `config_dir` → legacy `auth_path`'s parent directory →
 * `CODEX_HOME` → `~/.codex`. `config_dir` and `auth_path` may both be set only
 * if they name the same directory.
 */
export const resolveCodexHome = (opts: {
  configDir?: string;
  authPath?: string;
  env?: Record<string, string | undefined>;
}): CodexHome => {
  const env = opts.env ?? Deno.env.toObject();
  const configDir = opts.configDir?.trim() || undefined;
  const authPath = opts.authPath?.trim() || undefined;

  if (authPath && basename(authPath) !== "auth.json") {
    throw new Error(
      `auth_path must name an auth.json file, got ${JSON.stringify(authPath)}`,
    );
  }
  const authPathDir = authPath ? dirname(authPath) : undefined;

  if (configDir && authPathDir && resolve(configDir) !== resolve(authPathDir)) {
    throw new Error(
      `config_dir (${JSON.stringify(configDir)}) and auth_path's directory ` +
        `(${JSON.stringify(authPathDir)}) disagree — set only one`,
    );
  }

  const dir = configDir ?? authPathDir ?? env["CODEX_HOME"] ?? join(homedir(), ".codex");
  return { dir, authJsonPath: authPath ?? join(dir, "auth.json") };
};
