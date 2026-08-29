/**
 * Ink components for the TUI. Written with `createElement` (aliased `h`) rather
 * than JSX so the files run straight through Node's native TypeScript
 * type-stripping with no build step — the same constraint the rest of the
 * codebase keeps. Every component is a pure projection of {@link TuiState}.
 */
import { createElement as h, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "../protocol/wire.ts";
import { layout, type Buffer } from "./editor.ts";
import {
  actionsFor,
  cacheHeat,
  cacheStatus,
  clock,
  groupsOf,
  pendingFor,
  pickerVisible,
  queueFor,
  selectedSession,
  visibleLog,
  type ConfirmState,
  type LogLine,
  type Pending,
  type PickerState,
  type PromptState,
  type TuiState,
} from "./model.ts";
import {
  bar,
  C,
  humanTokens,
  mmss,
  money,
  shortId,
  spinnerFrame,
  STATUS,
  TONE_COLOR,
  truncate,
  wrapText,
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

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

export function Header({ state, width }: { state: TuiState; width: number }): ReactNode {
  const lamp =
    state.connection === "live"
      ? h(Text, { color: C.good }, "● live")
      : state.connection === "reconnecting"
        ? h(Text, { color: C.warn }, "◍ reconnecting")
        : state.connection === "closed"
          ? h(Text, { color: C.bad }, "○ offline")
          : h(Text, { color: C.dim }, "◌ connecting");

  const repo = state.daemon ? basename(state.daemon.repoRoot) : "—";
  const running = state.sessions.filter((s) => s.status === "running" || s.status === "starting").length;
  const waiting = state.sessions.filter((s) => s.status === "awaiting_input").length;

  return h(
    Box,
    { width, justifyContent: "space-between", paddingX: 1 },
    h(
      Box,
      { gap: 1 },
      h(Text, { color: C.accent, bold: true }, "▍ loom"),
      h(Text, { color: C.dim }, `v${state.daemon?.version ?? "?"}`),
      h(Text, { color: C.faint }, "·"),
      h(Text, { color: C.text, wrap: "truncate-end" }, repo),
    ),
    h(
      Box,
      { gap: 1 },
      h(Text, { color: C.dim }, `${state.sessions.length} sessions`),
      waiting ? h(Text, { color: C.await_ }, `◆ ${waiting}`) : null,
      running ? h(Text, { color: C.accent }, `● ${running}`) : null,
      h(Text, { color: C.faint }, "·"),
      lamp,
    ),
  );
}

// ---------------------------------------------------------------------------
// fleet list (left column)
// ---------------------------------------------------------------------------

export function Fleet({
  state,
  tick,
  width,
  now = Date.now(),
}: {
  state: TuiState;
  tick: number;
  width: number;
  now?: number;
}): ReactNode {
  const groups = groupsOf(state.sessions);
  const iw = inside(width);
  const pcolor = new Map(state.providers.map((p) => [p.id, p.color]));
  const compactingIds = new Set(Object.keys(state.compacting));

  const blocks =
    groups.length === 0
      ? [
          h(
            Text,
            { key: "empty", color: C.dim },
            "no sessions yet — press ",
            h(Text, { color: C.accent }, "n"),
            " to start one",
          ),
        ]
      : groups.map((g, i) =>
          h(
            Box,
            { key: g.status, flexDirection: "column", marginTop: i ? 1 : 0 },
            h(
              Text,
              { bold: true },
              h(Text, { color: STATUS[g.status].color }, STATUS[g.status].glyph + " "),
              h(Text, { color: C.dim }, g.label.toUpperCase()),
              h(Text, { color: C.faint }, `  ${g.sessions.length}`),
            ),
            ...g.sessions.map((s) =>
              FleetRow({
                s,
                selected: s.id === state.selectedId,
                tick,
                iw,
                now,
                pcolor,
                compacting: compactingIds.has(s.id),
              }),
            ),
          ),
        );

  return h(
    Box,
    { flexDirection: "column", width, borderStyle: "round", borderColor: C.faint, paddingX: 1 },
    h(Text, { color: C.dim }, "FLEET"),
    h(Box, { flexDirection: "column", marginTop: 1 }, ...blocks),
  );
}

/** Fleet-row cache dot: `⟢` graded green → amber → red by TTL left, blank otherwise. */
const CACHE_HEAT_COLOR = { fresh: C.good, fading: C.warn, expiring: C.bad } as const;

function FleetRow({
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
}): ReactNode {
  const look = STATUS[s.status];
  const glyph = s.status === "running" ? spinnerFrame(tick) : look.glyph;
  const id = shortId(s.id);
  const cost = money(s.costUsd);
  const heat = cacheHeat(cacheStatus(s, now));
  // Always 2 cols so titles stay aligned whether or not a session has a warm cache.
  const cacheColor = heat ? CACHE_HEAT_COLOR[heat] : null;
  const idColor = pcolor.get(s.provider) || C.faint;
  const forked = s.parentId != null && s.forkTurn != null;
  const idText = forked ? `⑂${id}` : id;
  const room = Math.max(6, iw - (2 + 2 + idText.length + 2 + 2 + cost.length + 1));
  const title = truncate(titleLine(s.title), room).padEnd(room);

  return h(
    Text,
    { key: s.id, wrap: "truncate-end" },
    h(Text, { color: selected ? C.accent : C.faint }, selected ? "▍ " : "  "),
    h(Text, { color: s.status === "running" ? C.accent : look.color }, glyph + " "),
    h(Text, { color: idColor }, `${idText}  `),
    compacting
      ? h(Text, { color: C.accent }, "⇊ ")
      : h(Text, { color: cacheColor ?? C.faint }, cacheColor ? "⟢ " : "  "),
    h(Text, { color: selected ? C.text : C.dim, bold: selected }, title),
    h(Text, { color: C.faint }, ` ${cost}`),
  );
}

// ---------------------------------------------------------------------------
// detail (right column, top)
// ---------------------------------------------------------------------------

export function Detail({
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
}): ReactNode {
  if (!session) {
    return h(
      Box,
      { width, borderStyle: "round", borderColor: C.faint, paddingX: 1, flexDirection: "column" },
      h(Text, { color: C.dim }, "DETAIL"),
      h(Text, { color: C.faint }, "select a session with ↑/↓"),
    );
  }

  const s = session;
  const w = inside(width);
  const look = STATUS[s.status];
  const ctxFrac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
  const ctxPct = Math.round(ctxFrac * 100);
  const g = s.git;

  const gitLine = g
    ? [
        s.inPlace ? "in-place" : null,
        g.branch ?? s.branch ?? "(detached)",
        `${g.commits} commit${g.commits === 1 ? "" : "s"}`,
        g.aheadOfBase ? `+${g.aheadOfBase}` : null,
        g.behindBase ? `-${g.behindBase} behind` : null,
        g.dirty ? "dirty" : "clean",
      ]
        .filter(Boolean)
        .join("  ·  ")
    : s.inPlace
      ? "in-place — repo working dir"
      : "no worktree";

  return h(
    Box,
    { width, borderStyle: "round", borderColor: look.color, paddingX: 1, flexDirection: "column" },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: C.dim }, `DETAIL  ${shortId(s.id)}`),
      h(
        Text,
        {},
        h(Text, { color: C.faint }, "engine "),
        h(Text, { color: engineColor || C.faint }, s.provider),
        h(Text, { color: C.faint }, s.model ? ` / ${s.model}` : ""),
      ),
    ),
    h(Text, { color: C.text, wrap: "truncate-end" }, truncate(titleLine(s.title), w)),
    s.parentId && s.forkTurn != null
      ? h(Text, { color: C.faint }, `⑂ forked from ${shortId(s.parentId)} @ turn ${s.forkTurn}`)
      : null,
    h(
      Box,
      { marginTop: 1, gap: 2 },
      h(
        Text,
        { color: look.color, bold: true },
        `${look.glyph} ${look.label}${s.awaitReason ? ` · ${s.awaitReason}` : ""}`,
      ),
      h(Text, { color: C.dim }, `mode ${s.mode}`),
      h(Text, { color: C.dim }, `${s.turns} turn${s.turns === 1 ? "" : "s"}`),
    ),
    h(
      Box,
      { marginTop: 1, gap: 2 },
      h(Text, { color: C.dim }, "context"),
      h(Text, { color: ctxFrac > 0.85 ? C.bad : ctxFrac > 0.6 ? C.warn : C.accentDim }, bar(ctxFrac, 16)),
      h(Text, { color: C.dim }, `${ctxPct}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`),
    ),
    compacting
      ? h(
          Box,
          { gap: 2 },
          h(Text, { color: C.dim }, "       "),
          h(
            Text,
            { color: C.accent },
            `⇊ compacting… ${Math.max(0, Math.round((now - compacting.startedAt) / 1000))}s`,
          ),
          h(Text, { color: C.faint }, `from ${humanTokens(compacting.before)}`),
        )
      : null,
    (() => {
      const cs = cacheStatus(s, now);
      if (cs.state === "unknown") return null;
      const hit = cs.lastHit ? `  ·  ${cs.lastHit === "hit" ? "last turn hit" : "last turn rewrote"}` : "";
      return h(
        Box,
        { gap: 2 },
        h(Text, { color: C.dim }, "cache  "),
        cs.state === "warm"
          ? h(Text, { color: C.good }, `⟢ warm ~${mmss(cs.remainingMs)}${hit}`)
          : h(Text, { color: C.faint }, `⟢ cold${hit}`),
      );
    })(),
    h(
      Box,
      { gap: 2 },
      h(Text, { color: C.dim }, "tokens "),
      h(
        Text,
        { color: C.faint },
        `${humanTokens(s.usage.input)} in · ${humanTokens(s.usage.output)} out · ${humanTokens(s.usage.cacheRead)} cr · ${humanTokens(s.usage.cacheWrite)} cw`,
      ),
      h(
        Text,
        { color: s.costUsd ? C.good : C.faint },
        (s.costSource === "table" ? "~" : "") + money(s.costUsd),
      ),
    ),
    s.budget.maxCostUsd != null
      ? (() => {
          const col =
            s.budgetState === "halted" ? C.bad : s.budgetState === "warned" ? C.warn : C.accentDim;
          const frac = s.budget.maxCostUsd > 0 ? s.costUsd / s.budget.maxCostUsd : 0;
          return h(
            Box,
            { gap: 2 },
            h(Text, { color: C.dim }, "budget "),
            h(Text, { color: col }, bar(frac, 16)),
            h(
              Text,
              { color: col },
              `${money(s.costUsd)} / $${s.budget.maxCostUsd.toFixed(2)}${s.budgetState !== "ok" ? `  ${s.budgetState}` : ""}`,
            ),
          );
        })()
      : null,
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: C.faint }, "⌥ "),
      h(Text, { color: C.dim, wrap: "truncate-end" }, gitLine),
    ),
    g?.lastCommitSubject
      ? h(Text, { color: C.faint, wrap: "truncate-end" }, `  “${truncate(g.lastCommitSubject, w - 4)}”`)
      : null,
    queued.length > 0
      ? h(
          Text,
          { color: C.accentDim, wrap: "truncate-end" },
          `▸ ${queued.length} queued — “${truncate((queued[0] ?? "").replace(/\s+/g, " ").trim(), w - 16)}”`,
        )
      : null,
    s.subagents.length > 0
      ? (() => {
          const active = s.subagents.filter((a) => a.active);
          const names = s.subagents.map((a) => (a.active ? a.name : `${a.name} ✓`)).join(", ");
          return h(
            Text,
            { color: C.dim, wrap: "truncate-end" },
            `⑂ ${active.length}/${s.subagents.length} sub-agent${s.subagents.length === 1 ? "" : "s"} · ${truncate(names, w - 20)}`,
          );
        })()
      : null,
  );
}

