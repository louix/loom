import {
  sessionStartupTimeout,
  type SessionEnvironment,
} from "../../../core/src/session-environment.ts";
/** Trusted host supervisor. Its stdin lifetime owns the VM and its relays. */
import { join } from "node:path";
import { attachDiskTemplates, retainDiskTemplates } from "../packaged/disk-templates.ts";
import { writeSessionAuth, type SessionAuth } from "./auth.ts";
import { startEgress } from "./egress.ts";
import { cleanupSessionVm } from "./cleanup.ts";
import {
  reapVm,
  sessionVmName,
  vmCreateArguments,
  vmEnvironment,
  vmExecArguments,
  stageGuestImage,
} from "../packaged/vm.ts";
import {
  lockSessionState,
  assertNoActiveVm,
  finishSessionState,
  writeRecoveryFile,
  removeSessionRuntimeState,
} from "./persistence.ts";
import type { RecoverableBinding } from "./recovery.ts";
import { startMcpRelay } from "./mcp-relay.ts";
import { readFrames } from "../worker/transport.ts";
import { reportStartup, readStartupProgress, classifyStartupFailure } from "./progress.ts";
import { seedRepoBase, pruneRepoBases } from "./repo-base.ts";
import {
  discardSessionDisks,
  saveSessionDisks,
  attachSessionDisks,
  sessionDiskSizes,
} from "./disks.ts";
const bootstrap = setTimeout(() => Deno.exit(1), 10_000);
const frames = readFrames(Deno.stdin.readable, (value) => value);
const first = await frames.next();
clearTimeout(bootstrap);
if (first.done) Deno.exit(0);
const { binding, auth, extraAllowedHosts, providerHosts, environment } = first.value as {
  binding: RecoverableBinding;
  auth: SessionAuth;
  extraAllowedHosts?: string[];
  providerHosts?: string[];
  environment?: SessionEnvironment;
};
let child: Deno.ChildProcess | undefined;
if (binding.preparationOnly) Deno.env.set("LOOM_PREPARATION_ONLY", "1");
let persistentLock: Deno.FsFile | undefined;
let ownsPersistent = false;
const relays: ReturnType<typeof startMcpRelay>[] = [];
let egress: ReturnType<typeof startEgress> | undefined;
let input: WritableStreamDefaultWriter<Uint8Array> | undefined;
let ended = false;
let machineDirectory: string | undefined;
const cancelled = new AbortController();
const done = Promise.withResolvers<void>();
const stop = () => {
  ended = true;
  cancelled.abort();
  done.resolve();
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
const deadline = setTimeout(stop, sessionStartupTimeout(environment));
const network: Array<{ host: string; allowed: boolean }> = [];
const blockedHosts = new Set<string>();
let phase = "starting";
const status = () => {
  Deno.writeTextFileSync(
    join(binding.state, "status.json.tmp"),
    JSON.stringify({
      phase,
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
const command = async (args: string[]) => {
  if (ended) throw new Error("Session closed during startup");
  child = Deno.spawn(binding.smolvm, args, {
    clearEnv: true,
    env: vmEnvironment(binding.state),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const started = Date.now();
  const stage = args[1] === "start" ? "boot" : "runtime";
  const heartbeat = setInterval(
    () => reportStartup(stage, Math.floor((Date.now() - started) / 1000)),
    15_000,
  );
  let result;
  try {
    result = await Promise.race([child.output(), done.promise.then(() => undefined)]);
  } finally {
    clearInterval(heartbeat);
  }
  if (!result) throw new Error("Session VM startup interrupted");
  if (!result.success) {
    const detail = new TextDecoder().decode(result.stderr).trim().slice(-4096);
    throw new Error(
      `smolvm ${args.slice(0, 2).join(" ")} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
};
try {
  if (binding.sessionDirectory) {
    persistentLock = await lockSessionState(binding.sessionDirectory);
    await assertNoActiveVm(binding.sessionDirectory);
    if (!binding.preparationOnly) await discardSessionDisks(binding.sessionDirectory);
    const profile = join(binding.sessionDirectory, "profile");
    await Deno.mkdir(profile, { recursive: true, mode: 0o700 });
    if ((await Deno.lstat(profile)).isSymlink)
      throw new Error("Session profile must not be a symlink");
    binding.recovery = { version: 3, ready: false, reaped: false };
    await writeRecoveryFile(binding.state, "owner.json", {
      token: binding.token,
    });
    ownsPersistent = true;
    await persist();
  }
  for (const name of ["home", "cache", "data", "config", "private"])
    await Deno.mkdir(join(binding.state, name), { mode: 0o700 });
  if (ended) throw new Error("Parent closed before credential setup");
  await writeSessionAuth(join(binding.state, "private"), auth);
  await Deno.writeTextFile(
    join(binding.state, "private/environment.json"),
    JSON.stringify(environment ?? null),
    { mode: 0o600 },
  );
  if (binding.preparationOnly)
    await Deno.writeTextFile(join(binding.state, "private/prepare-only"), "1", { mode: 0o600 });
  status();
  egress = startEgress(
    join(binding.state, "egress.sock"),
    (host, allowed) => {
      network.push({ host, allowed });
      // Report each blocked host once; retries would otherwise flood progress.
      if (!allowed && !blockedHosts.has(host) && blockedHosts.size < 32) {
        blockedHosts.add(host);
        reportStartup("networkBlocked", undefined, host);
      }
      if (network.length > 32) network.shift();
      status();
    },
    {
      extraAllowedHosts: extraAllowedHosts ?? [],
      providerHosts: providerHosts ?? ["api.anthropic.com"],
    },
  );
  const create = vmCreateArguments(binding, environment);
  create.push(...sessionDiskSizes);
  create.push(
    "-v",
    `${binding.state}/private:/run/loom/private:ro`,
    "--mount-socket",
    `${binding.state}/egress.sock:/run/loom/egress.sock`,
  );
  if (binding.sessionDirectory && !binding.preparationOnly)
    create.push(
      "-v",
      `${binding.sessionDirectory}/profile:/tmp/loom-home/${auth.codexOauth ? ".codex" : ".claude"}`,
    );
  if (binding.packageCache)
    await Deno.writeTextFile(join(binding.state, "private/cache-path"), binding.packageCache);
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
  await attachDiskTemplates(binding.state, binding.smolvm);
  reportStartup("runtime");
  await stageGuestImage(binding);
  await command(create);
  const diskHome = binding.preparationOnly ? binding.sessionDirectory! : binding.state;
  const diskDirectory = join(diskHome, "disks");
  machineDirectory = await command(["machine", "data-dir", "--name", sessionVmName]);
  let saved = false;
  if (binding.repoBaseDirectory) {
    saved = await seedRepoBase(binding.repoBaseDirectory, diskHome, binding, cancelled.signal);
  }
  if (!saved) reportStartup("cold");
  if (saved) await attachSessionDisks(diskDirectory, machineDirectory, binding.state);
  reportStartup("boot");
  await command(["machine", "start", "--name", sessionVmName]);
  await retainDiskTemplates(binding.state, binding.smolvm);
  if (ended) throw new Error("Session closed during VM startup");
  child = Deno.spawn(binding.smolvm, vmExecArguments(binding), {
    clearEnv: true,
    env: vmEnvironment(binding.state),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  input = child.stdin.getWriter();
  // Never expose raw vendor stderr: it can contain credentials.
  const diagnostics = binding.preparationOnly
    ? child.stderr.pipeTo(Deno.stderr.writable, { preventClose: true })
    : readStartupProgress(child.stderr, (stage, elapsed) => reportStartup(stage, elapsed));
  void diagnostics.catch(stop);
  const output = child.stdout
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          if (ownsPersistent && !binding.recovery.ready) {
            binding.recovery.ready = true;
            await persist();
          }
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeTo(Deno.stdout.writable, { preventClose: true });
  void output.catch(stop);
  phase = "running";
  status();
  clearTimeout(deadline);
  await Promise.race([done.promise, child.status, output]);
  if (binding.preparationOnly) {
    if (ended) throw new Error("Preparation cancelled");
    const result = await child.status;
    await Promise.all([output, diagnostics]);
    Deno.exitCode = result.code;
    if (result.success) {
      await command(["machine", "stop", "--name", sessionVmName]);
      if (!saved)
        await saveSessionDisks(diskDirectory, machineDirectory, binding, cancelled.signal);
    }
  }
} catch (error) {
  Deno.exitCode = 1;
  // Explicit preparation has no provider credentials. Report the command's
  // failure, without resource sampling or console/backend log dumps.
  if (binding.preparationOnly)
    console.error(error instanceof Error ? error.message : String(error));
  else console.error(JSON.stringify({ loomStartupFailure: classifyStartupFailure(error) }));
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
      state: async () => {
        if (ownsPersistent) {
          binding.recovery.reaped = true;
          await persist();
        }
        await removeSessionRuntimeState(binding.state);
        if (binding.sessionDirectory && ownsPersistent)
          await finishSessionState(binding.sessionDirectory, binding.token);
        if (!binding.preparationOnly && binding.repoBaseDirectory)
          await pruneRepoBases(binding.repoBaseDirectory, undefined).catch(() => {});
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
