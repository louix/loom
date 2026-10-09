/**
 * loom-isolate over a fake VM backend: the "guest" is a host process. The fake
 * smolvm (written by the test) runs the guest argv unchanged in the requested
 * working directory, with the VM's private /tmp mapped into its state directory.
 * Closing the fake VM kills every guest command, as stopping a real VM would.
 */
import { join } from "node:path";
import type { VmBinding } from "../../runtime/src/packaged/vm.ts";
import type { launchEnvironmentVm } from "../../runtime/src/session-vm/environment-launch.ts";
import type { vmCommand } from "../../runtime/src/session-vm/command.ts";
import type { IsolateDependencies } from "../../cli/src/isolate/cli.ts";

// Read per call: in-process tests configure the environment after importing this module.
const setting = (name: string) => Deno.env.get("LOOM_ISOLATE_FAKE_" + name);
const record = (event: Record<string, unknown>) =>
  Deno.writeTextFile(setting("LOG")!, JSON.stringify({ pid: Deno.pid, ...event }) + "\n", {
    append: true,
  });
const guestTmp = (state: string, text: string) => text.replaceAll("/tmp/", state + "/tmp/");

export const launch: typeof launchEnvironmentVm = async (options) => {
  const state = await Deno.makeTempDir({ prefix: "loom-isolate-fake-vm-" });
  await Deno.mkdir(options.sessionDirectory!, { recursive: true, mode: 0o700 });
  await Deno.mkdir(join(state, "tmp"));
  await Deno.writeTextFile(join(options.sessionDirectory!, "fake-running"), state);
  await record({
    event: "launch",
    directory: options.sessionDirectory,
    workspace: options.workspace,
    extraAllowedHosts: options.extraAllowedHosts ?? [],
    activity: options.activity?.(),
  });
  const exited = Promise.withResolvers<void>();
  const booted = Promise.withResolvers<void>();
  const boot = setTimeout(booted.resolve, Number(setting("BOOT_MS") ?? 0));
  const ready = booted.promise;
  void ready.catch(() => {});
  let closed: Promise<void> | undefined;
  return {
    binding: { smolvm: setting("SMOLVM")!, state, workspace: options.workspace } as VmBinding,
    pid: Deno.pid,
    ready,
    exited: exited.promise,
    status: async () => ({ phase: "running", network: [] }),
    close: () =>
      (closed ??= (async () => {
        clearTimeout(boot);
        booted.reject(new Error("Environment closed during startup"));
        for await (const entry of Deno.readDir(join(state, "tmp"))) {
          const pid = Number(await Deno.readTextFile(join(state, "tmp", entry.name)));
          try {
            Deno.kill(-pid, "SIGKILL");
          } catch {
            try {
              Deno.kill(pid, "SIGKILL");
            } catch {
              /* exited */
            }
          }
        }
        await Deno.remove(state, { recursive: true });
        await Deno.remove(join(options.sessionDirectory!, "fake-running"));
        await record({ event: "close" });
        exited.resolve();
      })()),
  };
};

export const command: typeof vmCommand = async (binding, source, _timeoutMs, signal) => {
  const result = await new Deno.Command("/bin/sh", {
    args: ["-c", guestTmp(binding.state, source)],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  await record({ event: "command", command: source, code: result.code });
  return {
    code: result.code,
    output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
    timedOut: false,
  };
};

export const fakeDependencies: IsolateDependencies = {
  backend: { launch, command },
  verifyRuntime: async (runtime) => ({
    ...runtime,
    system: Deno.build.arch + "-linux",
    environmentCompatibility: "fake",
    environmentVersion: 2,
    smolvmVersion: "fake",
  }),
};
