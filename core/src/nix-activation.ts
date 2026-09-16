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

/** Inspect only the checkout root; never execute .envrc or infer a shell from default.nix. */
export const detectNixActivation = (
  cwd: string,
  settings: NixActivationSettings,
): NixActivation | undefined => {
  if (!settings.autoActivate) return;
  for (const kind of ["flake", "shell"] as const)
    if (isFile(join(cwd, `${kind}.nix`))) return { kind, devShell: settings.devShell };
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
