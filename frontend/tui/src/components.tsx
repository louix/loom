/**
 * Ink components for the TUI. Written in JSX and run with no bundler — `@oxc-node`
 * transforms `.tsx` on the fly (the `loom`/`loomd` bins and the test runner both
 * load its hook), so the only build step is still "none". Every component is a
 * pure projection of {@link TuiState}.
 */
import { type ReactNode } from "react";
import { Box, Text } from "ink";
import { cacheHitRate } from "@loom/core/cache";
import type { DoctorMcpServer, DoctorReport, SessionSnapshot } from "@loom/core/wire";
import type { SessionMode } from "@loom/core/types";
import { foldInteraction, type SessionInteraction } from "@loom/core/interaction";
import { layout, layoutWrapped, type Buffer } from "./editor.ts";
import { searchSessions } from "./fleet-search.ts";
import {
  connectionOf,
  fleetDaemon,
  fleetProviders,
  fleetSessions,
  cacheHeat,
  cacheStatus,
  clock,
  fleetLayout,
  fleetRowBudget,
  focusedChildOf,
  footerHints,
  logFilterTag,
  parseAskUserQuestions,
  pickerVisible,
  providerInfo,
  queueFor,
  selectedSession,
  visibleLog,
  type AskUserQuestionItem,
  type Connection,
  type ConfirmState,
  type FleetChild,
  type LogLine,
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

/** The ` · …` tail after a status label in the Detail pane. */
const statusDetailSuffix = (s: SessionSnapshot): string => {
  if (s.status.kind === "awaiting_input") return ` · ${s.status.on}`;
  if (s.status.kind === "working_background") {
    const n = (s.backgroundTasks ?? []).length;
    return n > 0 ? ` · ${n} task${n === 1 ? "" : "s"}` : "";
  }
  return "";
};

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
  comment: "note about this session (blank clears it)",
  discuss: "what should change about the plan?",
  compact: "steer the summary (optional) — blank = best-effort summary of everything",
  send: "type a message…",
  answer: "type a message…",
  answerQuestion: 'type your answer — e.g. "a" or "a, but …"',
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
  const lamp = lampFor(connectionOf(state));

  const daemon = fleetDaemon(state);
  const sessions = fleetSessions(state);
  const repo = daemon ? basename(daemon.repoRoot) : "—";
  const running = sessions.filter(
    (s) => s.status.kind === "running" || s.status.kind === "starting",
  ).length;
  const waiting = sessions.filter((s) => s.status.kind === "awaiting_input").length;
  const bg = sessions.filter((s) => s.status.kind === "working_background").length;

  return (
    <Box width={width} justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        <Text color={C.accent} bold wrap="truncate-end">
          {"▍ loom"}
        </Text>
        <Text color={C.dim} wrap="truncate-end">
          {`v${daemon?.version ?? "?"}`}
        </Text>
        <Text color={C.faint}>{"·"}</Text>
        <Text color={C.text} wrap="truncate-end">
          {repo}
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={C.dim} wrap="truncate-end">
          {`${sessions.length} sessions`}
        </Text>
        {waiting ? <Text color={C.await_}>{`◆ ${waiting}`}</Text> : null}
        {running ? <Text color={C.accent}>{`● ${running}`}</Text> : null}
        {bg ? <Text color={C.accentDim}>{`◐ ${bg}`}</Text> : null}
        <Text color={C.faint}>{"·"}</Text>
        <Text color={lamp.color} wrap="truncate-end">
          {lamp.text}
        </Text>
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
  height,
  now = Date.now(),
}: {
  state: TuiState;
  tick: number;
  width: number;
  /** Row budget for the whole pane, border to border — entries beyond it
   *  scroll (centered on the selection) instead of spilling past the pane
   *  into whatever the layout put next (the reply box, the footer). */
  height: number;
  now?: number;
}): ReactNode => {
  const iw = inside(width);
  const pcolor = new Map(fleetProviders(state).map((p) => [p.id, p.color]));
  const compactingIds = new Set(
    fleetSessions(state)
      .filter((x) => x.compacting !== undefined)
      .map((x) => x.id),
  );
  // Drilled in? The focus only ever applies to the selected session's rows.
  const focused = focusedChildOf(state);
  const childKeyOf = (s: SessionSnapshot): string | null =>
    focused && s.id === state.selectedId ? focused.key : null;

  const budget = fleetRowBudget(height, state.find != null);
  const { visible, offset, total } = fleetLayout(state, budget);
  const truncated = total > visible.length;

  let blocks: ReactNode[];
  if (total === 0) {
    blocks = [
      state.find ? (
        <Text key="empty" color={C.dim} wrap="truncate-end">
          {"no sessions match — esc clears the filter"}
        </Text>
      ) : (
        <Text key="empty" color={C.dim}>
          {"no sessions yet — press "}
          <Text color={C.accent}>{"n"}</Text>
          {" to start one"}
        </Text>
      ),
    ];
  } else {
    blocks = visible.map((entry, i) => {
      switch (entry.kind) {
        case "blank":
          return <Box key={`blank-${i}`} height={1} />;
        case "groupHeader":
          return (
            <Text key={`hdr-${entry.group.status}`} bold>
              <Text color={statusLook(entry.group.status).color}>
                {statusLook(entry.group.status).glyph + " "}
              </Text>
              <Text color={C.dim}>{entry.group.label.toUpperCase()}</Text>
              <Text color={C.faint}>{`  ${entry.group.sessions.length}`}</Text>
            </Text>
          );
        case "session":
          return FleetRow({
            s: entry.s,
            selected: entry.s.id === state.selectedId,
            focused: childKeyOf(entry.s) != null,
            tick,
            iw,
            now,
            pcolor,
            compacting: compactingIds.has(entry.s.id),
          });
        case "child":
          return FleetChildRow({
            rowKey: `${entry.s.id}:${entry.c.key}`,
            c: entry.c,
            isLast: entry.isLast,
            sel: entry.c.key === childKeyOf(entry.s),
            tick,
            iw,
          });
        case "childMore":
          return (
            <Text key={`more-${entry.s.id}`} color={C.faint}>
              {`  └ +${entry.extra} more`}
            </Text>
          );
      }
    });
  }

  let title = "FLEET";
  if (focused) {
    title = `FLEET · ${shortId(state.selectedId ?? "")} ▸ ${childGlyph(focused)} ${truncate(
      focused.label.replace(/\s+/g, " ").trim(),
      Math.max(8, iw - 24),
    )}`;
  } else if (state.find) {
    const query = state.find.buffer.text;
    const matched = searchSessions(
      { sessions: fleetSessions(state), transcripts: state.transcripts },
      query,
    ).length;
    title = `FLEET · ${matched}/${fleetSessions(state).length} match${matched === 1 ? "" : "es"}`;
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width={width}
      borderStyle="round"
      borderColor={C.faint}
      borderBackgroundColor={C.bg}
      paddingX={1}
    >
      <Text color={C.dim} wrap="truncate-end">
        {title}
      </Text>
      {state.find ? (
        <Box marginTop={1} flexShrink={0}>
          <InputLine
            buf={state.find.buffer}
            room={Math.max(8, iw - 2)}
            placeholder="type to filter"
            multiline={false}
          />
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {blocks}
        {truncated ? (
          <Text color={C.faint} wrap="truncate-end">
            {`↕ ${offset + 1}–${offset + visible.length} of ${total}`}
          </Text>
        ) : null}
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
  focused = false,
  tick,
  iw,
  now,
  pcolor,
  compacting = false,
}: {
  s: SessionSnapshot;
  selected: boolean;
  /** The fleet is drilled into this row's children — its cursor goes dim and
   *  the bright one moves onto the focused child row. */
  focused?: boolean;
  tick: number;
  iw: number;
  now: number;
  /** provider id → Fleet-row id colour ("" for the plain default). */
  pcolor: Map<string, string>;
  /** A compaction is in flight — show a `⇊` in the cache-dot slot. */
  compacting?: boolean;
}): ReactNode => {
  const look = statusLook(s.status.kind);
  const glyph = s.status.kind === "running" ? spinnerFrame(tick) : look.glyph;
  const id = shortId(s.id);
  const cost = money(s.costUsd);
  const heat = cacheHeat(cacheStatus(s, now));
  // Always 2 cols so titles stay aligned whether or not a session has a warm cache.
  const cacheColor = heat ? cacheHeatColor(heat) : null;
  const idColor = pcolor.get(s.provider) || C.faint;
  const forked = s.parentId != null && s.forkTurn != null;
  const idText = forked ? `⑂${id}` : id;
  const room = Math.max(6, iw - (2 + 2 + idText.length + 2 + 2 + 2 + cost.length + 1));
  const title = truncate(titleLine(s.title), room).padEnd(room);

  return (
    <Text key={s.id} wrap="truncate-end">
      <Text color={selected && !focused ? C.accent : C.faint}>{selected ? "▍ " : "  "}</Text>
      <Text color={s.status.kind === "running" ? C.accent : look.color}>{glyph + " "}</Text>
      <Text color={idColor}>{`${idText}  `}</Text>
      {compacting ? (
        <Text color={C.accent}>{"⇊ "}</Text>
      ) : (
        <Text color={cacheColor ?? C.faint}>{cacheColor ? "⟢ " : "  "}</Text>
      )}
      <Text color={C.faint}>{s.comment ? "✎ " : "  "}</Text>
      <Text color={selected ? C.text : C.dim} bold={selected}>
        {title}
      </Text>
      <Text color={C.faint}>{` ${cost}`}</Text>
    </Text>
  );
};

/** Glyph per background-task kind — a hint at what the child is. */
const BG_KIND_GLYPH: Record<string, string> = {
  subagent: "⑂",
  shell: "$",
  workflow: "⚙",
  monitor: "◉",
  other: "•",
};

/** Fleet-row glyph for a child — its task kind, or the sub-agent fork. */
const childGlyph = (c: FleetChild): string =>
  c.source === "sub" ? "⑂" : (BG_KIND_GLYPH[c.taskKind ?? "other"] ?? "•");

/**
 * One indented row under a fleet session for a live background task or
 * still-running foreground sub-agent — called per {@link FleetEntry} `child`
 * (and `childMore`) entry, since those are now the fleet's own flat rows
 * rather than a nested block per session (see `fleetEntries`).
 */
const FleetChildRow = ({
  rowKey,
  c,
  isLast,
  sel,
  tick,
  iw,
}: {
  /** Session-qualified key — plain child keys aren't unique across sessions
   *  once every row sits in one flat list. */
  rowKey: string;
  c: FleetChild;
  /** Last child shown for its session (draws `└` instead of `├`) — false
   *  when a "+N more" row follows it. */
  isLast: boolean;
  sel: boolean;
  tick: number;
  iw: number;
}): ReactNode => {
  const room = Math.max(6, iw - 8);
  return (
    <Text key={rowKey} wrap="truncate-end">
      <Text color={sel ? C.accent : C.faint}>{sel ? "▍ " : "  "}</Text>
      <Text color={C.faint}>{isLast ? "└ " : "├ "}</Text>
      <Text color={C.accentDim}>{spinnerFrame(tick) + " "}</Text>
      <Text color={C.faint}>{childGlyph(c) + " "}</Text>
      <Text color={sel ? C.text : C.dim} bold={sel}>
        {truncate(c.label.replace(/\s+/g, " ").trim(), room)}
      </Text>
    </Text>
  );
};

// ---------------------------------------------------------------------------
// detail (right column, top)
// ---------------------------------------------------------------------------

/** Left gutter (chars) for the label ∶ value rows in the Detail pane. */
const DETAIL_GUTTER = 8;

/** A fixed-width label gutter + a value that truncates to the rest of the row. */
const Field = ({ label, children }: { label: string; children: ReactNode }): ReactNode => (
  <Box>
    <Text color={C.dim}>{label.padEnd(DETAIL_GUTTER)}</Text>
    <Box flexGrow={1}>{children}</Box>
  </Box>
);

export const Detail = ({
  session,
  width,
  queued = [],
  now = Date.now(),
  engineColor = "",
  account = "",
  compacting = null,
}: {
  session: SessionSnapshot | null;
  width: number;
  queued?: string[];
  now?: number;
  /** Ink colour for the provider/model line; matches the Fleet id colour. */
  engineColor?: string;
  /** `<login method> (<org>)` for a Claude profile; "" hides the line. */
  account?: string;
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
  const look = statusLook(s.status.kind);
  const ctxFrac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
  const ctxPct = Math.round(ctxFrac * 100);
  const g = s.git;
  const gitLine = gitLineText(s);
  const hitRate = cacheHitRate(s.usage);

  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={look.color}
      borderBackgroundColor={C.bg}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color={C.dim} wrap="truncate-end">{`DETAIL  ${shortId(s.id)}`}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text wrap="truncate-end">
            <Text color={C.faint}>{"engine "}</Text>
            <Text color={engineColor || C.faint}>{s.provider}</Text>
            <Text color={C.faint}>{s.model ? ` / ${s.model}` : ""}</Text>
          </Text>
        </Box>
      </Box>
      {account ? (
        <Text color={C.faint} wrap="truncate-end">
          {account}
        </Text>
      ) : null}
      <Text color={C.text} wrap="truncate-end">
        {truncate(titleLine(s.title), w)}
      </Text>
      {s.parentId && s.forkTurn != null ? (
        <Text color={C.faint} wrap="truncate-end">
          {`⑂ forked from ${shortId(s.parentId)} @ turn ${s.forkTurn}`}
        </Text>
      ) : null}
      <Box marginTop={1} gap={2}>
        <Text color={look.color} bold wrap="truncate-end">
          {`${look.glyph} ${look.label}${statusDetailSuffix(s)}`}
        </Text>
        {/* `[mode]` in the same gold the event log gives tool commands — the one */}
        {/* thing on this row you change mid-session, so it should catch the eye. */}
        <Text wrap="truncate-end">
          <Text color={C.dim}>{"mode "}</Text>
          <Text color={C.warn}>{`[${modeLabel(s.mode)}]`}</Text>
        </Text>
        <Text color={C.dim} wrap="truncate-end">
          {`${s.turns} turn${s.turns === 1 ? "" : "s"}`}
        </Text>
      </Box>
      <Field label="context">
        <Text wrap="truncate-end">
          <Text color={contextHeatColor(ctxFrac)}>{bar(ctxFrac, 16)}</Text>
          <Text color={C.dim}>
            {`  ${ctxPct}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`}
          </Text>
        </Text>
      </Field>
      {compacting ? (
        <Field label="">
          <Text wrap="truncate-end">
            <Text color={C.accent}>
              {`⇊ compacting… ${Math.max(0, Math.round((now - compacting.startedAt) / 1000))}s`}
            </Text>
            <Text color={C.faint}>{`  from ${humanTokens(compacting.before)}`}</Text>
          </Text>
        </Field>
      ) : null}
      {(() => {
        const cs = cacheStatus(s, now);
        if (cs.state === "unknown") return null;
        const hit = cs.lastHit
          ? `  ·  ${cs.lastHit === "hit" ? "last turn hit" : "last turn rewrote"}`
          : "";
        const warm = s.keepWarm ? "  ·  keep-warm" : "";
        // The countdown length is only confirmed once a turn has written cache
        // and reported which bucket; until then it is the configured pin, which
        // the provider is free to ignore. Say so rather than imply precision.
        const assumed = cs.source === "config" ? "  ·  ttl assumed" : "";
        return (
          <Field label="cache">
            {cs.state === "warm" ? (
              <Text
                color={C.good}
                wrap="truncate-end"
              >{`⟢ warm ~${mmss(cs.remainingMs)}${hit}${warm}${assumed}`}</Text>
            ) : (
              <Text color={C.faint} wrap="truncate-end">{`⟢ cold${hit}${warm}${assumed}`}</Text>
            )}
          </Field>
        );
      })()}
      <Box>
        <Text color={C.dim}>{"tokens".padEnd(DETAIL_GUTTER)}</Text>
        <Box flexGrow={1}>
          <Text color={C.faint} wrap="truncate-end">
            {`${humanTokens(s.usage.input)} in · ${humanTokens(s.usage.output)} out · ${humanTokens(s.usage.cacheRead)} cr · ${humanTokens(s.usage.cacheWrite)} cw` +
              // Share of prompt tokens served from cache over the session's
              // life. The other figures on this row are lifetime totals too, so
              // a session that switched models blends them — `loom cache` is
              // the per-model breakdown.
              (hitRate == null ? "" : ` · ${Math.round(hitRate * 100)}% cached`)}
          </Text>
        </Box>
        <Text color={s.costUsd ? C.good : C.faint} wrap="truncate-end">
          {` ${(s.costSource === "table" ? "~" : "") + money(s.costUsd)}`}
        </Text>
      </Box>
      {Object.keys(s.rateLimits).length > 0 ? (
        <Field label="plan">
          <Text wrap="truncate-end">
            {Object.entries(s.rateLimits).map(([window, rl], i) => {
              let col: string = C.faint;
              if (rl.status === "rejected") col = C.bad;
              else if (rl.status === "allowed_warning") col = C.warn;
              const pct = rl.utilization != null ? `${Math.round(rl.utilization)}%` : "?%";
              const resets = rl.resetsAt != null ? `  ⟳ ${humanDuration(rl.resetsAt - now)}` : "";
              return (
                <Text key={window} color={col}>
                  {`${i > 0 ? "   " : ""}${window} ${pct}${resets}`}
                </Text>
              );
            })}
          </Text>
        </Field>
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
      {s.comment ? (
        <Field label="comment">
          <Text color={C.accentDim} wrap="truncate-end">
            {truncate(s.comment.replace(/\s+/g, " ").trim(), w - DETAIL_GUTTER)}
          </Text>
        </Field>
      ) : null}
      {queued.length > 0 ? (
        <Text color={C.accentDim} wrap="truncate-end">
          {`▸ ${queued.length} queued — “${truncate((queued[0] ?? "").replace(/\s+/g, " ").trim(), w - 16)}”`}
        </Text>
      ) : null}
      {(s.subagents ?? []).length > 0
        ? (() => {
            const subs = s.subagents ?? [];
            const active = subs.filter((a) => a.active);
            const names = subs.map((a) => (a.active ? a.name : `${a.name} ✓`)).join(", ");
            return (
              <Text color={C.dim} wrap="truncate-end">
                {`⑂ ${active.length}/${subs.length} sub-agent${subs.length === 1 ? "" : "s"} · ${truncate(names, w - 20)}`}
              </Text>
            );
          })()
        : null}
      {(s.backgroundTasks ?? []).length > 0 ? (
        <Text color={C.accentDim} wrap="truncate-end">
          {`◐ ${s.backgroundTasks.length} background task${s.backgroundTasks.length === 1 ? "" : "s"} · ${truncate(
            s.backgroundTasks.map((t) => t.title.replace(/\s+/g, " ").trim()).join(", "),
            w - 24,
          )}`}
        </Text>
      ) : null}
    </Box>
  );
};

/**
 * The physical rows {@link Detail} renders for a session — the layout's budget
 * for the right column. Every Detail line truncates (never wraps), so the count
 * is exact. `deriveView` sizes the split event log against this; it used to
 * hardcode 13, which drifted from the conditional lines a claude chat accumulates
 * (account / cache / plan / commit subject / background tasks), overflowed the
 * body, and pushed the top of the UI off the alt screen. Keep in lockstep with
 * Detail's JSX above — `test/tui-model.test.ts` pins both ends.
 */
export const detailRows = (
  session: SessionSnapshot | null,
  opts: {
    /** `<login method> (<org>)` line — claude profiles only. */
    account?: string;
    /** Compaction-in-flight row. */
    compacting?: { startedAt: number; before: number } | null;
    /** Queued-messages row. */
    queued?: readonly string[];
  } = {},
): number => {
  if (!session) return 4; // borders + "DETAIL" + the select hint
  const s = session;
  let rows = 4; // borders + the title row + the title line
  if (opts.account) rows += 1;
  if (s.parentId && s.forkTurn != null) rows += 1;
  rows += 2; // status row + its marginTop
  rows += 1; // context
  if (opts.compacting) rows += 1;
  // cache row: appears once cache data exists (warm → cold with age, but the
  // row persists), so `Date.now()` here can't disagree with the render.
  if (cacheStatus(s, Date.now()).state !== "unknown") rows += 1;
  rows += 1; // tokens
  if (Object.keys(s.rateLimits).length > 0) rows += 1;
  rows += 2; // git row + its marginTop
  if (s.git?.lastCommitSubject) rows += 1;
  if (s.comment) rows += 1;
  if ((opts.queued ?? []).length > 0) rows += 1;
  if (s.subagents.length > 0) rows += 1;
  if ((s.backgroundTasks ?? []).length > 0) rows += 1;
  return rows;
};

/**
 * The clickable cell span of Detail's gold `[mode]` chip, in 1-based screen
 * coordinates — `null` when no session is shown or the chip is truncated off a
 * narrow pane. `originX`/`originY` are the Detail box's top-left; `paneW` its
 * outer width. Mirrors {@link Detail}'s chrome up to the status row the same way
 * {@link detailRows} mirrors the whole card; `test/tui-model.test.ts` pins it.
 */
export const modeChipHit = (
  session: SessionSnapshot | null,
  geom: { originX: number; originY: number; paneW: number; account?: string },
): { y: number; x0: number; x1: number } | null => {
  if (!session) return null;
  const s = session;
  const forked = s.parentId != null && s.forkTurn != null;
  // border + DETAIL header + title + the status row's marginTop, plus the
  // optional account / fork lines between header and status.
  const y = geom.originY + 4 + (geom.account ? 1 : 0) + (forked ? 1 : 0);
  const look = statusLook(s.status.kind);
  const left = `${look.glyph} ${look.label}${statusDetailSuffix(s)}`;
  const contentX = geom.originX + 2; // round border + paddingX:1
  const x0 = contentX + [...left].length + 2; // the status row's gap={2}
  const chip = `mode [${modeLabel(s.mode)}]`;
  const rightEdge = geom.originX + geom.paneW - 3; // inside the far border + pad
  if (x0 > rightEdge) return null;
  return { y, x0, x1: Math.min(x0 + [...chip].length - 1, rightEdge) };
};

// ---------------------------------------------------------------------------
// event log (right column, bottom)
// ---------------------------------------------------------------------------

export const EventLog = ({
  state,
  width,
  height,
  scroll = 0,
  tick = 0,
}: {
  state: TuiState;
  width: number;
  height: number;
  scroll?: number;
  tick?: number;
}): ReactNode => {
  // Drilled in? The pane narrows to the focused child's own stream.
  const child = focusedChildOf(state);
  const session = selectedSession(state);
  const active =
    child != null ||
    session?.status.kind === "running" ||
    session?.status.kind === "starting" ||
    session?.status.kind === "working_background";
  const capacity = Math.max(1, height - 3);

  // Measure the log (total wrapped rows) and build only the visible window's
  // rows — through the same helpers the scrollback handler measures with, so
  // scroll math can't drift from what renders. The full wrapped list is never
  // materialised, which is what keeps a LOG_CAP-sized log (hundreds of
  // thousands of wrapped rows) from stalling every render.
  const ctx = logContext(state, width);
  const total = totalRows(ctx);
  const maxScroll = Math.max(0, total - capacity);
  const off = Math.min(scroll, maxScroll);
  const end = total - off;
  const shown = windowRows(ctx, Math.max(0, end - capacity), end);
  const above = Math.max(0, end - capacity);

  // Pane title: the focused child's name while drilled in, else the plain header.
  let title = "EVENTS";
  if (child) {
    title = `EVENTS · ${childGlyph(child)} ${truncate(
      child.label.replace(/\s+/g, " ").trim(),
      Math.max(8, inside(width) - 24),
    )}`;
  }

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
        <Text color={C.dim} wrap="truncate-end">
          {title}
        </Text>
        <Text color={C.faint}>
          {logFilterTag(state.logFilter) + (off > 0 ? `  ·  ↑${above} more` : "")}
        </Text>
      </Box>
      {shown.length === 0 ? (
        <Text color={C.faint}>
          {child
            ? `  (no events from this ${child.source === "sub" ? "sub-agent" : "task"})`
            : "  (quiet)"}
        </Text>
      ) : (
        shown.map((r) =>
          r.first ? (
            <Text key={r.key} wrap="truncate-end">
              <Text color={C.faint}>{r.ts}</Text>
              <Text color={toneColor(r.tone)}>{`${r.glyph} `}</Text>
              <Text color={diffSegColor(r.kind, r.seg, toneColor(r.tone))}>{r.seg}</Text>
            </Text>
          ) : (
            <Text key={r.key} wrap="truncate-end">
              <Text>{" ".repeat(r.indent)}</Text>
              <Text color={diffSegColor(r.kind, r.seg, toneColor(r.tone))}>{r.seg}</Text>
            </Text>
          ),
        )
      )}
      {active ? <Text color={C.accentDim}>{`  ${spinnerFrame(tick)} working…`}</Text> : null}
    </Box>
  );
};

/** One wrapped screen row of the event log. `first` rows carry the time + glyph
 *  gutter; continuation rows carry `indent` spaces and nothing else. */
interface PhysicalRow {
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
const diffSegColor = (kind: LogLine["kind"], seg: string, fallback: string): string => {
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

/** Everything the log renderers need for one state + pane width: the visible
 *  (filtered / condensed) lines, and the pane's inner width. */
interface LogContext {
  lines: readonly LogLine[];
  iw: number;
}

const logContext = (state: TuiState, width: number): LogContext => {
  // The main stream keeps no per-row child prefix: a sub-agent's frames are
  // its subtree's lines (visibleLog hides them here), and drilled in the pane
  // header already names the child.
  const child = focusedChildOf(state);
  return {
    lines: visibleLog(state, child),
    iw: inside(width),
  };
};

/** Wrapped-row total for the visible log — O(lines) per call, with per-line
 *  geometry memoised in `layoutCache`, so re-measuring a grown log re-wraps
 *  only the new lines. Deliberately NOT cached per log version: a stale total
 *  here desyncs the scroll math from the rendered window (the exact bug class
 *  this replaced a full materialisation to avoid), and the walk is cheap — a
 *  WeakMap hit + an add per line. */
const totalRows = (ctx: LogContext): number => {
  let total = 0;
  for (const l of ctx.lines) total += lineLayout(l, ctx.iw).segs.length;
  return total;
};
/** The wrapped rows `[from, to)` of the visible log — builds only the window's
 *  row objects; the full wrapped list is never materialised. Partial lines at
 *  the window edges render their inner segments only, exactly like slices of a
 *  fully-built list did. */
const windowRows = (ctx: LogContext, from: number, to: number): PhysicalRow[] => {
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
 * The event log's wrapped-row count at pane `width` — what `logScroll` is a
 * row offset into, and what {@link EventLog} pins the viewport against. The
 * scrollback handler in `fleet-handle.ts` measures through this so the scroll
 * math can't drift from what renders: one logical line wraps to several
 * physical rows, and only this count is the truth.
 */
export const logRowCount = (state: TuiState, width: number): number =>
  totalRows(logContext(state, width));

// ---------------------------------------------------------------------------
// input line (the prompt's editor, the pickers' filter)
// ---------------------------------------------------------------------------

/** Max rows the editor draws; `promptRows` reserves the same so the footer
 *  can't overdraw the body when a big paste / $EDITOR return lands. Wrapped
 *  rows count against it — a wide paste scrolls within the same budget. */
export const MAX_EDITOR_ROWS = 8;

/** Columns the prompt editor wraps to, given the terminal width: the footer's
 *  paddingX (1 + 1) and the 2-char caret gutter come off first. Single source
 *  of truth for both `InputLine`'s wrap and `promptRows`' height budget. */
const editorRoom = (cols: number): number => Math.max(8, cols - 4);

/** One drawn row with the block caret at `col`, windowed to `room` columns so
 *  the caret stays visible in text longer than the row. */
const caretCell = (ln: string, col: number, room: number): ReactNode => {
  const off = Math.max(0, col - (room - 1));
  return (
    <Text wrap="hard">
      <Text color={C.text}>{ln.slice(off, col)}</Text>
      <Text inverse>{ln.slice(col, col + 1) || " "}</Text>
      <Text color={C.text}>{ln.slice(col + 1, off + room)}</Text>
    </Text>
  );
};

/**
 * The one input-line component: an editor buffer drawn with the `▍ ` gutter and
 * a block caret. `multiline` (the default) soft-wraps and scrolls within
 * {@link MAX_EDITOR_ROWS} — the prompt; `multiline={false}` pins the buffer to
 * a single row, windowing the text around the caret — the pickers' filter line.
 *
 * Rows are never ellipsized: they are wrapped to the exact drawable width, and
 * a row that still measures wider than its columns (wide glyphs) hard-breaks
 * onto the next line rather than being truncated with a `…`.
 */
export const InputLine = ({
  buf,
  room,
  placeholder,
  multiline = true,
}: {
  buf: Buffer;
  room: number;
  placeholder?: string;
  multiline?: boolean;
}): ReactNode => {
  if (buf.text === "") {
    return (
      <Box>
        <Text color={C.accent}>{"▍ "}</Text>
        <Text inverse> </Text>
        {placeholder ? (
          <Text color={C.faint} wrap="hard">
            {` ${placeholder}`}
          </Text>
        ) : null}
      </Box>
    );
  }

  if (!multiline) {
    const { lines, row, col } = layout(buf);
    return (
      <Box>
        <Text color={C.accent}>{"▍ "}</Text>
        {caretCell(lines[row] ?? "", col, room)}
      </Box>
    );
  }

  const { rows, row, col } = layoutWrapped(buf, room);

  // Window to MAX_EDITOR_ROWS around the caret so the rendered height matches
  // what `promptRows` told the layout to reserve.
  const start =
    rows.length <= MAX_EDITOR_ROWS
      ? 0
      : Math.min(Math.max(0, row - Math.floor(MAX_EDITOR_ROWS / 2)), rows.length - MAX_EDITOR_ROWS);
  const shown = rows.slice(start, start + MAX_EDITOR_ROWS);
  const moreAbove = start > 0;
  const moreBelow = start + MAX_EDITOR_ROWS < rows.length;

  return (
    <Box flexDirection="column">
      {shown.map((ln, i) => {
        const r = start + i;
        const gutter =
          (i === 0 && moreAbove) || (i === shown.length - 1 && moreBelow) ? "⋮ " : "▍ ";
        const content: ReactNode =
          r === row ? (
            caretCell(ln, col, room)
          ) : (
            <Text color={C.text} wrap="hard">
              {ln.length ? ln : " "}
            </Text>
          );
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
  answerQuestion: "answer",
  deny: "deny",
  title: "rename",
  comment: "save",
  discuss: "send",
  compact: "compact",
};

/** The `[mode]` chip: gold once it's off the mundane `manual` default, faint
 *  otherwise — the same chip the Detail pane shows for a live session. */
const modeChip = (mode: string | null | undefined): ReactNode => {
  return (
    <Text wrap="truncate-end" color={mode && mode !== "default" ? C.warn : C.faint}>
      {`[${modeLabel(mode)}]`}
    </Text>
  );
};

const promptHints = (p: PromptState, queued: number, sessionMode?: string | null): string => {
  const bits = [`enter ${MODE_HINT[p.kind]}`, "⌥⏎ newline", "⌥e editor"];
  // a new-session prompt has no session / log yet; an AskUserQuestion answer
  // opens the formatted question sheet rather than the event log
  if (p.kind === "answerQuestion") bits.push("⌥o view");
  else if (p.kind !== "new") bits.push("⌥o log");
  if (p.kind === "new") {
    // ⇧⇥ cycles the mode the session starts in; ⌥m / ⌥p pick its model.
    bits.push(`⇧⇥ mode:${modeLabel(p.mode)}`);
    bits.push("⌥p provider/model");
  } else if (p.kind === "send") {
    // ⇧⇥ re-modes the live session, ⌥m swaps its model, ⌥p its provider — all
    // without leaving the half-typed message.
    bits.push(`⇧⇥ mode:${modeLabel(sessionMode)}`);
    bits.push("⌥m model");
    bits.push("⌥p provider");
  }
  if (p.kind === "new" || p.kind === "send") bits.push("↑↓ history");
  if (p.kind === "send" && queued > 0) bits.push(`⌥x clear ${queued} queued`);
  // Esc on an AskUserQuestion answer drops back to the request panel (where
  // ← / → move between questions), keeping what's been answered — it doesn't
  // abandon the whole call the way cancelling any other prompt does.
  bits.push(p.kind === "answerQuestion" ? "esc back" : "esc cancel");
  return bits.join("  ·  ");
};

/** Glyph prefixing a footer notice, by tone — a quiet "message line" marker
 *  that reads at a glance: ✓ done, ✕ failed, ▸ needs you, · informational. */
const noticeGlyph = (tone: Tone): string => {
  switch (tone) {
    case "good":
      return "✓";
    case "bad":
      return "✕";
    case "accent":
      return "▸";
    case "warn":
      return "!";
    default:
      return "·";
  }
};

export const FooterArea = ({ state, width }: { state: TuiState; width: number }): ReactNode => {
  if (state.mode === "prompt" && state.prompt) {
    const p = state.prompt;
    if (p.sessionId !== null) {
      // A reply to a session — the input lives on that session's EVENTS pane
      // (`PromptPane`, under the log); the footer keeps only the hints row.
      const mode =
        p.kind === "send" ? fleetSessions(state).find((x) => x.id === p.sessionId)?.mode : null;
      return (
        <Box width={width} paddingX={1}>
          <Text color={C.faint} wrap="truncate-end">
            {promptHints(p, p.kind === "send" ? queueFor(state, p.sessionId).length : 0, mode)}
          </Text>
        </Box>
      );
    }
    const queued = p.kind === "send" ? queueFor(state, p.sessionId).length : 0;
    const placeholder = PROMPT_PLACEHOLDER[p.kind];
    const prov = p.kind === "new" ? providerInfo(state, p.provider ?? "") : null;
    // A send prompt re-modes / re-models its target with ⇧⇥ / ⌥m, so it shows
    // the session's current mode chip too.
    const sendSess =
      p.kind === "send" && p.sessionId
        ? fleetSessions(state).find((x) => x.id === p.sessionId)
        : null;
    const showModeChip = p.kind === "new" || sendSess != null;
    const chipMode = p.kind === "new" ? p.mode : sendSess?.mode;
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Box gap={1}>
          <Text color={C.accent} bold wrap="truncate-end">
            {p.label}
          </Text>
          {showModeChip ? modeChip(chipMode) : null}
          {p.kind === "new" ? (
            <Text color={prov?.color || C.faint} wrap="truncate-end">
              {`${prov?.tag ?? p.provider ?? "?"} / ${p.model || prov?.defaultModel || "auto"}`}
            </Text>
          ) : null}
          {p.kind === "new" ? <Text color={C.faint}>{"⌥p change"}</Text> : null}
        </Box>
        <InputLine buf={p.buffer} room={editorRoom(width)} placeholder={placeholder} />
        {/* Truncate, never wrap — this row is budgeted as exactly one line
            (see promptRows); wrapping it grows the frame past the terminal. */}
        <Text color={C.faint} wrap="truncate-end">
          {promptHints(p, queued, sendSess?.mode)}
        </Text>
      </Box>
    );
  }

  const hints = footerHints(state);
  return (
    <Box flexDirection="column" width={width}>
      {/* A transient notice owns this full-width row rather than hanging off the
          hint row: appended there it word-wrapped past the terminal edge once
          hints + text outgrew `width`, and the extra footer row made the frame
          taller than `rows` — Ink's repaint then drifted and pushed the top
          bar off the alt screen. `promptRows` reserves this row while a notice
          is up; every Text below truncates so the footer stays its budgeted
          height at any width. */}
      {state.notice ? (
        <Box paddingX={1}>
          <Text wrap="truncate-end" color={toneColor(state.notice.tone)}>
            {`${noticeGlyph(state.notice.tone)} ${state.notice.text}`}
          </Text>
        </Box>
      ) : null}
      <Text color={C.faint}>{"─".repeat(width)}</Text>
      <Box paddingX={1}>
        {/* One truncating Text (not a flex row of chips): overflow clips the
         * tail instead of wrapping a hint onto a second line. */}
        <Text wrap="truncate-end">
          {hints.flatMap((hint, i) => [
            i > 0 ? (
              <Text key={`s${i}`} color={C.faint}>
                {" · "}
              </Text>
            ) : null,
            <Text key={`k${i}`} color={C.accent}>
              {hint.keys}
            </Text>,
            <Text key={`l${i}`} color={C.dim}>
              {` ${hint.label}`}
            </Text>,
          ])}
        </Text>
      </Box>
    </Box>
  );
};

/** Rows the footer strip occupies, for the parent's height maths — rule +
 *  hints in browse, label + editor + hints in a prompt. The editor's budget
 *  counts word-wrapped rows at the terminal's width (same wrap the editor
 *  draws, via `editorRoom`), capped at {@link MAX_EDITOR_ROWS}. A transient
 *  notice adds its own row in browse only (the prompt footer never renders
 *  one); it must be budgeted here so the frame stays exactly `rows` tall
 *  while it's up, or Ink's repaints drift and the top bar slides off the
 *  alt screen. */
export const promptRows = (state: TuiState, cols: number): number => {
  if (state.mode !== "prompt" || !state.prompt) return 2 + (state.notice ? 1 : 0);
  // A reply prompt's input is budgeted on the EVENTS pane (promptPaneRows);
  // the footer carries just its hints row.
  if (state.prompt.sessionId !== null) return 1;
  const editor = Math.min(
    MAX_EDITOR_ROWS,
    layoutWrapped(state.prompt.buffer, editorRoom(cols)).rows.length,
  );
  return 1 /* label */ + editor + 1; /* hints */
};

/** Columns the pane prompt wraps to: the right column minus its padding (2+2)
 *  and the 2-char caret gutter — mirrors `editorRoom` for the pane. */
const paneRoom = (width: number): number => Math.max(8, width - 6);

/** Rows a session-targeted prompt's input group occupies on the EVENTS pane:
 *  the label row plus the word-wrapped editor, capped like the footer editor.
 *  Keep in sync with {@link PromptPane}'s room. */
export const promptPaneRows = (state: TuiState, width: number): number => {
  const p = state.prompt;
  if (!p || p.sessionId === null) return 0;
  const editor = Math.min(MAX_EDITOR_ROWS, layoutWrapped(p.buffer, paneRoom(width)).rows.length);
  return 1 /* label */ + editor;
};

/** The input group for a session-targeted prompt — label + the session's mode
 *  chip, then the editor — drawn under that session's EVENTS log: you're
 *  replying to this agent, so the input sits with its transcript. */
export const PromptPane = ({ state, width }: { state: TuiState; width: number }): ReactNode => {
  const p = state.prompt;
  if (!p || p.sessionId === null) return null;
  const sess = p.kind === "send" ? fleetSessions(state).find((x) => x.id === p.sessionId) : null;
  return (
    <Box flexDirection="column" width={width} paddingX={2}>
      <Box gap={1}>
        <Text color={C.accent} bold wrap="truncate-end">
          {p.label}
        </Text>
        {sess ? modeChip(sess.mode) : null}
      </Box>
      <InputLine buf={p.buffer} room={paneRoom(width)} placeholder={PROMPT_PLACEHOLDER[p.kind]} />
    </Box>
  );
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
  else if (confirm.action === "gc") actionText = "remove the worktrees";
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

/** Chrome around {@link RequestPanel}'s body: the round border (top + bottom),
 *  the title row and the hint row. */
const REQUEST_PANEL_CHROME = 4;
/** Body rows for a non-question request (command / diff / path dump) — the
 *  historic fixed size, kept for those. */
const REQUEST_PANEL_MIN_BODY = 4;
/** Ceiling on the request panel's body. An `AskUserQuestion` grows the panel to
 *  fit the active question's options rather than clipping them, but never past
 *  this — the fleet list would otherwise scroll off screen. `⌥o` shows the
 *  whole call, and ⇥ / ⇧⇥ cycle the other questions into view one at a time. */
const REQUEST_PANEL_MAX_BODY = 14;

/** Height reserved for {@link RequestPanel} in the layout for a non-question
 *  request. Question requests size dynamically — see {@link requestPanelRows}. */
export const REQUEST_PANEL_ROWS = REQUEST_PANEL_CHROME + REQUEST_PANEL_MIN_BODY;

/** One `AskUserQuestion` question as lettered choices — the prompt text, then
 *  `a) label — description` per option, each wrapped to `w`. `active` (0-based,
 *  clamped) picks which question; progress (N/M) lives in the panel title.
 *  Unclamped — callers size the panel to fit (see {@link requestPanelRows}). */
export const askQuestionLines = (
  qs: AskUserQuestionItem[],
  active: number,
  w: number,
): string[] => {
  const q = qs[Math.max(0, Math.min(qs.length - 1, active))];
  if (!q) return [];
  const lines: string[] = [...wrapText(q.question, w)];
  q.options.forEach((opt, oi) => {
    const letter = String.fromCharCode(97 + oi);
    const desc = opt.description ? ` — ${opt.description}` : "";
    lines.push(...wrapText(`  ${letter}) ${opt.label}${desc}`, w));
  });
  return lines;
};

/** `AskUserQuestion` rendered as lettered choices for one question at a time.
 *  Falls back to the generic raw-JSON dump if the call didn't match the
 *  expected shape. */
const describeAskUserQuestion = (input: unknown, w: number, active = 0): string[] => {
  const qs = parseAskUserQuestions(input);
  if (qs.length === 0) return describeRequest(input, w);
  return askQuestionLines(qs, active, w).slice(0, REQUEST_PANEL_MAX_BODY);
};

/** Rows {@link RequestPanel} needs to show `pending` at `width` without
 *  clipping the active question. Non-question requests keep the fixed
 *  {@link REQUEST_PANEL_ROWS}; an `AskUserQuestion` grows to fit question
 *  `questionIdx`'s options, capped at {@link REQUEST_PANEL_MAX_BODY}. */
export const requestPanelRows = (
  request: SessionInteraction | null,
  width: number,
  questionIdx = 0,
): number => {
  if (request?.kind !== "user_question") return REQUEST_PANEL_ROWS;
  const qs = parseAskUserQuestions(request.input);
  if (qs.length === 0) return REQUEST_PANEL_ROWS;
  const body = Math.max(
    REQUEST_PANEL_MIN_BODY,
    Math.min(REQUEST_PANEL_MAX_BODY, askQuestionLines(qs, questionIdx, inside(width)).length),
  );
  return REQUEST_PANEL_CHROME + body;
};

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
  request,
  queued = 1,
  width,
  questionIdx = 0,
}: {
  /** The request being acted on — one of the session's, chosen by the model's
   *  `activeRequest`. Rendered from the interaction itself, so its id, kind and
   *  payload stay together all the way to the screen. */
  request: SessionInteraction | null;
  /** How many requests the session has outstanding in total, this one included
   *  — the panel says so, because answering this one does not clear the rest. */
  queued?: number;
  width: number;
  /** For `AskUserQuestion`: which question to show — the one the answer prompt
   *  is currently collecting. */
  questionIdx?: number;
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
      <Text color={C.faint} wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );

  if (request === null) return null;
  const lines = (text: string, max: number, key = ""): ReactNode[] =>
    wrapText(text.replace(/\s+/g, " ").trim(), w)
      .slice(0, max)
      .map((l, i) => (
        <Text key={`${key}${i}`} color={C.text} wrap="truncate-end">
          {l}
        </Text>
      ));
  // "…and N more" is the whole reason the panel takes a count: answering the
  // one on screen leaves the others outstanding and the turn still blocked.
  const alsoQueued = queued > 1 ? `  ·  ${queued - 1} more queued` : "";

  return foldInteraction<ReactNode>({
    onQuestion: (q) =>
      box(
        "? QUESTION",
        [
          ...lines(q.question, 4),
          q.context ? (
            <Text key="ctx" color={C.faint} wrap="truncate-end">
              {truncate(q.context.replace(/\s+/g, " ").trim(), w)}
            </Text>
          ) : null,
        ],
        `a answer  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`,
      ),
    onPlanReview: (p) =>
      box(
        "❖ PLAN REVIEW",
        lines(p.plan, 5),
        `a review  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`,
      ),
    onUserQuestion: (u) => {
      const qs = parseAskUserQuestions(u.input);
      // Title position marker: which question of this call we're on, plus —
      // when others are queued behind it — where this one sits in the queue.
      const pos = [
        qs.length > 1 ? `${questionIdx + 1}/${qs.length}` : "",
        queued > 1 ? `1 of ${queued}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return box(
        `? QUESTION${pos ? ` (${pos})` : ""}`,
        describeAskUserQuestion(u.input, w, questionIdx).map((l, i) => (
          <Text key={i} color={C.text} wrap="truncate-end">
            {l}
          </Text>
        )),
        `a answer  ·  d deny${
          qs.length > 1 ? "  ·  ←/→ question" : ""
        }  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`,
      );
    },
    onPermission: (p) =>
      box(
        `⇱ PERMISSION — ${p.tool || "tool"}${queued > 1 ? ` (1 of ${queued})` : ""}`,
        describeRequest(p.input, w).map((l, i) => (
          <Text key={i} color={C.text} wrap="truncate-end">
            {l}
          </Text>
        )),
        `a approve  ·  d deny  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`,
      ),
  })(request);
};

// ---------------------------------------------------------------------------
// plan-review overlay (the post-planning decision)
// ---------------------------------------------------------------------------

export const PlanReview = ({
  plan,
  width,
  height,
  scroll,
  ctx,
  impl,
  cur,
  target,
}: {
  plan: { text: string; mode: SessionMode };
  width: number;
  /** Row budget for the whole overlay — the plan body fills whatever the fixed
   *  chrome leaves and scrolls (PgUp/PgDn/wheel) past that. */
  height: number;
  /** First wrapped plan line to show — a top-anchored offset, clamped here. */
  scroll?: number;
  /** The plan's session context meter — the input for the implement-here vs
   *  implement-fresh call (`i` vs `f`). Absent when the limit is unknown. */
  ctx?: { used: number; limit: number };
  /** The `f` (implement fresh) retarget staged by `⌥p`, if any. */
  impl?: { provider: string; model?: string; effort?: string };
  /** The plan's session's current provider / model / effort, to show what a
   *  staged `impl` diverges from. */
  cur?: { provider: string; model?: string | null; effort?: string | null };
  /** Display resolution for whichever of `impl` / `cur` is the effective
   *  implement-fresh target: the provider's fleet tag + its Ink colour. */
  target?: { tag: string; color: string };
}): ReactNode => {
  const w = inside(width);
  const lines = plan.text.split("\n").flatMap((ln) => (ln === "" ? [""] : wrapText(ln, w)));
  // Fixed chrome around the plan body: title + spacer + scroll line + spacer +
  // context meter + mode + implement-fresh + forks + spacer + 4 actions +
  // spacer + hint (15 rows), plus the border and paddingY rows (4).
  const WINDOW = Math.max(3, height - 19);
  const off = Math.min(Math.max(0, scroll ?? 0), Math.max(0, lines.length - WINDOW));
  const body = lines.slice(off, off + WINDOW);
  const overflow = lines.length > WINDOW;
  const frac = ctx && ctx.limit > 0 ? Math.min(1, ctx.used / ctx.limit) : null;

  const shown =
    impl ??
    (cur
      ? { provider: cur.provider, model: cur.model ?? undefined, effort: cur.effort ?? undefined }
      : null);
  const providerForks = impl !== undefined && cur !== undefined && impl.provider !== cur.provider;
  const diverged =
    impl !== undefined &&
    cur !== undefined &&
    (providerForks ||
      (impl.model !== undefined && impl.model !== (cur.model ?? undefined)) ||
      (impl.effort !== undefined && impl.effort !== (cur.effort ?? undefined)));
  const row = (k: string, v: string): ReactNode => (
    <Box gap={1}>
      <Box width={3}>
        <Text color={C.accent}>{k}</Text>
      </Box>
      <Text color={C.dim} wrap="truncate-end">
        {v}
      </Text>
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
      <Text color={C.faint} wrap="truncate-end">
        {overflow
          ? `  ↕ lines ${off + 1}–${off + body.length} of ${lines.length}  ·  PgUp/PgDn`
          : " "}
      </Text>
      <Box height={1} />
      {frac !== null && ctx ? (
        <Text>
          <Text color={contextHeatColor(frac)}>{bar(frac, 16)}</Text>
          <Text color={C.dim}>
            {`  ${Math.round(frac * 100)}% context · ${humanTokens(ctx.used)}/${humanTokens(ctx.limit)}`}
          </Text>
        </Text>
      ) : null}
      <Text wrap="truncate-end">
        {"implementation mode "}
        {modeChip(plan.mode)}
        <Text color={C.faint}>{"  ·  ⇧⇥ cycles"}</Text>
      </Text>
      <Text wrap="truncate-end">
        {"implement fresh → "}
        {shown ? (
          <Text color={target?.color || C.faint}>{target?.tag ?? shown.provider}</Text>
        ) : (
          <Text color={C.faint}>{"the session's current model"}</Text>
        )}
        {shown?.model ? <Text color={C.text}>{` / ${shown.model}`}</Text> : null}
        {shown?.effort ? <Text color={C.warn}>{`  ·  ${shown.effort}`}</Text> : null}
        {diverged ? <Text color={C.faint}>{"  ·  differs from this session"}</Text> : null}
        <Text color={C.faint}>{"  ·  ⌥p retarget"}</Text>
      </Text>
      {providerForks ? (
        <Text color={C.faint}>{"  different provider — implements in a fresh forked session"}</Text>
      ) : null}
      <Box height={1} />
      {row("i", "implement — the agent proceeds in this context")}
      {row("f", "implement fresh — compact to the plan + goal first")}
      {row("e", "edit the plan in $EDITOR, then implement what you saved")}
      {row("d", "discuss — send a note back; the agent stays in plan mode")}
      <Box height={1} />
      <Text color={C.faint} wrap="truncate-end">
        {"⌥o / o view read-only  ·  esc backs out — the review stays pending"}
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
    "run an action without leaving the prompt — ⌥e ⌥o ⌥x; ⌥m / ⌥p switch the model / provider (also from the fleet view)",
  ],
  ["⇧⇥", "cycle the permission mode — on the selection, or inside a prompt (mid-message)"],
  ["Space", "the command palette — everything valid right now, fuzzy, with its key"],
];

const HELP_ROWS: Array<[string, string]> = [
  ["↑ / ↓  ·  j / k", "move the selection"],
  [
    "→ / ←  (fleet)",
    "drill into the session's sub-agents & background tasks — ↑/↓ picks one and EVENTS follows it · back out (esc too)",
  ],
  ["Space", "command palette — search and run any action available here"],
  [
    "a / ⏎  ·  d",
    "approve a request (`a` only) · answer / review it (`⏎` too)  ·  `d` deny (deny-only — never deletes)",
  ],
  [
    "⏎  ·  i",
    "send a message to the selected session (revives a stopped one)  ·  interrupt its turn",
  ],
  ["c  ·  x", "compact the context (any time)  ·  archive the session"],
  [
    "u  ·  ⇧⇥  ·  ⌥m / ⌥p",
    "undo to an earlier turn  ·  cycle the permission mode  ·  switch the model, or the provider + model (applies next turn)",
  ],
  ["e  ·  y", "rename  ·  copy the branch name to the clipboard"],
  ["o  ·  v", "view the log in $EDITOR  ·  event log full / chat"],
  [
    "⇥",
    "toggle the fleet list — hide it to give the session's detail + events the whole width (esc brings it back)",
  ],
  ["t", "cycle theme — dark / light / argonext"],
  [
    "n  ·  /",
    "new session (the prompt shows the provider / model; ⌥p to change)  ·  find a session",
  ],
  [
    "F  ·  X",
    "hard fork — new session + worktree off this one (aisdk)  ·  delete the session (confirm)",
  ],
  ["R  ·  Q", "restart the daemon  ·  quit the UI and stop the daemon  (both confirm)"],
  ["q  ·  ⌃c  ·  esc", "quit the UI, daemon keeps running  ·  quit  ·  back out of any overlay"],
  ["⟢ (fleet)", "prompt cache still warm — green → amber → red as it lapses"],
  ["␣ keep cache warm", "daemon re-primes the cache before its TTL lapses (Claude, pinned TTL)"],
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
    "⇧⇥  ·  ⌥m  ·  ⌥p",
    "cycle the permission mode  ·  switch the model  ·  switch the provider + model — the new session's, or the one you're messaging (aisdk↔aisdk carries the transcript; Claude isn't supported yet)",
  ],
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
      {/* The prompt's input line, pinned to one row, so the filter reads as
          "type here" and takes the same readline motions. */}
      <InputLine buf={picker.filter} room={w - 4} placeholder="type to search" multiline={false} />
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

// ---------------------------------------------------------------------------
// doctor overlay — enabled tools, connector plugins, daemon vitals
// ---------------------------------------------------------------------------

const DocRow = ({ label, children }: { label: string; children: ReactNode }): ReactNode => (
  <Box gap={2}>
    <Box width={13} flexShrink={0}>
      <Text color={C.faint}>{label}</Text>
    </Box>
    <Text color={C.dim}>{children}</Text>
  </Box>
);

const DocHead = ({ children }: { children: ReactNode }): ReactNode => (
  <>
    <Box height={1} />
    <Text color={C.dim} bold>
      {children}
    </Text>
  </>
);

const MCP_MARK: Record<DoctorMcpServer["status"], { glyph: string; color: string }> = {
  ok: { glyph: "✓", color: C.good },
  missing: { glyph: "✗", color: C.bad },
};

export const Doctor = ({
  report,
  width,
}: {
  report: DoctorReport | null;
  width: number;
}): ReactNode => (
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
      {"loom — doctor"}
    </Text>
    {report ? (
      <DoctorBody report={report} />
    ) : (
      <Text color={C.faint}>{"  querying the daemon…"}</Text>
    )}
  </Box>
);

const DoctorBody = ({ report }: { report: DoctorReport }): ReactNode => {
  const d = report.daemon;
  const ws = report.webSearch;

  return (
    <>
      <DocHead>{"daemon"}</DocHead>
      <DocRow label="version">
        {`${d.version}  ·  pid ${d.pid}  ·  up ${humanDuration(d.uptimeMs)}`}
      </DocRow>
      <DocRow label="repo">{d.repoRoot}</DocRow>
      <DocRow label="clients">{`${d.clients}  (${d.connections} connection${d.connections === 1 ? "" : "s"})`}</DocRow>
      <DocRow label="events">{`seq ${d.eventSeq}  ·  ${d.eventBuffer} buffered`}</DocRow>
      <DocRow label="sessions">{`${d.sessions}  ·  ${d.runningSessions} running`}</DocRow>

      <DocHead>{"connectors"}</DocHead>
      {report.connectors.map((c) => (
        <Box key={c.pkg} gap={2}>
          <Box width={13} flexShrink={0}>
            <Text color={c.loaded ? C.good : C.faint}>{c.loaded ? "● loaded" : "○ idle"}</Text>
          </Box>
          <Text color={C.dim}>
            {c.pkg.replace(/^@loom\/connector-/, "")}
            <Text color={C.faint}>{`  ${c.providerIds.join(", ") || "—"}`}</Text>
          </Text>
        </Box>
      ))}

      <DocHead>{"mcp servers"}</DocHead>
      <Text color={C.faint}>{"  mounted into every session"}</Text>
      {report.mcp.map((m) => {
        const mk = MCP_MARK[m.status];
        return (
          <Box key={m.name} flexDirection="column">
            <Box gap={2}>
              <Box width={13} flexShrink={0}>
                <Text color={mk.color}>{`${mk.glyph} ${m.name}`}</Text>
              </Box>
              <Text color={C.dim}>{m.resolved}</Text>
            </Box>
            {m.note ? <Text color={C.faint}>{`               ${m.note}`}</Text> : null}
          </Box>
        );
      })}

      <DocHead>{"tools"}</DocHead>
      <DocRow label="loom">{report.tools.loom.join(", ")}</DocRow>
      <DocRow label="claude">
        {report.tools.claude.join(", ")}
        <Text color={C.faint}>{"  + native"}</Text>
      </DocRow>
      <DocRow label="aisdk">{report.tools.aisdk.join(", ")}</DocRow>
      <DocRow label="disabled">
        {report.tools.claudeDisabled.join(", ")}
        <Text color={C.faint}>{"  (Claude — use fff)"}</Text>
      </DocRow>
      <DocRow label="web_search">
        <Text color={ws.enabled ? C.good : C.faint}>
          {ws.backend === "none" ? "off" : `${ws.backend} · ${ws.enabled ? "enabled" : "disabled"}`}
        </Text>
        {ws.note ? <Text color={C.faint}>{`  ${ws.note}`}</Text> : null}
      </DocRow>

      {report.configWarnings.length > 0 ? (
        <>
          <DocHead>{"config warnings"}</DocHead>
          {report.configWarnings.map((w, i) => (
            <Text key={i} color={C.warn} wrap="wrap">
              {`  ${w}`}
            </Text>
          ))}
        </>
      ) : null}
    </>
  );
};
