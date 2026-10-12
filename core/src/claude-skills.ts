import { join, relative, sep } from "node:path";

/** `skipped`: one line per symlink left out of the copy, for the caller to log. */
export type ClaudeSkillsCopy =
  | { kind: "copied"; skipped: string[] }
  | { kind: "invalid"; message: string };

/** One write of a skill's copy. */
type SkillStep = { kind: "dir"; to: string } | { kind: "file"; from: string; to: string };

/** Skills' copy, decided in full before anything is written. */
type SkillPlan =
  | { kind: "planned"; steps: readonly SkillStep[]; skipped: readonly string[] }
  | { kind: "invalid"; message: string };

/** What one directory entry adds to the plan. */
type EntryPlan =
  | { kind: "file"; step: SkillStep }
  | { kind: "dir"; dir: PendingDir }
  | { kind: "skip"; line: string }
  | { kind: "none" }
  | { kind: "invalid"; message: string };

/** A directory still to plan, under the directories it was reached through. */
interface PendingDir {
  readonly from: string;
  readonly to: string;
  readonly ancestors: Ancestry;
}

type Ancestry = { readonly dir: string; readonly parent: Ancestry | null };

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
  const plan = planClaudeSkills(configDir, names);
  return plan.kind === "invalid" ? plan : writeClaudeSkills(plan, names, dest);
};

/** The copy of each named skill, into `<dest>/<name>` once `dest` is joined on. */
const planClaudeSkills = (configDir: string, names: readonly string[]): SkillPlan => {
  const bad = names.find((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name));
  if (bad !== undefined)
    return { kind: "invalid", message: `skills: "${bad}" is not a skill directory name` };
  const missing = names.filter((name) => !isFile(join(configDir, "skills", name, "SKILL.md")));
  if (missing.length > 0)
    return {
      kind: "invalid",
      message: `skills: ${missing.map((name) => `"${name}"`).join(", ")} not found in ${configDir} (expected ${join(configDir, "skills", missing[0] ?? "", "SKILL.md")})`,
    };
  const plans = names.map((name) =>
    // The skill directory itself may be a link (into a dotfiles checkout, say);
    // what it contains may only link within it.
    planSkill(Deno.realPathSync(join(configDir, "skills", name)), name),
  );
  const invalid = plans.find((plan) => plan.kind === "invalid");
  if (invalid !== undefined) return invalid;
  return {
    kind: "planned",
    steps: plans.flatMap((plan) => (plan.kind === "planned" ? plan.steps : [])),
    skipped: plans.flatMap((plan) => (plan.kind === "planned" ? plan.skipped : [])),
  };
};

/** Write `plan` under `dest`, replacing each named skill there. */
const writeClaudeSkills = (
  plan: Extract<SkillPlan, { kind: "planned" }>,
  names: readonly string[],
  dest: string,
): ClaudeSkillsCopy => {
  Deno.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    try {
      Deno.removeSync(join(dest, name), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  for (const step of plan.steps)
    if (step.kind === "dir") Deno.mkdirSync(join(dest, step.to), { recursive: true });
    else Deno.copyFileSync(step.from, join(dest, step.to));
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

const inside = (ancestors: Ancestry | null, real: string): boolean =>
  ancestors !== null && (within(real, ancestors.dir) || inside(ancestors.parent, real));

const realPathOrNull = (path: string): string | null => {
  try {
    return Deno.realPathSync(path);
  } catch {
    return null;
  }
};

/**
 * A symlink out of the skill fails the copy: it could carry any host file
 * (`~/.ssh`) into a VM or plugin, and leaving it out would hand the agent a
 * skill missing what it names. A link into a directory already being copied (an
 * ancestor) is left out, as copying it would never end.
 */
const planSkill = (root: string, to: string): SkillPlan => {
  // Appended to in place: concatenating the plans of every entry made planning
  // quadratic. `for…of` over an array visits what is pushed while it runs.
  const mutSteps: SkillStep[] = [];
  const mutSkipped: string[] = [];
  const mutPending: PendingDir[] = [{ from: root, to, ancestors: { dir: root, parent: null } }];
  for (const dir of mutPending) {
    mutSteps.push({ kind: "dir", to: dir.to });
    for (const entry of Deno.readDirSync(dir.from)) {
      const planned = planEntry(root, dir, entry);
      switch (planned.kind) {
        case "invalid":
          return planned;
        case "file":
          mutSteps.push(planned.step);
          break;
        case "dir":
          mutPending.push(planned.dir);
          break;
        case "skip":
          mutSkipped.push(planned.line);
          break;
        case "none":
          break;
      }
    }
  }
  return { kind: "planned", steps: mutSteps, skipped: mutSkipped };
};

const planEntry = (root: string, dir: PendingDir, entry: Deno.DirEntry): EntryPlan => {
  const source = join(dir.from, entry.name);
  const target = join(dir.to, entry.name);
  const real = entry.isSymlink ? realPathOrNull(source) : source;
  if (real === null) return { kind: "skip", line: `${source}: a broken symlink` };
  if (!within(root, real))
    return {
      kind: "invalid",
      message: `skills: ${source} links outside its skill ${root}, to ${real}; copy what it names into the skill instead`,
    };
  if (entry.isSymlink && inside(dir.ancestors, real))
    return {
      kind: "skip",
      line: `${source}: links back to ${relative(root, real) || "the skill"} (a loop)`,
    };
  const stat = Deno.lstatSync(real);
  if (stat.isDirectory)
    return {
      kind: "dir",
      dir: { from: real, to: target, ancestors: { dir: real, parent: dir.ancestors } },
    };
  return stat.isFile
    ? { kind: "file", step: { kind: "file", from: real, to: target } }
    : { kind: "none" };
};