// ---------------------------------------------------------------------------
// event log (right column, bottom)
// ---------------------------------------------------------------------------

export function EventLog({
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
}): ReactNode {
  const tagged = state.logFilter === "all";
  const capacity = Math.max(1, height - 3); // header line + top/bottom border
  const subName = new Map<string, string>();
  for (const s of state.sessions) for (const a of s.subagents) subName.set(a.id, a.name);
  const physical = physicalRows(visibleLog(state), inside(width), tagged, subName);

  const maxScroll = Math.max(0, physical.length - capacity);
  const off = Math.min(scroll, maxScroll);
  const end = physical.length - off;
  const shown = physical.slice(Math.max(0, end - capacity), end);
  const above = Math.max(0, end - capacity);

  return h(
    Box,
    {
      width,
      borderStyle: "round",
      borderColor: off > 0 ? C.accentDim : C.faint,
      paddingX: 1,
      flexDirection: "column",
      flexGrow: 1,
    },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: C.dim }, full ? "EVENTS · fullscreen" : "EVENTS"),
      h(
        Text,
        { color: C.faint },
        (tagged ? "all sessions" : "this session") + (off > 0 ? `  ·  ↑${above} more` : ""),
      ),
    ),
    ...(shown.length === 0 ? [h(Text, { key: "none", color: C.faint }, "  (quiet)")] : shown.map((r) => r.node)),
  );
}

