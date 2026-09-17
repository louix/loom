import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { CreateSessionOptions } from "@loom/core/types";

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** Native async hooks deliver JSON on completion; keep a bounded log for inspection meanwhile. */
export const claudeInitHooks = (options: CreateSessionOptions, directory: string) => {
  const context: string[] = [];
  const hooks = (options.initHooks?.hooks ?? []).map((hook, index) => {
    const output = join(directory, `${index}.log`);
    const status = join(directory, `${index}.status`);
    const env = {
      ...options.initHooks!.env,
      LOOM_HOOK: hook.name,
      LOOM_HOOK_EVENT: "init",
      LOOM_SESSION_ID: options.sessionId,
    };
    const report = (outcome: string) =>
      quote(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `[loom] Initialization ${outcome}: ${hook.run}. Output: ${output}. Status: ${status}.`,
          },
        }),
      );
    context.push(
      `[loom] Initialization is running: ${hook.run}\nOutput: ${output}\nStatus: ${status} (exit code when finished).`,
    );
    const script = `
set -o pipefail
mkdir -- ${quote(join(directory, `${index}.started`))} 2>/dev/null || exit 0
cd -- ${quote(options.cwd)} || exit 1
timeout --kill-after=1s ${hook.timeoutMs / 1000}s env ${Object.entries(env)
      .map(([key, value]) => quote(key + "=" + value))
      .join(" ")} sh -c ${quote(hook.run)} 2>&1 | { head -c 8000; cat >/dev/null; } > ${quote(
      output,
    )}
code=$?
printf '%s\\n' "$code" > ${quote(status)}
case "$code" in
  0) printf '%s\\n' ${report("finished")} ;;
  124|137) printf '%s\\n' ${report("timed out")} ;;
  *) printf '%s\\n' ${report("failed")} ;;
esac
`;
    return {
      type: "command" as const,
      command: "bash -c " + quote(script),
      async: true,
    };
  });
  // No matcher: a newly forked conversation may start via native resume.
  // The adapter consumes initHooks once, so rewind/restart cannot register them again.
  return {
    settings: { hooks: { SessionStart: [{ hooks }] } } satisfies Options["settings"],
    context: context.join("\n\n"),
  };
};
