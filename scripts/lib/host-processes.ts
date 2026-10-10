/**
 * Host process inspection for real-VM scripts' lookup and leak checks: /proc on
 * Linux, ps and lsof on macOS, which has no /proc. Only this user's processes are
 * visible on macOS; the scripts only ever look for their own.
 */
import { join } from "node:path";

export interface HostProcess {
  pid: number;
  /** argv. On macOS ps joins it with spaces, so arguments containing spaces are split. */
  argv: string[];
  /**
   * Command line and, when requested, environment (Linux) or open file paths
   * (macOS, where environments are hidden), for substring checks.
   */
  text: string;
  /** Working directory, when requested and readable. */
  cwd?: string | undefined;
  /** Terminal device of stdin (Linux) or the controlling terminal (macOS), when requested. */
  tty?: string | undefined;
}

export interface HostProcessFields {
  environment?: boolean;
  cwd?: boolean;
  tty?: boolean;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const linuxProcesses = async (fields: HostProcessFields) => {
  const found: HostProcess[] = [];
  for await (const entry of Deno.readDir("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    const at = (name: string) => join("/proc", entry.name, name);
    const cmdline = await Deno.readTextFile(at("cmdline")).catch(() => "");
    const environ = fields.environment
      ? await Deno.readTextFile(at("environ")).catch(() => "")
      : "";
    const process: HostProcess = {
      pid: Number(entry.name),
      argv: cmdline.split("\0").filter((arg, i, all) => arg || i < all.length - 1),
      text: cmdline + "\0" + environ,
    };
    if (fields.cwd) process.cwd = await Deno.readLink(at("cwd")).catch(() => undefined);
    if (fields.tty) process.tty = await Deno.readLink(at("fd/0")).catch(() => undefined);
    found.push(process);
  }
  return found;
};

const run = async (command: string, args: string[]) => {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  // lsof exits 1 when some selected process has no matching file; its output still counts.
  if (!result.success && command !== "/usr/sbin/lsof")
    throw new Error(`${command} failed: ${decode(result.stderr)}`);
  return decode(result.stdout);
};

/** `ps -o pid=,<column>=` lines, keyed by PID. */
const psColumn = async (flags: string[], column: string) => {
  const rows = new Map<number, string>();
  const text = await run("/bin/ps", [...flags, "-ww", "-o", `pid=,${column}=`]);
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+) (.*)$/);
    if (match) rows.set(Number(match[1]), match[2]!);
  }
  return rows;
};

const darwinProcesses = async (fields: HostProcessFields) => {
  const user = ["-U", String(Deno.uid())];
  const commands = await psColumn(user, "command");
  const ttys = fields.tty ? await psColumn(user, "tty") : undefined;
  const cwds = new Map<number, string>();
  const files = new Map<number, string[]>();
  if (fields.cwd || fields.environment) {
    // macOS hides other processes' environments, even from their owner's ps -E;
    // their open files (sockets, logs, mounts) stand in for them.
    const descriptors = fields.environment ? [] : ["-d", "cwd"];
    const lsof = ["-n", "-P", "-a", "-u", String(Deno.uid()), ...descriptors, "-F", "pfn"];
    const text = await run("/usr/sbin/lsof", lsof);
    let pid = 0;
    let fd = "";
    for (const line of text.split("\n")) {
      const value = line.slice(1);
      if (line.startsWith("p")) pid = Number(value);
      else if (line.startsWith("f")) fd = value;
      else if (line.startsWith("n") && pid) {
        if (fd === "cwd") cwds.set(pid, value);
        files.set(pid, [...(files.get(pid) ?? []), value]);
      }
    }
  }
  return [...commands].map(([pid, command]): HostProcess => {
    const tty = ttys?.get(pid)?.trim();
    return {
      pid,
      argv: command.split(" "),
      text: fields.environment ? [command, ...(files.get(pid) ?? [])].join("\0") : command,
      ...(fields.cwd && cwds.has(pid) ? { cwd: cwds.get(pid) } : {}),
      ...(tty && tty !== "??" ? { tty: "/dev/" + tty } : {}),
    };
  });
};

/** This host's processes (on macOS, this user's), except the calling one. */
export const hostProcesses = async (fields: HostProcessFields = {}): Promise<HostProcess[]> =>
  (Deno.build.os === "darwin"
    ? await darwinProcesses(fields)
    : await linuxProcesses(fields)
  ).filter((process) => process.pid !== Deno.pid);

/** Processes still referencing one of the paths in argv, environment or (optionally) cwd. */
export const processesUsing = async (paths: string[], { cwd = false } = {}) => {
  const found: string[] = [];
  for (const process of await hostProcesses({ environment: true, cwd })) {
    if (
      paths.some((path) => process.text.includes(path)) ||
      (process.cwd !== undefined && paths.includes(process.cwd))
    )
      found.push(`${process.pid} ${process.argv.join(" ")}`);
  }
  return found;
};

/** The session VM supervisor, which runs in its VM's runtime state directory. */
export const supervisorPid = async (state: string) => {
  for (const process of await hostProcesses({ cwd: true }))
    if (process.text.includes("session-vm/supervisor.ts") && process.cwd === state)
      return process.pid;
};

/**
 * Set another terminal's window size: GNU stty `-F` on Linux; on macOS the system's
 * BSD stty `-f`, named absolutely since a Nix shell may put GNU stty first on PATH.
 */
export const resizeTerminal = (tty: string, rows: number, cols: number) =>
  new Deno.Command(Deno.build.os === "darwin" ? "/bin/stty" : "stty", {
    args: [
      Deno.build.os === "darwin" ? "-f" : "-F",
      tty,
      "rows",
      String(rows),
      "cols",
      String(cols),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

/**
 * Run a shell command line on a fresh PTY with script(1), passing its exit status
 * through: util-linux on Linux, BSD script (whose `-e` is implied) on macOS.
 */
export const ptyCommand = (commandLine: string): { command: string; args: string[] } => {
  if (Deno.build.os === "darwin")
    return { command: "/usr/bin/script", args: ["-q", "/dev/null", "/bin/sh", "-c", commandLine] };
  const command = (Deno.env.get("PATH") ?? "")
    .split(":")
    .map((dir) => join(dir, "script"))
    .find((path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    });
  if (!command) throw new Error("util-linux script is required");
  return { command, args: ["-q", "-e", "-c", commandLine, "/dev/null"] };
};
