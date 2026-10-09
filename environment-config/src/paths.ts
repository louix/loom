import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Trusted environment configuration: `$XDG_CONFIG_HOME/loom/environment.jsonc`,
 * normally `~/.config/loom/environment.jsonc`. Deliberately not Loom's
 * `config.jsonc` beside it: main-new reused that name for this schema, which
 * rejects every Loom setting. Nothing reads one file in place of the other.
 */
export const environmentUserConfigPath = (): string => {
  const base = Deno.env.get("XDG_CONFIG_HOME")?.trim() || join(homedir(), ".config");
  return join(base, "loom", "environment.jsonc");
};

/** Project intent at the checkout root; the same name and schema as main-new. */
export const PROJECT_CONFIG_FILE = "loom.json";
/** Repository content is read whole; keep it small. */
export const PROJECT_CONFIG_MAX_BYTES = 16384;
