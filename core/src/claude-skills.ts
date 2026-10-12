import { join, relative, sep } from "node:path";

/** `skipped`: one line per symlink left out of the copy, for the caller to log. */
export type ClaudeSkillsCopy =
  | { kind: "copied"; skipped: string[] }
  | { kind: "invalid"; message: string };

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
  const skipped: string[] = [];
  for (const name of names) {
    try {
      Deno.removeSync(join(dest, name), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    // The skill directory itself may be a link (into a dotfiles checkout, say);
    // what it contains may only link within it.
    const root = Deno.realPathSync(join(configDir, "skills", name));
    copyTree(root, root, join(dest, name), [root], skipped);
  }
  return { kind: "copied", skipped };
};

const isFile = (path: string): boolean => {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
};

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + sep);

/**
 * Follows a symlink only to a file or directory inside the skill, and never into
 * a directory it is already copying: a link out of the skill could carry any
 * host file (`~/.ssh`) into a VM or plugin, and a link to an ancestor loops.
 */
const copyTree = (
  root: string,
  from: string,
  to: string,
  ancestors: readonly string[],
  skipped: string[],
): void => {
  Deno.mkdirSync(to, { recursive: true });
  for (const entry of Deno.readDirSync(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    let real = source;
    if (entry.isSymlink) {
      try {
        real = Deno.realPathSync(source);
      } catch {
        skipped.push(`${source}: a broken symlink`);
        continue;
      }
      if (!within(root, real)) {
        skipped.push(`${source}: links outside the skill, to ${real}`);
        continue;
      }
      if (ancestors.some((dir) => within(real, dir))) {
        skipped.push(`${source}: links back to ${relative(root, real) || "the skill"} (a loop)`);
        continue;
      }
    }
    const stat = Deno.lstatSync(real);
    if (stat.isDirectory) copyTree(root, real, target, [...ancestors, real], skipped);
    else if (stat.isFile) Deno.copyFileSync(real, target);
  }
};
