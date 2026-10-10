/**
 * Build an Apple Silicon guest runtime on first use. A package without a pinned
 * runtime for its guest source ships the pinned recipe's own builder instead
 * (flake.nix `runtimeBuild`): a disposable smolvm VM with network access but
 * no credentials or host configuration, seeing only the guest source and an
 * output directory. Loom adds the result to the Nix store, so sessions still
 * receive an immutable store path, and keeps it under the source's identity
 * until a package with different guest source needs another.
 */
import { join } from "node:path";
import {
  builtRuntimeHome,
  builtRuntimePath,
  inspectArtifact,
  runtimeBuildFor,
  runtimeHome,
  type RuntimeBuild,
} from "./artifact.ts";
import { retainedVmStates, vmMaintenanceLock } from "./maintenance.ts";

export type BuildFailure = "network" | "space" | "builder";
/** Rough peak use: the builder VM's disk and output under /tmp, the result in /nix. */
export const buildSpace = { temporaryGiB: 20, storeGiB: 4 } as const;
export const buildFailures: Record<BuildFailure, string> = {
  network:
    "Building the VM runtime needs network access to download Linux packages (cache.nixos.org, Docker Hub). Check the connection, then retry.",
  space: `Building the VM runtime ran out of disk space. It needs about ${buildSpace.temporaryGiB} GB free under /tmp and ${buildSpace.storeGiB} GB in /nix while it builds; free space, then retry.`,
  builder: "Building the VM runtime failed.",
};
export const classifyBuildFailure = (log: string): BuildFailure => {
  if (/no space left on device|ENOSPC|disk quota exceeded|not enough (?:free )?space/i.test(log))
    return "space";
  if (
    /could(?:n't| not) resolve host|unable to download|network is unreachable|temporary failure in name resolution|connection (?:refused|reset|timed out)|failed to connect|operation timed out|TLS handshake|SSL connect error|no route to host|timeout was reached/i.test(
      log,
    )
  )
    return "network";
  return "builder";
};

