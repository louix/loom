/**
 * The process an on-demand runtime build runs under (spawned by build.ts). It
 * takes the runtime home's builder lock before the builder starts and holds it
 * until the builder has exited, so any later Loom learns whether a build is
 * under way by trying that lock: held means running, free means gone. No
 * process ids or start times are compared, so neither pid reuse nor the
 * locale, time zone or environment of either side can mislead it, and a crash
 * of the Loom that started it changes nothing.
 *
 * The builder starts only on the word of the Loom that spawned this process,
 * given once the lock is held: a Loom dying before then leaves nothing running.
 * Imports nothing, so it starts quickly with few permissions.
 */

/** Written to stdout once the builder lock is held. */
export const supervisorLocked = "locked";
/** Read from stdin: start the builder. End of input without it means Loom has gone. */
export const supervisorGo = "go";

/**
 * Stop the builder's foreground VM command: its trap then stops and deletes the
 * VM, and the shell exits with the builder.
 */
const stopBuilder = (shell: number) => {
  try {
    new Deno.Command("/bin/sh", {
      args: [
        "-c",
        'for p in $(pgrep -P "$0"); do pkill -TERM -P "$p"; kill -TERM "$p"; done',
        String(shell),
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch {
    /* exited */
  }
};

const supervise = async (args: string[]) => {
  const [lockPath, builder, output, log, marker] = args;
  if (!lockPath || !builder || !output || !log || !marker) Deno.exit(2);
  let shell: Deno.ChildProcess | undefined;
  // Stopping Loom stops the build; before the builder starts there is nothing to stop.
  Deno.addSignalListener("SIGTERM", () => (shell ? stopBuilder(shell.pid) : Deno.exit(143)));
  // A terminal's interrupt or hangup reaches the builder directly; the lock stays
  // held until the builder has actually exited.
  for (const signal of ["SIGINT", "SIGHUP"] as const) Deno.addSignalListener(signal, () => {});
  const lock = await Deno.open(lockPath, { create: true, read: true, write: true, mode: 0o600 });
  await lock.lock(true);
  await Deno.stdout.write(new TextEncoder().encode(`${supervisorLocked}\n`));
  let input = "";
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    input += chunk;
    if (input.includes("\n")) break;
  }
  if (input.split("\n")[0] !== supervisorGo) Deno.exit(2);
  // Only a temporary directory crosses: the builder sets its own private HOME/XDG
  // paths, and nothing from Loom's environment (credentials included) reaches it.
  // Output goes straight to the log, never through a pipe whose reader may exit,
  // and the shell marks success for whichever Loom finishes the build.
  shell = new Deno.Command("/bin/sh", {
    args: ["-c", '"$0" "$1" >>"$2" 2>&1 && : >"$3"', builder, output, log, marker],
    clearEnv: true,
    env: { TMPDIR: "/tmp" },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const status = await shell.status;
  // Exiting releases the lock, after the success marker is in place.
  Deno.exit(status.success ? 0 : 1);
};

if (import.meta.main) await supervise(Deno.args);
