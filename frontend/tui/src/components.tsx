/**
 * Ink components for the TUI. Written in JSX and run with no bundler — `@oxc-node`
 * transforms `.tsx` on the fly (the `loom`/`loomd` bins and the test runner both
 * load its hook), so the only build step is still "none". Every component is a
 * pure projection of {@link TuiState}.
 */
import { useMemo, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "@loom/core/wire";
import { layout, type Buffer } from "./editor.ts";
import {
  cacheHeat,
  cacheStatus,
  clock,
  footerHints,
  groupsOf,
  pickerVisible,
  providerInfo,
  queueFor,
  selectedSession,
  visibleLog,
  type Connection,
  type ConfirmState,
  type LogLine,
  type Pending,
  type PickerState,
  type PromptKind,
  type PromptState,
  type TuiState,
} from "./model.ts";
import {
  bar,
  C,
  humanDuration,
  humanTokens,
  mmss,
  modeLabel,
  money,
  shortId,
  spinnerFrame,
  statusLook,
  toneColor,
  truncate,
  wrapText,
  type Tone,
} from "./theme.ts";

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

/** Inner width of a `borderStyle:"round"` + `paddingX:1` box. */
const inside = (w: number): number => Math.max(4, w - 4);

/** First non-blank line of a (possibly multi-line) session title. */
const titleLine = (t: string | null): string => {
  for (const raw of (t ?? "").split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return "(untitled)";
};

/** Connection lamp — glyph + colour per {@link Connection}, read fresh so it follows the theme. */
const lampFor = (c: Connection): { color: string; text: string } => {
  switch (c) {
    case "live":
      return { color: C.good, text: "● live" };
    case "reconnecting":
      return { color: C.warn, text: "◍ reconnecting" };
    case "closed":
      return { color: C.bad, text: "○ offline" };
    case "connecting":
      return { color: C.dim, text: "◌ connecting" };
  }
};

/** Editor placeholder per prompt kind. */
const PROMPT_PLACEHOLDER: Record<PromptKind, string> = {
  deny: "reason (optional)",
  new: "describe the task…",
  title: "session title",
  discuss: "what should change about the plan?",
  compact: "what to keep in focus — blank compacts the whole history",
  send: "type a message…",
  answer: "type a message…",
};

/** Context-meter colour by fill fraction. */
const contextHeatColor = (frac: number): string => {
  if (frac > 0.85) return C.bad;
  if (frac > 0.6) return C.warn;
  return C.accentDim;
};

/** The one-line git summary under a session's Detail pane. */
const gitLineText = (s: SessionSnapshot): string => {
  const g = s.git;
  if (g) {
    return [
      s.inPlace ? "in-place" : null,
      g.branch ?? s.branch ?? "(detached)",
      `${g.commits} commit${g.commits === 1 ? "" : "s"}`,
      g.aheadOfBase ? `+${g.aheadOfBase}` : null,
      g.behindBase ? `-${g.behindBase} behind` : null,
      g.dirty ? "dirty" : "clean",
    ]
      .filter(Boolean)
      .join("  ·  ");
  }
  if (s.inPlace) return "in-place — repo working dir";
  if (s.branch) return `${s.branch}  ·  no worktree (gc'd)`;
  return "no worktree";
};

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

export const Header = ({ state, width }: { state: TuiState; width: number }): ReactNode => {
  const lamp = lampFor(state.connection);

  const repo = state.daemon ? basename(state.daemon.repoRoot) : "—";
  const running = state.sessions.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
  const waiting = state.sessions.filter((s) => s.status === "awaiting_input").length;

  return (
    <Box width={width} justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        <Text color={C.accent} bold>
          {"▍ loom"}
        </Text>
        <Text color={C.dim}>{`v${state.daemon?.version ?? "?"}`}</Text>
        <Text color={C.faint}>{"·"}</Text>
        <Text color={C.text} wrap="truncate-end">
          {repo}
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={C.dim}>{`${state.sessions.length} sessions`}</Text>
        {waiting ? <Text color={C.await_}>{`◆ ${waiting}`}</Text> : null}
        {running ? <Text color={C.accent}>{`● ${running}`}</Text> : null}
        <Text color={C.faint}>{"·"}</Text>
        <Text color={lamp.color}>{lamp.text}</Text>
      </Box>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// fleet list (left column)
// ---------------------------------------------------------------------------

export const Fleet = ({
  state,
  tick,
  width,
  now = Date.now(),
}: {
  state: TuiState;
  tick: number;
  width: number;
  now?: number;
}): ReactNode => {
  const groups = groupsOf(state.sessions);
  const iw = inside(width);
  const pcolor = new Map(state.providers.map((p) => [p.id, p.color]));
  const compactingIds = new Set(Object.keys(state.compacting));

  const blocks =
    groups.length === 0
      ? [
          <Text key="empty" color={C.dim}>
            {"no sessions yet — press "}
            <Text color={C.accent}>{"n"}</Text>
            {" to start one"}
          </Text>,
        ]
      : groups.map((g, i) => (
          <Box key={g.status} flexDirection="column" marginTop={i ? 1 : 0}>
            <Text bold>
              <Text color={statusLook(g.status).color}>{statusLook(g.status).glyph + " "}</Text>
              <Text color={C.dim}>{g.label.toUpperCase()}</Text>
              <Text color={C.faint}>{`  ${g.sessions.length}`}</Text>
            </Text>
            {g.sessions.map((s) =>
              FleetRow({
                s,
                selected: s.id === state.selectedId,
                tick,
                iw,
                now,
                pcolor,
                compacting: compactingIds.has(s.id),
              }),
            )}
          </Box>
        ));

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={C.faint}
      borderBackgroundColor={C.bg}
      paddingX={1}
    >
      <Text color={C.dim}>{"FLEET"}</Text>
      <Box flexDirection="column" marginTop={1}>
        {blocks}
      </Box>
    </Box>
  );
};

/** Fleet-row cache dot: `⟢` graded green → amber → red by TTL left, blank otherwise. */
const cacheHeatColor = (h: "fresh" | "fading" | "expiring"): string => {
  switch (h) {
    case "fresh":
      return C.good;
    case "fading":
      return C.warn;
    case "expiring":
      return C.bad;
  }
};

const FleetRow = ({
  s,
  selected,
  tick,
  iw,
  now,
  pcolor,
  compacting = false,
}: {
  s: SessionSnapshot;
  selected: boolean;
  tick: number;
  iw: number;
  now: number;
  /** provider id → Fleet-row id colour ("" for the plain default). */
  pcolor: Map<string, string>;
  /** A compaction is in flight — show a `⇊` in the cache-dot slot. */
  compacting?: boolean;
}): ReactNode => {
  const look = statusLook(s.status);
  const glyph = s.status === "running" ? spinnerFrame(tick) : look.glyph;
  const id = shortId(s.id);
  const cost = money(s.costUsd);
  const heat = cacheHeat(cacheStatus(s, now));
  // Always 2 cols so titles stay aligned whether or not a session has a warm cache.
  const cacheColor = heat ? cacheHeatColor(heat) : null;
  const idColor = pcolor.get(s.provider) || C.faint;
  const forked = s.parentId != null && s.forkTurn != null;
  const idText = forked ? `⑂${id}` : id;
  const room = Math.max(6, iw - (2 + 2 + idText.length + 2 + 2 + cost.length + 1));
  const title = truncate(titleLine(s.title), room).padEnd(room);

  return (
    <Text key={s.id} wrap="truncate-end">
      <Text color={selected ? C.accent : C.faint}>{selected ? "▍ " : "  "}</Text>
      <Text color={s.status === "running" ? C.accent : look.color}>{glyph + " "}</Text>
      <Text color={idColor}>{`${idText}  `}</Text>
      {compacting ? (
        <Text color={C.accent}>{"⇊ "}</Text>
      ) : (
        <Text color={cacheColor ?? C.faint}>{cacheColor ? "⟢ " : "  "}</Text>
      )}
      <Text color={selected ? C.text : C.dim} bold={selected}>
        {title}
      </Text>
      <Text color={C.faint}>{` ${cost}`}</Text>
    </Text>
  );
};

// ---------------------------------------------------------------------------
// detail (right column, top)
// ---------------------------------------------------------------------------

export const Detail = ({
  session,
  width,
  queued = [],
  now = Date.now(),
  engineColor = "",
  compacting = null,
}: {
  session: SessionSnapshot | null;
  width: number;
  queued?: string[];
  now?: number;
  /** Ink colour for the provider/model line; matches the Fleet id colour. */
  engineColor?: string;
  /** Set while a compaction is in flight on this session. */
  compacting?: { startedAt: number; before: number } | null;
}): ReactNode => {
  if (!session) {
    return (
      <Box
        width={width}
        borderStyle="round"
        borderColor={C.faint}
        borderBackgroundColor={C.bg}
        paddingX={1}
        flexDirection="column"
      >
        <Text color={C.dim}>{"DETAIL"}</Text>
        <Text color={C.faint}>{"select a session with ↑/↓"}</Text>
      </Box>
    );
  }

  const s = session;
  const w = inside(width);
  const look = statusLook(s.status);
  const ctxFrac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
  const ctxPct = Math.round(ctxFrac * 100);
  const g = s.git;
  const gitLine = gitLineText(s);

  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={look.color}
      borderBackgroundColor={C.bg}
      paddingX={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text color={C.dim}>{`DETAIL  ${shortId(s.id)}`}</Text>
        <Text>
          <Text color={C.faint}>{"engine "}</Text>
          <Text color={engineColor || C.faint}>{s.provider}</Text>
          <Text color={C.faint}>{s.model ? ` / ${s.model}` : ""}</Text>
        </Text>
      </Box>
      <Text color={C.text} wrap="truncate-end">
        {truncate(titleLine(s.title), w)}
      </Text>
      {s.parentId && s.forkTurn != null ? (
        <Text color={C.faint}>{`⑂ forked from ${shortId(s.parentId)} @ turn ${s.forkTurn}`}</Text>
      ) : null}
      <Box marginTop={1} gap={2}>
        <Text color={look.color} bold>
          {`${look.glyph} ${look.label}${s.awaitReason ? ` · ${s.awaitReason}` : ""}`}
        </Text>
        {/* `[mode]` in the same gold the event log gives tool commands — the one */}
        {/* thing on this row you change mid-session, so it should catch the eye. */}
        <Text>
          <Text color={C.dim}>{"mode "}</Text>
          <Text color={C.warn}>{`[${modeLabel(s.mode)}]`}</Text>
        </Text>
        <Text color={C.dim}>{`${s.turns} turn${s.turns === 1 ? "" : "s"}`}</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text color={C.dim}>{"context"}</Text>
        <Text color={contextHeatColor(ctxFrac)}>{bar(ctxFrac, 16)}</Text>
        <Text color={C.dim}>
          {`${ctxPct}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`}
        </Text>
      </Box>
      {compacting ? (
        <Box gap={2}>
          <Text color={C.dim}>{"       "}</Text>
          <Text color={C.accent}>
            {`⇊ compacting… ${Math.max(0, Math.round((now - compacting.startedAt) / 1000))}s`}
          </Text>
          <Text color={C.faint}>{`from ${humanTokens(compacting.before)}`}</Text>
        </Box>
      ) : null}
      {(() => {
        const cs = cacheStatus(s, now);
        if (cs.state === "unknown") return null;
        const hit = cs.lastHit
          ? `  ·  ${cs.lastHit === "hit" ? "last turn hit" : "last turn rewrote"}`
          : "";
        return (
          <Box gap={2}>
            <Text color={C.dim}>{"cache  "}</Text>
            {cs.state === "warm" ? (
              <Text color={C.good}>{`⟢ warm ~${mmss(cs.remainingMs)}${hit}`}</Text>
            ) : (
              <Text color={C.faint}>{`⟢ cold${hit}`}</Text>
            )}
          </Box>
        );
      })()}
      <Box gap={2}>
        <Text color={C.dim}>{"tokens "}</Text>
        <Text color={C.faint}>
          {`${humanTokens(s.usage.input)} in · ${humanTokens(s.usage.output)} out · ${humanTokens(s.usage.cacheRead)} cr · ${humanTokens(s.usage.cacheWrite)} cw`}
        </Text>
        <Text color={s.costUsd ? C.good : C.faint}>
          {(s.costSource === "table" ? "~" : "") + money(s.costUsd)}
        </Text>
      </Box>
      {Object.keys(s.rateLimits).length > 0 ? (
        <Box gap={2}>
          <Text color={C.dim}>{"plan "}</Text>
          {Object.entries(s.rateLimits).map(([window, w]) => {
            let col: string = C.faint;
            if (w.status === "rejected") col = C.bad;
            else if (w.status === "allowed_warning") col = C.warn;
            const pct = w.utilization != null ? `${Math.round(w.utilization)}%` : "?%";
            const resets = w.resetsAt != null ? `  ⟳ ${humanDuration(w.resetsAt - now)}` : "";
            return (
              <Text key={window} color={col}>
                {`${window} ${pct}${resets}`}
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={C.faint}>{"⌥ "}</Text>
        <Text color={C.dim} wrap="truncate-end">
          {gitLine}
        </Text>
      </Box>
      {g?.lastCommitSubject ? (
        <Text color={C.faint} wrap="truncate-end">
          {`  “${truncate(g.lastCommitSubject, w - 4)}”`}
        </Text>
      ) : null}
      {queued.length > 0 ? (
        <Text color={C.accentDim} wrap="truncate-end">
          {`▸ ${queued.length} queued — “${truncate((queued[0] ?? "").replace(/\s+/g, " ").trim(), w - 16)}”`}
        </Text>
      ) : null}
      {s.subagents.length > 0
        ? (() => {
            const active = s.subagents.filter((a) => a.active);
            const names = s.subagents.map((a) => (a.active ? a.name : `${a.name} ✓`)).join(", ");
            return (
              <Text color={C.dim} wrap="truncate-end">
                {`⑂ ${active.length}/${s.subagents.length} sub-agent${s.subagents.length === 1 ? "" : "s"} · ${truncate(names, w - 20)}`}
              </Text>
            );
          })()
        : null}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// event log (right column, bottom)
// ---------------------------------------------------------------------------

export const EventLog = ({
  state,
  width,
  height,
  scroll = 0,
  full = false,
}: {
  state: TuiState;
  width: number;
  height: number;
  scroll?: number;
  full?: boolean;
}): ReactNode => {
  const capacity = Math.max(1, height - 3); // header line + top/bottom border
  // Only the selected session's sub-agents can show in its log. Key the map by a
  // cheap signature so a `session_updated` that merely bumped a token counter (a
  // fresh `sessions` array, same sub-agents) doesn't invalidate the wrap below.
  const sel = selectedSession(state);
  const subSig = (sel?.subagents ?? []).map((a) => `${a.id}=${a.name}`).join(",");
  const subName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of sel?.subagents ?? []) m.set(a.id, a.name);
    return m;
    // sel is captured; subSig is its identity for this purpose.
  }, [subSig]);

  // Flatten the visible log to physical (wrapped) rows. `wrapLine` memoises per
  // line, so a new event re-wraps one line rather than the whole backlog, and
  // only the `shown` slice is turned into elements below.
  const rows = useMemo(
    () => physicalRows(visibleLog(state), inside(width), subName),
    [state.log, state.logFilter, state.selectedId, subName, width],
  );

  const maxScroll = Math.max(0, rows.length - capacity);
  const off = Math.min(scroll, maxScroll);
  const end = rows.length - off;
  const shown = rows.slice(Math.max(0, end - capacity), end);
  const above = Math.max(0, end - capacity);

  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={off > 0 ? C.accentDim : C.faint}
      borderBackgroundColor={C.bg}
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
    >
      <Box justifyContent="space-between">
        <Text color={C.dim}>{full ? "EVENTS · fullscreen" : "EVENTS"}</Text>
        <Text color={C.faint}>
          {(state.logFilter === "everything" ? "full" : state.logFilter === "chat_and_tools" ? "chat+tools" : "chat") +
            (off > 0 ? `  ·  ↑${above} more` : "")}
        </Text>
      </Box>
      {shown.length === 0 ? (
        <Text color={C.faint}>{"  (quiet)"}</Text>
      ) : (
        shown.map((r) =>
          r.first ? (
            <Text key={r.key} wrap="truncate-end">
              <Text color={C.faint}>{r.ts}</Text>
              {r.sub ? <Text color={C.faint}>{r.sub}</Text> : null}
              <Text color={toneColor(r.tone)}>{`${r.glyph} `}</Text>
              <Text color={toneColor(r.tone)}>{r.seg}</Text>
            </Text>
          ) : (
            <Text key={r.key} wrap="truncate-end">
              <Text>{" ".repeat(r.indent)}</Text>
              <Text color={toneColor(r.tone)}>{r.seg}</Text>
            </Text>
          ),
        )
      )}
    </Box>
  );
};

/** One wrapped screen row of the event log. `first` rows carry the time + glyph
 *  gutter; continuation rows carry `indent` spaces and nothing else. */
interface PhysicalRow {
  readonly key: string;
  readonly first: boolean;
  readonly ts: string;
  readonly sub: string;
  readonly indent: number;
  readonly glyph: string;
  readonly tone: Tone;
  readonly seg: string;
}

/**
 * The visible log flattened to physical rows, oldest first — pure data, so the
 * caller builds elements only for the slice it shows. Each event's full body is
 * word-wrapped to width and never clipped (the pane scrolls); intentional
 * newlines survive as their own rows.
 */
const physicalRows = (
  lines: readonly LogLine[],
  iw: number,
  subName: ReadonlyMap<string, string>,
): PhysicalRow[] => {
  const out: PhysicalRow[] = [];
  for (const l of lines) {
    const ts = `${clock(l.ts)} `;
    // A sub-agent's events get a dim "⑂name " prefix and hang one level in.
    const sub = l.agentId ? `⑂${subName.get(l.agentId) ?? shortId(l.agentId)} ` : "";
    const indent = ts.length + sub.length + 2; // + "glyph "
    const segs = wrapLine(l, Math.max(8, iw - indent));
    segs.forEach((seg, i) => {
      out.push({
        key: `${l.seq}-${l.ts}-${i}`,
        first: i === 0,
        ts,
        sub,
        indent,
        glyph: l.glyph,
        tone: l.tone,
        seg,
      });
    });
  }
  return out;
};

/**
 * `wrapText` over a log line's body, memoised by line identity + column count —
 * appending an event then re-wraps one line, not the 400-line backlog. LogLines
 * are immutable and fall out of `state.log` at its cap, so the `WeakMap` self-bounds.
 */
const wrapCache = new WeakMap<LogLine, { room: number; segs: readonly string[] }>();
const wrapLine = (l: LogLine, room: number): readonly string[] => {
  const hit = wrapCache.get(l);
  if (hit && hit.room === room) return hit.segs;
  // Wrap each source line separately so intentional newlines are kept.
  const source = (l.full ?? l.text).replace(/[ \t]+$/gm, "") || "…";
  const segs = source.split("\n").flatMap((ln) => wrapText(ln.trim() === "" ? " " : ln, room));
  wrapCache.set(l, { room, segs });
  return segs;
};

// ---------------------------------------------------------------------------
// text editor view (used by the prompt)
// ---------------------------------------------------------------------------

/** Max rows the editor draws; `promptRows` reserves the same so the footer
 *  can't overdraw the body when a big paste / $EDITOR return lands. */
export const MAX_EDITOR_ROWS = 8;

export const EditorView = ({
  buf,
  width,
  placeholder,
}: {
  buf: Buffer;
  width: number;
  placeholder?: string;
}): ReactNode => {
  if (buf.text === "") {
    return (
      <Box>
        <Text color={C.accent}>{"▍ "}</Text>
        <Text inverse> </Text>
        {placeholder ? <Text color={C.faint}>{` ${placeholder}`}</Text> : null}
      </Box>
    );
  }

  const { lines, row, col } = layout(buf);
  const room = Math.max(8, width - 2);

  // Window to MAX_EDITOR_ROWS around the caret so the rendered height matches
  // what `promptRows` told the layout to reserve.
  const start =
    lines.length <= MAX_EDITOR_ROWS
      ? 0
      : Math.min(
          Math.max(0, row - Math.floor(MAX_EDITOR_ROWS / 2)),
          lines.length - MAX_EDITOR_ROWS,
        );
  const shown = lines.slice(start, start + MAX_EDITOR_ROWS);
  const moreAbove = start > 0;
  const moreBelow = start + MAX_EDITOR_ROWS < lines.length;

  return (
    <Box flexDirection="column">
      {shown.map((ln, i) => {
        const r = start + i;
        const gutter =
          (i === 0 && moreAbove) || (i === shown.length - 1 && moreBelow) ? "⋮ " : "▍ ";
        let content: ReactNode;
        if (r === row) {
          const off = Math.max(0, col - (room - 1));
          content = (
            <Text wrap="truncate-end">
              <Text color={C.text}>{ln.slice(off, col)}</Text>
              <Text inverse>{ln.slice(col, col + 1) || " "}</Text>
              <Text color={C.text}>{ln.slice(col + 1, off + room)}</Text>
            </Text>
          );
        } else {
          content = (
            <Text color={C.text} wrap="truncate-end">
              {ln.length ? ln : " "}
            </Text>
          );
        }
        return (
          <Box key={r}>
            <Text color={C.accent}>{gutter}</Text>
            {content}
          </Box>
        );
      })}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// footer: contextual hints, or the prompt editor
// ---------------------------------------------------------------------------

const MODE_HINT: Record<PromptState["kind"], string> = {
  new: "start",
  send: "send",
  answer: "answer",
  deny: "deny",
  title: "rename",
  discuss: "send",
  compact: "compact",
};

/** The `[mode]` chip: gold once it's off the mundane `manual` default, faint
 *  otherwise — the same chip the Detail pane shows for a live session. */
const modeChip = (mode: string | null | undefined): ReactNode => {
  return (
    <Text color={mode && mode !== "default" ? C.warn : C.faint}>{`[${modeLabel(mode)}]`}</Text>
  );
};

const promptHints = (p: PromptState, queued: number, sessionMode?: string | null): string => {
  const bits = [`enter ${MODE_HINT[p.kind]}`, "⌥⏎ newline", "⌥e editor"];
  if (p.kind !== "new") bits.push("⌥o log"); // a new-session prompt has no session / log yet
  if (p.kind === "new") {
    // ⇧⇥ cycles the mode the session starts in; ⌥m / ⌥p pick its model.
    bits.push(`⇧⇥ mode:${modeLabel(p.mode)}`);
    bits.push("⌥p provider/model");
  } else if (p.kind === "send") {
    // ⇧⇥ re-modes the live session, ⌥m swaps its model — both without leaving
    // the half-typed message.
    bits.push(`⇧⇥ mode:${modeLabel(sessionMode)}`);
    bits.push("⌥m model");
  }
  if (p.kind === "new" || p.kind === "send") bits.push("↑↓ history");
  if (p.kind === "send" && queued > 0) bits.push(`⌥x clear ${queued} queued`);
  bits.push("esc cancel");
  return bits.join("  ·  ");
};

export const FooterArea = ({ state, width }: { state: TuiState; width: number }): ReactNode => {
  if (state.mode === "prompt" && state.prompt) {
    const p = state.prompt;
    const queued = p.kind === "send" ? queueFor(state, p.sessionId).length : 0;
    const placeholder = PROMPT_PLACEHOLDER[p.kind];
    const prov = p.kind === "new" ? providerInfo(state, p.provider ?? "") : null;
    // A send prompt re-modes / re-models its target with ⇧⇥ / ⌥m, so it shows
    // the session's current mode chip too.
    const sendSess =
      p.kind === "send" && p.sessionId ? state.sessions.find((x) => x.id === p.sessionId) : null;
    const showModeChip = p.kind === "new" || sendSess != null;
    const chipMode = p.kind === "new" ? p.mode : sendSess?.mode;
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Box gap={1}>
          <Text color={C.accent} bold>
            {p.label}
          </Text>
          {showModeChip ? modeChip(chipMode) : null}
          {p.kind === "new" ? (
            <Text color={prov?.color || C.faint}>
              {`${prov?.tag ?? p.provider ?? "?"} / ${p.model || prov?.defaultModel || "auto"}`}
            </Text>
          ) : null}
          {p.kind === "new" ? <Text color={C.faint}>{"⌥p change"}</Text> : null}
        </Box>
        <EditorView buf={p.buffer} width={width - 2} placeholder={placeholder} />
        <Text color={C.faint}>{promptHints(p, queued, sendSess?.mode)}</Text>
      </Box>
    );
  }

  const hints = footerHints(state);
  return (
    <Box flexDirection="column" width={width}>
      <Text color={C.faint}>{"─".repeat(width)}</Text>
      <Box width={width} paddingX={1}>
        <Box gap={1}>
          {hints.flatMap((hint, i) => [
            i > 0 ? (
              <Text key={`s${i}`} color={C.faint}>
                {"·"}
              </Text>
            ) : null,
            <Text key={`k${i}`} color={C.accent}>
              {hint.keys}
            </Text>,
            <Text key={`l${i}`} color={C.dim}>
              {hint.label}
            </Text>,
          ])}
        </Box>
        <Box flexGrow={1} />
        {state.notice ? (
          <Text color={toneColor(state.notice.tone)}>{state.notice.text}</Text>
        ) : null}
      </Box>
    </Box>
  );
};

/** Rows the prompt editor occupies, for the parent's height maths. */
export const promptRows = (state: TuiState): number => {
  if (state.mode !== "prompt" || !state.prompt) return 2;
  const editor = Math.min(
    MAX_EDITOR_ROWS,
    Math.max(1, state.prompt.buffer.text.split("\n").length),
  );
  return 1 /* label */ + editor + 1; /* hints */
};

// ---------------------------------------------------------------------------
// confirm overlay
// ---------------------------------------------------------------------------

export const Confirm = ({
  confirm,
  width,
}: {
  confirm: ConfirmState;
  width: number;
}): ReactNode => {
  const accent = confirm.danger ? C.bad : C.accent;
  let actionText = "quit and stop the daemon";
  if (confirm.action === "restart") actionText = "restart the daemon";
  else if (confirm.action === "deleteSession")
    actionText = confirm.deleteBranch ? "delete the session + branch" : "delete the session";
  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={accent}
      borderBackgroundColor={C.bg}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text color={accent} bold>
        {confirm.title}
      </Text>
      {confirm.body ? <Text color={C.warn}>{confirm.body}</Text> : null}
      {confirm.branchName ? (
        <Box gap={1} marginTop={1}>
          <Text color={C.accent}>{"b"}</Text>
          <Text color={confirm.deleteBranch ? C.bad : C.dim}>
            {confirm.deleteBranch
              ? `will also delete branch ${confirm.branchName}`
              : `keep branch ${confirm.branchName}`}
          </Text>
        </Box>
      ) : null}
      <Box height={1} />
      <Box gap={2}>
        <Text color={C.accent}>{"enter"}</Text>
        <Text color={C.dim}>{actionText}</Text>
        <Text color={C.faint}>{"·"}</Text>
        <Text color={C.accent}>{"esc"}</Text>
        <Text color={C.dim}>{"cancel"}</Text>
      </Box>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// pending request panel (what you're approving / being asked)
// ---------------------------------------------------------------------------

/** Height reserved for {@link RequestPanel} in the layout. */
export const REQUEST_PANEL_ROWS = 8;

const describeRequest = (input: unknown, w: number): string[] => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o["command"] === "string") return wrapText(o["command"], w).slice(0, 5);
    const parts: string[] = [];
    const path = o["file_path"] ?? o["path"] ?? o["notebook_path"];
    if (typeof path === "string") parts.push(path);
    if (typeof o["pattern"] === "string") parts.push(`pattern: ${o["pattern"]}`);
    if (typeof o["url"] === "string") parts.push(String(o["url"]));
    if (typeof o["old_string"] === "string")
      parts.push(`− ${String(o["old_string"]).replace(/\s+/g, " ")}`);
    if (typeof o["new_string"] === "string")
      parts.push(`+ ${String(o["new_string"]).replace(/\s+/g, " ")}`);
    if (parts.length > 0) return parts.flatMap((p) => wrapText(p, w)).slice(0, 5);
    return wrapText(JSON.stringify(o), w).slice(0, 5);
  }
  return input == null ? [] : wrapText(String(input), w).slice(0, 5);
};

export const RequestPanel = ({
  pending,
  width,
}: {
  pending: Pending;
  width: number;
}): ReactNode => {
  const w = inside(width);
  const box = (title: string, body: ReactNode[], hint: string): ReactNode => (
    <Box
      width={width}
      borderStyle="round"
      borderColor={C.await_}
      borderBackgroundColor={C.bg}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={C.await_} bold>
        {title}
      </Text>
      {body}
      <Text color={C.faint}>{hint}</Text>
    </Box>
  );

  if (pending.question !== undefined) {
    return box(
      "? QUESTION",
      [
        ...wrapText((pending.questionText ?? "").replace(/\s+/g, " ").trim(), w)
          .slice(0, 4)
          .map((l, i) => (
            <Text key={i} color={C.text}>
              {l}
            </Text>
          )),
        pending.questionContext ? (
          <Text key="ctx" color={C.faint} wrap="truncate-end">
            {truncate(pending.questionContext.replace(/\s+/g, " ").trim(), w)}
          </Text>
        ) : null,
      ],
      "a answer  ·  ⌥o / o view  ·  i interrupt",
    );
  }
  if (pending.plan !== undefined) {
    return box(
      "❖ PLAN REVIEW",
      wrapText((pending.planText ?? "").replace(/\s+/g, " ").trim(), w)
        .slice(0, 5)
        .map((l, i) => (
          <Text key={i} color={C.text} wrap="truncate-end">
            {l}
          </Text>
        )),
      "a review  ·  ⌥o / o view  ·  i interrupt",
    );
  }
  const perms = pending.permissions ?? [];
  if (perms.length > 0) {
    const p0 = perms[0]!;
    const more = perms.length > 1 ? ` (1 of ${perms.length})` : "";
    return box(
      `⇱ PERMISSION — ${p0.tool || "tool"}${more}`,
      describeRequest(p0.input, w).map((l, i) => (
        <Text key={i} color={C.text} wrap="truncate-end">
          {l}
        </Text>
      )),
      `a approve  ·  d deny  ·  ⌥o / o view  ·  i interrupt${more ? "  ·  more queued" : ""}`,
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// plan-review overlay (the post-planning decision)
// ---------------------------------------------------------------------------

export const PlanReview = ({ text, width }: { text: string; width: number }): ReactNode => {
  const w = inside(width);
  const lines = text.split("\n").flatMap((ln) => (ln === "" ? [""] : wrapText(ln, w)));
  const body = lines.slice(0, 16);
  const row = (k: string, v: string): ReactNode => (
    <Box gap={1}>
      <Box width={3}>
        <Text color={C.accent}>{k}</Text>
      </Box>
      <Text color={C.dim}>{v}</Text>
    </Box>
  );
  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={C.await_}
      borderBackgroundColor={C.bg}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text color={C.await_} bold>
        {"❖ PLAN REVIEW"}
      </Text>
      <Box height={1} />
      {body.map((l, i) => (
        <Text key={i} color={C.text} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
      {lines.length > body.length ? (
        <Text color={C.faint}>
          {`  … ${lines.length - body.length} more lines — ⌥o / o to read it all`}
        </Text>
      ) : null}
      <Box height={1} />
      {row("i", "implement — the agent proceeds in this context")}
      {row("f", "implement fresh — compact to the plan + goal first")}
      {row("e", "edit the plan in $EDITOR, then implement what you saved")}
      {row("d", "discuss — send a note back; the agent stays in plan mode")}
      <Box height={1} />
      <Text color={C.faint}>
        {"⌥o / o view read-only  ·  a plan review must be answered — esc does nothing"}
      </Text>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// help overlay
// ---------------------------------------------------------------------------

/** The grammar in one screen — the five rules, then the keys they generate. */
const GRAMMAR_ROWS: Array<[string, string]> = [
  ["bare key", "act on the selected session, or move"],
  ["Shift + key", "the heavier / structural sibling — Q quit-all · R restart · X delete · F fork"],
  ["Ctrl + key", "text editing only, in the prompt (⌃a ⌃e ⌃b ⌃f ⌃u ⌃k ⌃w) — ⌃c quits"],
  [
    "Alt + key",
    "run an action without leaving the prompt — ⌥e ⌥o ⌥p ⌥x; ⌥m switches the model (also from the fleet view)",
  ],
  ["⇧⇥", "cycle the permission mode — on the selection, or inside a prompt (mid-message)"],
  ["Space", "the command palette — everything valid right now, fuzzy, with its key"],
];

const HELP_ROWS: Array<[string, string]> = [
  ["↑ / ↓  ·  j / k", "move the selection"],
  ["Space", "command palette — search and run any action available here"],
  [
    "a / ⏎  ·  d",
    "approve a request (`a` only) · answer / review it (`⏎` too)  ·  `d` deny (deny-only — never deletes)",
  ],
  [
    "⏎  ·  i",
    "send a message to the selected session (revives a stopped one)  ·  interrupt its turn",
  ],
  ["c  ·  x", "compact the context (once the meter passes half)  ·  mark the session done"],
  [
    "u  ·  ⇧⇥  ·  ⌥m",
    "undo to an earlier turn  ·  cycle the permission mode  ·  switch the model (applies next turn)",
  ],
  ["e  ·  y", "rename  ·  copy the branch name to the clipboard"],
  [
    "o  ·  v  ·  ⇥",
    "view the log in $EDITOR  ·  event log full / chat  ·  fullscreen the event log",
  ],
  ["t", "toggle dark / light theme"],
  [
    "n  ·  f",
    "new session (the prompt shows the provider / model; ⌥p to change)  ·  find a session",
  ],
  [
    "F  ·  X",
    "hard fork — new session + worktree off this one (aisdk)  ·  delete the session (confirm)",
  ],
  ["R  ·  Q", "restart the daemon  ·  quit the UI and stop the daemon  (both confirm)"],
  ["q  ·  ⌃c  ·  esc", "quit the UI, daemon keeps running  ·  quit  ·  back out of any overlay"],
  ["⟢ (fleet)", "prompt cache still warm — green → amber → red as it lapses"],
  ["fleet id colour", "which provider the session runs on (default provider stays plain)"],
];

const EDIT_ROWS: Array<[string, string]> = [
  ["enter  ·  esc", "submit  ·  cancel"],
  ["⇧⏎ / ⌥⏎", "insert a newline (⇧⏎ needs a terminal that sends a distinct code; ⌥⏎ always works)"],
  ["⌃a / ⌃e", "start / end of line     ⌃b / ⌃f  char back / forward"],
  ["⌃← / ⌃→", "word back / forward"],
  ["⌃u / ⌃k  ·  ⌃w", "kill to start / end     ·     delete the word before the cursor"],
  [
    "⌥e  ·  ⌥o",
    "edit in $EDITOR, event log alongside (`:wq` to return)  ·  view the log, read-only",
  ],
  [
    "⇧⇥  ·  ⌥m",
    "cycle the permission mode  ·  switch the model — the new session's, or the one you're messaging",
  ],
  ["⌥p", "provider / model picker   (new-session prompt only)"],
  ["⌥x  ·  ↑ / ↓", "clear the queued messages (send)  ·  walk the prompt history"],
];

// ---------------------------------------------------------------------------
// picker overlay — provider / model choice, session find
// ---------------------------------------------------------------------------

export const Picker = ({
  picker,
  width,
  height,
}: {
  picker: PickerState;
  width: number;
  height: number;
}): ReactNode => {
  const w = inside(width);
  const vis = pickerVisible(picker);
  const rows = Math.max(3, height - 7);
  const start = Math.max(
    0,
    Math.min(Math.max(0, vis.length - rows), picker.index - Math.floor(rows / 2)),
  );
  const shown = vis.slice(start, start + rows);

  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={C.accent}
      borderBackgroundColor={C.bg}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text color={C.accent} bold>
        {`▸ ${picker.title.toUpperCase()}`}
      </Text>
      {/* A prompt-style input line so it reads as "type here", with a block caret */}
      {/* and a placeholder when empty. */}
      <Box>
        <Text color={C.accent}>{"▍ "}</Text>
        <Text color={C.text}>{picker.filter}</Text>
        <Text inverse> </Text>
        {picker.filter ? null : <Text color={C.faint}>{" type to search"}</Text>}
      </Box>
      <Text color={C.faint}>
        {picker.items.length === 0
          ? " "
          : `${vis.length}/${picker.items.length} match${vis.length === 1 ? "" : "es"}`}
      </Text>
      <Box height={1} />
      {shown.length === 0
        ? [
            <Text key="none" color={C.faint} wrap="wrap">
              {picker.items.length === 0 ? (picker.emptyText ?? "nothing to pick") : "no matches"}
            </Text>,
          ]
        : shown.map((it, i) => {
            const on = start + i === picker.index;
            return (
              <Text key={it.id} wrap="truncate-end" color={on ? C.text : C.dim} bold={on}>
                <Text color={on ? C.accent : C.faint}>{on ? "▍ " : "  "}</Text>
                {truncate(it.label, Math.max(6, w - 32))}
                {it.hint ? <Text color={C.faint}>{`  ${truncate(it.hint, 28)}`}</Text> : null}
              </Text>
            );
          })}
      {start + shown.length < vis.length || start > 0 ? (
        <Text color={C.faint}>{`  … ${vis.length - shown.length} more`}</Text>
      ) : null}
      <Box height={1} />
      <Text color={C.faint}>
        {picker.items.length === 0
          ? "enter continue · esc cancel"
          : "type to filter · ↑↓ move · enter pick · esc cancel"}
      </Text>
    </Box>
  );
};

export const Help = ({ width }: { width: number }): ReactNode => {
  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={C.accent}
      borderBackgroundColor={C.bg}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text color={C.accent} bold>
        {"loom — keys"}
      </Text>
      <Box height={1} />
      <Text color={C.dim} bold>
        {"the grammar"}
      </Text>
      {GRAMMAR_ROWS.map(([k, v], i) => (
        <Box key={`g${i}`} gap={2}>
          <Box width={16}>
            <Text color={C.accent}>{k}</Text>
          </Box>
          <Text color={C.dim}>{v}</Text>
        </Box>
      ))}
      <Box height={1} />
      {HELP_ROWS.map(([k, v], i) => (
        <Box key={i} gap={2}>
          <Box width={16}>
            <Text color={C.accent}>{k}</Text>
          </Box>
          <Text color={C.dim}>{v}</Text>
        </Box>
      ))}
      <Box height={1} />
      <Text color={C.dim} bold>
        {"in the prompt"}
      </Text>
      {EDIT_ROWS.map(([k, v], i) => (
        <Box key={`e${i}`} gap={2}>
          <Box width={16}>
            <Text color={C.accent}>{k}</Text>
          </Box>
          <Text color={C.dim}>{v}</Text>
        </Box>
      ))}
      <Box height={1} />
      <Text color={C.faint}>
        {"loom drives worktrees only — it never pushes or touches your remotes."}
      </Text>
    </Box>
  );
};
