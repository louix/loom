import { loadAllRepoConfigs } from "../../backend/daemon/src/config/config.ts";
import { runtimeHome } from "../../runtime/src/packaged/artifact.ts";
import { pruneRuntimeCache } from "../../runtime/src/packaged/prune.ts";
import { join } from "node:path";

/** Preserve explicit runtime pins in every configured repo, including disabled providers. */
export const pruneRuntimeCaches = async (repo: string) => {
  const paths = new Set<string>();
  for (const config of loadAllRepoConfigs(repo)) {
    for (const policy of [
      config.isolation.claude,
      config.isolation.codex,
      config.isolation.aisdk,
    ]) {
      if (!policy) continue;
      for (const path of [policy.artifact, policy.smolvm]) {
        const candidates = path.includes("/")
          ? [path]
          : (Deno.env.get("PATH") ?? "")
              .split(":")
              .filter(Boolean)
              .map((dir) => join(dir, path));
        let resolved = path;
        for (const candidate of candidates) {
          try {
            if (!path.includes("/") && !(await Deno.stat(candidate)).isFile) continue;
            resolved = await Deno.realPath(candidate);
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
        paths.add(resolved);
      }
    }
  }
  return await pruneRuntimeCache(runtimeHome(), [...paths]);
};
