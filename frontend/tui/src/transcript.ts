/**
 * The transcript's lines: what an event becomes, what the filter keeps, and how
 * it wraps to the pane.
 *
 * Everything here is pure and takes lines rather than state, so the same
 * geometry answers both questions that have to agree — how many wrapped rows
 * the log has (what the scrollback offset counts in) and which rows the pane
 * draws. When those two drifted apart the viewport slid; keeping one measuring
 * function is what makes that impossible rather than merely unlikely.
 */
import { stripVTControlCharacters } from "node:util";
import { mkStore, type Store } from "./store.ts";
import { markdownText, plainText } from "./markdown.ts";
import type { TextDocument, TextSpan } from "./text-layout.ts";
import { absurd } from "@loom/core/absurd";
import type { HarnessEvent } from "@loom/core/events";
import { sessionStateLabel } from "@loom/core/session-state";
import type { HistoryCursor, HistoryPage, PushFrame, TranscriptId } from "@loom/core/wire";
import {
  C,
  clock,
  humanTokens,
  inside,
  type Palette,
  type Tone,
  truncate,
  wrapText,
} from "./theme.ts";

/** How much of the selected session's log to show:
 *   - `chat`           — just the conversation (tool traffic and thinking
 *                        collapsed to one-line markers)
 *   - `chat_and_tools` — conversation plus each individual tool call, but not
 *                        its output
 *   - `everything`     — the raw log, unfiltered */
export type LogFilter = "chat" | "chat_and_tools" | "everything";

/** `v` cycles through {@link LogFilter} in this order. */
export const cycleLogFilter = (f: LogFilter): LogFilter => {
  switch (f) {
    case "chat":
      return "chat_and_tools";
    case "chat_and_tools":
      return "everything";
    default:
      return "chat";
  }
};

/** Human label for what pressing `v` would switch the event log *to*. */
export const logFilterLabel = (f: LogFilter): string => {
  switch (f) {
    case "chat":
      return "chat only";
    case "chat_and_tools":
      return "chat + tool calls";
    case "everything":
      return "show everything";
    default:
      return absurd(f);
  }
};

/** Compact label for the *current* filter, as shown in the event-log header. */
export const logFilterTag = (f: LogFilter): string => {
  switch (f) {
    case "everything":
      return "full";
    case "chat_and_tools":
      return "chat+tools";
    default:
      return "chat";
  }
};

export interface LogLine {
  /**
   * The entry's durable {@link TranscriptId}: the id the daemon's live push and
   * its history pages both carry, so the two merge by identity rather than by
   * guessing from timestamps. `null` for a locally synthesised line, which has
   * no durable counterpart: a queued-message marker, which is derived per
   * render from the outbox rather than held anywhere.
   */
  id: TranscriptId | null;
  sessionId: string;
  /** The event kind, so `chat` view can collapse tool / thinking runs. */
  kind: HarnessEvent["type"] | "echo";
  /** Sub-agent that produced the event, when applicable. */
  agentId?: string;
  glyph: string;
  /** Compact one-liner for the log pane (may be truncated). */
  text: string;
  /**
   * The event's full body, newlines intact — for the `o` / `⌥o` editor view. The pane
   * itself renders it in full too (wrapped, never clipped). Omitted when it
   * would just equal {@link text}.
   */
  full?: string;
  /** For `tool_call`: the input's `description` field, when the tool provided one
   *  (e.g. Bash) — used by the `chat` view instead of a generic count. */
  toolDescription?: string;
  tone: Tone;
  ts: number;
}

/** The non-transcript event kinds — surfaced via the session snapshot /
 *  indicators, never the conversation (`applyPush` filters the same list). */
export const NON_TRANSCRIPT: ReadonlySet<string> = new Set([
  "status_changed",
  "compact_progress",
  "context",
  "background_tasks",
  "rate_limit",
]);

// ---------------------------------------------------------------------------
// event → log line
// ---------------------------------------------------------------------------

export const toLogLine = (
  id: TranscriptId | null,
  ev: HarnessEvent,
  toolName?: string,
): LogLine => {
  const f = formatEvent(ev, toolName);
  return {
    id,
    sessionId: ev.sessionId,
    kind: ev.type,
    ...(ev.agentId ? { agentId: ev.agentId } : {}),
    glyph: f.glyph,
    text: f.text,
    ...(f.full !== undefined && f.full !== f.text ? { full: f.full } : {}),
    ...(f.toolDescription !== undefined ? { toolDescription: f.toolDescription } : {}),
    tone: f.tone,
    ts: ev.ts,
  };
};

export interface EventFormat {
  glyph: string;
  text: string;
  /** Untruncated body with newlines, when it differs from {@link text}. */
  full?: string;
  /** `tool_call` only: the input's `description` field, when present. */
  toolDescription?: string;
  tone: Tone;
}

export const oneLine = (s: string, n = 200): string => truncate(s.replace(/\s+/g, " ").trim(), n);

/**
 * Full body: normalise newlines, expand tabs, trim trailing space, keep
 * everything else. Tabs matter here — a tab counts as ~1 column to our word
 * wrap and to Ink's own width math, but a real terminal jumps it to the next
 * 8-column stop. Left in, a tab-indented diff can render wider than the
 * terminal thinks, so the line hard-wraps outside Ink's row accounting and
 * every subsequent redraw lands one row off (looks like a blank line wedged
 * between every row) until the offending line scrolls out of view.
 */
const body = (s: string): string =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();

/**
 * One `"question"="answer"` pair from an `AskUserQuestion` tool result. Non-greedy
 * on both sides, ended by the next pair's opening quote or the trailing sentence
 * that follows the whole set — not by any `"` inside the answer itself, so a quote
 * embedded in free-text (`the session would "know" about it`) doesn't cut it short.
 */
const ASK_USER_QUESTION_PAIR = /"([^]*?)"="([^]*?)"(?=, "|\.\s|\.$|$)/g;

/**
 * The SDK renders a resolved `AskUserQuestion` as one run-on confirmation
 * sentence (`The user answered: "…"="…", "…"="…". <note>`) — technically
 * correct but unreadable once the answer is more than a few words. Reflow it
 * into `Q:`/`A:` blocks for the event log; `null` (leave the raw text as-is)
 * if the shape doesn't match.
 */
const formatAskUserQuestionResult = (raw: string): string | null => {
  const prefix = "The user answered: ";
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  const pairs: Array<{ q: string; a: string }> = [];
  ASK_USER_QUESTION_PAIR.lastIndex = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = ASK_USER_QUESTION_PAIR.exec(rest))) {
    pairs.push({ q: m[1]!, a: m[2]! });
    end = ASK_USER_QUESTION_PAIR.lastIndex;
  }
  if (pairs.length === 0) return null;
  const note = rest
    .slice(end)
    .replace(/^\.\s*/, "")
    .trim();
  const blocks = pairs.map((p, i) => {
    const n = pairs.length > 1 ? String(i + 1) : "";
    return `Q${n}: ${p.q}\nA${n}: ${p.a}`;
  });
  return [...blocks, ...(note ? [note] : [])].join("\n\n");
};

