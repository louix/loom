/**
 * Pick the Claude Code executable for the SDK to spawn.
 *
 * The SDK ships a prebuilt native binary, but it is a plain glibc ELF and does
 * not run everywhere (NixOS, musl, minimal containers). So: an explicit config
 * path wins, then a `claude` found on `PATH`, and only if neither resolves do
 * we defer to the SDK's bundled binary (return `undefined`).
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const onPath = (name: string): string | undefined => {
  const raw = process.env["PATH"];
  if (!raw) return undefined;
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
};

/**
 * @param explicit `providers.claude.cli_path` from config ("" = auto).
 * @returns an absolute path to pass as `pathToClaudeCodeExecutable`, or
 *   `undefined` to let the SDK use its bundled binary.
 */
export const resolveClaudeCli = (explicit: string): string | undefined => {
  if (explicit) {
    if (isExecutableFile(explicit)) return explicit;
    throw new Error(`providers.claude.cli_path is not an executable file: ${explicit}`);
  }
  return onPath("claude");
};