export interface BuildDependencies {
  /**
   * Run the builder into `output`, writing its output to `log` and reporting each
   * line; resolves with success.
   */
  run(
    builder: string,
    output: string,
    log: string,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Add `directory` to the Nix store and root it at `link`; returns the store path. */
  register(directory: string, link: string): Promise<string>;
  inspect(artifact: string): Promise<unknown>;
  /** Free bytes on the filesystem holding `path`, when known. */
  freeBytes(path: string): Promise<number | undefined>;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
const command = async (name: string, args: string[]) => {
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command(name, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (cause) {
    throw new Error(`Cannot run ${name}; the VM runtime build needs Nix installed`, { cause });
  }
  if (!result.success) throw new Error(`${name} failed: ${decode(result.stderr)}`);
  return decode(result.stdout);
};

/** Report each line appended to `path` until `exited` settles and the file is drained. */
const follow = async (path: string, onLine: (line: string) => void, exited: Promise<unknown>) => {
  let done = false;
  void exited.finally(() => (done = true));
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(64 * 1024);
  let rest = "";
  let drained = false;
  try {
    for (;;) {
      const read = await file.read(buffer);
      if (read) {
        const parts = (rest + decoder.decode(buffer.subarray(0, read), { stream: true })).split(
          /\r?\n|\r/,
        );
        rest = parts.pop()!;
        for (const part of parts) onLine(part);
        continue;
      }
      // One more read after exit picks up whatever was written just before it.
      if (done && drained) break;
      drained = done;
      if (!done) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    rest += decoder.decode();
    if (rest) onLine(rest);
  } finally {
    file.close();
  }
};

export const buildDependencies: BuildDependencies = {
  async run(builder, output, log, onLine, signal) {
    // Only a temporary directory crosses: the builder sets its own private HOME/XDG
    // paths, and nothing from Loom's environment (credentials included) reaches it.
    // Darwin's Unix socket limit needs the builder's VM state under a short path.
    // Output goes straight to the log, never through a pipe Loom's exit would close.
    const child = new Deno.Command("/bin/sh", {
      args: ["-c", 'exec "$0" "$1" >>"$2" 2>&1', builder, output, log],
      clearEnv: true,
      env: { TMPDIR: "/tmp" },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    // Stopping the builder's foreground VM command lets its trap run at once: the
    // trap stops and deletes the VM. Loom exiting mid-build stops it the same way.
    const stop = () => {
      try {
        new Deno.Command("pkill", {
          args: ["-TERM", "-P", String(child.pid)],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        child.kill("SIGTERM");
      } catch {
        /* exited */
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    globalThis.addEventListener("unload", stop);
    try {
      await follow(log, onLine, child.status);
      return (await child.status).success;
    } finally {
      signal?.removeEventListener("abort", stop);
      globalThis.removeEventListener("unload", stop);
    }
  },
  async register(directory, link) {
    // Same name and content address as the pinned fixed-output derivation.
    const path = await command("nix-store", ["--add-fixed", "--recursive", "sha256", directory]);
    await Deno.remove(link).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await command("nix-store", ["--add-root", link, "--indirect", "--realise", path]);
    return path;
  },
  inspect: inspectArtifact,
  async freeBytes(path) {
    try {
      const output = await command("df", ["-Pk", path]);
      const available = Number(output.split("\n").at(-1)?.trim().split(/\s+/)[3]);
      return Number.isFinite(available) ? available * 1024 : undefined;
    } catch {
      return undefined;
    }
  },
};

/** The built runtime's store path, or undefined if this identity is not built. */
export const builtRuntime = async (
  build: RuntimeBuild,
  home = runtimeHome(),
  inspect: BuildDependencies["inspect"] = inspectArtifact,
): Promise<string | undefined> => {
  let artifact: string;
  try {
    artifact = await Deno.realPath(builtRuntimePath(build, home));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  await inspect(artifact);
  return artifact;
};

/**
 * Remove built runtimes other than `keep` and the newest, which, like a selected
 * runtime generation, stays for whichever installed Loom built it last.
 * The caller holds the VM maintenance lock.
 */
export const removeBuiltRuntimes = async (
  home: string,
  keep: (link: string, artifact: string | undefined) => boolean,
  dryRun = false,
): Promise<number> => {
  const directory = builtRuntimeHome(home);
  let removed = 0;
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(directory));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  let newest: { link: string; at: number } | undefined;
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}$/.test(entry.name) || !entry.isSymlink) continue;
    const link = join(directory, entry.name);
    const at = (await Deno.lstat(link)).mtime?.getTime() ?? 0;
    if (!newest || at > newest.at) newest = { link, at };
  }
  for (const entry of entries) {
    const identity = /^([a-f0-9]{32})(\.log)?$/.exec(entry.name);
    if (!identity || (identity[2] ? !entry.isFile : !entry.isSymlink)) continue;
    const link = join(directory, identity[1]!);
    const artifact = await Deno.realPath(link).catch(() => undefined);
    if (link === newest?.link || keep(link, artifact)) continue;
    // Removing a link releases its GC root; Nix frees the store path at its next collection.
    if (!dryRun) await Deno.remove(join(directory, entry.name));
    if (!identity[2]) removed++;
  }
  return removed;
};

const tryLock = async (path: string) => {
  const file = await Deno.open(path, { create: true, read: true, write: true, mode: 0o600 });
  if (await file.tryLock(true)) return file;
  file.close();
  return undefined;
};
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const scratchPrefix = "loom-runtime-build-";
const writable = async (path: string) => {
  const info = await Deno.lstat(path);
  if (info.isSymlink) return;
  await Deno.chmod(path, (info.mode ?? 0) | 0o200);
  if (info.isDirectory)
    for await (const entry of Deno.readDir(path)) await writable(join(path, entry.name));
};

export interface EnsureBuiltRuntimeOptions {
  home?: string;
  temporary?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /** Minimum interval between progress reports from builder output. */
  progressIntervalMs?: number;
  dependencies?: BuildDependencies;
}

/**
 * The runtime for `build`, building it first if this identity has none. Concurrent
 * callers (the daemon's session starts, `loom runtime update`, loom-isolate) wait
 * for one build instead of running their own.
 */
export const ensureBuiltRuntime = async (
  build: RuntimeBuild,
  options: EnsureBuiltRuntimeOptions = {},
): Promise<string> => {
  const {
    home = runtimeHome(),
    temporary = "/tmp",
    onProgress = () => {},
    signal,
    progressIntervalMs = 5_000,
    dependencies = buildDependencies,
  } = options;
  const existing = await builtRuntime(build, home, dependencies.inspect);
  if (existing) return existing;
  const directory = builtRuntimeHome(home);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  let lock = await tryLock(join(directory, ".lock"));
  if (!lock) onProgress("Waiting for another Loom process to finish building the VM runtime…");
  while (!lock) {
    await sleep(1_000, signal);
    lock = await tryLock(join(directory, ".lock"));
  }
  try {
    const built = await builtRuntime(build, home, dependencies.inspect);
    if (built) return built;
    const gib = 1024 ** 3;
    for (const [path, needed] of [
      [temporary, buildSpace.temporaryGiB],
      ["/nix/store", buildSpace.storeGiB],
    ] as const) {
      const free = await dependencies.freeBytes(path);
      if (free !== undefined && free < needed * gib)
        throw new Error(
          `Building the VM runtime needs about ${needed} GB free in ${path}; ${(free / gib).toFixed(1)} GB is available. Free space, then retry with loom runtime update.`,
        );
    }
    const link = builtRuntimePath(build, home);
    const logPath = `${link}.log`;
    await Deno.writeTextFile(logPath, "", { mode: 0o600 });
    // Holding the lock, any other scratch output is an interrupted build's.
    for await (const entry of Deno.readDir(temporary)) {
      if (!entry.name.startsWith(scratchPrefix) || !entry.isDirectory) continue;
      const stale = join(temporary, entry.name);
      if ((await Deno.lstat(stale)).uid !== Deno.uid()) continue;
      await writable(stale).catch(() => {});
      await Deno.remove(stale, { recursive: true }).catch(() => {});
    }
    const scratch = await Deno.makeTempDir({ dir: temporary, prefix: scratchPrefix });
    const started = Date.now();
    const tail: string[] = [];
    let reported = 0;
    let latest = "";
    const report = () =>
      onProgress(
        `Building the VM runtime (${elapsed(Date.now() - started)} elapsed)${latest ? `: ${latest}` : "…"}`,
      );
    const ticker = setInterval(report, 60_000);
    try {
      onProgress(
        "Building the VM runtime for this Loom version. The first start after installing or upgrading Loom can take 15–60 minutes; later starts reuse it.",
      );
      const output = join(scratch, "lvm");
      const success = await dependencies.run(
        build.builder,
        output,
        logPath,
        (line) => {
          const text = line.trim();
          if (!text) return;
          tail.push(text);
          if (tail.length > 40) tail.shift();
          latest = text.length > 120 ? text.slice(0, 117) + "…" : text;
          if (Date.now() - reported >= progressIntervalMs) {
            reported = Date.now();
            report();
          }
        },
        signal,
      );
      signal?.throwIfAborted();
      if (!success) {
        const kind = classifyBuildFailure(tail.join("\n"));
        throw new Error(
          `${buildFailures[kind]} Retry with loom runtime update or by starting the session again. Build log: ${logPath}` +
            (kind === "builder" ? `\n${tail.slice(-10).join("\n")}` : ""),
        );
      }
      onProgress("Adding the VM runtime to the Nix store…");
      const artifact = await dependencies.register(output, link);
      try {
        await dependencies.inspect(artifact);
      } catch (error) {
        await Deno.remove(link).catch(() => {});
        throw error;
      }
      await Deno.remove(logPath).catch(() => {});
      onProgress(`VM runtime ready after ${elapsed(Date.now() - started)}.`);
      // Older Loom versions' runtimes go once no VM may still use them.
      const maintenance = await vmMaintenanceLock(true, temporary).catch(() => undefined);
      if (maintenance)
        try {
          if (!(await retainedVmStates(temporary)).length)
            await removeBuiltRuntimes(home, (path) => path === link);
        } catch {
          /* Cleanup is retried by loom runtime prune. */
        } finally {
          maintenance.close();
        }
      return artifact;
    } finally {
      clearInterval(ticker);
      await writable(scratch).catch(() => {});
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  } finally {
    lock.close();
  }
};

interface SharedBuild {
  done: Promise<string>;
  listeners: Set<(message: string) => void>;
  latest?: string;
}
const building = new Map<string, SharedBuild>();

/**
 * Build `artifact` first if it is the package's on-demand runtime and not built
 * yet. Callers in one process share a build, and a caller's `signal` only stops
 * its own wait: a cancelled session start leaves the build to finish for the next.
 */
export const ensureRuntimeArtifact = async (
  artifact: string,
  options: { onProgress?: (message: string) => void; signal?: AbortSignal } = {},
  build = runtimeBuildFor(artifact),
  /** Settings for a build this call starts; tests use their own home and dependencies. */
  settings: Omit<EnsureBuiltRuntimeOptions, "onProgress" | "signal"> = {},
): Promise<void> => {
  if (!build) return;
  const { onProgress, signal } = options;
  signal?.throwIfAborted();
  let shared = building.get(build.identity);
  if (!shared) {
    const listeners = new Set<(message: string) => void>();
    const entry: SharedBuild = {
      listeners,
      done: ensureBuiltRuntime(build, {
        onProgress: (message) => {
          entry.latest = message;
          for (const listener of listeners) listener(message);
        },
        ...settings,
      }).finally(() => building.delete(build.identity)),
    };
    // Every waiter may have gone; the outcome still must not be unhandled.
    entry.done.catch(() => {});
    building.set(build.identity, (shared = entry));
  }
  if (onProgress) {
    shared.listeners.add(onProgress);
    if (shared.latest) onProgress(shared.latest);
  }
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      shared.done,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal!.reason);
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    if (onProgress) shared.listeners.delete(onProgress);
  }
};