export const formatEvent = (ev: HarnessEvent, toolName?: string): EventFormat => {
  switch (ev.type) {
    case "assistant_text":
      return {
        glyph: "▪",
        text: oneLine(ev.text),
        full: body(ev.text),
        tone: "plain",
      };
    case "thinking":
      return {
        glyph: "·",
        text: oneLine(ev.text),
        full: body(ev.text),
        tone: "think",
      };
    case "tool_call": {
      const desc = toolDescriptionOf(ev.input);
      return {
        glyph: "⚙",
        text: `${ev.name}${summarizeInput(ev.name, ev.input)}`,
        full: toolCallFull(ev.name, ev.input),
        ...(desc !== undefined ? { toolDescription: desc } : {}),
        tone: "warn",
      };
    }
    case "tool_result": {
      const raw = ev.ok ? valueOf(ev.output) : toolErrorText(ev.output);
      const out = typeof raw === "string" ? body(raw) : "";
      // A read-only whole-file tool's result is just the file the user can
      // already see — the call line (path + range) says enough; don't dump
      // the content into the log a second time.
      const terse = ev.ok && toolName !== undefined && isReadTool(toolName);
      const full = ev.ok ? (formatAskUserQuestionResult(out) ?? out) : `error\n${out}`;
      return {
        glyph: "↳",
        text: ev.ok ? "ok" : `error ${oneLine(out || String(raw), 120)}`,
        ...(out && !terse ? { full } : {}),
        tone: ev.ok ? "good" : "bad",
      };
    }
    case "permission_request":
      return {
        glyph: "⇱",
        text: `${ev.tool} needs approval · req ${ev.id}`,
        tone: "accent",
      };
    case "question":
      return {
        glyph: "?",
        text: `${oneLine(ev.question, 120)} · req ${ev.id}`,
        full: body(ev.question),
        tone: "accent",
      };
    case "answer":
      return {
        glyph: "↩",
        text: oneLine(ev.text, 120),
        full: body(ev.text),
        tone: "accent",
      };
    case "plan_review":
      return {
        glyph: "❖",
        text: `plan ready for review · req ${ev.id}`,
        tone: "accent",
      };
    case "usage":
      return {
        glyph: "∑",
        text: `+${humanTokens(ev.tokens.input)}in +${humanTokens(
          ev.tokens.output,
        )}out · ctx ${humanTokens(ev.contextUsed)}/${
          ev.contextLimit > 0 ? humanTokens(ev.contextLimit) : "unknown"
        }`,
        tone: "dim",
      };
    case "compact": {
      const head = `context compacted ${humanTokens(ev.before)}${
        ev.after > 0 ? ` → ${humanTokens(ev.after)}` : ""
      }`;
      return {
        glyph: "⇊",
        text: `${head}${ev.summary ? ` · ${oneLine(ev.summary, 80)}` : ""}`,
        ...(ev.summary ? { full: `${head}\n\n${body(ev.summary)}` } : {}),
        tone: "accent",
      };
    }
    case "context":
      return {
        glyph: "∑",
        text: `ctx ${humanTokens(ev.contextUsed)}`,
        tone: "dim",
      };
    case "compact_progress":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return {
        glyph: "⇊",
        text: `compacting… ${Math.round(ev.elapsedMs / 1000)}s`,
        tone: "dim",
      };
    case "rate_limit":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return {
        glyph: "◷",
        text: `${ev.window ?? "plan"} ${ev.utilization ?? "?"}%`,
        tone: "dim",
      };
    case "subagent_started":
      return {
        glyph: "⤷",
        text: `sub-agent “${ev.name}” started`,
        tone: "dim",
      };
    case "subagent_stopped":
      return { glyph: "⤴", text: `sub-agent finished`, tone: "dim" };
    case "background_tasks":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return {
        glyph: "◐",
        text:
          ev.tasks.length === 0
            ? "background work drained"
            : `${ev.tasks.length} background task${ev.tasks.length === 1 ? "" : "s"} running`,
        tone: "dim",
      };
    case "status_changed":
      return {
        glyph: "◈",
        text: `${sessionStateLabel(ev.status)}${ev.note ? ` (${ev.note})` : ""}`,
        tone: "dim",
      };
    case "startup_progress":
      return { glyph: "·", text: ev.message, tone: "dim" };
    case "error":
      return {
        glyph: "✕",
        text: oneLine(ev.message, 160),
        full: body(ev.message),
        tone: "bad",
      };
    case "result":
      // The turn's text is already in the log as assistant_text; a failure gets
      // its own `error` line. So this is just a terse end-of-turn marker.
      if (ev.kind === "ok" && ev.stopReason === "step_limit") {
        return {
          glyph: "■",
          text: "turn paused — step ceiling hit repeatedly (send to continue)",
          tone: "warn",
        };
      }
      return {
        glyph: "■",
        text: ev.kind === "ok" ? "turn complete" : "turn failed",
        tone: ev.kind === "ok" ? "good" : "bad",
      };
    case "rewind":
      return {
        glyph: "↶",
        text: `rewound to turn ${ev.toTurn}`,
        tone: "accent",
      };
    case "provider_changed":
      return {
        glyph: "⇄",
        text: `provider · ${ev.from} → ${ev.provider}${
          ev.model ? `/${ev.model}` : ""
        }${ev.effort ? ` · ${ev.effort}` : ""}${ev.lossy ? " · context summarized" : ""}`,
        tone: "accent",
      };
    case "user_message":
      return {
        glyph: ev.injected ? "»" : "›",
        text: ev.injected ? `${oneLine(ev.text, 160)} · sent mid-turn` : oneLine(ev.text, 160),
        full: ev.injected ? `${body(ev.text)}\n\n(sent mid-turn)` : body(ev.text),
        tone: "accent",
      };
    default:
      return absurd(ev);
  }
};

/** Claude's built-in whole-file reader, and tilth's structural equivalent — a
 *  tool_result here is just the file, already visible to the user; showing it
 *  again in the log is pure noise (see `formatEvent`'s `tool_result` case). */
const isReadTool = (name: string): boolean => name === "Read" || name.endsWith("tilth_read");

/** String-replacement editors, across every connector's naming for one. */
const isEditTool = (name: string): boolean =>
  name === "Edit" || name === "MultiEdit" || name === "edit" || name.endsWith("tilth_edit");

/** tilth's batch multi-file write — its `files` array gets one block per file
 *  instead of rendering as a single JSON blob (see `tilthWriteBody`). */
const isTilthWriteTool = (name: string): boolean => name.endsWith("tilth_write");

