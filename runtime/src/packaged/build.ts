/**
 * Build an Apple Silicon guest runtime on first use. A package without a pinned
 * runtime for its guest source ships the pinned recipe's own builder instead
 * (flake.nix `runtimeBuild`): a disposable smolvm VM with network access but
 * no credentials or host configuration, seeing only the guest source and an
 * output directory. Loom adds the result to the Nix store, so sessions still
 * receive an immutable store path, and keeps it under the source's identity
 * while any installed Loom has used it lately.
 */
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  builtRuntimeHome,
  builtRuntimePath,
  inspectArtifact,
  runtimeBuildFor,
  runtimeHome,
  type RuntimeBuild,
} from "./artifact.ts";
import { supervisorGo, supervisorLocked } from "./build-supervisor.ts";
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
   * line; resolves with success once the builder has exited. The builder outlives
   * Loom: it holds `lock` from before it starts until it has exited, and
   * {@link succeeded}`(output)` appears once it has succeeded, so a later Loom can
   * wait for it and finish the build.
   */
  run(
    builder: string,
    output: string,
    log: string,
    lock: string,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Add `directory` to the Nix store and root it at `link`; returns the store path. */
  register(directory: string, link: string): Promise<string>;
  inspect(artifact: string): Promise<unknown>;
  /** Free bytes on the filesystem holding `path`, when known. */
  freeBytes(path: string): Promise<number | undefined>;
}

