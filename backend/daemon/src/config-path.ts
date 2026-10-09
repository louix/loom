import { join } from "node:path";
import { userDirectory } from "@loom/core/user-dirs";
/**
 * The only config file: `$XDG_CONFIG_HOME/loom/config.jsonc`, falling back to
 * `~/.config/loom/config.jsonc`. Includes global defaults and repo overrides.
 */
export const userConfigPath = (): string => {
  return join(userDirectory("config"), "loom", "config.jsonc");
};