const pathOf = (o: Record<string, unknown>): string | undefined => {
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.path === "string") return o.path;
  return undefined;
};

const summarizeInput = (name: string, input: unknown): string => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (isTilthWriteTool(name) && Array.isArray(o.files)) {
      const paths = o.files.map((f) =>
        f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string"
          ? ((f as Record<string, unknown>).path as string)
          : "?",
      );
      return `  ${paths.length} file${paths.length === 1 ? "" : "s"}: ${oneLine(
        paths.join(", "),
        80,
      )}`;
    }
    if (isReadTool(name)) {
      const path = pathOf(o);
      if (path !== undefined) {
        const offset = typeof o.offset === "number" ? o.offset : undefined;
        const limit = typeof o.limit === "number" ? o.limit : undefined;
        const range =
          offset !== undefined || limit !== undefined
            ? ` [${offset ?? 0}${limit !== undefined ? `+${limit}` : "+"}]`
            : "";
        return `  ${oneLine(path, 80)}${range}`;
      }
    }
    for (const k of ["command", "file_path", "path", "pattern", "query", "url"]) {
      if (typeof o[k] === "string") return `  ${oneLine(o[k] as string, 80)}`;
    }
  }
  return "";
};

/** The tool input's `description` field (e.g. Bash's), when present and non-blank. */
const toolDescriptionOf = (input: unknown): string | undefined => {
  if (input && typeof input === "object") {
    const d = (input as Record<string, unknown>).description;
    if (typeof d === "string" && d.trim()) return oneLine(d, 120);
  }
  return undefined;
};

/**
 * Full tool-call rendering for the editor / wrapped view. Edit-shaped tools
 * (`old_string` / `new_string`) render as a removed/added block; tilth_write's
 * batch `files` gets one block per file; everything else falls back to one
 * `key: value` line per argument — strings verbatim (multi-line ones indented
 * under their key), anything else as compact JSON. Readable, not a raw dump.
 */
const toolCallFull = (name: string, input: unknown): string => {
  if (input == null || typeof input !== "object") return name;
  const o = input as Record<string, unknown>;
  if (isEditTool(name)) {
    const diff = editDiffBody(name, o);
    if (diff !== undefined) return diff;
  }
  if (isTilthWriteTool(name) && Array.isArray(o.files)) {
    return tilthWriteBody(name, o.files);
  }
  const entries = Object.entries(o);
  if (entries.length === 0) return name;
  const lines = [name];
  for (const [k, v] of entries) {
    if (typeof v === "string") {
      const normalized = v.includes("\t") || v.includes("\r") ? body(v) : v;
      if (normalized.includes("\n")) {
        lines.push(`${k}:`);
        for (const ln of normalized.split("\n")) lines.push(`  ${ln}`);
      } else {
        lines.push(`${k}: ${normalized}`);
      }
    } else {
      let rendered: string;
      try {
        rendered = JSON.stringify(v);
      } catch {
        rendered = String(v);
      }
      lines.push(`${k}: ${rendered}`);
    }
  }
  return lines.join("\n");
};

/** `old_string` / `new_string` (any connector's naming for them) as a
 *  removed/added block — a full diff library is overkill for a single
 *  anchored replacement, and this is what the call already tells you changed. */
const editDiffBody = (name: string, o: Record<string, unknown>): string | undefined => {
  const oldS = typeof o.old_string === "string" ? o.old_string : undefined;
  const newS = typeof o.new_string === "string" ? o.new_string : undefined;
  if (oldS === undefined || newS === undefined) return undefined;
  const path = pathOf(o);
  const lines = [path ? `${name}  ${path}` : name];
  for (const ln of body(oldS).split("\n")) lines.push(`- ${ln}`);
  for (const ln of body(newS).split("\n")) lines.push(`+ ${ln}`);
  return lines.join("\n");
};

/** One block per file for tilth_write's batch `files` array, instead of the
 *  whole call rendering as a single JSON blob. */
const tilthWriteBody = (name: string, files: unknown[]): string => {
  const blocks = files.map((f) => {
    const rec = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const path = typeof rec.path === "string" ? rec.path : "?";
    const mode = typeof rec.mode === "string" ? rec.mode : "hash";
    if (typeof rec.content === "string") {
      const lines = [`${path}  (${mode})`];
      for (const ln of body(rec.content).split("\n")) lines.push(`+ ${ln}`);
      return lines.join("\n");
    }
    if (Array.isArray(rec.edits)) {
      const lines = [`${path}  (${mode})`];
      for (const e of rec.edits) {
        const edit = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        const start = typeof edit.start === "string" ? edit.start : "?";
        const end = typeof edit.end === "string" ? edit.end : undefined;
        lines.push(`@ ${start}${end ? `-${end}` : ""}`);
        const content = typeof edit.content === "string" ? edit.content : "";
        for (const ln of body(content).split("\n")) lines.push(`+ ${ln}`);
      }
      return lines.join("\n");
    }
    return path;
  });
  return [name, ...blocks].join("\n\n");
};

const valueOf = (x: unknown): unknown => {
  if (x && typeof x === "object" && "text" in (x as Record<string, unknown>)) {
    return (x as Record<string, unknown>)["text"];
  }
  return x;
};

