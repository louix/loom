import { fileURLToPath } from "node:url";

export interface WorkerLaunchSpec {
  executable: string;
  entrypoint: string;
  configPath: string;
  cwd: string;
  env: Record<string, string>;
  permissions: { read: string[]; write: string[]; net: string[]; env: string[]; run: string[] };
}
export interface WorkerProcess {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  exited: Promise<unknown>;
  pid: number;
  terminate(): void;
}
export type WorkerLauncher = (spec: WorkerLaunchSpec) => WorkerProcess;

/** No inherited environment, runtime downloads, permission prompts or blanket grants. */
export const launchLocalWorker: WorkerLauncher = (spec) => {
  const grants = Object.entries(spec.permissions).flatMap(([name, values]) => {
    if (values.some((v) => !v || v.includes(","))) throw new Error(`invalid ${name} permission`);
    return values.length ? [`--allow-${name}=${values.join(",")}`] : [];
  });
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
    ],
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
