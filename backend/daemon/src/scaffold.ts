import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The only config file: `$XDG_CONFIG_HOME/loom/config.jsonc`, falling back to
 * `~/.config/loom/config.jsonc`. Includes global defaults and repo overrides.
 */
export const userConfigPath = (): string => {
  const base = Deno.env.get("XDG_CONFIG_HOME")?.trim() || join(homedir(), ".config");
  return join(base, "loom", "config.jsonc");
};

/** The `config.example.jsonc` shipped at the root of `@loom/daemon`. */
export const exampleConfigPath = (): string => {
  return join(import.meta.dirname!, "..", "config.example.jsonc");
};

/** Schema is copied beside the user config so editor support works offline. */
export const exampleSchemaPath = (): string =>
  join(import.meta.dirname!, "..", "config.schema.json");
export const userSchemaPath = (): string => join(dirname(userConfigPath()), "config.schema.json");

/**
 * First-run convenience: drop a copy of `config.example.jsonc` at
 * {@link userConfigPath} when nothing is there yet, so `loom` has an obvious,
 * annotated place to configure providers. Never overwrites an existing file.
 * Returns the path when it created one, `null` otherwise (already present, or
 * the example couldn't be read).
 */
export const scaffoldUserConfig = (): string | null => {
  const dest = userConfigPath();
  const src = exampleConfigPath();
  if (!existsSync(src)) return null;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    const schema = exampleSchemaPath();
    if (
      existsSync(schema) &&
      (!existsSync(userSchemaPath()) ||
        readFileSync(schema, "utf8") !== readFileSync(userSchemaPath(), "utf8"))
    )
      copyFileSync(schema, userSchemaPath());
    if (existsSync(dest)) return null;
    // COPYFILE_EXCL: fail rather than clobber if the file appeared between the
    // existsSync above and now (two daemons for two repos on first run, or a
    // user hand-editing it immediately).
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    return dest;
  } catch {
    return null;
  }
};
