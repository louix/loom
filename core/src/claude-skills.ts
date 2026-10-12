import { join, relative, sep } from "node:path";

/** `skipped`: one line per symlink left out of the copy, for the caller to log. */
export type ClaudeSkillsCopy =
  | { kind: "copied"; skipped: string[] }
  | { kind: "invalid"; message: string };

/** One write of a skill's copy. */
type SkillStep = { kind: "dir"; to: string } | { kind: "file"; from: string; to: string };

/** A skill's copy, decided in full before anything is written. */
type SkillPlan =
  | { kind: "planned"; steps: readonly SkillStep[]; skipped: readonly string[] }
  | { kind: "invalid"; message: string };

/**
 * Copy each named `<configDir>/skills/<name>` into `<dest>/<name>`, replacing
 * what is there. Checks every name, and every symlink in every skill, before
 * copying any.
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
  const plan = names
    .map((name) => {
      // The skill directory itself may be a link (into a dotfiles checkout, say);
      // what it contains may only link within it.
      const root = Deno.realPathSync(join(configDir, "skills", name));
      return planTree(root, root, join(dest, name), [root]);
    })
    .reduce(joinPlans, { kind: "planned", steps: [], skipped: [] });
  if (plan.kind === "invalid") return plan;
  Deno.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    try {
      Deno.removeSync(join(dest, name), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  for (const step of plan.steps)
    if (step.kind === "dir") Deno.mkdirSync(step.to, { recursive: true });
    else Deno.copyFileSync(step.from, step.to);
  return { kind: "copied", skipped: [...plan.skipped] };
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

const realPathOrNull = (path: string): string | null => {
  try {
    return Deno.realPathSync(path);
  } catch {
    return null;
  }
};

const skip = (line: string): SkillPlan => ({ kind: "planned", steps: [], skipped: [line] });

const joinPlans = (a: SkillPlan, b: SkillPlan): SkillPlan => {
  if (a.kind === "invalid") return a;
  if (b.kind === "invalid") return b;
  return {
    kind: "planned",
    steps: [...a.steps, ...b.steps],
    skipped: [...a.skipped, ...b.skipped],
  };
};

/**
 * A symlink out of the skill fails the copy: it could carry any host file
 * (`~/.ssh`) into a VM or plugin, and leaving it out would hand the agent a
 * skill missing what it names. A link into a directory already being copied (an
 * ancestor) is left out, as copying it would never end.
 */
const planTree = (
  root: string,
  from: string,
  to: string,
  ancestors: readonly string[],
): SkillPlan =>
  Array.from(Deno.readDirSync(from)).reduce<SkillPlan>(
    (plan, entry) => joinPlans(plan, planEntry(root, from, to, ancestors, entry)),
    { kind: "planned", steps: [{ kind: "dir", to }], skipped: [] },
  );

const planEntry = (
  root: string,
  from: string,
  to: string,
  ancestors: readonly string[],
  entry: Deno.DirEntry,
): SkillPlan => {
  const source = join(from, entry.name);
  const target = join(to, entry.name);
  const real = entry.isSymlink ? realPathOrNull(source) : source;
  if (real === null) return skip(`${source}: a broken symlink`);
  if (!within(root, real))
    return {
      kind: "invalid",
      message: `skills: ${source} links outside its skill ${root}, to ${real}; copy what it names into the skill instead`,
    };
  if (entry.isSymlink && ancestors.some((dir) => within(real, dir)))
    return skip(`${source}: links back to ${relative(root, real) || "the skill"} (a loop)`);
  const stat = Deno.lstatSync(real);
  if (stat.isDirectory) return planTree(root, real, target, [...ancestors, real]);
  return stat.isFile
    ? { kind: "planned", steps: [{ kind: "file", from: real, to: target }], skipped: [] }
    : { kind: "planned", steps: [], skipped: [] };
};
