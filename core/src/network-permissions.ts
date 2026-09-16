import { resolve } from "node:path";
/** Keep trusted host capabilities, but permit only this daemon's Unix IPC. */
export const ipcPermissions = (socket: string): string[] => {
  const path = resolve(socket);
  if (path.includes(",")) throw new Error("Loom IPC socket paths cannot contain commas");
  return [
    "--no-prompt",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--allow-sys",
    "--allow-ffi",
    `--allow-net=unix:${path}`,
  ];
};
/** CLI wrappers start without network. Re-exec once the repository/socket is known. */
export const relaunchForIpc = async (
  entry: string,
  socket: string,
  cliArgs: string[] = Deno.args,
): Promise<void> => {
  const exact = await Deno.permissions.query({ name: "net", host: `unix:${resolve(socket)}` });
  const broad = await Deno.permissions.query({ name: "net" });
  if (exact.state === "granted" && broad.state !== "granted") return;
  Deno.exit(await runWithIpc(entry, socket, cliArgs));
};

/** Run one client with scoped IPC, forwarding signals while it owns the terminal. */
export const runWithIpc = async (
  entry: string,
  socket: string,
  cliArgs: string[],
  env: Record<string, string> = {},
): Promise<number> => {
  const args = [
    "run",
    "--cached-only",
    "--frozen",
    "--node-modules-dir=manual",
    ...ipcPermissions(socket),
    entry,
    ...cliArgs,
  ];
  // Reopen the inherited terminal before starting permission-scoped Deno.
  // This gives stdin independent file flags from stdout even when /dev/pts
  // is hidden. Opening /proc from inside Deno would require --allow-all.
  const reopenStdin = Deno.build.os === "linux" && Deno.stdin.isTerminal();
  const child = new Deno.Command(reopenStdin ? "/bin/sh" : Deno.execPath(), {
    args: reopenStdin
      ? ["-c", 'exec "$@" < /proc/self/fd/0', "loom-ipc", Deno.execPath(), ...args]
      : args,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const terminate = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  };
  Deno.addSignalListener("SIGTERM", terminate);
  // Interactive children own Ctrl-C, including shells and editor handoffs.
  const interrupt = Deno.stdin.isTerminal() ? () => {} : terminate;
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGQUIT", interrupt);
  try {
    return (await child.status).code;
  } finally {
    Deno.removeSignalListener("SIGTERM", terminate);
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGQUIT", interrupt);
  }
};
