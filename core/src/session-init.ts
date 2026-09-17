import type { CreateSessionOptions, SessionRef } from "./types.ts";
import { executeShellHook } from "./shell-hook.ts";

/** Run init in the session's environment; failures inform the opening turn without blocking it. */
export const runSessionInit = async <T extends CreateSessionOptions | SessionRef>(
  options: T,
  progress: (message: string) => void | Promise<void>,
  signal: AbortSignal,
  environment?: Record<string, string>,
  deferAsync = true,
): Promise<T> => {
  const { initHooks } = options;
  const session = { ...options };
  delete session.initHooks;
  if (!initHooks || ("oneShot" in options && options.oneShot)) return session;
  const background = initHooks.hooks.filter((hook) => hook.async && deferAsync);
  if (background.length) session.initHooks = { ...initHooks, hooks: background };
  const failures: string[] = [];
  for (const hook of initHooks.hooks) {
    if (hook.async && deferAsync) continue;
    signal.throwIfAborted();
    await progress(`Running init hook: ${hook.name}…`);
    try {
      const result = await executeShellHook(
        hook.run,
        options.cwd,
        {
          ...(environment ?? Deno.env.toObject()),
          ...initHooks.env,
          LOOM_HOOK: hook.name,
          LOOM_HOOK_EVENT: "init",
          LOOM_SESSION_ID: options.sessionId,
        },
        hook.timeoutMs,
        signal,
      );
      if (result.code !== 0) {
        const why = result.timedOut ? "timed out" : `exited ${result.code}`;
        const message = `Init hook "${hook.name}" ${why}:\n${result.output || "(no output)"}`;
        failures.push(message);
        await progress(message);
      } else await progress(`Init hook finished: ${hook.name}.`);
    } catch (error) {
      signal.throwIfAborted();
      const message = `Init hook "${hook.name}" failed: ${String(error)}`;
      failures.push(message);
      await progress(message);
    }
  }
  signal.throwIfAborted();
  if (failures.length) {
    const feedback =
      "\n\n[loom] Session initialization had errors. You can repair the project and retry the commands:\n\n" +
      failures.join("\n\n").slice(0, 64_000);
    if ("prompt" in session) session.prompt += feedback;
    else session.systemPromptAppend = (session.systemPromptAppend ?? "") + feedback;
  }
  return session;
};
