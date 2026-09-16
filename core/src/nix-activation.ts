import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

export interface NixActivation {
  kind: "devenv" | "flake" | "shell" | "default";
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Inspect the checkout root, or HEAD for preparation/bare repos; never execute .envrc. */
export const detectNixActivation = (
  cwd: string,
  allowed: boolean,
  committed = false,
): NixActivation | undefined => {
  if (!allowed) return;
  for (const kind of ["devenv", "flake", "shell", "default"] as const) {
    if (!committed && isFile(join(cwd, `${kind}.nix`))) return { kind };
  }
  // Bare repo identity has no checkout. Read only tree metadata, so config loading,
  // preparation preflight and session startup agree without materializing files.
  const git = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
  if (!committed) {
    const bare = git(["rev-parse", "--is-bare-repository"]);
    if (bare.status !== 0 || bare.stdout.trim() !== "true") return;
  }
  const tree = git([
    "ls-tree",
    "-z",
    "HEAD",
    "--",
    "devenv.nix",
    "flake.nix",
    "shell.nix",
    "default.nix",
  ]);
  if (tree.status !== 0) return; // An unborn bare repository has no environment yet.
  const files = new Set(
    tree.stdout.split("\0").flatMap((entry) => {
      const match = /^100(?:644|755) blob [0-9a-f]+\t(.+)$/.exec(entry);
      return match ? [match[1]!] : [];
    }),
  );
  for (const kind of ["devenv", "flake", "shell", "default"] as const) {
    if (files.has(`${kind}.nix`)) return { kind };
  }
};

export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** nix-shell accepts shell source, whereas nix develop accepts argv. */
export const nixActivationCommand = (activation: NixActivation, command: string[]): string[] => {
  if (activation.kind === "devenv") {
    return ["devenv", "shell", "--", ...command];
  }
  if (activation.kind === "flake") {
    return ["nix", "develop", "path:.#default", "--no-write-lock-file", "--command", ...command];
  }
  return [
    "nix-shell",
    `./${activation.kind}.nix`,
    "--run",
    "exec " + command.map(shellQuote).join(" "),
  ];
};
