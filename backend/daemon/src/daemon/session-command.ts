import type { SessionSnapshot } from "@loom/core/wire";
import { executeShellHook, type HookAttempt } from "../../../../core/src/shell-hook.ts";
import { applyEnvironmentChanges, type EnvironmentChanges } from "./local-environment.ts";

/** Project commands follow execution mode, independently of checkout layout. */
export const runSessionCommand = async (options: {
  session: SessionSnapshot;
  repoRoot: string;
  command: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  localEnvironment: (sessionId: string) => EnvironmentChanges | undefined;
  runGuest: (
    session: SessionSnapshot,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    env: Record<string, string>,
  ) => Promise<HookAttempt>;
}): Promise<HookAttempt> => {
  const { session, command, env, timeoutMs, signal } = options;
  signal.throwIfAborted();
  // Legacy private clones also require a VM; never execute their code on the host.
  if (session.isolation === "vm" || session.checkout === "clone")
    return options.runGuest(session, command, timeoutMs, signal, env);
  const cwd = session.inPlace ? options.repoRoot : session.worktree;
  if (!cwd) throw new Error("The session workspace is unavailable. Resume it first.");
  const environment = options.localEnvironment(session.id);
  return executeShellHook(
    command,
    cwd,
    { ...applyEnvironmentChanges(Deno.env.toObject(), environment), ...env },
    timeoutMs,
    signal,
  );
};
