import type { AgentSession } from "@loom/core/types";
/** Refresh the host snapshot after an early provider 401. Never replay a turn:
 * it may already have run tools. One attempt per mounted session avoids loops. */
export const refreshOnAuthFailure = <T extends AgentSession>(
  session: T,
  refresh: () => Promise<unknown>,
): T => {
  let attempted = false;
  return new Proxy(session, {
    get(target, key) {
      if (key === "events")
        return async function* () {
          for await (const event of target.events()) {
            if (
              !attempted &&
              event.type === "error" &&
              /\b401\b|authentication_(?:error|failed)|invalid authentication credentials/i.test(
                event.message,
              )
            ) {
              attempted = true;
              // Display the failure immediately; renewal prepares a later explicit send.
              void refresh().catch(() => {});
            }
            yield event;
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
