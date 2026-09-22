/** Noninteractive counterpart of loom shell, using SmolVM's existing exec transport. */
import {
  guestWorkingDirectory,
  sessionVmName,
  vmEnvironment,
  type VmBinding,
} from "../packaged/vm.ts";
import { guestShellEnvironmentPath } from "./shell.ts";
import type { HookAttempt } from "../../../core/src/shell-hook.ts";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export const vmCommand = async (
  binding: VmBinding,
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
  env: Record<string, string> = {},
): Promise<HookAttempt> => {
  signal.throwIfAborted();
  const overrides = Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid guest environment name");
      return quote(key + "=" + value);
    })
    .join(" ");
  const cancel = new AbortController();
  let timedOut = false;
  const abort = () => cancel.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel.abort();
  }, timeoutMs);
  try {
    const child = new Deno.Command(binding.smolvm, {
      args: [
        "machine",
        "exec",
        "--name",
        sessionVmName,
        "-w",
        guestWorkingDirectory(binding),
        "--",
        "/bin/sh",
        "-c",
        `set -e
. ${guestShellEnvironmentPath}
exec env ${overrides} sh -c ${quote(command)}`,
      ],
      env: vmEnvironment(binding.state),
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: cancel.signal,
    }).spawn();
    let output = "";
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (output.length < 65536) output += text.slice(0, 65536 - output.length);
      }
    };
    const [status] = await Promise.all([child.status, drain(child.stdout), drain(child.stderr)]);
    return { code: status.code, output, timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};
