/** Opt-in VM launcher using the existing connector WorkerProcess contract. */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectArtifact } from "../../../../runtime/src/packaged/artifact.ts";
import { reapVm, type VmBinding } from "../../../../runtime/src/packaged/vm.ts";
import { cleanupSessionVm } from "../../../../runtime/src/session-vm/cleanup.ts";
import type { WorkerProcess } from "./worker-launch.ts";

export interface SessionVmOptions {
  workspace: string;
  artifact: string;
  smolvm: string;
  auth: { ANTHROPIC_API_KEY?: string; CLAUDE_CODE_OAUTH_TOKEN?: string };
  allowRepoPrograms?: boolean;
}
export interface SessionVmStatus {
  phase: string;
  gitPid?: number;
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
  }
> => {
  const artifact = await Deno.realPath(options.artifact);
  const smolvm = await Deno.realPath(options.smolvm);
  const workspace = await Deno.realPath(options.workspace);
  const manifest = await inspectArtifact(artifact);
  const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-session-vm-" });
  const binding = {
    version: 1 as const,
    artifact,
    smolvm,
    workspace,
    manifest,
    state,
    token: crypto.randomUUID(),
    gitSocket: join(state, "git.sock"),
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
        auth: {
          ANTHROPIC_API_KEY: options.auth.ANTHROPIC_API_KEY,
          CLAUDE_CODE_OAUTH_TOKEN: options.auth.CLAUDE_CODE_OAUTH_TOKEN,
        },
        allowRepoPrograms: options.allowRepoPrograms ?? false,
      }) + "\n",
    );
    child.stderr.on("data", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
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
        // A killed supervisor cannot reap: stop its native CLI group before fallback.
        killGroup();
        try {
          await Deno.stat(state);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          throw error;
        }
        await cleanupSessionVm({
          stop: async () => {},
          egress: async () => {},
          git: async () => {},
          credentials: () => remove(join(state, "private")),
          reap: () => reapVm(binding),
          state: () => remove(state),
        });
      })());
    void exited.then(clean, clean).catch(() => {});
    let stopping = false;
    return {
      binding,
      status: async () => JSON.parse(await Deno.readTextFile(join(state, "status.json"))),
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      exited,
      pid: child.pid ?? -1,
      terminate() {
        if (stopping) return;
        stopping = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        timer = setTimeout(killGroup, 20_000);
      },
      cleanup: clean,
    };
  } catch (error) {
    await remove(state);
    throw error;
  }
};