/** MCP failures can carry text blocks or a message instead of a plain string. */
const toolErrorText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["content"])) {
      const text = record["content"]
        .filter(
          (block): block is { type: "text"; text: string } =>
            block !== null &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string",
        )
        .map((block) => block.text)
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    for (const key of ["text", "message"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};

/** The lines a page contributes, in page order. Non-transcript kinds are
 *  dropped exactly as the live path drops them. */
export const pageLines = (page: HistoryPage): LogLine[] => {
  // Per-page only: a call/result pair split across two pages falls back to
  // generic formatting, a fine default for history that old.
  const toolNames: Record<string, string> = {};
  const out: LogLine[] = [];
  for (const entry of page.items) {
    const ev = entry.event;
    if (NON_TRANSCRIPT.has(ev.type)) continue;
    if (ev.type === "tool_call") toolNames[ev.id] = ev.name;
    const toolName = ev.type === "tool_result" ? toolNames[ev.id] : undefined;
    out.push(toLogLine(entry.id, ev, toolName));
  }
  return out;
};

/**
 * The one-line marker a follow-up gets while it waits for the current turn.
 *
 * Synthesised per render from the outbox, not stored: there is no durable row
 * behind it, so it has no id, no place in the id order and nothing to
 * reconcile against. It sits after every durable line, which is where the
 * message it stands for is going.
 */
export const queuedLine = (sessionId: string, text: string): LogLine => ({
  id: null,
  sessionId,
  kind: "echo",
  glyph: "▸",
  text: `queued: ${text.replace(/\s+/g, " ").trim()}`,
  full: `queued: ${text}`,
  tone: "dim",
  ts: 0,
});

// ---------------------------------------------------------------------------
// the resource
// ---------------------------------------------------------------------------

/**
 * Retained durable lines — roughly 20MB of event text per 10k lines in a
 * tool-heavy session. It bounds both the footprint and the per-event cost:
 * every append copies the array, so an uncapped window makes each arriving
 * frame more expensive than the last.
 *
 * The window is always *contiguous*. Whichever end the reader is at survives:
 * following the tail evicts the front, paging back evicts the tail. Nothing
 * evicted is lost — `olderCursor` is always the retained front — but the two
 * cases are not symmetric, because only tail eviction leaves a hole between
 * what is held and what is arriving. That is the `detached` variant.
 */
export const TRANSCRIPT_CAP = 10_000;

/** The next older page's fetch. Loaded lines stay put across all three. */
export type OlderFetch =
  | { readonly t: "idle" }
  | { readonly t: "loading" }
  | { readonly t: "failed"; readonly error: string };

/** A retained window of one session's durable history. */
export interface TranscriptWindow {
  readonly sessionId: string;
  /** Durable entries, ascending by id and deduplicated by it. Entries are
   *  keyed and ordered by their durable id, never by timestamp: a burst of
   *  events shares one millisecond and a provider can report them out of
   *  order, so a timestamp-sorted merge stitches history back together wrongly
   *  at exactly the boundaries that matter — a daemon restart, a tool storm. */
  readonly lines: readonly LogLine[];
  /**
   * Where the next older page starts. Always the retained front, so anything
   * dropped to stay inside {@link TRANSCRIPT_CAP} is refetchable by
   * construction. `null` iff {@link lines} reaches the oldest entry the daemon
   * holds — running out of room here can never be mistaken for the daemon
   * running out of history.
   */
  readonly olderCursor: HistoryCursor | null;
  readonly older: OlderFetch;
}

/**
 * The selected session's transcript — one resource, not a cache per session.
 * Selecting another session loads that one; what the reader was looking at
 * before is not kept, because keeping it meant keeping a window, a cursor and
 * a following flag per session that no one was reading and nothing was
 * invalidating.
 *
 * A window exists only in the two loaded variants, and the difference between
 * them is not a flag beside the load state but the state itself:
 *
 *   • `tailing`  — the window ends at the live tail, so an arriving event
 *                  belongs immediately after the last retained line.
 *   • `detached` — paging back past the cap evicted the newest end. The entries
 *                  between this window and the live stream are gone, so an
 *                  arriving event has nowhere to go that wouldn't draw a gap as
 *                  continuous history; it reaches the reader through the notice
 *                  line instead, and `End` reloads the newest page.
 *
 * `loading` and `failed` carry `early`: the live entries that arrived before
 * the page did. The subscription is established long before any fetch, so
 * those are real events, not a window — no cursor, nothing to page. The head
 * page merges them in by durable id, which is the whole of the overlap
 * handling.
 */
export type Transcript =
  | { readonly t: "unloaded" }
  | {
      readonly t: "loading";
      readonly sessionId: string;
      readonly early: readonly LogLine[];
    }
  | {
      readonly t: "failed";
      readonly sessionId: string;
      readonly error: string;
      readonly early: readonly LogLine[];
    }
  | ({ readonly t: "tailing" } & TranscriptWindow)
  | ({ readonly t: "detached" } & TranscriptWindow);

export const noTranscript: Transcript = { t: "unloaded" };

/** Start (or restart) the selected session's transcript at its newest page. */
export const openTranscript = (sessionId: string): Transcript => ({
  t: "loading",
  sessionId,
  early: [],
});

export const transcriptSession = (tr: Transcript): string | null =>
  tr.t === "unloaded" ? null : tr.sessionId;

/** The window, or null while there isn't one — the only door to the operations
 *  a window supports (paging older, appending the live tail). */
export const transcriptWindow = (tr: Transcript): TranscriptWindow | null =>
  tr.t === "tailing" || tr.t === "detached" ? tr : null;

const NO_LINES: readonly LogLine[] = [];

/** Every durable line the transcript is holding, oldest first. */
export const transcriptLines = (tr: Transcript): readonly LogLine[] => {
  switch (tr.t) {
    case "unloaded":
      return NO_LINES;
    case "loading":
    case "failed":
      return tr.early;
    case "tailing":
    case "detached":
      return tr.lines;
    default:
      return absurd(tr);
  }
};

/** Merge `add` into `have` by durable id, keeping id order. Entries already
 *  held win, so a page overlapping the live stream re-uses the objects the
 *  renderer has already measured instead of replacing them. */
const mergeById = (have: readonly LogLine[], add: readonly LogLine[]): LogLine[] => {
  if (add.length === 0) return [...have];
  const byId = new Map<TranscriptId, LogLine>();
  for (const l of have) if (l.id !== null) byId.set(l.id, l);
  for (const l of add) if (l.id !== null && !byId.has(l.id)) byId.set(l.id, l);
  return [...byId.values()].sort((x, y) => (x.id ?? 0) - (y.id ?? 0));
};

/**
 * The one retention rule, applied wherever a window grows: page merges,
 * ordinary live appends, and out-of-order live merges all come through here.
 *
 * `keep` says which end the reader is at and therefore which end survives.
 * `atOldest` is what the source claims about the *front* it supplied — a page
 * whose `olderCursor` was `null`, or a window we already believed reached the
 * daemon's first entry. That claim only holds while that front is still here,
 * which is why `olderCursor` is recomputed from the retained window rather than
 * copied from the page.
 */
const trim = (
  win: TranscriptWindow,
  lines: readonly LogLine[],
  keep: "newest" | "oldest",
  atOldest: boolean,
): { readonly win: TranscriptWindow; readonly lostTail: boolean } => {
  const fits = lines.length <= TRANSCRIPT_CAP;
  // Not `fits ? lines : slice(...)`: this runs on every arriving event, and
  // computing the trim eagerly would put an O(n) copy on the common path where
  // there is nothing to trim.
  let kept = lines;
  if (!fits) {
    kept =
      keep === "newest"
        ? lines.slice(lines.length - TRANSCRIPT_CAP)
        : lines.slice(0, TRANSCRIPT_CAP);
  }
  const front = kept[0];
  // `null` — and only `null` — means the retained front IS the daemon's oldest
  // entry. Evicting the front withdraws that claim and points the cursor at
  // what was dropped, so scroll-back can always get it back.
  const frontKept = front !== undefined && front === lines[0];
  let olderCursor = win.olderCursor;
  if (atOldest && frontKept) olderCursor = null;
  else if (front?.id != null) olderCursor = { olderThan: front.id };
  return {
    win: { ...win, lines: kept, olderCursor },
    lostTail: !fits && keep === "oldest",
  };
};

/** Cap the pre-fetch buffer the same way a window is capped. A session that
 *  streams 10k events before its first page lands is not a reason to grow
 *  without bound. */
const capEarly = (lines: readonly LogLine[]): readonly LogLine[] =>
  lines.length <= TRANSCRIPT_CAP ? lines : lines.slice(lines.length - TRANSCRIPT_CAP);

/**
 * Fold one live entry in. Almost always a plain append — its id is newer than
 * anything held — so that case avoids building a map per event.
 *
 * An event for any other session is not this resource's: there is no cache to
 * put it in, and selecting that session loads it from the daemon.
 */
export const liveLine = (tr: Transcript, line: LogLine): Transcript => {
  if (transcriptSession(tr) !== line.sessionId) return tr;
  switch (tr.t) {
    case "unloaded":
    case "detached":
      return tr;
    case "loading":
    case "failed":
      return { ...tr, early: capEarly([...tr.early, line]) };
    case "tailing": {
      const atOldest = tr.olderCursor === null;
      const last = tr.lines[tr.lines.length - 1];
      // Out of order, or a repeat of something already held. `mergeById` dedupes
      // by durable id, so neither can grow the window twice — but a merge is a
      // growth like any other and takes the same cap.
      const grown =
        last !== undefined && last.id !== null && line.id !== null && line.id <= last.id
          ? mergeById(tr.lines, [line])
          : [...tr.lines, line];
      return { ...trim(tr, grown, "newest", atOldest).win, t: "tailing" };
    }
    default:
      return absurd(tr);
  }
};

/**
 * The newest page landed. It is the newest by definition, so the resource is
 * `tailing` whatever it was before, and whatever arrived while the fetch was
 * out merges in by durable id.
 */
export const headLoaded = (tr: Transcript, sessionId: string, page: HistoryPage): Transcript => {
  if (transcriptSession(tr) !== sessionId) return tr;
  const base: TranscriptWindow = {
    sessionId,
    lines: [],
    olderCursor: null,
    older: { t: "idle" },
  };
  const merged = mergeById(transcriptLines(tr), pageLines(page));
  return {
    ...trim(base, merged, "newest", page.olderCursor === null).win,
    t: "tailing",
  };
};

/** The newest page failed. What arrived meanwhile is kept — those lines are on
 *  screen, and the retry merges them the same way a first load does. */
export const headFailed = (tr: Transcript, sessionId: string, error: string): Transcript =>
  tr.t === "loading" && tr.sessionId === sessionId
    ? { t: "failed", sessionId, error, early: tr.early }
    : tr;

export const olderLoading = (tr: Transcript, sessionId: string): Transcript => {
  if (tr.t !== "tailing" && tr.t !== "detached") return tr;
  if (tr.sessionId !== sessionId) return tr;
  return { ...tr, older: { t: "loading" } };
};

/** An older page extends the front, so the window keeps its oldest end. If the
 *  cap then drops its newest, the live tail is no longer attached to it. */
export const olderLoaded = (tr: Transcript, sessionId: string, page: HistoryPage): Transcript => {
  if (tr.t !== "tailing" && tr.t !== "detached") return tr;
  if (tr.sessionId !== sessionId) return tr;
  const merged = mergeById(tr.lines, pageLines(page));
  const { win, lostTail } = trim(tr, merged, "oldest", page.olderCursor === null);
  const detached = lostTail || tr.t === "detached";
  return { ...win, older: { t: "idle" }, t: detached ? "detached" : "tailing" };
};

/** A failed older-page fetch loses the page, not the transcript the reader is
 *  looking at. */
export const olderFailed = (tr: Transcript, sessionId: string, error: string): Transcript => {
  if (tr.t !== "tailing" && tr.t !== "detached") return tr;
  if (tr.sessionId !== sessionId) return tr;
  return { ...tr, older: { t: "failed", error } };
};

/**
 * What the event pane shows, per {@link LogFilter}. A focused child (fleet
 * drill-down) narrows the session's log to the events that child produced —
 * the `agentId` tag the adapter stamps on sub-agent frames — and the
 * condensers then run on that narrowed stream, so thinking-runs collapse
 * within the child rather than across the whole session. Unfocused, those
 * child-tagged frames are hidden: they live in the child's subtree, and the
 * main stream keeps only the ⤷/⤴ markers that announce a sub-agent.
 */
export const filterLog = (
  lines: readonly LogLine[],
  filter: LogFilter,
  childId: string | null,
): LogLine[] => {
  const base = childId
    ? lines.filter((l) => l.agentId === childId)
    : lines.filter((l) => !l.agentId);
  switch (filter) {
    case "chat":
      return condenseLog(base);
    case "chat_and_tools":
      return condenseToolResults(base);
    case "everything":
      return base;
    default:
      return absurd(filter);
  }
};
/** Collapse a run of consecutive `thinking` lines (starting at `i`) into one
 *  `· thought for Ns` marker, returning it and the index past the run. */
const collapseThinking = (lines: readonly LogLine[], i: number): [LogLine, number] => {
  let j = i;
  while (j < lines.length && lines[j]?.kind === "thinking") j += 1;
  const first = lines[i]!;
  const last = lines[j - 1]!;
  const secs = Math.round((last.ts - first.ts) / 1000);
  return [
    {
      id: first.id,
      sessionId: first.sessionId,
      kind: "thinking",
      ...(first.agentId ? { agentId: first.agentId } : {}),
      glyph: "·",
      text: secs > 0 ? `thought for ${secs}s` : "thought a moment",
      tone: "think",
      ts: first.ts,
    },
    j,
  ];
};

/** `⌃E`-style: fold consecutive `thinking` into `· thought for Ns`, and
 *  consecutive `tool_call` / `tool_result` into `⚙ N tool calls`. Everything
 *  else passes through untouched. */
export const condenseLog = (lines: readonly LogLine[]): LogLine[] => {
  const out: LogLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l) break;
    if (l.kind === "usage") {
      i += 1; // pure metering — not conversation
      continue;
    }
    if (l.kind === "thinking") {
      const [marker, next] = collapseThinking(lines, i);
      out.push(marker);
      i = next;
      continue;
    }
    if (l.kind === "tool_call" || l.kind === "tool_result") {
      let j = i;
      // Runs of tool calls with no `description` collapse into one `N tool
      // call(s)` marker (as before); calls that do have one get their own
      // line instead, in place among the undescribed runs' markers.
      let pending: LogLine | null = null;
      let pendingCount = 0;
      const flushPending = () => {
        if (!pending) return;
        out.push({
          id: pending.id,
          sessionId: pending.sessionId,
          kind: "tool_call",
          ...(pending.agentId ? { agentId: pending.agentId } : {}),
          glyph: "⚙",
          text: `${pendingCount} tool call${pendingCount === 1 ? "" : "s"}`,
          tone: "warn",
          ts: pending.ts,
        });
        pending = null;
        pendingCount = 0;
      };
      while (
        j < lines.length &&
        (lines[j]?.kind === "tool_call" || lines[j]?.kind === "tool_result")
      ) {
        const line = lines[j]!;
        if (line.kind === "tool_call") {
          if (line.toolDescription) {
            flushPending();
            out.push({
              id: line.id,
              sessionId: line.sessionId,
              kind: "tool_call",
              ...(line.agentId ? { agentId: line.agentId } : {}),
              glyph: "⚙",
              text: line.toolDescription,
              tone: "warn",
              ts: line.ts,
            });
          } else {
            if (!pending) pending = line;
            pendingCount += 1;
          }
        }
        j += 1;
      }
      flushPending();
      i = j;
      continue;
    }
    out.push(l);
    i += 1;
  }
  return out;
};

