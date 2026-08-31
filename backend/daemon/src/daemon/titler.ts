/**
 * Auto-titling (M7a). A session's title starts as the first message clipped to
 * 200 chars; after the first turn the daemon replaces it with a short summary
 * produced by a cheap, tool-free one-shot through the *same* provider. A manual
 * rename (`session.setTitle`) locks the title and this never runs again.
 */
import { randomUUID } from "node:crypto";
import type { AgentProvider } from "@loom/core/types";
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
  return /^(?:i['’]?m |i am |i |sorry\b|could you|can you|please\b|what |which |who |when |where |why |how |tell me|provide |describe |hello\b|hey\b)/i.test(
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
  return providerId === "claude" ? "claude-haiku-4-5-20251001" : undefined;
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

  let session;
  try {
    session = await provider.createSession({
      sessionId: `title-${randomUUID()}`,
      cwd,
      prompt: `${INSTRUCTION}\n\n${prompt}`,
      mode: "auto", // no permission round-trips for a throwaway
      mcpServers: [],
      oneShot: true,
      disableTools: NO_TOOLS,
      settingSources: [],
      systemPromptAppend: SYSTEM,
      ...(model ? { model } : {}),
    });
  } catch (err) {
    log.debug("titler: createSession failed", { err: String(err) });
    return null;
  }

  let text = "";
  const timer = setTimeout(() => void session.close().catch(() => {}), req.timeoutMs ?? 30_000);
  try {
    for await (const ev of session.events()) {
      if (ev.type === "assistant_text") text += ev.text;
      else if (ev.type === "result" || (ev.type === "error" && ev.fatal)) break;
    }
  } catch (err) {
    log.debug("titler: stream failed", { err: String(err) });
  } finally {
    clearTimeout(timer);
    await session.close().catch(() => {});
  }
  return cleanTitle(text);
};
