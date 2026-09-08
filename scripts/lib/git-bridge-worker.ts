/** Test supervisor for the standalone host worker, with explicit Deno permissions. */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prepareGitBridge, type GitBridgeOptions } from "../../runtime/src/git-bridge/service.ts";

export const gitBridgeWorker = async function (options: GitBridgeOptions) {
  const prepared = await prepareGitBridge(options);
  const binding = join(options.state, "git-binding.json");
  await Deno.writeTextFile(binding, JSON.stringify(prepared), { mode: 0o600 });
  const main = fileURLToPath(new URL("../../runtime/src/git-bridge/main.ts", import.meta.url));
  const paths = [options.workspace, options.gitDir, options.commonDir, options.state, options.git];
  if (paths.some((p) => /[,\n\0]/.test(p))) throw new Error("Unsupported Deno permission path");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      `--allow-read=${paths.join(",")}`,
      `--allow-write=${options.state}`,
      `--allow-run=${options.git}`,
      `--allow-net=unix:${join(prepared.dir, "git.sock")}`,
      main,
      binding,
    ],
    // No host environment or IP grant; only the selected executable and Unix endpoint.
    clearEnv: true,
    env: {},
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const writer = child.stdin.getWriter();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* exited */
        }
      }, 10_000);
      try {
        try {
          await writer.close();
        } catch {
          /* worker already exited */
        }
        const status = await child.status;
        const errors = await stderr;
        if (!status.success) throw new Error(`Git worker exited ${status.code}: ${errors}`);
      } finally {
        clearTimeout(timer);
        await reader.cancel();
        reader.releaseLock();
        writer.releaseLock();
      }
    })());
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* exited */
    }
  }, 10_000);
  try {
    let ready = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Git worker exited before ready: ${await stderr}`);
      ready += new TextDecoder().decode(value);
      if (ready.length > 4096) throw new Error("Oversized worker readiness message");
      if (!ready.includes("\n")) continue;
      const message = JSON.parse(ready.slice(0, ready.indexOf("\n")));
      if (
        message.version !== 1 ||
        typeof message.socket !== "string" ||
        !message.socket.startsWith(options.state + "/")
      )
        throw new Error("Invalid Git worker readiness message");
      return { socket: message.socket as string, close };
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Git worker startup failed");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
