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
export const relaunchForIpc = async (entry: string, socket: string): Promise<void> => {
  const exact = await Deno.permissions.query({ name: "net", host: `unix:${resolve(socket)}` });
  const broad = await Deno.permissions.query({ name: "net" });
  if (exact.state === "granted" && broad.state !== "granted") return;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--frozen",
      "--node-modules-dir=manual",
      ...ipcPermissions(socket),
      entry,
      ...Deno.args,
    ],
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
  try {
    Deno.exit((await child.status).code);
  } finally {
    Deno.removeSignalListener("SIGTERM", terminate);
  }
};
