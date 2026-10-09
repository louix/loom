import {
  executionOptionsSchema,
  type ExecutionOptions,
  type ExecutionTarget,
} from "../../../core/src/execution.ts";
import {
  guestWorkingDirectory,
  sessionVmName,
  vmEnvironment,
  type VmBinding,
} from "../packaged/vm.ts";
import { guestShellEnvironmentPath } from "./shell.ts";

/** Keep argv positional even while loading the environment prepared inside the VM. */
export const vmExecutionCommand = (
  binding: VmBinding,
  options: ExecutionOptions,
): ExecutionTarget["vm"] => {
  const { argv, stdin, tty, terminal } = executionOptionsSchema.parse(options);
  const terminalEnv: Record<string, string> = Object.fromEntries(
    Object.entries(terminal ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    executable: binding.smolvm,
    args: [
      "machine",
      "exec",
      "--name",
      sessionVmName,
      // Without -i, smolvm buffers all output until exit unless asked to stream it.
      ...(stdin ? ["-i"] : ["--stream"]),
      ...(tty
        ? [
            "-t",
            ...Object.entries(terminalEnv).flatMap(([key, value]) => ["-e", key + "=" + value]),
          ]
        : []),
      "-w",
      guestWorkingDirectory(binding),
      "--",
      "/bin/sh",
      "-c",
      `set -e
. ${guestShellEnvironmentPath}
exec "$@"`,
      "loom-exec",
      ...argv,
    ],
    env: { ...vmEnvironment(binding.state), ...(tty ? terminalEnv : {}) },
  };
};
