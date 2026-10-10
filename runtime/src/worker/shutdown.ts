import { terminateProcessGroup } from "../../../core/src/process-group.ts";

/** POSIX native workers lead their own process group. Parent EOF must also
 * clean up ordinary descendants when the daemon is no longer alive to do it.
 * Detached descendants are outside this lifecycle mechanism, not confined.
 * Descendants get SIGTERM and a grace before SIGKILL: an agent's `git` killed
 * outright leaves its worktree's index.lock behind. */
export const exitWorker = async (code: number): Promise<never> => {
  if (Deno.args.includes("--process-group")) {
    // The group's SIGTERM reaches this process too; it must outlive it to escalate.
    Deno.addSignalListener("SIGTERM", () => {});
    await terminateProcessGroup(Deno.pid);
  }
  Deno.exit(code);
};

export const armWorkerShutdown = () => {
  if (Deno.args.includes("--process-group")) setTimeout(() => void exitWorker(1), 5000);
};
