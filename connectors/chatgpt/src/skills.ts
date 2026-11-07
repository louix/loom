import type { CodexRpcClient } from "./rpc.ts";

/** Loom supplies the catalog; disable native skills without changing shared config. */
export const skillConfig = async (
  rpc: CodexRpcClient,
  cwd: string,
): Promise<Record<string, unknown>> => {
  const result = (await rpc.requestStartup("skills/list", { cwds: [cwd], forceReload: true })) as {
    data: Array<{
      skills: Array<{ path: string }>;
    }>;
  };
  const entries = result.data.flatMap((entry) => entry.skills);
  return {
    "skills.bundled.enabled": false,
    "skills.config": entries.map((skill) => ({
      path: skill.path,
      enabled: false,
    })),
  };
};