/** Wrap every log line to `iw` columns; returns one entry per physical row. */
function physicalRows(
  lines: readonly LogLine[],
  iw: number,
  tagged: boolean,
  subName: Map<string, string> = new Map(),
): Array<{ key: string; node: ReactNode }> {
  const out: Array<{ key: string; node: ReactNode }> = [];
  for (const l of lines) {
    const ts = `${clock(l.ts)} `;
    const tag = tagged ? `${shortId(l.sessionId)} ` : "";
    // A sub-agent's events get a dim "⑂name " prefix and hang one level in.
    const sub = l.agentId ? `⑂${subName.get(l.agentId) ?? shortId(l.agentId)} ` : "";
    const indent = ts.length + tag.length + sub.length + 2; // + "glyph "
    const room = Math.max(8, iw - indent);
    const wrapped = wrapText(l.text.replace(/\s+/g, " ").trim() || "…", room);
    wrapped.forEach((seg, i) => {
      out.push({
        key: `${l.seq}-${l.ts}-${i}`,
        node:
          i === 0
            ? h(
                Text,
                { key: `${l.seq}-${l.ts}-0`, wrap: "truncate-end" },
                h(Text, { color: C.faint }, ts + tag),
                sub ? h(Text, { color: C.faint }, sub) : null,
                h(Text, { color: TONE_COLOR[l.tone] }, `${l.glyph} `),
                h(Text, { color: TONE_COLOR[l.tone] }, seg),
              )
            : h(
                Text,
                { key: `${l.seq}-${l.ts}-${i}`, wrap: "truncate-end" },
                h(Text, null, " ".repeat(indent)),
                h(Text, { color: TONE_COLOR[l.tone] }, seg),
              ),
      });
    });
  }
  return out;
}


