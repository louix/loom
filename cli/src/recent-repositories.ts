import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tryFindRepoRoot } from "@loom/core/paths";

export const recentRepositoriesPath = (): string =>
  join(
    Deno.env.get("XDG_STATE_HOME") || join(homedir(), ".local", "state"),
    "loom",
    "repositories.json",
  );

export const readRecentRepositories = (path = recentRepositoriesPath()): string[] => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value)
      ? [
          ...new Set(value.filter((p): p is string => typeof p === "string" && p.startsWith("/"))),
        ].slice(0, 50)
      : [];
  } catch {
    return [];
  }
};

/** Resolve again on display: moved/deleted repositories should not be offered. */
export const availableRepositories = (path = recentRepositoriesPath()): string[] => [
  ...new Set(
    readRecentRepositories(path)
      .map(tryFindRepoRoot)
      .filter((p): p is string => p !== null),
  ),
];

/** History is convenience state; a failed write must never prevent opening a repo. */
export const rememberRepository = (repo: string, path = recentRepositoriesPath()): void => {
  try {
    const repos = [repo, ...readRecentRepositories(path).filter((p) => p !== repo)].slice(0, 50);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${Deno.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(repos) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Best effort.
  }
};
