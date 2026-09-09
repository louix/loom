/** Trusted host supervisor. Its stdin lifetime owns the VM and both capabilities. */
import { join } from "node:path";
import { writeSessionAuth, type SessionAuth } from "./auth.ts";
import { startSessionGit } from "../../../backend/daemon/src/daemon/git-worker.ts";
import { startEgress } from "./egress.ts";
import { cleanupSessionVm } from "./cleanup.ts";
import {
  reapVm,
  sessionVmName,
  vmCreateArguments,
  vmEnvironment,
  vmExecArguments,
} from "../packaged/vm.ts";
import {
  lockSessionState,
  assertNoActiveVm,
  finishSessionState,
  writeRecoveryFile,
  removeSessionRuntimeState,
} from "./persistence.ts";
import { bootId, processIdentity } from "./process.ts";
import type { RecoverableBinding } from "./recovery.ts";
import { startMcpRelay } from "./mcp-relay.ts";
import { readFrames } from "../worker/transport.ts";
const bootstrap = setTimeout(() => Deno.exit(1), 10_000);
const frames = readFrames(Deno.stdin.readable, (value) => value);
const first = await frames.next();
clearTimeout(bootstrap);
if (first.done) Deno.exit(0);
const { binding, auth, allowRepoPrograms } = first.value as {
  binding: RecoverableBinding;
  auth: SessionAuth;
  allowRepoPrograms: boolean;
};
let child: Deno.ChildProcess | undefined;
let persistentLock: Deno.FsFile | undefined;
let ownsPersistent = false;
const relays: ReturnType<typeof startMcpRelay>[] = [];
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
const persist = async () => {
  if (binding.sessionDirectory && ownsPersistent)
    await writeRecoveryFile(binding.sessionDirectory, "active.json", binding);
};
const track = async (pid: number) => {
  if (!binding.sessionDirectory) return;
  const identity = await processIdentity(pid);
  if (identity) binding.recovery.processes.push(identity);
  await persist();
};
// The shell cannot exec smolvm until its PID identity is durably recorded.
// Positional arguments keep paths/arguments out of shell syntax.
const gated = (args: string[]) => [
  "-c",
  'read -r loom_ready && [ "$loom_ready" = go ] && exec "$@"',
  "loom-session",
  binding.smolvm,
  ...args,
];
const command = async (args: string[]) => {
  if (ended) throw new Error("Session closed during startup");
  child = new Deno.Command("/bin/sh", {
    args: gated(args),
    clearEnv: true,
    env: vmEnvironment(binding.state),
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  await track(child.pid);
  if (ended) throw new Error("Session closed before command release");
  const gate = child.stdin.getWriter();
  await gate.write(new TextEncoder().encode("go\n"));
  await gate.close();
  const result = await Promise.race([child.status, done.promise.then(() => undefined)]);
  if (!result?.success) throw new Error("Session VM startup interrupted or failed");
};
try {
  if (binding.sessionDirectory) {
    persistentLock = await lockSessionState(binding.sessionDirectory);
    await assertNoActiveVm(binding.sessionDirectory);
    const profile = join(binding.sessionDirectory, "profile");
    await Deno.mkdir(profile, { recursive: true, mode: 0o700 });
    if ((await Deno.lstat(profile)).isSymlink)
      throw new Error("Session profile must not be a symlink");
    binding.recovery = { version: 1, bootId: await bootId(), processes: [], reaped: false };
    await writeRecoveryFile(binding.state, "owner.json", {
      token: binding.token,
      bootId: binding.recovery.bootId,
    });
    ownsPersistent = true;
    await track(Deno.pid);
  }
  for (const name of ["home", "cache", "data", "config", "private"])
    await Deno.mkdir(join(binding.state, name), { mode: 0o700 });
  if (ended) throw new Error("Parent closed before credential setup");
  await writeSessionAuth(join(binding.state, "private"), auth);
  git = await startSessionGit(
    binding.workspace,
    binding.state,
    binding.artifact,
    allowRepoPrograms,
    track,
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
  // Claude already puts the closure's Git shim on PATH; no separate mount needed.
  const shimMount = create.indexOf(`${binding.artifact}/bin:/run/loom/bin:ro`);
  if (shimMount !== -1) create.splice(shimMount - 1, 2);
  create[create.indexOf("--mem") + 1] = "2048";
  create.push(
    "-v",
    `${binding.state}/private:/run/loom/private:ro`,
    "--mount-socket",
    `${binding.state}/egress.sock:/run/loom/egress.sock`,
  );
  if (binding.sessionDirectory)
    create.push("-v", `${binding.sessionDirectory}/profile:/tmp/loom-home/.claude`);
  for (const [index, relay] of (binding.mcpRelays ?? []).entries()) {
    const socket = join(binding.state, `mcp-${index}.sock`);
    relays.push(startMcpRelay(socket, relay.port));
    create.push("--mount-socket", `${socket}:/run/loom/mcp-${index}.sock`);
  }
  await Deno.writeTextFile(
    join(binding.state, "private/mcp.json"),
    JSON.stringify(binding.mcpRelays ?? []),
    { mode: 0o600 },
  );
  await command(create);
  await command(["machine", "start", "--name", sessionVmName]);
  if (ended) throw new Error("Session closed during VM startup");
  child = new Deno.Command("/bin/sh", {
    args: gated(vmExecArguments(binding)),
    clearEnv: true,
    env: vmEnvironment(binding.state),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await track(child.pid);
  input = child.stdin.getWriter();
  if (ended) throw new Error("Session closed before guest release");
  await input.write(new TextEncoder().encode("go\n"));
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
        await Promise.all([egress?.close(), ...relays.map((relay) => relay.close())]);
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
      state: async () => {
        if (ownsPersistent) {
          binding.recovery.reaped = true;
          await persist();
        }
        await removeSessionRuntimeState(binding.state);
        if (binding.sessionDirectory && ownsPersistent)
          await finishSessionState(binding.sessionDirectory, binding.token);
      },
    });
  } catch {
    Deno.exitCode = 1;
    console.error(`Session VM cleanup incomplete; state: ${binding.state}`);
  }
  // stdin and the parent can still be alive when a guest or capability dies.
  persistentLock?.close();
  Deno.exit(Deno.exitCode);
}
