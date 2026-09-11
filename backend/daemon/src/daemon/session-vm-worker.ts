import {
  environmentEnabled,
  type SessionEnvironment,
} from "../../../../core/src/session-environment.ts";
import { normalizeExtraHosts } from "../../../../runtime/src/session-vm/network-policy.ts";
/** Opt-in VM launcher using the existing connector WorkerProcess contract. */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArtifact } from "../../../../runtime/src/packaged/artifact.ts";
import { readRecovery, recoverSessionVm } from "../../../../runtime/src/session-vm/recovery.ts";
import {
  finishSessionState,
  lockSessionState,
} from "../../../../runtime/src/session-vm/persistence.ts";
import { workspaceMounts } from "../../../../runtime/src/packaged/workspace.ts";
import { reapVm, type VmBinding } from "../../../../runtime/src/packaged/vm.ts";
import { cleanupSessionVm } from "../../../../runtime/src/session-vm/cleanup.ts";
import { readSessionDisks } from "../../../../runtime/src/session-vm/disks.ts";
import { repoBaseDirectory } from "../../../../runtime/src/session-vm/repo-base.ts";
import type { WorkerProcess } from "./worker-launch.ts";
import {
  sessionAuth,
  writeSessionAuth,
  type SessionAuth,
} from "../../../../runtime/src/session-vm/auth.ts";

export interface SessionVmOptions {
  workspace: string;
  artifact: string;
  smolvm: string;
  auth?: SessionAuth;
  /** Shared by sessions using the same provider profile; caller owns its lifetime. */
  authOwner?: {
    current(force?: boolean): Promise<SessionAuth>;
    subscribe(
      write: (value: SessionAuth) => Promise<void>,
      expired: () => void,
    ): Promise<() => Promise<void>>;
  };
  extraAllowedHosts?: string[];
  environment?: SessionEnvironment;
  providerHosts?: string[];
  sessionDirectory?: string;
  /** Foreground repo preparation: no provider capabilities, raw setup output. */
  preparationOnly?: boolean;
  repoRoot?: string;
  mcpRelays?: Array<{ port: number; guestPort: number }>;
}
export interface SessionVmStatus {
  phase: string;
  execPid?: number;
  network: Array<{ host: string; allowed: boolean }>;
}
const remove = async (path: string) => {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};
export const launchSessionVm = async (
  options: SessionVmOptions,
): Promise<
  WorkerProcess & {
    binding: VmBinding;
    status(): Promise<SessionVmStatus>;
    exitCode: Promise<number>;
    diagnostics?: ReadableStream<Uint8Array>;
  }
