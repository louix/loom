import type { AgentSession } from "@loom/core/types";
import {
  explainFileLimit,
  fileLimitDiagnostic,
  isFileLimitError,
} from "../../../../runtime/src/session-vm/file-limit.ts";

/** Annotate failures only. Successful file reads may contain examples of EMFILE. */
export const withVmDiagnostics = <T extends AgentSession>(session: T): T => {
  let toolWarning = false;
  return new Proxy(session, {
    get(target, key) {
      if (key === "events")
        return async function* () {
          for await (const event of target.events()) {
            if (event.type === "error") {
              yield { ...event, message: explainFileLimit(event.message) };
            } else if (event.type === "result" && event.kind === "error") {
              yield { ...event, error: explainFileLimit(event.error) };
            } else {
              if (
                event.type === "tool_result" &&
                !event.ok &&
                !toolWarning &&
                isFileLimitError(JSON.stringify(event.output))
              ) {
                toolWarning = true;
                yield {
                  sessionId: event.sessionId,
                  ts: event.ts,
                  ...(event.agentId ? { agentId: event.agentId } : {}),
                  type: "error" as const,
                  fatal: false,
                  message: fileLimitDiagnostic,
                };
              }
              yield event;
            }
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