/** `chat_and_tools`: like {@link condenseLog}, but keeps each tool call as
 *  its own line instead of collapsing the run — only the tool *results* (the
 *  output) are dropped. */
export const condenseToolResults = (lines: readonly LogLine[]): LogLine[] => {
  const out: LogLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l) break;
    if (l.kind === "usage" || l.kind === "tool_result") {
      i += 1;
      continue;
    }
    if (l.kind === "thinking") {
      const [marker, next] = collapseThinking(lines, i);
      out.push(marker);
      i = next;
      continue;
    }
    out.push(l);
    i += 1;
  }
  return out;
};

/** Role label for a log line in the `o` / `⌥o` transcript, or null to omit it. */
const transcriptHeader = (l: LogLine): string | null => {
  const midTurn = l.glyph === "»" ? " (mid-turn)" : "";
  switch (l.kind) {
    case "assistant_text":
      return "agent";
    case "thinking":
      return "agent (thinking)";
    case "tool_call":
      return `tool call: ${(l.full ?? l.text).split("\n")[0]}`;
    case "tool_result":
      return l.tone === "bad" ? "tool result (error)" : "tool result";
    case "user_message":
    case "echo":
      return `you${midTurn}`;
    case "question":
      return "agent asks";
    case "answer":
      return "you (answer)";
    case "plan_review":
      return "agent (plan ready for review)";
    case "permission_request":
      return "agent (needs approval)";
    case "compact":
      return "context compacted";
    case "error":
      return "error";
    case "subagent_started":
      return "sub-agent started";
    case "subagent_stopped":
      return "sub-agent finished";
    case "rewind":
      return "rewound";
    case "provider_changed":
      return "provider switched";
    // metadata, not conversation
    case "startup_progress":
    case "usage":
    case "result":
    case "status_changed":
    case "compact_progress":
    case "context":
    case "rate_limit":
    case "background_tasks":
      return null;
    default:
      return absurd(l.kind);
  }
};