> => {
  const extraAllowedHosts = normalizeExtraHosts(options.extraAllowedHosts);
  if (
    options.preparationOnly &&
    (options.authOwner || Object.keys(options.auth ?? {}).length || options.mcpRelays?.length)
  )
    throw new Error("Repo preparation must not receive provider credentials or MCP endpoints");
  if (options.auth && options.authOwner)
    throw new Error("Choose static auth or a credential owner");
  const auth = sessionAuth(
    options.authOwner ? await options.authOwner.current() : (options.auth ?? {}),
  );
  const artifact = await Deno.realPath(options.artifact);
  const smolvm = await Deno.realPath(options.smolvm);
  const workspace = await Deno.realPath(options.workspace);
  const mounts = await workspaceMounts(workspace, options.repoRoot);
  const manifest = await inspectArtifact(artifact);
  try {
    if ((await Deno.readTextFile(join(artifact, "claude-session-version"))).trim() !== "2")
      throw new Error("incompatible runtime");
  } catch {
    throw new Error(
      "Session VM runtime is missing or incompatible; upgrade the Loom package, or rebuild the configured provider runtime with this Loom version",
    );
  }
  if (environmentEnabled(options.environment)) {
    try {
      if ((await Deno.readTextFile(join(artifact, "session-environment-version"))).trim() !== "2")
        throw new Error();
    } catch {
      throw new Error(
        "Session environment requires a rebuilt provider runtime; upgrade Loom or run loom runtime update",
      );
    }
  }
  let sessionDirectory: string | undefined;
  let savedDisks = false;
  if (options.sessionDirectory) {
    await Deno.mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
    sessionDirectory = await Deno.realPath(options.sessionDirectory);
    if (
      sessionDirectory === workspace ||
      sessionDirectory.startsWith(workspace + "/") ||
      /[:,;|\n\0]/.test(sessionDirectory)
    )
      throw new Error("Session history must be outside the worktree");
    savedDisks = await readSessionDisks(join(sessionDirectory, "disks"), {
      artifact,
      smolvm,
      writableNix: options.environment?.nix === true,
    });
  }
  const state = await Deno.realPath(
    await Deno.makeTempDir({
      dir: "/tmp",
      // smolvm uses HOME/Library/Caches on macOS, regardless of XDG_CACHE_HOME.
      // Leave room for its VM ID and control socket within Darwin's 104-byte limit.
      prefix: Deno.build.os === "darwin" ? "loom-svm-" : "loom-session-vm-",
    }),
  );
  const binding = {
    version: 1 as const,
    artifact,
    smolvm,
    workspace,
    manifest,
    state,
    token: crypto.randomUUID(),
    ...(options.environment?.nix ? { writableNix: true } : {}),
    mounts,
    ...(sessionDirectory ? { sessionDirectory } : {}),
    ...(sessionDirectory && (savedDisks || environmentEnabled(options.environment))
      ? { persistentDisks: true }
      : {}),
    ...(options.mcpRelays ? { mcpRelays: options.mcpRelays } : {}),
    ...(options.preparationOnly ? { preparationOnly: true } : {}),
    ...(options.repoRoot ? { repoBaseDirectory: repoBaseDirectory(options.repoRoot) } : {}),
  };
  try {
    const root = new URL("../../../../", import.meta.url);
    const child = spawn(
      Deno.execPath(),
      [
        "run",
        "-A",
        "--no-prompt",
        "--cached-only",
        "--frozen",
        "--node-modules-dir=manual",
        `--config=${fileURLToPath(new URL("deno.json", root))}`,
        fileURLToPath(new URL("runtime/src/session-vm/supervisor.ts", root)),
      ],
      {
        cwd: state,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          ...(Deno.env.get("DENO_DIR") ? { DENO_DIR: Deno.env.get("DENO_DIR")! } : {}),
        },
      },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    // A private bootstrap frame precedes the unchanged guest worker protocol.
    // Credentials never enter argv, environment, logs, or an unsupervised file.
    child.stdin.on("error", () => {});
    child.stdin.write(
      JSON.stringify({
        binding,
        extraAllowedHosts,
        environment: options.environment,
        providerHosts: normalizeExtraHosts(options.providerHosts ?? ["api.anthropic.com"]),
        auth,
      }) + "\n",
    );
    if (!options.preparationOnly) child.stderr.on("data", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = new AbortController();
    void exited.then(
      () => ended.abort(),
      () => ended.abort(),
    );
    let unsubscribe: (() => Promise<void>) | undefined;
    let subscribing: Promise<void> | undefined;
    let publication: Promise<void> = Promise.resolve();
    const killGroup = () => {
      if (!child.pid) return;
      try {
        Deno.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    };
    let cleanup: Promise<void> | undefined;
    const clean = () =>
      (cleanup ??= (async () => {
        await exited.catch(() => {});
        clearTimeout(timer);
        await unsubscribe?.();
        await publication.catch(() => {});
        if (sessionDirectory && (await readRecovery(sessionDirectory))?.token === binding.token) {
          const lock = await lockSessionState(sessionDirectory);
          try {
            const record = await readRecovery(sessionDirectory);
            if (record?.token === binding.token) {
              await recoverSessionVm(sessionDirectory);
              return;
            }
          } finally {
            lock.close();
          }
        }
        // A killed supervisor cannot reap: stop its native CLI group before fallback.
        if (!sessionDirectory) killGroup();
        try {
          await Deno.stat(state);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            if (sessionDirectory) await finishSessionState(sessionDirectory, binding.token);
            return;
          }
          throw error;
        }
        await cleanupSessionVm({
          stop: async () => {},
          egress: async () => {},
          credentials: () => remove(join(state, "private")),
          reap: () => reapVm(binding),
          state: async () => {
            await remove(state);
            if (sessionDirectory) await finishSessionState(sessionDirectory, binding.token);
          },
        });
      })().catch((error) => {
        cleanup = undefined;
        throw error;
      }));
    void exited.then(clean, clean).catch(() => {});
    let stopping = false;
    const worker = {
      binding,
      status: async () => JSON.parse(await Deno.readTextFile(join(state, "status.json"))),
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      exited,
      pid: child.pid ?? -1,
      exitCode: exited.then(() => child.exitCode ?? 1),
      ...(options.preparationOnly
        ? { diagnostics: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array> }
        : {}),
      terminate() {
        if (stopping) return;
        stopping = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        timer = setTimeout(killGroup, 20_000);
      },
      cleanup: clean,
    };
    if (options.authOwner) {
      subscribing = (async () => {
        // Wait until the supervisor has written its initial credential snapshot.
        const deadline = Date.now() + 15_000;
        for (;;) {
          if (ended.signal.aborted) return;
          try {
            await Deno.stat(join(state, "private/auth.json"));
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          if (Date.now() > deadline) throw new Error("Session credentials were not initialized");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        unsubscribe = await options.authOwner!.subscribe(
          async (value) => {
            if (ended.signal.aborted) return;
            publication = writeSessionAuth(join(state, "private"), value);
            await publication;
          },
          () => worker.terminate(),
        );
        if (ended.signal.aborted) await unsubscribe();
      })();
      void subscribing.catch(() => worker.terminate());
    }
    return worker;
  } catch (error) {
    await remove(state);
    throw error;
  }
};
