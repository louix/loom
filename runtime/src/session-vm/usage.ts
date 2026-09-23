/** On-demand guest counters. Inspection never starts or recovers a VM. */
import type { VmRecord } from "./inventory.ts";
import { vmEnvironment } from "../packaged/vm.ts";

export interface VmUsage {
  cpuPercent: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
}

export const vmUsageCommand = `head -n 1 /proc/stat
sleep 0.25
head -n 1 /proc/stat
cat /proc/meminfo
printf '\\nDISK\\n'
df -kP /storage 2>/dev/null || true`;

export const parseVmUsage = (text: string): VmUsage => {
  const cpus = [...text.matchAll(/^cpu\s+([\d ]+)$/gm)].map((m) =>
    m[1]!.trim().split(/\s+/).slice(0, 8).map(Number),
  );
  let cpuPercent: number | null = null;
  if (cpus.length === 2 && cpus.every((c) => c.length >= 4)) {
    const [a, b] = cpus as [number[], number[]];
    const elapsed = b.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0);
    const idle = b[3]! + (b[4] ?? 0) - (a[3]! + (a[4] ?? 0));
    if (elapsed > 0 && idle >= 0 && idle <= elapsed)
      cpuPercent = (100 * (elapsed - idle)) / elapsed;
  }
  const memory = (key: string) => {
    const m = text.match(new RegExp("^" + key + ":\\s+(\\d+) kB$", "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const memoryTotal = memory("MemTotal");
  const available = memory("MemAvailable");
  const disk = text.split("\nDISK\n")[1]?.trim().split("\n")[1]?.trim().split(/\s+/);
  const diskTotal = disk && /^\d+$/.test(disk[1] ?? "") ? Number(disk[1]) * 1024 : null;
  const diskUsed = disk && /^\d+$/.test(disk[2] ?? "") ? Number(disk[2]) * 1024 : null;
  return {
    cpuPercent,
    memoryTotal,
    memoryUsed:
      memoryTotal !== null && available !== null && available <= memoryTotal
        ? memoryTotal - available
        : null,
    diskTotal,
    diskUsed,
  };
};

export const sampleVmUsage = async (vm: VmRecord, signal: AbortSignal): Promise<VmUsage> => {
  if (vm.state !== "running" || !vm.smolvm) throw new Error("VM metrics unavailable");
  const cancel = new AbortController();
  const abort = () => cancel.abort();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 2000);
  const run = async (args: string[]) => {
    const child = new Deno.Command(vm.smolvm!, {
      args,
      clearEnv: true,
      env: vmEnvironment(vm.paths.state),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: cancel.signal,
    }).spawn();
    let output = "";
    const drain = async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk, { stream: true });
        if (output.length > 65536) {
          cancel.abort();
          throw new Error("VM metrics response too large");
        }
      }
    };
    const [status] = await Promise.all([child.status, drain()]);
    if (!status.success) throw new Error("VM metrics unavailable");
    return output;
  };
  try {
    const machines: unknown = JSON.parse(await run(["machine", "ls", "--json"]));
    if (!Array.isArray(machines) || machines.length !== 1)
      throw new Error("VM metrics unavailable");
    const name: unknown = machines[0]?.name;
    if (typeof name !== "string" || !/^(loom-session|vm-[a-z0-9]+)$/.test(name))
      throw new Error("VM metrics unavailable");
    return parseVmUsage(
      await run([
        "machine",
        "exec",
        "--name",
        name,
        "--timeout",
        "1s",
        "-w",
        "/",
        "--",
        "/bin/sh",
        "-c",
        vmUsageCommand,
      ]),
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};
