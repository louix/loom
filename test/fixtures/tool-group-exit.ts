/**
 * A worker whose session closes a Bash command that ignores SIGTERM, then exits:
 * `worker` the way runtime/src/worker/main.ts does, `abrupt` straight away.
 * Writes the command's process group id to `pidFile` first.
 */
import { BashShell } from "../../aisdk/src/tools/bash.ts";
import { exitWorker } from "../../runtime/src/worker/shutdown.ts";

const [pidFile = "pgid", exit] = Deno.args;
const shell = new BashShell(Deno.cwd());
void shell.run(`trap '' TERM; echo $$ > '${pidFile}'; sleep 1000`, 600_000).catch(() => {});
for (;;) {
  const text = await Deno.readTextFile(pidFile).catch(() => "");
  if (text.endsWith("\n")) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
shell.close();
if (exit === "abrupt") Deno.exit(0);
await exitWorker(0);
