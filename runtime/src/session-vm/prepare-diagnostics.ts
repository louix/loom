import { join } from "node:path";
import { statfs } from "node:fs/promises";

/** Serialized samples: diagnostics never queue up behind a slow filesystem. */
export const monitorPreparation = (sample: () => Promise<string>): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const text = await sample();
      if (!stopped) console.error(`[prepare resources] ${text}`);
    } catch {
      // A missing diagnostic must not fail preparation.
    }
    if (!stopped)
      timer = setTimeout(() => {
        void run();
      }, 30_000);
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

export const guestPreparationResources = async (): Promise<string> => {
  const [memory, vmstat] = await Promise.all([
    Deno.readTextFile("/proc/meminfo"),
    Deno.readTextFile("/proc/vmstat"),
  ]);
  const memoryValue = (name: string) =>
    memory.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? "?";
  const disks = await Promise.all(
    ["/storage", Deno.cwd()].map(async (path) => {
      try {
        const disk = await statfs(path);
        return `${path === "/storage" ? "storage" : "worktree"}_free_MiB=${Math.floor((disk.bavail * disk.bsize) / 1048576)} free_inodes=${disk.ffree}`;
      } catch {
        return "disk statistics unavailable";
      }
    }),
  );
  return `guest MemAvailable_kB=${memoryValue("MemAvailable")} MemTotal_kB=${memoryValue("MemTotal")} SwapFree_kB=${memoryValue("SwapFree")} oom_kill=${vmstat.match(/^oom_kill (\d+)/m)?.[1] ?? "?"} ${disks.join("; ")}`;
};

/** Capture the original Linux VM process identity; never start or signal a VM. */
export const hostPreparationResources = async (
  machineDirectory: string,
): Promise<() => Promise<string>> => {
  if (Deno.build.os !== "linux")
    return async () => "host process sampling unavailable on this platform";
  try {
    const pid = (await Deno.readTextFile(join(machineDirectory, "agent.pid"))).split("\n")[0]!;
    if (!/^[1-9]\d*$/.test(pid)) throw new Error("Invalid PID");
    const readStat = async () => {
      const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
      return stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
    };
    const identity = (await readStat())[19];
    return async () => {
      try {
        const stat = await readStat();
        if (stat[19] !== identity) return `host VM pid=${pid}: original process gone (PID reused)`;
        const status = await Deno.readTextFile(`/proc/${pid}/status`);
        const rss = status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? "?";
        return `host VM pid=${pid} state=${stat[0]} RSS_kB=${rss}`;
      } catch (error) {
        return error instanceof Deno.errors.NotFound
          ? `host VM pid=${pid}: process gone`
          : `host VM pid=${pid}: process statistics unavailable`;
      }
    };
  } catch {
    return async () => "host VM process identity unavailable";
  }
};

/** Read before reaping: smolvm deletes the console along with the machine.
 * Only explicit, credential-free preparation may expose this raw guest output.
 */
export const preparationConsoleTail = async (machineDirectory: string): Promise<string> => {
  const limit = 16 * 1024;
  const path = join(machineDirectory, "agent-console.log");
  let file: Deno.FsFile | undefined;
  try {
    if (!(await Deno.lstat(path)).isFile) return "VM console log unavailable.";
    file = await Deno.open(path, { read: true });
    const size = (await file.stat()).size;
    const start = Math.max(0, size - limit);
    await file.seek(start, Deno.SeekMode.Start);
    const bytes = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null || read === 0) break;
      offset += read;
    }
    // Console text is guest-controlled. Escape terminal control characters.
    const text = new TextDecoder().decode(bytes.subarray(0, offset)).replace(
      // eslint-disable-next-line no-control-regex -- deliberately neutralize terminal controls
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
      (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    );
    return text
      ? `VM console log${start ? " (last 16 KiB)" : ""}:\n${text}`
      : "VM console log is empty; a host-side VM kill may leave no guest diagnostic.";
  } catch {
    return "VM console log unavailable.";
  } finally {
    file?.close();
  }
};
