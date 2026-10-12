import type { ManagedProcess } from "../../../../runtime/src/process.ts";
import { escalateProcessGroup } from "@loom/core/process-group";
import { fileURLToPath } from "node:url";
import { claimWorkerScratch } from "./worker-scratch.ts";

export interface WorkerLaunchSpec {
  executable: string;
  entrypoint: string;
  configPath: string;
  cwd: string;
  env: Record<string, string>;
  permissions: {
    read: string[];
    write: string[];
    net: string[];
    env: string[] | true;
    run: string[] | true;
    sys?: string[];
  };
  processGroup?: boolean;
  cleanupPaths?: string[];
  /** The worker's own TMPDIR (worker-scratch.ts), claimed for its process group once launched. */
  scratch?: string;
}
export type WorkerProcess = ManagedProcess;
export type WorkerLauncher = (spec: WorkerLaunchSpec) => WorkerProcess;

/** No inherited environment, runtime downloads, permission prompts or blanket grants. */
export const launchLocalWorker: WorkerLauncher = (spec) => {
  const grants = Object.entries(spec.permissions).flatMap(([name, values]) => {
    if (values === true) return [`--allow-${name}`];
    if (values.some((v) => !v || v.includes(","))) throw new Error(`invalid ${name} permission`);
    return values.length ? [`--allow-${name}=${values.join(",")}`] : [];
  });
  if (spec.processGroup && Deno.build.os === "windows")
    throw new Error("native connector workers require a POSIX process-group launcher");
  // Deno-native pipes, not node:child_process + Readable.toWeb: cancelling that
  // adapter destroys stdout with an AbortError, which Deno's child_process exit
  // handler (still awaiting stdout's close) rethrows as an unhandled rejection
  // and kills the daemon.
  const child = new Deno.Command(spec.executable, {
    args: [
      "run",
      "--quiet",
      "--no-prompt",
      "--cached-only",
      "--frozen",
      "--node-modules-dir=manual",
      `--config=${spec.configPath}`,
      ...grants,
      spec.entrypoint,
      ...(spec.processGroup ? ["--process-group"] : []),
    ],
    cwd: spec.cwd,
    clearEnv: true,
    env: spec.env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // setsid: the worker leads a process group the daemon can signal as a whole.
    detached: spec.processGroup === true,
  }).spawn();
  // Only a group can be probed for its descendants: a scratch without one is never swept.
  if (spec.scratch && spec.processGroup) claimWorkerScratch(spec.scratch, child.pid);
  // Drain without exposing potentially sensitive vendor diagnostics or retaining
  // unbounded output. A redacted logging channel can be added with real connectors.
  const drained = child.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  const cleanup = async () => {
    for (const path of spec.cleanupPaths ?? []) {
      try {
        await Deno.remove(path, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  };
  if (!spec.processGroup) {
    return {
      input: child.stdin,
      output: child.stdout,
      pid: child.pid,
      exited: child.status.finally(() => drained),
      cleanup,
      terminate() {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      },
    };
  }
  let terminated = false;
  return {
    input: child.stdin,
    output: child.stdout,
    pid: child.pid,
    // Observe exit independently from EOF: a surviving grandchild may still own
    // stderr/stdout. The supervisor must kill the group before awaiting those pipes.
    exited: child.status,
    cleanup,
    terminate() {
      if (terminated) return;
      terminated = true;
      try {
        // SIGKILL follows only for what outlives the grace: an agent's `git`
        // killed outright leaves its index.lock behind. The escalation is
        // tracked; Daemon.stop waits for it before the daemon exits.
        Deno.kill(-child.pid, "SIGTERM");
        void escalateProcessGroup(child.pid);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return;
        // Darwin can report EPERM while the last group member is exiting.
        // Ignore it only after confirming that no live members remain.
        if (Deno.build.os === "darwin" && e instanceof Deno.errors.PermissionDenied) {
          try {
            Deno.kill(-child.pid, 0);
          } catch (check) {
            if (check instanceof Deno.errors.NotFound) return;
          }
          const group = Deno.spawnAndWaitSync("/bin/ps", ["-o", "stat=", "-g", String(child.pid)], {
            stdout: "piped",
            stderr: "piped",
          });
          if (group.success || (group.code === 1 && group.stderr.length === 0)) {
            const states = new TextDecoder()
              .decode(group.stdout)
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            if (states.every((state) => state.startsWith("Z"))) return;
          }
        }
        throw e;
      }
    },
  };
};

/** SDK-free mock and echo workers need no native children, credentials, network or write grants. */
export const mockLaunchSpec = (cwd: string): WorkerLaunchSpec => {
  const root = new URL("../../../../", import.meta.url);
  return {
    executable: Deno.execPath(),
    entrypoint: fileURLToPath(new URL("runtime/src/worker/main.ts", root)),
    configPath: fileURLToPath(new URL("deno.json", root)),
    cwd,
    env: {},
    permissions: { read: [fileURLToPath(root)], write: [], net: [], env: [], run: [] },
  };
};