/** Body text for the `o` / `⌥o` transcript — the header already names the role. */
const transcriptBody = (l: LogLine): string => {
  const raw = (l.full ?? l.text).replace(/[ \t]+$/gm, "").trimEnd();
  if (l.kind === "tool_call") {
    return raw.split("\n").slice(1).join("\n").trim() || "(no arguments)";
  }
  if (l.kind === "tool_result") {
    return raw.replace(/^error\n/, "").trim() || (l.tone === "bad" ? "(failed)" : "ok");
  }
  return raw;
};

/**
 * The selected session's log as a readable transcript for `$EDITOR`: one entry
 * per event as `[time]  <role>` then the body, blank line between. Raw bodies,
 * no `chat`-view collapsing — the "give me everything" view.
 */
export const transcriptText = (lines: readonly LogLine[]): string => {
  const parts: string[] = [];
  for (const l of lines) {
    const header = transcriptHeader(l);
    if (header === null) continue;
    parts.push(`[${clock(l.ts)}]  ${header}\n${transcriptBody(l)}`);
  }
  return parts.join("\n\n") || "(no events)";
};

// ---------------------------------------------------------------------------
// wrapped-row geometry
// ---------------------------------------------------------------------------

/** One wrapped screen row of the event log. `first` rows carry the time + glyph
 *  gutter; continuation rows carry `indent` spaces and nothing else. */
export interface PhysicalRow {
  readonly key: string;
  readonly first: boolean;
  readonly ts: string;
  readonly indent: number;
  readonly glyph: string;
  readonly tone: Tone;
  /** The source line's event kind — gates {@link diffSegColor}, so a bulleted
   *  list in assistant prose can't misread as a removed diff line. */
  readonly kind: LogLine["kind"];
  readonly seg: string;
  readonly spans?: readonly TextSpan[];
}

/** A `+ `/`- `-prefixed line inside a `tool_call` / `tool_result` body reads as
 *  an added/removed diff line (an Edit's old/new block, tilth_write's own
 *  `diff: true` output, or even a `git diff` a Bash call happened to print) —
 *  colour it accordingly. Any other row keeps its plain tone colour. */
export const diffSegColor = (
  kind: LogLine["kind"],
  seg: string,
  fallback: string,
  palette: Palette = C,
): string => {
  if (kind !== "tool_call" && kind !== "tool_result") return fallback;
  if (seg.startsWith("+ ")) return palette.good;
  if (seg.startsWith("- ")) return palette.bad;
  return fallback;
};

/**
 * Per-line render geometry: the gutter strings, indent, and the line's wrapped
 * segments, memoised per line + wrap width — appending an event then re-wraps
 * one line, not the backlog. LogLines are immutable and fall out of
 * `state.log` at its cap, so the `WeakMap` self-bounds.
 */
// Documents survive width changes; both caches release entries with their LogLine.
const documentCache = new WeakMap<LogLine, TextDocument>();
const layoutCache = new WeakMap<
  LogLine,
  {
    iw: number;
    ts: string;
    indent: number;
    segs: readonly string[];
    spans?: readonly (readonly TextSpan[])[];
  }
>();
const lineLayout = (
  l: LogLine,
  iw: number,
): {
  ts: string;
  indent: number;
  segs: readonly string[];
  spans?: readonly (readonly TextSpan[])[];
} => {
  const hit = layoutCache.get(l);
  if (hit && hit.iw === iw) return hit;
  const ts = `${clock(l.ts)} `;
  const indent = ts.length + 2; // + "glyph "
  // Output from PTYs may contain bare CRs (including CRCRLF) and cursor
  // commands. Normalize before measuring rows: terminal controls can escape
  // the pane even when Ink clips the text to its measured width.
  const source =
    stripVTControlCharacters(l.full ?? l.text)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "    ")
      // eslint-disable-next-line no-control-regex -- only newlines may reach row splitting
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
      .replace(/ +$/gm, "") || "…";
  const width = Math.max(8, iw - indent);
  if (
    l.kind === "assistant_text" ||
    l.kind === "user_message" ||
    l.kind === "echo" ||
    l.kind === "answer" ||
    l.kind === "question" ||
    l.kind === "thinking"
  ) {
    const literal = l.kind === "user_message" || l.kind === "echo" || l.kind === "answer";
    let doc = documentCache.get(l);
    if (!doc) {
      doc = (literal ? plainText : markdownText)(source);
      documentCache.set(l, doc);
    }
    const rows = doc.layout(width);
    const entry = {
      iw,
      ts,
      indent,
      segs: rows.map((r) => r.text),
      // Literal messages inherit their role color instead of document styling.
      ...(literal ? {} : { spans: rows.map((r) => r.spans) }),
    };
    layoutCache.set(l, entry);
    return entry;
  }
  const segs = source
    .split("\n")
    .flatMap((ln) => wrapText(ln.trim() === "" ? " " : ln, Math.max(8, iw - indent)));
  const entry = { iw, ts, indent, segs };
  layoutCache.set(l, entry);
  return entry;
};

