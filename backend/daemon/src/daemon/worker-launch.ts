import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

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
}
export interface WorkerProcess {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  exited: Promise<unknown>;
  pid: number;
  terminate(): void;
  cleanup?(): Promise<void>;
  /** Credential-free supervisor diagnosis, drained before interpreting worker EOF. */
  failure?(): Promise<Error | undefined>;
}
export type WorkerLauncher = (spec: WorkerLaunchSpec) => WorkerProcess;

/** No inherited environment, runtime downloads, permission prompts or blanket grants. */
export const launchLocalWorker: WorkerLauncher = (spec) => {
  const grants = Object.entries(spec.permissions).flatMap(([name, values]) => {
    if (values === true) return [`--allow-${name}`];
    if (values.some((v) => !v || v.includes(","))) throw new Error(`invalid ${name} permission`);
    return values.length ? [`--allow-${name}=${values.join(",")}`] : [];
  });
  const args = [
    "run",
    "--quiet",
    "--no-prompt",
    "--cached-only",
    "--frozen",
    "--node-modules-dir=manual",
    `--config=${spec.configPath}`,
    ...grants,
    spec.entrypoint,
  ];
  if (spec.processGroup) {
    if (Deno.build.os === "windows")
      throw new Error("native connector workers require a POSIX process-group launcher");
    args.push("--process-group");
    const child = spawn(spec.executable, args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Observe exit independently from EOF: a surviving grandchild may still own
    // stderr/stdout. The supervisor must kill the group before awaiting those pipes.
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    void exited.catch(() => {});
    child.stderr.on("data", () => {});
    let terminated = false;
    return {
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      pid: child.pid ?? -1,
      exited,
      terminate() {
        if (child.pid && !terminated) {
          terminated = true;
          try {
            Deno.kill(-child.pid, "SIGKILL");
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
              const group = Deno.spawnAndWaitSync(
                "/bin/ps",
                ["-o", "stat=", "-g", String(child.pid)],
                { stdout: "piped", stderr: "piped" },
              );
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
        }
      },
      async cleanup() {
        for (const path of spec.cleanupPaths ?? []) {
          try {
            await Deno.remove(path, { recursive: true });
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
        }
      },
    };
  }
  const child = new Deno.Command(spec.executable, {
    args,
    cwd: spec.cwd,
    clearEnv: true,
    env: spec.env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Drain without exposing potentially sensitive vendor diagnostics or retaining
  // unbounded output. A redacted logging channel can be added with real connectors.
  const drained = child.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  return {
    input: child.stdin,
    output: child.stdout,
    pid: child.pid,
    exited: child.status.finally(() => drained),
    terminate() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    },
  };
};

/** Mock has no native children, provider credentials, network or write grants. */
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
