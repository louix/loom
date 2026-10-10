import { settleProcessGroups, terminateProcessGroup } from "../../../core/src/process-group.ts";

/** POSIX native workers lead their own process group. Parent EOF must also
 * clean up ordinary descendants when the daemon is no longer alive to do it.
 * Detached descendants are outside this lifecycle mechanism, not confined.
 * Descendants get SIGTERM and a grace before SIGKILL: an agent's `git` killed
 * outright leaves its worktree's index.lock behind. The tools' own detached
 * groups (Bash, background tasks) already SIGTERMed by the session's close are
 * not in this group: their SIGKILLs are awaited too, or the exit drops them. */
export const exitWorker = async (code: number): Promise<never> => {
  if (Deno.args.includes("--process-group")) {
    // The group's SIGTERM reaches this process too; it must outlive it to escalate.
    Deno.addSignalListener("SIGTERM", () => {});
    await Promise.all([terminateProcessGroup(Deno.pid), settleProcessGroups()]);
  } else {
    await settleProcessGroups();
  }
  Deno.exit(code);
};

export const armWorkerShutdown = () => {
  if (Deno.args.includes("--process-group")) setTimeout(() => void exitWorker(1), 5000);
};