/** Everything the log renderers need for one set of lines + pane width: the
 *  lines the filter kept, and the pane's inner width. */
export interface LogContext {
  lines: readonly LogLine[];
  iw: number;
}

export const logContext = (lines: readonly LogLine[], width: number): LogContext => ({
  lines,
  iw: inside(width),
});

/** Wrapped-row total for the visible log — O(lines) per call, with per-line
 *  geometry memoised in `layoutCache`, so re-measuring a grown log re-wraps
 *  only the new lines. Deliberately NOT cached per log version: a stale total
 *  here desyncs the scroll math from the rendered window (the exact bug class
 *  this replaced a full materialisation to avoid), and the walk is cheap — a
 *  WeakMap hit + an add per line. */
export const totalRows = (ctx: LogContext): number => {
  let total = 0;
  for (const l of ctx.lines) total += lineLayout(l, ctx.iw).segs.length;
  return total;
};
/** The wrapped rows `[from, to)` of the visible log — builds only the window's
 *  row objects; the full wrapped list is never materialised. Partial lines at
 *  the window edges render their inner segments only, exactly like slices of a
 *  fully-built list did. */
export const windowRows = (ctx: LogContext, from: number, to: number): PhysicalRow[] => {
  const out: PhysicalRow[] = [];
  if (to <= from) return out;
  let off = 0;
  let n = -1;
  for (const l of ctx.lines) {
    n += 1;
    const { ts, indent, segs, spans } = lineLayout(l, ctx.iw);
    const lineEnd = off + segs.length;
    if (lineEnd > from) {
      const lo = Math.max(0, from - off);
      const hi = Math.min(segs.length, to - off);
      for (let i = lo; i < hi; i++) {
        out.push({
          // The durable id is unique within a session and stable across daemon
          // restarts; a synthesised line has none, so it falls back to its
          // position, which is stable for as long as the line is on screen.
          key: `${l.id ?? `q${n}`}-${i}`,
          first: i === 0,
          ts,
          indent,
          glyph: l.glyph,
          tone: l.tone,
          kind: l.kind,
          seg: segs[i]!,
          ...(spans ? { spans: spans[i]! } : {}),
        });
      }
      if (lineEnd >= to) break;
    }
    off = lineEnd;
  }
  return out;
};

/**
 * The event log's wrapped-row count at pane `width` — what the scrollback
 * offset is a row offset into, and what `EventLog` pins the viewport against.
 * The transcript handle measures through this so the scroll math can't drift
 * from what renders: one logical line wraps to several physical rows, and only
 * this count is the truth.
 */
export const logRowCount = (lines: readonly LogLine[], width: number): number =>
  totalRows(logContext(lines, width));

// ---------------------------------------------------------------------------
// the handle
// ---------------------------------------------------------------------------

/** Fold only durable entries for this resource; other sessions cost no formatting. */
export const liveFrame = (tr: Transcript, frame: PushFrame, toolName?: string): Transcript => {
  if (
    frame.type !== "event" ||
    frame.id === undefined ||
    NON_TRANSCRIPT.has(frame.event.type) ||
    transcriptSession(tr) !== frame.event.sessionId
  ) {
    return tr;
  }
  return liveLine(tr, toLogLine(frame.id, frame.event, toolName));
};

export interface TranscriptView {
  readonly transcript: Transcript;
  readonly scroll: number;
}

export interface TranscriptDeps {
  /** `session.events`. One page; a cursor continues into older history. */
  fetch: (sessionId: string, cursor: HistoryCursor | null) => Promise<HistoryPage>;
  /** Only fetch while the daemon is there. */
  connected: () => boolean;
  /** The lines the pane is drawing — filter and child focus already applied.
   *  Scroll is measured in the wrapped rows *these* produce, through the same
   *  geometry the pane renders with. */
  shown: (transcript: Transcript) => readonly LogLine[];
  /** The log pane's width in columns and its height in wrapped rows. */
  paneWidth: () => number;
  pageRows: () => number;
}

export interface TranscriptControl extends Pick<Store<TranscriptView>, "get" | "subscribe"> {
  readonly receive: (frame: PushFrame) => void;
  readonly refresh: () => void;
  readonly contentChanged: () => void;
  /** Wrapped rows the viewport is offset up from the live tail. */
  readonly scroll: () => number;
  /** Scroll back by `by` rows (negative moves toward the tail). Pulls the next
   *  older page as the viewport nears the top. */
  readonly scrollBy: (by: number) => void;
  /** Home: the oldest line held. */
  readonly toTop: () => void;
  /** End: back to the live tail — and, from a detached window, the action that
   *  reloads the newest page. Also the explicit retry for a failed load. */
  readonly toTail: () => void;
  /** A selection/filter/connection input, independent of resource publications. */
  readonly select: (id: string | null, viewKey: string) => void;
  /** Re-measure after the terminal resized. */
  readonly resized: () => void;
  readonly dispose: () => void;
}

