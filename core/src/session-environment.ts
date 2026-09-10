/** Trusted host configuration; commands are executed only inside the session VM. */
export interface SessionEnvironment {
  nix: boolean;
  commandPrefix: string[];
  prepare: string;
  timeoutMs: number;
}

export const normalizeSessionEnvironment = (value: unknown): SessionEnvironment => {
  const v = value === undefined ? {} : value;
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("isolation.environment must be a table");
  const r = v as Record<string, unknown>;
  if (
    Object.keys(r).some((k) => !["nix", "command_prefix", "prepare", "timeout_seconds"].includes(k))
  )
    throw new Error("Unknown isolation.environment setting");
  if (r.nix !== undefined && typeof r.nix !== "boolean")
    throw new Error("isolation.environment.nix must be a boolean");
  const prefix = r.command_prefix ?? [];
  if (
    !Array.isArray(prefix) ||
    prefix.length > 64 ||
    !prefix.every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0"),
    )
  )
    throw new Error("isolation.environment.command_prefix must be an array of nonempty arguments");
  const prepare = r.prepare ?? "";
  if (typeof prepare !== "string" || prepare.length > 65536 || prepare.includes("\0"))
    throw new Error("isolation.environment.prepare must be a shell command string");
  const seconds = r.timeout_seconds ?? 900;
  if (!Number.isInteger(seconds) || Number(seconds) < 1 || Number(seconds) > 3600)
    throw new Error("isolation.environment.timeout_seconds must be an integer from 1 to 3600");
  return {
    nix: r.nix === true,
    commandPrefix: [...prefix],
    prepare,
    timeoutMs: Number(seconds) * 1000,
  };
};

export const environmentEnabled = (env?: SessionEnvironment): boolean =>
  !!env && (env.nix || env.commandPrefix.length > 0 || env.prepare.length > 0);

export const sessionStartupTimeout = (env?: SessionEnvironment): number =>
  120_000 + (environmentEnabled(env) ? env!.timeoutMs : 0);
