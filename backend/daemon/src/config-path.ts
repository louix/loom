import { homedir } from "node:os";
import { join } from "node:path";
/**
 * The only config file: `$XDG_CONFIG_HOME/loom/config.jsonc`, falling back to
 * `~/.config/loom/config.jsonc`. Includes global defaults and repo overrides.
 */
export const userConfigPath = (): string => {
  const base = Deno.env.get("XDG_CONFIG_HOME")?.trim() || join(homedir(), ".config");
  return join(base, "loom", "config.jsonc");
};