/** What the last measurement saw, so the next one can tell where the log grew. */
interface Anchor {
  readonly key: string;
  readonly rows: number;
  readonly tailId: TranscriptId | null;
  readonly pinnedTop: boolean;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One lifetime per loaded transcript, owning its requests and the viewport.
 *
 * The lifetime is a counter, not a cancellation: a fetch that has already
 * resolved has a callback queued whatever we do to the promise, so every
 * callback checks the generation it was issued under before it is allowed to
 * touch anything. Selecting another session, losing the connection, jumping to
 * the latest page and unmounting all bump it.
 *
 * The viewport is corrected in exactly one place ({@link mkTranscript}'s
 * `reanchor`), from what the previous measurement saw. The promise callbacks
 * report *what* landed — an older page lands above the window, a live event
 * below it — and nothing else adjusts the offset.
 */
export const mkTranscript = (d: TranscriptDeps): TranscriptControl => {
  let resource: Transcript = noTranscript;
  const store = mkStore<TranscriptView>({ transcript: resource, scroll: 0 });
  const toolNames = new Map<string, string>();
  let disposed = false;
  let viewKey = "";
  const publish = () => {
    const before = store.get();
    if (before.transcript !== resource || before.scroll !== scroll) {
      store.set({ transcript: resource, scroll });
    }
  };
  const commit = (tr: Transcript, older = false) => {
    if (disposed || tr === resource) return;
    resource = tr;
    reanchor(older);
    publish();
  };
  let gen = 0;
  let scroll = 0;
  let anchor: Anchor = { key: "", rows: 0, tailId: null, pinnedTop: false };

  const anchorKey = (): string => `${gen} ${viewKey}`;

  /**
   * Measure the pane and remember it. Returns the ceiling for `scroll`:
   * `EventLog` pins the viewport at `rows - capacity` (the top of the log), so
   * the backing offset must clamp there too — running it past the top would
   * leave you scrolling back down the same distance before the viewport moves
   * again.
   */
  const sync = (key: string): number => {
    const lines = d.shown(resource);
    const rows = logRowCount(lines, d.paneWidth());
    const max = Math.max(0, rows - d.pageRows());
    scroll = Math.min(scroll, max);
    anchor = {
      key,
      rows,
      tailId: lines[lines.length - 1]?.id ?? null,
      pinnedTop: scroll >= max,
    };
    return max;
  };

  const invalidate = (): void => {
    gen += 1;
  };

  /** Load `sessionId`'s newest page under a fresh lifetime. */
  const open = (sessionId: string): void => {
    if (disposed) return;
    invalidate();
    toolNames.clear();
    const mine = gen;
    commit(openTranscript(sessionId));
    if (!d.connected()) return;
    d.fetch(sessionId, null).then(
      (page) => {
        if (mine !== gen) return;
        commit(headLoaded(resource, sessionId, page));
      },
      (e: unknown) => {
        if (mine !== gen) return;
        commit(headFailed(resource, sessionId, errText(e)));
      },
    );
  };

  /**
   * Pull the next older page. A `null` cursor means the daemon has nothing
   * older — and only that, since retention re-points the cursor at whatever it
   * evicted rather than clearing it.
   */
  const loadOlder = (): void => {
    if (!d.connected()) return;
    const tr = resource;
    const win = transcriptWindow(tr);
    if (!win || win.older.t === "loading" || win.olderCursor === null) return;
    const mine = gen;
    const { sessionId, olderCursor } = win;
    commit(olderLoading(tr, sessionId));
    d.fetch(sessionId, olderCursor).then(
      (page) => {
        if (mine !== gen) return;
        // Read by the reanchor this commit triggers: these rows land *above*
        // the window, which is the one growth a tail-relative offset cannot
        // simply absorb.
        commit(olderLoaded(resource, sessionId, page), true);
      },
      (e: unknown) => {
        if (mine !== gen) return;
        commit(olderFailed(resource, sessionId, errText(e)));
      },
    );
  };

  /**
   * Keep the reader on the rows they are reading.
   *
   * At the live tail (`scroll === 0`) there is nothing to hold: new rows appear
   * below and the viewport is already where it should be, so the common case
   * costs one string compare and no measurement.
   */
  const reanchor = (fold = false): void => {
    const key = anchorKey();
    if (key !== anchor.key) {
      // A different session, filter, child or lifetime: the rows the offset was
      // counted against are gone.
      scroll = 0;
      anchor = { key, rows: 0, tailId: null, pinnedTop: false };
      return;
    }
    if (scroll === 0 && !fold) return;
    const before = anchor;
    const max = sync(key);
    if (fold) {
      // Rows landed above the window. A view anchored on its own rows keeps
      // them for free — the offset counts up from the tail — but a view pinned
      // at the top has to follow the new top, and at the cap the fold drops
      // rows below the viewport as well, so a moved tail invalidates the offset
      // altogether. Both re-derive from the top the reader is already at: this
      // fetch only fires within a page of it.
      if (before.pinnedTop || anchor.tailId !== before.tailId) scroll = max;
    } else if (anchor.rows > before.rows) {
      // A live frame landed at the tail while you were reading history. Grow
      // the offset by however many rows the log gained — `end = total - scroll`
      // (see `EventLog`) then holds still and the same window renders. A cap
      // trim (net rows <= 0) is a no-op.
      scroll = Math.min(max, scroll + (anchor.rows - before.rows));
    }
    anchor = { ...anchor, pinnedTop: scroll >= max };
  };

  return {
    get: store.get,
    subscribe: store.subscribe,
    receive: (frame) => {
      if (disposed) return;
      if (frame.type !== "event" || frame.event.sessionId !== transcriptSession(resource)) return;
      const ev = frame.event;
      let name: string | undefined;
      if (ev.type === "tool_call") toolNames.set(ev.id, ev.name);
      if (ev.type === "tool_result") {
        name = toolNames.get(ev.id);
        toolNames.delete(ev.id);
      }
      commit(liveFrame(resource, frame, name));
    },
    refresh: () => {
      const id = transcriptSession(resource);
      if (id) open(id);
    },
    contentChanged: () => {
      reanchor();
      publish();
    },
    scroll: () => scroll,

    scrollBy: (by) => {
      const max = sync(anchorKey());
      scroll = Math.max(0, Math.min(max, scroll + by));
      anchor = { ...anchor, pinnedTop: scroll >= max };
      // Prefetch the next older page as the viewport nears the top, so paging
      // back feels seamless instead of stalling at the current oldest line.
      if (max - scroll < d.pageRows()) loadOlder();
      publish();
    },

    toTop: () => {
      const max = sync(anchorKey());
      scroll = max;
      anchor = { ...anchor, pinnedTop: true };
      loadOlder();
      publish();
    },

    toTail: () => {
      scroll = 0;
      const tr = resource;
      // Paging back far enough evicts the newest end of the window, and live
      // entries stop being folded in while that is true. Jumping to the tail is
      // the action that undoes it — and the explicit retry a failed load waits
      // for.
      if (tr.t === "detached" || tr.t === "failed") {
        return void open(tr.sessionId);
      }
      publish();
    },

    select: (id, key) => {
      if (disposed) return;
      viewKey = key;
      const tr = resource;
      if (!d.connected() || id === null) {
        // No connection means no transcript we can trust: entries were appended
        // while we were away and the cursor is a position in a history the next
        // connection re-reads from scratch.
        if (tr.t !== "unloaded") {
          invalidate();
          commit(noTranscript);
        }
      } else if (transcriptSession(tr) !== id) {
        open(id);
      }
      reanchor();
      publish();
    },

    resized: () => {
      if (scroll === 0) return;
      sync(anchorKey());
      publish();
    },

    dispose: () => {
      disposed = true;
      invalidate();
      toolNames.clear();
    },
  };
};