/** The marker a successful builder leaves beside its output. */
export const succeeded = (output: string) => `${output}.ok`;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
const supervisor = fileURLToPath(new URL("./build-supervisor.ts", import.meta.url));
/** The arguments that run {@link supervisor} for a builder. */
export const supervisorCommand = (builder: string, output: string, log: string, lock: string) => [
  "run",
  "--no-config",
  "--no-lock",
  "--no-prompt",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  supervisor,
  lock,
  builder,
  output,
  log,
  succeeded(output),
];
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
  async run(builder, output, log, lock, onLine, signal) {
    // The supervisor holds `lock` for the builder's whole life and starts it with
    // nothing of Loom's environment; it needs only a PATH to stop the builder.
    // Darwin's Unix socket limit needs the builder's VM state under a short path.
    const child = new Deno.Command(Deno.execPath(), {
      args: supervisorCommand(builder, output, log, lock),
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: "/tmp",
        DENO_NO_UPDATE_CHECK: "1",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    // SIGTERM stops the builder's foreground VM command so its trap stops and
    // deletes the VM, or, before the builder starts, ends the supervisor. Loom
    // exiting mid-build stops it the same way.
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* exited */
      }
    };
    signal?.addEventListener("abort", stop, { once: true });
    globalThis.addEventListener("unload", stop);
    try {
      // The builder starts only once it holds the lock: from then on a later Loom
      // sees it running whatever happens to this one.
      const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let reply = "";
      while (!reply.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        reply += value;
      }
      await reader.cancel().catch(() => {});
      const writer = child.stdin.getWriter();
      if (reply.split("\n")[0] === supervisorLocked)
        await writer.write(new TextEncoder().encode(`${supervisorGo}\n`)).catch(() => {});
      await writer.close().catch(() => {});
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

/** How long a built runtime stays after its last use, for every installed Loom using it. */
export const builtRuntimeRetentionMs = 14 * 24 * 60 * 60 * 1000;
const usedMarker = (link: string) => `${link}.used`;
/** Record a use of the runtime at `link`; cleanup keeps recently used runtimes. */
const markUsed = async (link: string) => {
  const marker = usedMarker(link);
  const now = new Date();
  try {
    // Rewriting an empty file need not touch its modification time; setting it does.
    await Deno.writeTextFile(marker, "", { create: true, append: true, mode: 0o600 });
    await Deno.utime(marker, now, now);
  } catch {
    /* Unrecorded, the runtime is merely kept for less long. */
  }
};

/**
 * Remove built runtimes other than `keep`, the most recently used one and any
 * used within `retainMs`: another installed Loom (loom-isolate at another
 * revision, say) may still start sessions on one, and removing it would make each
 * rebuild the other's. The caller holds the VM maintenance lock.
 */
export const removeBuiltRuntimes = async (
  home: string,
  keep: (link: string, artifact: string | undefined) => boolean,
  dryRun = false,
  retainMs = 0,
  now = Date.now(),
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
  // A runtime built before uses were recorded was last used when it was built.
  const lastUse = async (link: string) =>
    (
      (await Deno.stat(usedMarker(link)).catch(() => undefined)) ?? (await Deno.lstat(link))
    ).mtime?.getTime() ?? 0;
  const used = new Map<string, number>();
  for (const entry of entries) {
    if (!/^[a-f0-9]{32}$/.test(entry.name) || !entry.isSymlink) continue;
    const link = join(directory, entry.name);
    used.set(link, await lastUse(link));
  }
  let newest: string | undefined;
  for (const [link, at] of used) if (!newest || at > used.get(newest)!) newest = link;
  for (const entry of entries) {
    const identity = /^([a-f0-9]{32})(\.log|\.used)?$/.exec(entry.name);
    if (!identity || (identity[2] ? !entry.isFile : !entry.isSymlink)) continue;
    const link = join(directory, identity[1]!);
    const artifact = await Deno.realPath(link).catch(() => undefined);
    const at = used.get(link);
    if (link === newest || (at !== undefined && now - at < retainMs) || keep(link, artifact))
      continue;
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
/**
 * Scratch output in the shared temporary directory, named for the runtime home
 * whose lock covers it: another home's builds are none of this one's business.
 */
const scratchPrefix = (home: string) =>
  `loom-runtime-build-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}-`;
const writable = async (path: string) => {
  const info = await Deno.lstat(path);
  if (info.isSymlink) return;
  await Deno.chmod(path, (info.mode ?? 0) | 0o200);
  if (info.isDirectory)
    for await (const entry of Deno.readDir(path)) await writable(join(path, entry.name));
};
const removeScratch = async (path: string) => {
  await writable(path).catch(() => {});
  await Deno.remove(path, { recursive: true }).catch(() => {});
};
const exists = (path: string) =>
  Deno.lstat(path).then(
    () => true,
    () => false,
  );

/**
 * The lock a runtime home's builder holds, through its supervisor, from before
 * it starts until it has exited (build-supervisor.ts). The builder outlives the
 * Loom that started it, so whether a build is under way is whether this lock is
 * held; nothing compares process ids or start times. Separate from the lock
 * Loom processes take to build, which goes with its holder.
 */
export const builderLock = (home: string) => join(builtRuntimeHome(home), ".builder.lock");
/** How often a later Loom checks whether an earlier builder still runs: one `flock`. */
const builderPollMs = 1_000;
/** The builder lock once no builder holds it. */
const builderExited = async (home: string, signal?: AbortSignal) => {
  for (;;) {
    const lock = await tryLock(builderLock(home));
    if (lock) return lock;
    await sleep(builderPollMs, signal);
  }
};

/**
 * The build a runtime home's lock holder starts, written before its builder may
 * start: the next holder finds its output and log, and knows its scratch output
 * is free to go once no builder holds {@link builderLock}.
 */
interface BuildRecord {
  identity: string;
  scratch: string;
  since: number;
}
const buildRecord = (home: string) => join(builtRuntimeHome(home), ".build");
const readBuildRecord = async (
  home: string,
  temporary: string,
): Promise<BuildRecord | undefined> => {
  let value: Partial<BuildRecord> | null;
  try {
    value = JSON.parse(await Deno.readTextFile(buildRecord(home)));
  } catch {
    return undefined;
  }
  const { identity, scratch, since } = value ?? {};
  if (
    typeof identity !== "string" ||
    !/^[a-f0-9]{32}$/.test(identity) ||
    typeof scratch !== "string" ||
    join(temporary, basename(scratch)) !== scratch ||
    !basename(scratch).startsWith(scratchPrefix(home)) ||
    typeof since !== "number"
  )
    return undefined;
  return { identity, scratch, since };
};

/** A build's progress: its latest output line, at most every `intervalMs`, and each minute. */
const buildProgress = (
  onProgress: (message: string) => void,
  intervalMs: number,
  since = Date.now(),
) => {
  const tail: string[] = [];
  let reported = 0;
  let latest = "";
  const report = () =>
    onProgress(
      `Building the VM runtime (${elapsed(Date.now() - since)} elapsed)${latest ? `: ${latest}` : "…"}`,
    );
  const ticker = setInterval(report, 60_000);
  return {
    tail,
    onLine(line: string) {
      const text = line.trim();
      if (!text) return;
      tail.push(text);
      if (tail.length > 40) tail.shift();
      latest = text.length > 120 ? text.slice(0, 117) + "…" : text;
      if (Date.now() - reported >= intervalMs) {
        reported = Date.now();
        report();
      }
    },
    elapsed: () => elapsed(Date.now() - since),
    close: () => clearInterval(ticker),
  };
};

/**
 * Settle whatever build an earlier holder of the lock left. A builder still
 * running is waited for; one that succeeded is registered as its Loom would have
 * done. Only then is this home's scratch output an interrupted build's, and goes.
 * The caller holds the build lock.
 */
const settleEarlierBuild = async (
  home: string,
  temporary: string,
  dependencies: BuildDependencies,
  onProgress: (message: string) => void,
  progressIntervalMs: number,
  signal?: AbortSignal,
) => {
  const record = await readBuildRecord(home, temporary);
  let idle = await tryLock(builderLock(home));
  if (!idle) {
    onProgress("Waiting for the VM runtime build an earlier Loom process started…");
    const exited = builderExited(home, signal);
    // `follow` only needs to know when to stop; an abort is rethrown below.
    const stopped = exited.catch(() => {});
    const progress = buildProgress(onProgress, progressIntervalMs, record?.since);
    try {
      if (record) {
        const log = `${join(builtRuntimeHome(home), record.identity)}.log`;
        await Deno.writeTextFile(log, "", { append: true, mode: 0o600 });
        await follow(log, progress.onLine, stopped);
      } else await stopped;
    } catch (error) {
      void exited.then(
        (lock) => lock.close(),
        () => {},
      );
      throw error;
    } finally {
      progress.close();
    }
    idle = await exited;
  }
  try {
    await finishEarlierBuild(home, temporary, record, dependencies, onProgress);
  } finally {
    idle.close();
  }
};
/** Register what a finished earlier builder succeeded in, then clear its scratch output. */
const finishEarlierBuild = async (
  home: string,
  temporary: string,
  record: BuildRecord | undefined,
  dependencies: BuildDependencies,
  onProgress: (message: string) => void,
) => {
  if (record) {
    const link = join(builtRuntimeHome(home), record.identity);
    const output = join(record.scratch, "lvm");
    if ((await exists(succeeded(output))) && !(await exists(link))) {
      onProgress("Adding the VM runtime to the Nix store…");
      try {
        await dependencies.inspect(await dependencies.register(output, link));
        await markUsed(link);
        await Deno.remove(`${link}.log`).catch(() => {});
      } catch {
        // Its output is unusable after all: the identity builds again when needed.
        await Deno.remove(link).catch(() => {});
      }
    }
  }
  const prefix = scratchPrefix(home);
  for await (const entry of Deno.readDir(temporary)) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory) continue;
    const stale = join(temporary, entry.name);
    if ((await Deno.lstat(stale)).uid !== Deno.uid()) continue;
    await removeScratch(stale);
  }
  await Deno.remove(buildRecord(home)).catch(() => {});
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
 * for one build instead of running their own, as does a caller arriving after the
 * Loom that started a build died: its builder carries on.
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
  const link = builtRuntimePath(build, home);
  const existing = await builtRuntime(build, home, dependencies.inspect);
  if (existing) {
    await markUsed(link);
    return existing;
  }
  const directory = builtRuntimeHome(home);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  let lock = await tryLock(join(directory, ".lock"));
  if (!lock) onProgress("Waiting for another Loom process to finish building the VM runtime…");
  while (!lock) {
    await sleep(1_000, signal);
    lock = await tryLock(join(directory, ".lock"));
  }
  try {
    await settleEarlierBuild(home, temporary, dependencies, onProgress, progressIntervalMs, signal);
    const built = await builtRuntime(build, home, dependencies.inspect);
    if (built) {
      await markUsed(link);
      return built;
    }
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
    const logPath = `${link}.log`;
    await Deno.writeTextFile(logPath, "", { mode: 0o600 });
    const scratch = await Deno.makeTempDir({ dir: temporary, prefix: scratchPrefix(home) });
    const progress = buildProgress(onProgress, progressIntervalMs);
    try {
      onProgress(
        "Building the VM runtime for this Loom version. The first start after installing or upgrading Loom can take 15–60 minutes; later starts reuse it.",
      );
      const output = join(scratch, "lvm");
      // Recorded before the builder may start, so that a later Loom finds its work.
      const record: BuildRecord = { identity: build.identity, scratch, since: Date.now() };
      await Deno.writeTextFile(buildRecord(home), JSON.stringify(record), { mode: 0o600 });
      const success = await dependencies.run(
        build.builder,
        output,
        logPath,
        builderLock(home),
        progress.onLine,
        signal,
      );
      signal?.throwIfAborted();
      if (!success) {
        const kind = classifyBuildFailure(progress.tail.join("\n"));
        throw new Error(
          `${buildFailures[kind]} Retry with loom runtime update or by starting the session again. Build log: ${logPath}` +
            (kind === "builder" ? `\n${progress.tail.slice(-10).join("\n")}` : ""),
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
      await markUsed(link);
      await Deno.remove(logPath).catch(() => {});
      onProgress(`VM runtime ready after ${progress.elapsed()}.`);
      // Runtimes no installed Loom has used lately go once no VM may still use them.
      const maintenance = await vmMaintenanceLock(true, temporary).catch(() => undefined);
      if (maintenance)
        try {
          if (!(await retainedVmStates(temporary)).length)
            await removeBuiltRuntimes(
              home,
              (path) => path === link,
              false,
              builtRuntimeRetentionMs,
            );
        } catch {
          /* Cleanup is retried by loom runtime prune. */
        } finally {
          maintenance.close();
        }
      return artifact;
    } finally {
      progress.close();
      // `run` returns once the builder has exited; should it have failed with the
      // builder still running, the scratch output stays for the next lock holder.
      const idle = await tryLock(builderLock(home));
      if (idle)
        try {
          await removeScratch(scratch);
          await Deno.remove(buildRecord(home)).catch(() => {});
        } finally {
          idle.close();
        }
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
