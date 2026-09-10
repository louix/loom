import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Resolve macOS system aliases without following user-controlled path components.
 * Ownership checks must still reject substituted session directories/symlinks. */
export const canonicalHostPath = (path: string): string => {
  const absolute = resolve(path);
  if (Deno.build.os === "darwin") {
    for (const alias of ["/tmp", "/var", "/etc"])
      if (absolute === alias || absolute.startsWith(alias + "/"))
        return join(realpathSync(alias), relative(alias, absolute));
  }
  return absolute;
};