// ---------------------------------------------------------------------------
// text editor view (used by the prompt)
// ---------------------------------------------------------------------------

/** Max rows the editor draws; `promptRows` reserves the same so the footer
 *  can't overdraw the body when a big paste / $EDITOR return lands. */
export const MAX_EDITOR_ROWS = 8;

export function EditorView({
  buf,
  width,
  placeholder,
}: {
  buf: Buffer;
  width: number;
  placeholder?: string;
}): ReactNode {
  if (buf.text === "") {
    return h(
      Box,
      null,
      h(Text, { color: C.accent }, "▍ "),
      h(Text, { inverse: true }, " "),
      placeholder ? h(Text, { color: C.faint }, ` ${placeholder}`) : null,
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

  return h(
    Box,
    { flexDirection: "column" },
    ...shown.map((ln, i) => {
      const r = start + i;
      const gutter =
        (i === 0 && moreAbove) || (i === shown.length - 1 && moreBelow) ? "⋮ " : "▍ ";
      let content: ReactNode;
      if (r === row) {
        const off = Math.max(0, col - (room - 1));
        content = h(
          Text,
          { wrap: "truncate-end" },
          h(Text, { color: C.text }, ln.slice(off, col)),
          h(Text, { inverse: true }, ln.slice(col, col + 1) || " "),
          h(Text, { color: C.text }, ln.slice(col + 1, off + room)),
        );
      } else {
        content = h(Text, { color: C.text, wrap: "truncate-end" }, ln.length ? ln : " ");
      }
      return h(Box, { key: r }, h(Text, { color: C.accent }, gutter), content);
    }),
  );
}

// ---------------------------------------------------------------------------
// footer: contextual hints, or the prompt editor
// ---------------------------------------------------------------------------

const MODE_HINT: Record<PromptState["kind"], string> = {
  new: "start",
  send: "send",
  answer: "answer",
  deny: "deny",
  title: "rename",
  budget: "set",
  discuss: "send",
  compact: "compact",
};

function promptHints(p: PromptState, queued: number): string {
  const bits = [`enter ${MODE_HINT[p.kind]}`, "⌃E editor", "⌃O log"];
  if (p.kind === "new") bits.push(p.mode && p.mode !== "default" ? `⇧⇥ mode:${p.mode}` : "⇧⇥ mode");
  if (p.kind === "new" || p.kind === "send") bits.push("↑↓ history");
  if (p.kind === "send" && queued > 0) bits.push(`⌃X clear ${queued} queued`);
  bits.push("esc cancel");
  return bits.join("  ·  ");
}

export function FooterArea({ state, width }: { state: TuiState; width: number }): ReactNode {
  if (state.mode === "prompt" && state.prompt) {
    const p = state.prompt;
    const queued = p.kind === "send" ? queueFor(state, p.sessionId).length : 0;
    const placeholder =
      p.kind === "deny"
        ? "reason (optional)"
        : p.kind === "new"
          ? "describe the task…"
          : p.kind === "title"
            ? "session title"
            : p.kind === "budget"
              ? "max cost in USD, e.g. 2.50"
              : p.kind === "discuss"
                ? "what should change about the plan?"
                : p.kind === "compact"
                  ? "what to keep in focus — blank compacts the whole history"
                  : "type a message…";
    return h(
      Box,
      { flexDirection: "column", width, paddingX: 1 },
      h(
        Box,
        { gap: 1 },
        h(Text, { color: C.accent, bold: true }, p.label),
        p.kind === "new" && p.mode && p.mode !== "default"
          ? h(Text, { color: C.warn }, `[${p.mode}]`)
          : null,
      ),
      h(EditorView, { buf: p.buffer, width: width - 2, placeholder }),
      h(Text, { color: C.faint }, promptHints(p, queued)),
    );
  }

  const hints = actionsFor(selectedSession(state));
  return h(
    Box,
    { flexDirection: "column", width },
    h(Text, { color: C.faint }, "─".repeat(width)),
    h(
      Box,
      { width, paddingX: 1 },
      h(
        Box,
        { gap: 1 },
        ...hints.flatMap((hint, i) => [
          i > 0 ? h(Text, { key: `s${i}`, color: C.faint }, "·") : null,
          h(Text, { key: `k${i}`, color: C.accent }, hint.keys),
          h(Text, { key: `l${i}`, color: C.dim }, hint.label),
        ]),
      ),
      h(Box, { flexGrow: 1 }),
      state.notice ? h(Text, { color: TONE_COLOR[state.notice.tone] }, state.notice.text) : null,
    ),
  );
}

/** Rows the prompt editor occupies, for the parent's height maths. */
export function promptRows(state: TuiState): number {
  if (state.mode !== "prompt" || !state.prompt) return 2;
  const editor = Math.min(MAX_EDITOR_ROWS, Math.max(1, state.prompt.buffer.text.split("\n").length));
  return 1 /* label */ + editor + 1 /* hints */;
}

// ---------------------------------------------------------------------------
// confirm overlay
// ---------------------------------------------------------------------------

export function Confirm({ confirm, width }: { confirm: ConfirmState; width: number }): ReactNode {
  const accent = confirm.danger ? C.bad : C.accent;
  return h(
    Box,
    { width, borderStyle: "round", borderColor: accent, paddingX: 2, paddingY: 1, flexDirection: "column" },
    h(Text, { color: accent, bold: true }, confirm.title),
    confirm.body ? h(Text, { color: C.warn }, confirm.body) : null,
    h(Box, { height: 1 }),
    h(
      Box,
      { gap: 2 },
      h(Text, { color: C.accent }, "enter"),
      h(Text, { color: C.dim }, confirm.action === "restart" ? "restart the daemon" : "quit and stop the daemon"),
      h(Text, { color: C.faint }, "·"),
      h(Text, { color: C.accent }, "esc"),
      h(Text, { color: C.dim }, "cancel"),
    ),
  );
}

// ---------------------------------------------------------------------------
// pending request panel (what you're approving / being asked)
// ---------------------------------------------------------------------------

/** Height reserved for {@link RequestPanel} in the layout. */
export const REQUEST_PANEL_ROWS = 8;

function describeRequest(input: unknown, w: number): string[] {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o["command"] === "string") return wrapText(o["command"], w).slice(0, 5);
    const parts: string[] = [];
    const path = o["file_path"] ?? o["path"] ?? o["notebook_path"];
    if (typeof path === "string") parts.push(path);
    if (typeof o["pattern"] === "string") parts.push(`pattern: ${o["pattern"]}`);
    if (typeof o["url"] === "string") parts.push(String(o["url"]));
    if (typeof o["old_string"] === "string") parts.push(`− ${String(o["old_string"]).replace(/\s+/g, " ")}`);
    if (typeof o["new_string"] === "string") parts.push(`+ ${String(o["new_string"]).replace(/\s+/g, " ")}`);
    if (parts.length > 0) return parts.flatMap((p) => wrapText(p, w)).slice(0, 5);
    return wrapText(JSON.stringify(o), w).slice(0, 5);
  }
  return input == null ? [] : wrapText(String(input), w).slice(0, 5);
}

