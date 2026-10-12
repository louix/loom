import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { AISDK_SYSTEM, toolSteer } from "@loom/runtime/instructions";

/** Whose instruction-file conventions a session's agent follows. */
export type InstructionReader = "claude" | "codex" | "aisdk";

/** Instruction files whose presence stops Claude Code reading AGENTS.md on its own. */
const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

const ancestors = (dir: string): string[] =>
  dirname(dir) === dir ? [dir] : [dir, ...ancestors(dirname(dir))];

/**
 * Does Claude Code load `<dir>/AGENTS.md` itself? It does (v2.1.277 and later)
 * when project settings load and no CLAUDE.md, `.claude/CLAUDE.md` or
 * CLAUDE.local.md sits in the workspace or above it; otherwise only through a
 * CLAUDE.md that imports it (`@AGENTS.md`) or links to it.
 * https://code.claude.com/docs/en/memory#agents-md
 */
const claudeReadsAgents = (dir: string, agents: string, settingSources?: string[]): boolean => {
  // Omitted sources load them all, as on resume.
  if (settingSources && !settingSources.includes("project")) return false;
  const claudeFiles = ancestors(dir)
    .flatMap((at) => CLAUDE_FILES.map((name) => join(at, name)))
    .filter((path) => existsSync(path));
  return (
    claudeFiles.length === 0 ||
    claudeFiles.some(
      (path) => sameFile(path, agents) || /(^|\s)@(\.{1,2}\/)?AGENTS\.md\b/m.test(readText(path)),
    )
  );
};

/**
 * The repository's AGENTS.md, framed for the system prompt, for an agent that
 * would not read it itself — so every provider sees it exactly once. Codex
 * reads it natively; Claude Code when {@link claudeReadsAgents}; the AI SDK
 * engine reads no instruction files. `dir` is the workspace, except for a
 * session clone, which is agent-written: there the host checkout is read.
 * Null when there is no AGENTS.md, it is empty, or the provider reads it.
 */
export const repoInstructionsFor = (
  reader: InstructionReader,
  dir: string,
  /** Claude's `settingSources` for this launch; undefined loads every source. */
  claudeSettingSources?: string[],
): string | null => {
  const agents = join(dir, "AGENTS.md");
  const md = readText(agents).trim();
  if (!md) return null;
  const native: Record<InstructionReader, () => boolean> = {
    codex: () => true,
    claude: () => claudeReadsAgents(dir, agents, claudeSettingSources),
    aisdk: () => false,
  };
  return native[reader]() ? null : `# Repository instructions (AGENTS.md)\n\n${md}`;
};

/**
 * The system-prompt append for a new (or resumed) session: the standalone
 * base prompt for aisdk sessions (no vendor preset to append to) followed by
 * the tool steer — assuming every loom tool (`ask_user`/`commit`/`status`) is
 * mounted, which holds for both Claude and aisdk's `loomServer: true` sessions
 * — then the repository instructions from {@link repoInstructionsFor}.
 */
export const systemPromptAppendFor = (
  aisdk: boolean,
  withMcp: boolean,
  cwd: string,
  repoInstructions: string | null,
): string =>
  [
    ...(aisdk ? [AISDK_SYSTEM] : []),
    ...(aisdk && !withMcp ? [] : [toolSteer(cwd, { askUser: true, commit: true, status: true })]),
    repoInstructions,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join("\n\n");
