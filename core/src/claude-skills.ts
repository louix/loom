import { join } from "node:path";

export type ClaudeSkillsCopy = { kind: "copied" } | { kind: "invalid"; message: string };

/**
 * Copy each named `<configDir>/skills/<name>` into `<dest>/<name>`, replacing
 * what is there. Checks every name before copying any.
 */
export const copyClaudeSkills = (
  configDir: string,
  names: readonly string[],
  dest: string,
): ClaudeSkillsCopy => {
  const bad = names.find((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name));
  if (bad !== undefined)
    return { kind: "invalid", message: `skills: "${bad}" is not a skill directory name` };
  const missing = names.filter((name) => !isFile(join(configDir, "skills", name, "SKILL.md")));
  if (missing.length > 0)
    return {
      kind: "invalid",
      message: `skills: ${missing.map((name) => `"${name}"`).join(", ")} not found in ${configDir} (expected ${join(configDir, "skills", missing[0]!, "SKILL.md")})`,
    };
  Deno.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    try {
      Deno.removeSync(join(dest, name), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    copyTree(join(configDir, "skills", name), join(dest, name));
  }
  return { kind: "copied" };
};

const isFile = (path: string): boolean => {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
};

/** Follows symlinks: a linked reference file is copied as a file. */
const copyTree = (from: string, to: string): void => {
  Deno.mkdirSync(to, { recursive: true });
  for (const entry of Deno.readDirSync(from)) {
    const source = join(from, entry.name);
    const stat = Deno.statSync(source);
    if (stat.isDirectory) copyTree(source, join(to, entry.name));
    else if (stat.isFile) Deno.copyFileSync(source, join(to, entry.name));
  }
};
