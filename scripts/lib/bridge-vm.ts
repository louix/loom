/** Experimental explicit-lifecycle VM. Normal packaged MCP launches are unchanged. */
import {
  vmArguments,
  vmEnvironment,
  stageGuestImage,
  type VmBinding,
} from "../../runtime/src/packaged/vm.ts";

export const guestGitSocket = "/run/loom/git.sock";

export const bridgeVm = async function (binding: VmBinding, socket?: string, extra: string[] = []) {
  if (socket && (!socket.startsWith("/") || /[:;|\n\0]/.test(socket)))
    throw new Error("Unsupported host socket path");
  const command = async (args: string[]) => {
    const child = new Deno.Command(binding.smolvm, {
      args,
      clearEnv: true,
      env: vmEnvironment(binding.state),
      cwd: binding.state,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }, 60_000);
    try {
      return await child.output();
    } finally {
      clearTimeout(timer);
    }
  };
  const checked = async (args: string[]) => {
    const result = await command(args);
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return result;
  };
  // This helper owns exactly one machine in freshly-created private state.
  const machines = JSON.parse(
    new TextDecoder().decode((await checked(["machine", "ls", "--json"])).stdout),
  );
  if (machines.length) throw new Error("Bridge VM requires empty private state");
  const name = "loom-git-bridge";
  const close = async () => {
    const listed = JSON.parse(
      new TextDecoder().decode((await checked(["machine", "ls", "--json"])).stdout),
    );
    if (listed.some((m: { name: string }) => m.name !== name))
      throw new Error("Unexpected machine in private state");
    if (!listed.length) return;
    // A failed start may leave a stopped record. Delete still needs to run.
    await command(["machine", "stop", "--name", name]);
    await checked(["machine", "delete", "--name", name, "--force"]);
    const remaining = JSON.parse(
      new TextDecoder().decode((await checked(["machine", "ls", "--json"])).stdout),
    );
    if (remaining.length) throw new Error(`VM cleanup incomplete: ${binding.state}`);
  };
  try {
    const args = vmArguments(binding);
    await stageGuestImage(binding);
    const options = args.slice(2, args.indexOf("--")).filter((arg) => arg !== "-i");
    await checked([
      "machine",
      "create",
      "--name",
      name,
      ...options,
      ...(socket ? ["--mount-socket", `${socket}:${guestGitSocket}`] : []),
      ...extra,
    ]);
    await checked(["machine", "start", "--name", name]);
    return {
      exec: (args: string[]) =>
        command([
          "machine",
          "exec",
          "--name",
          name,
          "--timeout",
          "15s",
          "-w",
          binding.workspace,
          "--",
          ...args,
        ]),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Bridge VM startup and cleanup failed");
    }
    throw error;
  }
};
