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

/**
 * A model can stream tool-call arguments that are not valid JSON — GLM-5.3
 * (sference) occasionally leaks its native `arg_value` template placeholder
 * (an angle-bracket tag) into the delta stream.
 * The tool harness reports the parse failure back to the model,
 * but the malformed assistant message is persisted and re-sent with every
 * later request, and strict endpoints fail to *render* the prompt from then
 * on — a bare 400 on every subsequent turn, bricking the session. Re-encode
 * unparseable `tool-call` inputs as a parseable wrapper so every request
 * stays renderable; the model still sees what went wrong in the tool
 * result's error text.
 *
 * The wrapper must be an OBJECT, not a JSON string: the openai-compatible
 * converter emits `arguments: JSON.stringify(part.input)`, so a string input
 * goes out double-encoded — and sference's prompt renderer rejects that too.
 */
export const repairMalformedToolInputs = (messages: ModelMessage[]): ModelMessage[] => {
  const partsOf = (m: ModelMessage): Array<Record<string, unknown>> | null =>
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as unknown as Array<Record<string, unknown>>)
      : null;

  let repaired = false;
  const out = messages.map((m) => {
    const parts = partsOf(m);
    if (!parts) return m;
    let touched = false;
    const fixed = parts.map((p) => {
      if (p.type !== "tool-call" || typeof p.input !== "string") return p;
      try {
        JSON.parse(p.input);
        return p;
      } catch {
        touched = true;
        return { ...p, input: { malformed_tool_input: p.input } };
      }
    });
    if (!touched) return m;
    repaired = true;
    return { ...m, content: fixed } as unknown as ModelMessage;
  });
  return repaired ? out : messages;
};
