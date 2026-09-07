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
import { absurd } from "@loom/core/absurd";
import type { HarnessEvent } from "@loom/core/events";
import { sessionStateLabel } from "@loom/core/session-state";
import type { HistoryPage, TranscriptId } from "@loom/core/wire";
import { C, clock, humanTokens, inside, truncate, wrapText, type Tone } from "./theme.ts";

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
   * no durable counterpart and lives in {@link Transcript.echoes}.
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
      return { glyph: "▪", text: oneLine(ev.text), full: body(ev.text), tone: "plain" };
    case "thinking":
      return { glyph: "·", text: oneLine(ev.text), full: body(ev.text), tone: "think" };
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
      const raw = valueOf(ev.output);
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
      return { glyph: "⇱", text: `${ev.tool} needs approval · req ${ev.id}`, tone: "accent" };
    case "question":
      return {
        glyph: "?",
        text: `${oneLine(ev.question, 120)} · req ${ev.id}`,
        full: body(ev.question),
        tone: "accent",
      };
    case "answer":
      return { glyph: "↩", text: oneLine(ev.text, 120), full: body(ev.text), tone: "accent" };
    case "plan_review":
      return { glyph: "❖", text: `plan ready for review · req ${ev.id}`, tone: "accent" };
    case "usage":
      return {
        glyph: "∑",
        text: `+${humanTokens(ev.tokens.input)}in +${humanTokens(ev.tokens.output)}out · ctx ${humanTokens(ev.contextUsed)}/${humanTokens(ev.contextLimit)}`,
        tone: "dim",
      };
    case "compact": {
      const head = `context compacted ${humanTokens(ev.before)}${ev.after > 0 ? ` → ${humanTokens(ev.after)}` : ""}`;
      return {
        glyph: "⇊",
        text: `${head}${ev.summary ? ` · ${oneLine(ev.summary, 80)}` : ""}`,
        ...(ev.summary ? { full: `${head}\n\n${body(ev.summary)}` } : {}),
        tone: "accent",
      };
    }
    case "context":
      return { glyph: "∑", text: `ctx ${humanTokens(ev.contextUsed)}`, tone: "dim" };
    case "compact_progress":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return { glyph: "⇊", text: `compacting… ${Math.round(ev.elapsedMs / 1000)}s`, tone: "dim" };
    case "rate_limit":
      // Never reaches the log (filtered in applyPush); here for exhaustiveness.
      return { glyph: "◷", text: `${ev.window ?? "plan"} ${ev.utilization ?? "?"}%`, tone: "dim" };
    case "subagent_started":
      return { glyph: "⤷", text: `sub-agent “${ev.name}” started`, tone: "dim" };
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
    case "error":
      return { glyph: "✕", text: oneLine(ev.message, 160), full: body(ev.message), tone: "bad" };
    case "result":
      // The turn's text is already in the log as assistant_text; a failure gets
      // its own `error` line. So this is just a terse end-of-turn marker.
      if (ev.kind === "ok" && ev.stopReason === "step_limit")
        return {
          glyph: "■",
          text: "turn paused — step ceiling hit repeatedly (send to continue)",
          tone: "warn",
        };
      return {
        glyph: "■",
        text: ev.kind === "ok" ? "turn complete" : "turn failed",
        tone: ev.kind === "ok" ? "good" : "bad",
      };
    case "rewind":
      return { glyph: "↶", text: `rewound to turn ${ev.toTurn}`, tone: "accent" };
    case "provider_changed":
      return {
        glyph: "⇄",
        text: `provider · ${ev.from} → ${ev.provider}${ev.model ? `/${ev.model}` : ""}${
          ev.effort ? ` · ${ev.effort}` : ""
        }${ev.lossy ? " · context summarized" : ""}`,
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
      return `  ${paths.length} file${paths.length === 1 ? "" : "s"}: ${oneLine(paths.join(", "), 80)}`;
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
  if (l.kind === "tool_call") return raw.split("\n").slice(1).join("\n").trim() || "(no arguments)";
  if (l.kind === "tool_result")
    return raw.replace(/^error\n/, "").trim() || (l.tone === "bad" ? "(failed)" : "ok");
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
}

/** A `+ `/`- `-prefixed line inside a `tool_call` / `tool_result` body reads as
 *  an added/removed diff line (an Edit's old/new block, tilth_write's own
 *  `diff: true` output, or even a `git diff` a Bash call happened to print) —
 *  colour it accordingly. Any other row keeps its plain tone colour. */
export const diffSegColor = (kind: LogLine["kind"], seg: string, fallback: string): string => {
  if (kind !== "tool_call" && kind !== "tool_result") return fallback;
  if (seg.startsWith("+ ")) return C.good;
  if (seg.startsWith("- ")) return C.bad;
  return fallback;
};

/**
 * Per-line render geometry: the gutter strings, indent, and the line's wrapped
 * segments, memoised per line + wrap width — appending an event then re-wraps
 * one line, not the backlog. LogLines are immutable and fall out of
 * `state.log` at its cap, so the `WeakMap` self-bounds.
 */
const layoutCache = new WeakMap<
  LogLine,
  { iw: number; ts: string; indent: number; segs: readonly string[] }
>();
const lineLayout = (
  l: LogLine,
  iw: number,
): { ts: string; indent: number; segs: readonly string[] } => {
  const hit = layoutCache.get(l);
  if (hit && hit.iw === iw) return hit;
  const ts = `${clock(l.ts)} `;
  const indent = ts.length + 2; // + "glyph "
  // Wrap each source line separately so intentional newlines are kept.
  const source = (l.full ?? l.text).replace(/[ \t]+$/gm, "") || "…";
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
  for (const l of ctx.lines) {
    const { ts, indent, segs } = lineLayout(l, ctx.iw);
    const lineEnd = off + segs.length;
    if (lineEnd > from) {
      const lo = Math.max(0, from - off);
      const hi = Math.min(segs.length, to - off);
      for (let i = lo; i < hi; i++) {
        out.push({
          // The durable id is unique within a session and stable across daemon
          // restarts; a local echo has none, so it falls back to its timestamp.
          key: `${l.id ?? `e${l.ts}`}-${i}`,
          first: i === 0,
          ts,
          indent,
          glyph: l.glyph,
          tone: l.tone,
          kind: l.kind,
          seg: segs[i]!,
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
