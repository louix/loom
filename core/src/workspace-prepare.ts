import { initHookSchema, type InitHook } from "./types.ts";
import { executeShellHook } from "./shell-hook.ts";

/** Preparation has no agent to repair failures: stop before publishing any base. */
export const runWorkspacePrepare = async (
  hooks: InitHook[],
  cwd: string,
  signal: AbortSignal,
  environment = Deno.env.toObject(),
  report: (message: string) => void = console.error,
): Promise<void> => {
  for (const input of hooks) {
    const hook = initHookSchema.parse(input);
    if (hook.async) throw new Error("workspace_prepare hooks must block");
    signal.throwIfAborted();
    report("Running workspace_prepare: " + hook.name);
    const result = await executeShellHook(
      hook.run,
      cwd,
      {
        ...environment,
        LOOM_HOOK: hook.name,
        LOOM_HOOK_EVENT: "workspace_prepare",
        LOOM_REPO_ROOT: cwd,
        LOOM_WORKTREE: cwd,
      },
      hook.timeoutMs,
      signal,
    );
    signal.throwIfAborted();
    if (result.output) report(result.output);
    if (result.code !== 0)
      throw new Error(
        "workspace_prepare hook " +
          hook.name +
          (result.timedOut ? " timed out" : " failed (exit " + result.code + ")"),
      );
  }
};
