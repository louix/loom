import { join } from "node:path";
import type { CodexRpcClient } from "./rpc.ts";

/** Select native skills for this thread without writing the shared Codex config. */
export const skillConfig = async (
  rpc: CodexRpcClient,
  cwd: string,
  configDir: string,
  names: readonly string[] | undefined,
): Promise<Record<string, unknown>> => {
  if (names === undefined) return {};
  const selected = new Set(
    names.map((name) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
        throw new Error(`skills: "${name}" is not a skill directory name`);
      const path = join(configDir, "skills", name, "SKILL.md");
      try {
        if (Deno.statSync(path).isFile) return Deno.realPathSync(path);
      } catch {
        /* report the expected location below */
      }
      throw new Error(`skills: "${name}" not found (expected ${path})`);
    }),
  );
  const result = (await rpc.requestStartup("skills/list", { cwds: [cwd], forceReload: true })) as {
    data: Array<{
      skills: Array<{ path: string }>;
      errors: Array<{ path: string; message: string }>;
    }>;
  };
  const entries = result.data.flatMap((entry) => entry.skills);
  const canonical = (path: string) => {
    try {
      return Deno.realPathSync(path);
    } catch {
      return path;
    }
  };
  for (const path of selected) {
    if (!entries.some((skill) => canonical(skill.path) === path)) {
      const error = result.data
        .flatMap((entry) => entry.errors)
        .find((e) => canonical(e.path) === path);
      throw new Error(`skills: Codex could not load ${path}${error ? `: ${error.message}` : ""}`);
    }
  }
  return {
    "skills.config": entries.map((skill) => ({
      path: skill.path,
      enabled: selected.has(canonical(skill.path)),
    })),
  };
};
