import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeSessionEnvironment, type SessionEnvironment } from "./session-environment.ts";

export const nixActivationSchema = z
  .strictObject({
    auto_activate: z.boolean().default(true),
    dev_shell: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default("default"),
  })
  .prefault({});

export interface NixActivationSettings {
  autoActivate: boolean;
  devShell: string;
}
export interface NixActivation {
  kind: "flake" | "shell";
  devShell: string;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Inspect the checkout root, or committed HEAD for a bare repo; never execute .envrc. */
export const detectNixActivation = (
  cwd: string,
  settings: NixActivationSettings,
): NixActivation | undefined => {
  if (!settings.autoActivate) return;
  for (const kind of ["flake", "shell"] as const)
    if (isFile(join(cwd, `${kind}.nix`))) return { kind, devShell: settings.devShell };
  // Bare repo identity has no checkout. Read only tree metadata, so config loading,
  // preparation preflight and session startup agree without materializing files.
  const git = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  const bare = git(["rev-parse", "--is-bare-repository"]);
  if (bare.status !== 0 || bare.stdout.trim() !== "true") return;
  const tree = git(["ls-tree", "-z", "HEAD", "--", "flake.nix", "shell.nix"]);
  if (tree.status !== 0) return; // An unborn bare repository has no environment yet.
  const files = new Set(
    tree.stdout.split("\0").flatMap((entry) => {
      const match = /^100(?:644|755) blob [0-9a-f]+\t(.+)$/.exec(entry);
      return match ? [match[1]!] : [];
    }),
  );
  for (const kind of ["flake", "shell"] as const)
    if (files.has(`${kind}.nix`)) return { kind, devShell: settings.devShell };
};

export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** nix-shell accepts shell source, whereas nix develop accepts argv. */
export const nixActivationCommand = (activation: NixActivation, command: string[]): string[] => {
  if (activation.kind === "flake")
    return [
      "nix",
      "develop",
      `path:.#${activation.devShell}`,
      "--no-write-lock-file",
      "--command",
      ...command,
    ];
  if (activation.devShell !== "default")
    throw new Error(
      "session.environment.nix.dev_shell requires flake.nix; shell.nix has no named dev shells",
    );
  return ["nix-shell", "./shell.nix", "--run", "exec " + command.map(shellQuote).join(" ")];
};

/** Explicit VM prefixes override detection. The writable guest store remains a separate setting. */
export const resolveVmNixActivation = (
  environment: SessionEnvironment | undefined,
  settings: NixActivationSettings,
  cwd: string,
): SessionEnvironment => {
  const resolved = { ...(environment ?? normalizeSessionEnvironment(undefined)) };
  delete resolved.nixActivation;
  if (!resolved.commandPrefix.length) {
    const activation = detectNixActivation(cwd, settings);
    if (activation) resolved.nixActivation = activation;
  }
  return resolved;
};
