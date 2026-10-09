import {
  sessionVmName,
  type VmBinding,
  vmEnvironment,
  guestWorkingDirectory,
} from "../packaged/vm.ts";

export const guestShellEnvironmentPath = "/run/loom/shell-env.sh";
/** The same activated environment as JSON, restored by guest-worker.ts executions. */
export const guestWorkerEnvironmentPath = "/run/loom/worker-env.json";

/** Save the activated environment inside the guest; never send it over the host RPC. */
export const shellEnvironment = (env: Record<string, string>): string =>
  Object.entries(env)
    .filter(
      ([key]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        !["TERM", "COLORTERM", "LINES", "COLUMNS", "PWD", "OLDPWD", "SHLVL", "_"].includes(key),
    )
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    .join("\n") + "\n";

/** The same interactive shell as an execution, whose wrapper has loaded the environment. */
export const guestShellArgv = ["/bin/sh", "-c", 'exec "$SHELL" -i'];

export const vmShellCommand = (binding: VmBinding) => ({
  executable: binding.smolvm,
  args: [
    "machine",
    "exec",
    "--name",
    sessionVmName,
    "-i",
    "-t",
    "-w",
    guestWorkingDirectory(binding),
    "--",
    "/bin/sh",
    "-c",
    `if [ ! -r ${guestShellEnvironmentPath} ]; then
  echo 'This VM predates shell support. Archive and resume the session before opening a shell.' >&2
  exit 1
fi
. ${guestShellEnvironmentPath}
exec "$SHELL" -i`,
  ],
  env: vmEnvironment(binding.state),
});
