/** Linux host VMM counters; never enumerate descriptor targets or credential contents. */
export interface HostFileUsage {
  pid: number | null;
  open: number | null;
  softLimit: number | "unlimited" | null;
  hardLimit: number | "unlimited" | null;
  unavailable?: string;
}

export const unavailableHostFiles = (reason: string, pid: number | null = null): HostFileUsage => ({
  pid,
  open: null,
  softLimit: null,
  hardLimit: null,
  unavailable: reason,
});

export const parseFileLimits = (text: string): Pick<HostFileUsage, "softLimit" | "hardLimit"> => {
  const match = text.match(/^Max open files\s+(\d+|unlimited)\s+(\d+|unlimited)\s+files\s*$/m);
  const value = (s: string | undefined): number | "unlimited" | null => {
    if (s === "unlimited") return s;
    const n = s === undefined ? NaN : Number(s);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  return { softLimit: value(match?.[1]), hardLimit: value(match?.[2]) };
};

// Fixed labels avoid exposing paths or arbitrary exception text in the monitor.
const failure = (error: unknown): string => {
  if (error instanceof Deno.errors.NotFound) return "process or proc entry disappeared";
  if (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.NotCapable)
    return "permission denied";
  if (error instanceof Error && /too many open files|EMFILE|os error 24/i.test(error.message))
    return "monitor process open-file limit reached";
  return "read failed";
};

/** A PID can disappear or be recycled during enumeration. Discard such samples. */
export const sampleHostFileUsage = async (
  pid: unknown,
  signal: AbortSignal,
  procRoot = "/proc",
): Promise<HostFileUsage> => {
  signal.throwIfAborted();
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    return unavailableHostFiles("smolvm did not report a valid host PID");
  const directory = `${procRoot}/${pid}`;
  const identity = async () => {
    const stat = await Deno.readTextFile(directory + "/stat");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const start = fields[19]; // /proc/PID/stat field 22; comm can contain spaces and ')'.
    if (!start || !/^\d+$/.test(start)) throw new Error("Invalid process stat");
    return start;
  };
  try {
    const before = await identity();
    const reasons: string[] = [];
    let limits: Pick<HostFileUsage, "softLimit" | "hardLimit"> = {
      softLimit: null,
      hardLimit: null,
    };
    try {
      limits = parseFileLimits(await Deno.readTextFile(directory + "/limits"));
      if (limits.softLimit === null || limits.hardLimit === null)
        reasons.push("open-file limits not recognized");
    } catch (error) {
      reasons.push("limits: " + failure(error));
    }
    let open: number | null = null;
    try {
      let count = 0;
      for await (const entry of Deno.readDir(directory + "/fd")) {
        signal.throwIfAborted();
        if (/^\d+$/.test(entry.name)) count++;
      }
      open = count;
    } catch (error) {
      signal.throwIfAborted();
      reasons.push("descriptor count: " + failure(error));
    }
    signal.throwIfAborted();
    if (before !== (await identity()))
      return unavailableHostFiles("host PID changed during sampling", pid);
    return { pid, open, ...limits, ...(reasons.length ? { unavailable: reasons.join("; ") } : {}) };
  } catch (error) {
    signal.throwIfAborted();
    return unavailableHostFiles("host process identity: " + failure(error), pid);
  }
};
