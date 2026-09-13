/**
 * Generate a short session label through the same provider. The daemon calls
 * this after successful turns, retries failures, and persists successful
 * generation separately from a manual title lock.
 */
import { randomUUID } from "node:crypto";
import { isClaudeId } from "@loom/core/provider-id";
import type { AgentProvider, AgentSession } from "@loom/core/types";
import type { Logger } from "@loom/core/logger";

const SYSTEM =
  "You are a labelling function, not an assistant. Given a task description, " +
  "output ONLY a 4–6 word title for it in plain text — no quotes, no trailing " +
  "punctuation, no preamble. Never ask a question, never address the user, " +
  "never refuse. If the description is vague, terse, or nonsensical, still " +
  'produce your best-guess noun phrase (e.g. "Casual greeting from the user").';

const INSTRUCTION = "Title for this task (label only, no questions):";

/**
 * A reply that's a chat turn, not a label — a question back to the user, an
 * apology, or a refusal. We'd rather keep the clipped first message than show
 * one of these. (Merely *long* replies aren't rejected — they get capped.)
 */
const looksConversational = (firstLine: string, cleaned: string): boolean => {
  if (firstLine.trim().endsWith("?")) return true;
  return /^(?:i['’](?:m|ll|ve|d)\b|im |i am |i |sorry\b|could you|can you|please\b|what |which |who |when |where |why |how |tell me|provide |describe |hello\b|hey\b)/i.test(
    cleaned,
  );
};

/** Built-ins a titling turn has no business touching. */
const NO_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "TodoWrite",
];

/** A cheap model for the one-shot when `[titles] model` is unset. */
export const cheapModelFor = (providerId: string): string | undefined => {
  return isClaudeId(providerId) ? "claude-haiku-4-5-20251001" : undefined;
};

/**
 * Tidy a raw model reply into a title: first non-blank line, unwrapped, with
 * surrounding quotes and trailing punctuation stripped, capped at 72 chars.
 * Returns `null` when there's nothing usable.
 */
export const cleanTitle = (raw: string): string | null => {
  const firstLine = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  let t = firstLine
    .replace(/\s+/g, " ")
    .replace(/^[\s*"'`“”]+/, "") // leading wrappers
    .replace(/^(?:title|task)\s*[:\-–]\s*/i, "") // a "Title: …" preamble
    .replace(/[\s*"'`“”.!?,;:]+$/, "") // trailing wrappers + punctuation
    .trim();
  if (t.length === 0) return null;
  // A chat turn slipped through the system prompt — don't use it as a title.
  if (looksConversational(firstLine, t)) return null;
  if (t.length > 72) t = t.slice(0, 71).trimEnd() + "…";
  return t;
};

export interface TitleRequest {
  provider: AgentProvider;
  prompt: string;
  cwd: string;
  model?: string;
  log: Logger;
  /** Abort the one-shot after this long. */
  timeoutMs?: number;
}

/** Run the one-shot and return a cleaned title, or `null` on any failure. */
export const generateTitle = async (req: TitleRequest): Promise<string | null> => {
  const { provider, prompt, cwd, model, log } = req;
  if (!provider.capabilities.oneShot) return null;
  // A single word (a greeting, "hi", "help") has nothing to summarise and tends
  // to make the model converse — keep the clipped message as the title.
  if (prompt.trim().split(/\s+/).filter(Boolean).length < 2) return null;

  let session: AgentSession | undefined;
  let closing: Promise<void> | undefined;
  let timedOut = false;
  const close = (): Promise<void> => {
    if (!session) return Promise.resolve();
    return (closing ??= Promise.resolve()
      .then(() => session!.close())
      .catch(() => {}));
  };
  // Bound startup, streaming AND cleanup. Closing a broken provider need not
  // unblock its iterator; racing the whole job keeps naming/shutdown bounded.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      log.warn("titler: timed out", { timeoutMs: req.timeoutMs ?? 30_000 });
      void close();
      resolve(null);
    }, req.timeoutMs ?? 30_000);
  });
  const run = async (): Promise<string | null> => {
    try {
      session = await provider.createSession({
        sessionId: `title-${randomUUID()}`,
        cwd,
        prompt: `${INSTRUCTION}\n\n${prompt}`,
        mode: "auto",
        mcpServers: [],
        oneShot: true,
        disableTools: NO_TOOLS,
        settingSources: [],
        systemPromptAppend: SYSTEM,
        ...(model ? { model } : {}),
      });
      // A startup that resolves after the deadline still owns cleanup.
      if (timedOut) return null;
      let text = "";
      for await (const ev of session.events()) {
        if (timedOut) return null;
        if (ev.type === "assistant_text") text += ev.text;
        else if (ev.type === "result") {
          const title = ev.kind === "ok" ? cleanTitle(text) : null;
          if (!title) log.warn("titler: no usable title", { result: ev.kind });
          return title;
        } else if (ev.type === "error" && ev.fatal) break;
      }
      log.warn("titler: stream ended without a result");
      return null;
    } catch (err) {
      log.warn("titler: request failed", { err: String(err) });
      return null;
    } finally {
      await close();
    }
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