export function RequestPanel({ pending, width }: { pending: Pending; width: number }): ReactNode {
  const w = inside(width);
  const box = (title: string, body: ReactNode[], hint: string): ReactNode =>
    h(
      Box,
      { width, borderStyle: "round", borderColor: C.await_, paddingX: 1, flexDirection: "column" },
      h(Text, { color: C.await_, bold: true }, title),
      ...body,
      h(Text, { color: C.faint }, hint),
    );

  if (pending.question !== undefined) {
    return box(
      "? QUESTION",
      [
        ...wrapText((pending.questionText ?? "").replace(/\s+/g, " ").trim(), w)
          .slice(0, 4)
          .map((l, i) => h(Text, { key: i, color: C.text }, l)),
        pending.questionContext
          ? h(
              Text,
              { key: "ctx", color: C.faint, wrap: "truncate-end" },
              truncate(pending.questionContext.replace(/\s+/g, " ").trim(), w),
            )
          : null,
      ],
      "a answer  ·  ⌃o view  ·  i interrupt",
    );
  }
  if (pending.plan !== undefined) {
    return box(
      "❖ PLAN REVIEW",
      wrapText((pending.planText ?? "").replace(/\s+/g, " ").trim(), w)
        .slice(0, 5)
        .map((l, i) => h(Text, { key: i, color: C.text, wrap: "truncate-end" }, l)),
      "a review  ·  ⌃o view  ·  i interrupt",
    );
  }
  if (pending.permission !== undefined) {
    return box(
      `⇱ PERMISSION — ${pending.permTool ?? "tool"}`,
      describeRequest(pending.permInput, w).map((l, i) => h(Text, { key: i, color: C.text, wrap: "truncate-end" }, l)),
      "a approve  ·  d deny  ·  ⌃o view  ·  i interrupt",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// plan-review overlay (the post-planning decision)
// ---------------------------------------------------------------------------

export function PlanReview({ text, width }: { text: string; width: number }): ReactNode {
  const w = inside(width);
  const lines = text.split("\n").flatMap((ln) => (ln === "" ? [""] : wrapText(ln, w)));
  const body = lines.slice(0, 16);
  const row = (k: string, v: string): ReactNode =>
    h(Box, { gap: 1 }, h(Box, { width: 3 }, h(Text, { color: C.accent }, k)), h(Text, { color: C.dim }, v));
  return h(
    Box,
    { width, borderStyle: "round", borderColor: C.await_, paddingX: 2, paddingY: 1, flexDirection: "column" },
    h(Text, { color: C.await_, bold: true }, "❖ PLAN REVIEW"),
    h(Box, { height: 1 }),
    ...body.map((l, i) => h(Text, { key: i, color: C.text, wrap: "truncate-end" }, l || " ")),
    lines.length > body.length
      ? h(Text, { color: C.faint }, `  … ${lines.length - body.length} more lines — ⌃o to read it all`)
      : null,
    h(Box, { height: 1 }),
    row("i", "implement — the agent proceeds in this context"),
    row("f", "implement fresh — compact to the plan + goal first"),
    row("e", "edit the plan in $EDITOR, then implement what you saved"),
    row("d", "discuss — send a note back; the agent stays in plan mode"),
    h(Box, { height: 1 }),
    h(Text, { color: C.faint }, "⌃o view read-only  ·  a plan review must be answered — esc does nothing"),
  );
}

// ---------------------------------------------------------------------------
// send-choice overlay (message composed while the agent is still working)
// ---------------------------------------------------------------------------

export function SendChoice({ text, width }: { text: string; width: number }): ReactNode {
  const w = inside(width);
  const row = (k: string, v: string): ReactNode =>
    h(Box, { gap: 1 }, h(Box, { width: 12 }, h(Text, { color: C.accent }, k)), h(Text, { color: C.dim }, v));
  return h(
    Box,
    { width, borderStyle: "round", borderColor: C.accent, paddingX: 2, paddingY: 1, flexDirection: "column" },
    h(Text, { color: C.accent, bold: true }, "The agent is still working — send this how?"),
    h(Text, { color: C.dim, wrap: "truncate-end" }, `“${truncate(text.replace(/\s+/g, " ").trim(), w - 2)}”`),
    h(Box, { height: 1 }),
    row("a", "inject now — lands after the current tool call (Claude: next turn)"),
    row("t / enter", "queue until the turn ends"),
    row("esc", "back to the message — nothing is cleared"),
  );
}

// ---------------------------------------------------------------------------
// help overlay
// ---------------------------------------------------------------------------

const HELP_ROWS: Array<[string, string]> = [
  ["↑ / ↓  ·  j / k", "move the selection"],
  ["⟢ (fleet)", "prompt cache still warm — green → amber → red as it lapses"],
  ["PgUp / PgDn", "scroll the event log"],
  ["⇥", "toggle the fullscreen event log"],
  ["⌃o", "open the pending request — or the event log — in $EDITOR, read-only"],
  ["⌃y", "copy the selected session's branch to the clipboard"],
  ["a  ·  d", "approve / answer  ·  deny a permission request"],
  ["a (plan)", "open the plan review — then i / f / e / d to decide"],
  ["s", "send a follow-up turn (while running → inject now / queue for turn end)"],
  ["c", "compact the context window (shown once the meter passes half)"],
  ["u", "undo — rewind an idle session to an earlier turn (shows the re-prime cost)"],
  ["⌃f", "hard fork — a new session + worktree branched off this one (aisdk)"],
  ["⌃x", "clear the selected session's queued messages"],
  ["i  ·  r", "interrupt the turn  ·  resume an interrupted / errored session"],
  ["x  ·  e", "mark the session done  ·  rename it"],
  ["b", "set a cost budget (soft-warns or hard-halts on breach)"],
  ["⇧⇥  ·  M", "cycle the permission mode  ·  switch the session's model (next turn)"],
  ["n  ·  N", "new session (default provider)  ·  new with a provider + model picker"],
  ["f  ·  F", "find a session by title / message text  ·  toggle the log: this session / all"],
  ["fleet id colour", "which provider the session runs on (default provider stays plain)"],
  ["R", "restart the daemon (with confirmation)"],
  ["Q", "quit the UI and stop the daemon (with confirmation)"],
  ["q  ·  ⌃c", "quit the UI — the daemon keeps running"],
  ["?  ·  esc", "toggle this help  ·  back out of any overlay"],
];

const EDIT_ROWS: Array<[string, string]> = [
  ["enter  ·  esc", "submit  ·  cancel"],
  ["⌃e", "edit the text in $EDITOR, event log opened alongside (`:wq` to return); nothing sent until enter"],
  ["⌃o", "open the event log in $EDITOR, read-only"],
  ["⌃a", "start of line     ⌃u / ⌃k  kill to start / end     ⌃w  delete word"],
  ["↑ / ↓  ·  ⇧⇥", "prompt history     ·     cycle the mode (new session)"],
];

// ---------------------------------------------------------------------------
// picker overlay — provider / model choice, session find
// ---------------------------------------------------------------------------

export function Picker({
  picker,
  width,
  height,
}: {
  picker: PickerState;
  width: number;
  height: number;
}): ReactNode {
  const w = inside(width);
  const vis = pickerVisible(picker);
  const rows = Math.max(3, height - 7);
  const start = Math.max(
    0,
    Math.min(Math.max(0, vis.length - rows), picker.index - Math.floor(rows / 2)),
  );
  const shown = vis.slice(start, start + rows);

  return h(
    Box,
    { width, borderStyle: "round", borderColor: C.accent, paddingX: 2, paddingY: 1, flexDirection: "column" },
    h(Text, { color: C.accent, bold: true }, `▸ ${picker.title.toUpperCase()}`),
    h(
      Box,
      { gap: 1 },
      h(Text, { color: C.faint }, "filter"),
      h(Text, { color: C.text }, picker.filter || "…"),
      h(Text, { color: C.faint }, `  ${vis.length}/${picker.items.length}`),
    ),
    h(Box, { height: 1 }),
    ...(shown.length === 0
      ? [h(Text, { key: "none", color: C.faint }, "no matches")]
      : shown.map((it, i) => {
          const on = start + i === picker.index;
          return h(
            Text,
            { key: it.id, wrap: "truncate-end", color: on ? C.text : C.dim, bold: on },
            h(Text, { color: on ? C.accent : C.faint }, on ? "▍ " : "  "),
            truncate(it.label, Math.max(6, w - 32)),
            it.hint ? h(Text, { color: C.faint }, `  ${truncate(it.hint, 28)}`) : null,
          );
        })),
    start + shown.length < vis.length || start > 0
      ? h(Text, { color: C.faint }, `  … ${vis.length - shown.length} more`)
      : null,
    h(Box, { height: 1 }),
    h(Text, { color: C.faint }, "type to filter · ↑↓ move · enter pick · esc cancel"),
  );
}

export function Help({ width }: { width: number }): ReactNode {
  return h(
    Box,
    { width, borderStyle: "round", borderColor: C.accent, paddingX: 2, paddingY: 1, flexDirection: "column" },
    h(Text, { color: C.accent, bold: true }, "loom — keys"),
    h(Box, { height: 1 }),
    ...HELP_ROWS.map(([k, v], i) =>
      h(
        Box,
        { key: i, gap: 2 },
        h(Box, { width: 16 }, h(Text, { color: C.accent }, k)),
        h(Text, { color: C.dim }, v),
      ),
    ),
    h(Box, { height: 1 }),
    h(Text, { color: C.dim, bold: true }, "in the prompt"),
    ...EDIT_ROWS.map(([k, v], i) =>
      h(
        Box,
        { key: `e${i}`, gap: 2 },
        h(Box, { width: 16 }, h(Text, { color: C.accent }, k)),
        h(Text, { color: C.dim }, v),
      ),
    ),
    h(Box, { height: 1 }),
    h(Text, { color: C.faint }, "loom drives worktrees only — it never pushes or touches your remotes."),
  );
}
