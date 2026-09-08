/** Trusted host supervisor. Its stdin lifetime owns the VM and both capabilities. */
import { join } from "node:path";
import { startSessionGit } from "../../../backend/daemon/src/daemon/git-worker.ts";
import { startEgress } from "./egress.ts";
import { cleanupSessionVm } from "./cleanup.ts";
import {
  reapVm,
  sessionVmName,
  vmCreateArguments,
  vmEnvironment,
  vmExecArguments,
  type VmBinding,
} from "../packaged/vm.ts";
import { readFrames } from "../worker/transport.ts";
const bootstrap = setTimeout(() => Deno.exit(1), 10_000);
const frames = readFrames(Deno.stdin.readable, (value) => value);
const first = await frames.next();
clearTimeout(bootstrap);
if (first.done) Deno.exit(0);
const { binding, auth, allowRepoPrograms } = first.value as {
  binding: VmBinding;
  auth: { ANTHROPIC_API_KEY?: string; CLAUDE_CODE_OAUTH_TOKEN?: string };
  allowRepoPrograms: boolean;
};
let child: Deno.ChildProcess | undefined;
let git: Awaited<ReturnType<typeof startSessionGit>>;
let egress: ReturnType<typeof startEgress> | undefined;
let input: WritableStreamDefaultWriter<Uint8Array> | undefined;
let ended = false;
const done = Promise.withResolvers<void>();
const stop = () => {
  ended = true;
  done.resolve();
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
const deadline = setTimeout(stop, 120_000);
const network: Array<{ host: string; allowed: boolean }> = [];
let phase = "starting";
const status = () => {
  Deno.writeTextFileSync(
    join(binding.state, "status.json.tmp"),
    JSON.stringify({
      phase,
      gitPid: git?.pid,
      execPid: phase === "running" ? child?.pid : undefined,
      network,
    }),
    { mode: 0o600 },
  );
  Deno.renameSync(join(binding.state, "status.json.tmp"), join(binding.state, "status.json"));
};
// Read continuously, including during startup. Keep backpressure from hiding parent EOF,
// but bound queued protocol bytes if a guest stops consuming its input.
let pending = Promise.resolve();
let queued = 0;
const parent = (async () => {
  try {
    for await (const frame of frames) {
      const chunk = new TextEncoder().encode(JSON.stringify(frame) + "\n");
      if (!input || ended || (queued += chunk.length) > 8 * 1024 * 1024) break;
      const writer = input;
      pending = pending
        .then(() => writer.write(chunk))
        .then(() => {
          queued -= chunk.length;
        });
      void pending.catch(stop);
    }
  } catch {
    /* Parent closed. */
  } finally {
    stop();
  }
})();
void parent;
const command = async (args: string[]) => {
  if (ended) throw new Error("Session closed during startup");
  child = new Deno.Command(binding.smolvm, {
    args,
    clearEnv: true,
    env: vmEnvironment(binding.state),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const result = await Promise.race([child.status, done.promise.then(() => undefined)]);
  if (!result?.success) throw new Error("Session VM startup interrupted or failed");
};
try {
  for (const name of ["home", "cache", "data", "config", "private"])
    await Deno.mkdir(join(binding.state, name), { mode: 0o700 });
  if (ended) throw new Error("Parent closed before credential setup");
  await Deno.writeTextFile(join(binding.state, "private/auth.json"), JSON.stringify(auth), {
    mode: 0o600,
  });
  git = await startSessionGit(
    binding.workspace,
    binding.state,
    binding.artifact,
    allowRepoPrograms,
  );
  if (!git) throw new Error("Session VM requires a linked Git worktree");
  binding.gitSocket = git.socket;
  void git.exited.then(stop, stop);
  if (ended) throw new Error("Session closed during Git startup");
  status();
  egress = startEgress(join(binding.state, "egress.sock"), (host, allowed) => {
    network.push({ host, allowed });
    if (network.length > 32) network.shift();
    status();
  });
  const create = vmCreateArguments(binding);
  create[create.indexOf("--mem") + 1] = "2048";
  create.push(
    "-v",
    `${binding.state}/private:/run/loom/private:ro`,
    "--mount-socket",
    `${binding.state}/egress.sock:/run/loom/egress.sock`,
  );
  await command(create);
  await command(["machine", "start", "--name", sessionVmName]);
  if (ended) throw new Error("Session closed during VM startup");
  child = new Deno.Command(binding.smolvm, {
    args: vmExecArguments(binding),
    clearEnv: true,
    env: vmEnvironment(binding.state),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  input = child.stdin.getWriter();
  // Never expose raw vendor stderr: it can contain credentials.
  void child.stderr.pipeTo(new WritableStream({ write() {} })).catch(stop);
  const output = child.stdout.pipeTo(Deno.stdout.writable, { preventClose: true });
  void output.catch(stop);
  phase = "running";
  status();
  clearTimeout(deadline);
  await Promise.race([done.promise, child.status, output]);
} catch {
  Deno.exitCode = 1;
  console.error(`Session VM stopped during ${phase}; state: ${binding.state}`);
} finally {
  clearTimeout(deadline);
  stop();
  try {
    await cleanupSessionVm({
      stop: async () => {
        if (!child) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* exited */
        }
        await child.status;
      },
      egress: async () => {
        await egress?.close();
      },
      credentials: async () => {
        try {
          await Deno.remove(join(binding.state, "private"), { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      },
      reap: () => reapVm(binding),
      git: async () => {
        await git?.close();
      },
      state: () => Deno.remove(binding.state, { recursive: true }),
    });
  } catch {
    Deno.exitCode = 1;
    console.error(`Session VM cleanup incomplete; state: ${binding.state}`);
  }
  // stdin and the parent can still be alive when a guest or capability dies.
  Deno.exit(Deno.exitCode);
}
