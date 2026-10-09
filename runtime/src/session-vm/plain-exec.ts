/**
 * Plain-command consumer of the isolation library: boot one VM environment, run a
 * literal argv inside it, then release the lease and reap the VM. No conversation,
 * session protocol or daemon code participates; the caller allocates the workspace.
 */
import { parseArgs } from "node:util";
import { createVmEnvironmentCoordinator } from "./coordinator.ts";
import { directoryEnvironmentStorage } from "./environment-storage.ts";
import { ExecutionLeases } from "@loom/isolation/execution-leases";

export interface PlainExecOptions {
  /** Mounted read-write into the VM; never created, modified or removed here. */
  workspace: string;
  /** Caller-owned parent for this run's persistent VM state, outside the workspace. */
  stateRoot: string;
  artifact: string;
  smolvm: string;
  argv: string[];
  stdin?: "inherit" | "null";
  stdout?: "inherit" | "piped" | "null";
  stderr?: "inherit" | "piped" | "null";
  /** Trusted network grants; the environment otherwise has no egress at all. */
  extraAllowedHosts?: string[];
  onProgress?: (message: string) => void;
  /** Observe lease ownership; a private table is used otherwise. */
  leases?: ExecutionLeases;
  signal?: AbortSignal;
}
export interface PlainExecResult {
  code: number;
  signal: Deno.Signal | null;
  /** The disposable environment's ID, already stopped and removed. */
  environment: string;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
}

const collect = async (stream: ReadableStream<Uint8Array> | null) =>
  stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : undefined;

export const plainExec = async (options: PlainExecOptions): Promise<PlainExecResult> => {
  options.signal?.throwIfAborted();
  const id = "exec-" + crypto.randomUUID();
  const storage = directoryEnvironmentStorage(await Deno.realPath(options.stateRoot));
  const coordinator = createVmEnvironmentCoordinator(
    storage,
    undefined,
    options.leases ?? new ExecutionLeases(),
  );
  const owner = new AbortController();
  const abort = () => {
    owner.abort();
    // A running command ends with its transport; startup has no lease to cancel.
    if (coordinator.inspect(id).phase === "starting") void coordinator.stop(id).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await coordinator.start(id, {
      mode: "execution",
      workspace: options.workspace,
      artifact: options.artifact,
      smolvm: options.smolvm,
      ...(options.extraAllowedHosts ? { extraAllowedHosts: options.extraAllowedHosts } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const stdin = options.stdin ?? "null";
    const target = coordinator.openExecution(
      id,
      { argv: options.argv, stdin: stdin === "inherit", tty: false },
      owner,
    );
    try {
      const child = new Deno.Command(target.vm.executable, {
        args: target.vm.args,
        env: target.vm.env,
        clearEnv: true,
        stdin,
        stdout: options.stdout ?? "inherit",
        stderr: options.stderr ?? "inherit",
      }).spawn();
      const kill = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* exited */
        }
      };
      owner.signal.addEventListener("abort", kill, { once: true });
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.status,
          collect(options.stdout === "piped" ? child.stdout : null),
          collect(options.stderr === "piped" ? child.stderr : null),
        ]);
        return {
          code: status.code,
          environment: id,
          signal: status.signal,
          ...(stdout ? { stdout } : {}),
          ...(stderr ? { stderr } : {}),
        };
      } finally {
        owner.signal.removeEventListener("abort", kill);
      }
    } finally {
      coordinator.closeExecution(target.token, owner);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try {
      // Reap the VM, then drop this run's state under the same stopped-state lock.
      await coordinator.withStopped(id, () =>
        Deno.remove(storage.directory(id), { recursive: true }).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }),
      );
    } finally {
      await coordinator.close();
    }
  }
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Deno.args,
    allowPositionals: true,
    options: {
      artifact: { type: "string" },
      smolvm: { type: "string" },
      workspace: { type: "string" },
      state: { type: "string" },
      "allow-host": { type: "string", multiple: true },
    },
  });
  const { artifact, smolvm, workspace, state } = values;
  if (!artifact || !smolvm || !workspace || !state || !positionals.length) {
    console.error(
      "usage: plain-exec.ts --artifact=<runtime> --smolvm=<smolvm> --workspace=<dir> --state=<dir> [--allow-host=<host>]... -- <argv>...",
    );
    Deno.exit(2);
  }
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", interrupt);
  try {
    const result = await plainExec({
      workspace,
      stateRoot: state,
      artifact,
      smolvm,
      argv: positionals,
      stdin: "inherit",
      ...(values["allow-host"] ? { extraAllowedHosts: values["allow-host"] } : {}),
      onProgress: (message) => console.error("loom: " + message),
      signal: interrupted.signal,
    });
    Deno.exitCode = result.code;
  } catch (error) {
    console.error("loom: " + (error instanceof Error ? error.message : String(error)));
    Deno.exitCode = 1;
  } finally {
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", interrupt);
  }
}
