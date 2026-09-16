import { z } from "zod";

/** Trusted host configuration; commands are executed only inside the session VM. */
export interface SessionEnvironment {
  nix: boolean;
  /** Resolved automatically from the checkout; never accepted as VM config syntax. */
  nixActivation?: import("./nix-activation.ts").NixActivation;
  commandPrefix: string[];
  prepare: string;
  timeoutMs: number;
  memoryMiB: number;
  cpus: number;
}

/** Input units stay in seconds/MiB for config validation and editor schemas. */
export const sessionEnvironmentSchema = z
  .strictObject({
    nix: z.boolean().default(false),
    command_prefix: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((v) => !v.includes("\0")),
      )
      .max(64)
      .nullish()
      .transform((v) => v ?? []),
    prepare: z
      .string()
      .max(65536)
      .refine((v) => !v.includes("\0"))
      .nullish()
      .transform((v) => v ?? ""),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(2_073_600)
      .nullish()
      .transform((v) => v ?? 900),
    memory_mib: z
      .number()
      .int()
      .min(512)
      .max(65536)
      .nullish()
      .transform((v) => v ?? 2048),
    cpus: z
      .number()
      .int()
      .min(1)
      .max(64)
      .nullish()
      .transform((v) => v ?? 1),
  })
  .prefault({});

export const normalizeSessionEnvironment = (value: unknown): SessionEnvironment => {
  const result = sessionEnvironmentSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      result.error.issues
        .map((i) => `isolation.environment.${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  const r = result.data;
  return {
    nix: r.nix,
    commandPrefix: r.command_prefix,
    prepare: r.prepare,
    timeoutMs: r.timeout_seconds * 1000,
    memoryMiB: r.memory_mib,
    cpus: r.cpus,
  };
};

export const environmentEnabled = (env?: SessionEnvironment): boolean =>
  !!env &&
  (env.nix || !!env.nixActivation || env.commandPrefix.length > 0 || env.prepare.length > 0);

export const sessionStartupTimeout = (env?: SessionEnvironment): number =>
  120_000 + (environmentEnabled(env) ? env!.timeoutMs : 0);
