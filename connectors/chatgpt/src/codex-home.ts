/** Resolve the Codex directory used for authentication and native sessions. */
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface CodexHome {
  /** The Codex home directory — passed to spawned `codex` processes as `CODEX_HOME`. */
  dir: string;
  /** Where `auth.json` lives inside it. */
  authJsonPath: string;
}

/** Precedence: explicit config_dir, CODEX_HOME, then ~/.codex. */
export const resolveCodexHome = (opts: {
  configDir?: string;
  env?: Record<string, string | undefined>;
}): CodexHome => {
  const env = opts.env ?? Deno.env.toObject();
  const configDir = opts.configDir?.trim() || undefined;
  // Absolute, resolved once here (against the daemon's own cwd) rather than
  // left relative: discovery spawns don't set a child `cwd` while sessions
  // spawn inside their worktree, so a relative CODEX_HOME would silently name
  // two different directories depending on which path constructed it.
  const dir = resolve(configDir ?? env["CODEX_HOME"] ?? join(homedir(), ".codex"));
  return { dir, authJsonPath: join(dir, "auth.json") };
};
