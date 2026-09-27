/** Linux host VMM counters; never enumerate descriptor targets or credential contents. */
export interface HostFileUsage {
  pid: number;
  open: number | null;
  softLimit: number | "unlimited" | null;
  hardLimit: number | "unlimited" | null;
}

export const parseFileLimits = (text: string): Pick<HostFileUsage, "softLimit" | "hardLimit"> => {
  const match = text.match(/^Max open files\s+(\d+|unlimited)\s+(\d+|unlimited)\s+files\s*$/m);
  const value = (s: string | undefined): number | "unlimited" | null => {
    if (s === "unlimited") return s;
    const n = s === undefined ? NaN : Number(s);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  return { softLimit: value(match?.[1]), hardLimit: value(match?.[2]) };
};

/** A PID can disappear or be recycled during enumeration. Discard such samples. */
export const sampleHostFileUsage = async (
  pid: unknown,
  signal: AbortSignal,
  procRoot = "/proc",
): Promise<HostFileUsage | null> => {
  signal.throwIfAborted();
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
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
    const limits = parseFileLimits(await Deno.readTextFile(directory + "/limits").catch(() => ""));
    let open: number | null = null;
    try {
      let count = 0;
      for await (const entry of Deno.readDir(directory + "/fd")) {
        signal.throwIfAborted();
        if (/^\d+$/.test(entry.name)) count++;
      }
      open = count;
    } catch {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (before !== (await identity())) return null;
    return { pid, open, ...limits };
  } catch {
    signal.throwIfAborted();
    return null;
  }
};
