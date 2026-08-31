/**
 * Transcript hygiene shared by the provider (cold resume) and the live session
 * (interrupt / error mid-tool). Kept in its own module so `session.ts` and
 * `provider.ts` can both import it without a cycle.
 */
import type { ModelMessage } from "ai";

/**
 * A turn that was killed mid-tool (user interrupt, a daemon restart while a
 * permission was pending, or a provider error) leaves an assistant message whose
 * `tool-call` parts have no matching `tool-result` — most endpoints 400 on the
 * next request. Drop that trailing assistant message (and anything after it) so
 * the session is valid and a fresh `send` re-runs from the last real user turn.
 */
export const dropDanglingToolCalls = (messages: ModelMessage[]): ModelMessage[] => {
  const partsOf = (m: ModelMessage | undefined): Array<{ type?: string; toolCallId?: string }> =>
    Array.isArray(m?.content) ? (m.content as Array<{ type?: string; toolCallId?: string }>) : [];

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return messages;

  const callIds = partsOf(messages[lastAssistant])
    .filter((p) => p.type === "tool-call" && typeof p.toolCallId === "string")
    .map((p) => p.toolCallId as string);
  if (callIds.length === 0) return messages;

  const answered = new Set<string>();
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    for (const p of partsOf(messages[i])) {
      if (p.type === "tool-result" && typeof p.toolCallId === "string") answered.add(p.toolCallId);
    }
  }
  return callIds.every((id) => answered.has(id)) ? messages : messages.slice(0, lastAssistant);
};
