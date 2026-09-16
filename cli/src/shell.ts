import type { LoomClient } from "@loom/client";
import type { SessionShell } from "../../core/src/shell.ts";

/** Run a real shell while continuing to drain daemon events and hold the lease. */
export const openSessionShell = async (client: LoomClient, id: string): Promise<number> => {
  if (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal()) {
    throw new Error("loom shell needs an interactive terminal (stdin/stdout must be a TTY)");
  }
  const target = await client.request<SessionShell>("session.openShell", {
    id,
  });
  let child: Deno.ChildProcess | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnected = false;
  const terminate = () => {
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    killTimer ??= setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, 2000);
  };
  const lost = () => {
    disconnected = true;
    terminate();
  };
  const offClose = client.on("close", lost);
  const offDisconnect = client.on("disconnect", lost);
  // The terminal sends Ctrl-C to both processes; only the foreground shell handles it.
  const ignore = () => {};
  Deno.addSignalListener("SIGINT", ignore);
  Deno.addSignalListener("SIGQUIT", ignore);
  Deno.addSignalListener("SIGTERM", terminate);
  try {
    // Strip terminal control bytes from workspace paths before displaying them.
    // eslint-disable-next-line no-control-regex
    const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
    Deno.stdout.writeSync(
      new TextEncoder().encode(
        `Session ${id.slice(0, 8)} · ${
          target.isolation === "vm" ? "VM" : "Local"
        } · ${clean(target.cwd)}\nExit this shell to return to Loom.\n\n`,
      ),
    );
    const terminalEnv = Object.fromEntries(
      ["TERM", "COLORTERM"].flatMap((key) => {
        const value = Deno.env.get(key);
        return value ? [[key, value]] : [];
      }),
    );
    const vm = target.vm;
    const args = vm ? [...vm.args] : ["-i"];
    if (vm) {
      args.splice(
        args.indexOf("--"),
        0,
        ...Object.entries(terminalEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      );
    }
    if (disconnected) {
      throw new Error("The daemon disconnected before the shell opened.");
    }
    const executable = vm?.executable ?? (Deno.env.get("SHELL") || "/bin/sh");
    try {
      child = new Deno.Command(executable, {
        args,
        cwd: target.cwd,
        ...(vm ? { clearEnv: true, env: { ...vm.env, ...terminalEnv } } : {}),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
    } catch (error) {
      throw new Error(
        `Could not open shell (${executable}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = await child.status;
    if (disconnected) {
      throw new Error("The daemon disconnected; the shell was closed.");
    }
    return result.code;
  } finally {
    clearTimeout(killTimer);
    offClose();
    offDisconnect();
    Deno.removeSignalListener("SIGINT", ignore);
    Deno.removeSignalListener("SIGQUIT", ignore);
    Deno.removeSignalListener("SIGTERM", terminate);
    await client.request("session.closeShell", { token: target.token }).catch(() => {});
  }
};
