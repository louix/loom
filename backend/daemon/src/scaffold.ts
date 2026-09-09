import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The only config file: `$XDG_CONFIG_HOME/loom/config.toml`, falling back to
 * `~/.config/loom/config.toml`. Includes global defaults and [[repo]] overrides.
 */
export const userConfigPath = (): string => {
  const base = Deno.env.get("XDG_CONFIG_HOME")?.trim() || join(homedir(), ".config");
  return join(base, "loom", "config.toml");
};

/** The `config.example.toml` shipped at the root of `@loom/daemon`. */
export const exampleConfigPath = (): string => {
  return join(import.meta.dirname!, "..", "config.example.toml");
};

/**
 * First-run convenience: drop a copy of `config.example.toml` at
 * {@link userConfigPath} when nothing is there yet, so `loom` has an obvious,
 * annotated place to configure providers. Never overwrites an existing file.
 * Returns the path when it created one, `null` otherwise (already present, or
 * the example couldn't be read).
 */
export const scaffoldUserConfig = (): string | null => {
  const dest = userConfigPath();
  if (existsSync(dest)) return null;
  const src = exampleConfigPath();
  if (!existsSync(src)) return null;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    // COPYFILE_EXCL: fail rather than clobber if the file appeared between the
    // existsSync above and now (two daemons for two repos on first run, or a
    // user hand-editing it immediately).
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    return dest;
  } catch {
    return null;
  }
};
