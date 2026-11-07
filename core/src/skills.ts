import { join } from "node:path";
import { parseDocument } from "yaml";
import { userDirectory } from "./user-dirs.ts";
import type { CreateSessionOptions, SessionRef } from "./types.ts";

export const loomSkillsDirectory = (
  env: Record<string, string | undefined> = {
    HOME: Deno.env.get("HOME"),
    XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME"),
    LOOM_TEST_HOME: Deno.env.get("LOOM_TEST_HOME"),
  },
): string => join(userDirectory("config", env), "loom", "skills");

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export const loadSkills = (directory: string, selected?: readonly string[]): Skill[] => {
  const discover = (): string[] => {
    try {
      return [...Deno.readDirSync(directory)]
        .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory || entry.isSymlink))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  };
  return [...new Set(selected ?? discover())].map((name) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
      throw new Error(`skills: "${name}" is not a skill directory name`);
    const path = join(directory, name, "SKILL.md");
    let source: string;
    try {
      source = Deno.readTextFileSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound)
        throw new Error(`skills: "${name}" not found (expected ${path})`);
      throw error;
    }
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
    if (!frontmatter) throw new Error(`skills: ${path} requires YAML name and description`);
    const document = parseDocument(frontmatter);
    if (document.errors.length) throw new Error(`skills: ${path} has invalid YAML metadata`);
    const metadata: unknown = document.toJS({ maxAliasCount: 0 });
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("name" in metadata) ||
      metadata.name !== name ||
      !("description" in metadata) ||
      typeof metadata.description !== "string" ||
      !metadata.description.trim()
    )
      throw new Error(`skills: ${path} requires name: ${name} and a nonempty description`);
    return { name, description: metadata.description.trim(), path };
  });
};

export const skillInstructions = (skills: readonly Skill[]): string =>
  skills.length
    ? [
        "Loom skills",
        "Use a skill when the user names it or the task matches its description. Before using it, read its SKILL.md in full. Resolve supporting files relative to that skill's directory and read them as needed. User instructions take precedence over skill instructions.",
        ...skills.map(
          (skill) =>
            `- ${skill.name}: ${JSON.stringify(skill.description)} (file: ${JSON.stringify(skill.path)})`,
        ),
      ].join("\n")
    : "";

export const withSkillInstructions = <T extends CreateSessionOptions | SessionRef>(
  input: T,
  directory: string,
): T => {
  if ("oneShot" in input && input.oneShot) return input;
  const instructions = skillInstructions(loadSkills(directory, input.skills));
  return instructions
    ? { ...input, agentPrompt: [input.agentPrompt, instructions].filter(Boolean).join("\n\n") }
    : input;
};
