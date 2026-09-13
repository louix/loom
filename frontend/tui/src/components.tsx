/**
 * Ink components for the TUI. Written in JSX and run with no bundler — `@oxc-node`
 * transforms `.tsx` on the fly (the `loom`/`loomd` bins and the test runner both
 * load its hook), so the only build step is still "none". Every component is a
 * pure projection of the narrow view its pane is handed — see `views.ts`.
 */
import { memo, type ReactNode } from "react";
import { Box } from "ink";
import { Field, Fields, Hints, Line, Lines, Panel, Section, Text, useTheme } from "./ui.tsx";
export { PaletteContext } from "./ui.tsx";
import { rowLayout, type LayoutRow } from "./layout.ts";
import { helpLines } from "./help.ts";
import { absurd } from "@loom/core/absurd";
import { cacheHitRate } from "@loom/core/cache";
import type { DoctorReport, SessionSnapshot } from "@loom/core/wire";
import type { SessionMode } from "@loom/core/types";
import { foldInteraction, type SessionInteraction } from "@loom/core/interaction";
import { layout, layoutWrapped, type Buffer } from "./editor.ts";
import { diffSegColor } from "./transcript.ts";
import type { ClientState } from "@loom/client";
import { pending, type Outbox, type Outboxes } from "./composer.ts";
import type { ModeChoices } from "./mode-control.ts";
import type { FleetPaneView, HeaderView, LogView } from "./views.ts";
import {
  fleetSessions,
  cacheHeat,
  cacheStatus,
  footerHints,
  providerInfo,
  providerAccountOf,
  providerColorOf,
  queueFor,
  type CacheStatus,
  type Connection,
  type FleetChild,
  type TuiState,
} from "./model.ts";
import { parseAskUserQuestions, type AskUserQuestionItem } from "./interactions.ts";
import { pendingMode } from "./mode-control.ts";
import {
  openPrompt,
  pickerVisible,
  promptKind,
  type Confirm as ConfirmState,
  type Picker as PickerState,
  type Prompt,
  type PromptKind,
} from "./overlay.ts";
import {
  bar,
  humanDuration,
  humanTokens,
  mmss,
  modeChipText,
  modeLabel,
  modeText,
  shortId,
  spinnerFrame,
  statusLook,
  statusTone,
  toneColor,
  truncate,
  inside,
  wrapText,
  type Tone,
  type ThemeColor,
} from "./theme.ts";

/** The ` · …` tail after a status label in the Detail pane. */
const statusDetailSuffix = (s: SessionSnapshot): string => {
  if (s.status.kind === "awaiting_input") return ` · ${s.status.on}`;
  if (s.status.kind === "working_background") {
    const n = (s.backgroundTasks ?? []).length;
    return n > 0 ? ` · ${n} task${n === 1 ? "" : "s"}` : "";
  }
  return "";
};

/** First non-blank line of a (possibly multi-line) session title. */
const titleLine = (t: string | null): string => {
  for (const raw of (t ?? "").split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return "(untitled)";
};

/** Connection lamp — glyph + colour per {@link Connection}, read fresh so it follows the theme. */
const lampFor = (c: Connection) => {
  switch (c) {
    case "live":
      return { tone: "good" as const, text: "● live" };
    case "reconnecting":
      return { tone: "warn" as const, text: "◍ reconnecting" };
    case "closed":
      return { tone: "bad" as const, text: "○ offline" };
    case "connecting":
      return { tone: "dim" as const, text: "◌ connecting" };
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
  questions: 'type your answer — e.g. "a" or "a, but …"',
};

/** Context-meter colour by fill fraction. */
const contextHeatTone = (frac: number) => {
  if (frac > 0.85) return "bad";
  if (frac > 0.6) return "warn";
  return "accentDim";
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

export const Header = memo(({ view, width }: { view: HeaderView; width: number }): ReactNode => {
  const lamp = lampFor(view.connection);
  return (
    <Box width={width} justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        <Line tone="accent" bold>
          {"▍ loom"}
        </Line>
        <Line tone="dim">{`v${view.version}`}</Line>
        <Text tone="faint">{"·"}</Text>
        <Line tone="text">{view.repo}</Line>
      </Box>
      <Box gap={1}>
        <Line tone="dim">{`${view.sessions} sessions`}</Line>
        {view.waiting ? <Text tone="await_">{`◆ ${view.waiting}`}</Text> : null}
        {view.running ? <Text tone="accent">{`● ${view.running}`}</Text> : null}
        {view.background ? <Text tone="accentDim">{`◐ ${view.background}`}</Text> : null}
        <Text tone="faint">{"·"}</Text>
        <Line tone={lamp.tone}>{lamp.text}</Line>
      </Box>
    </Box>
  );
});

// ---------------------------------------------------------------------------
// fleet list (left column)
// ---------------------------------------------------------------------------

export const Fleet = memo(
  ({
    view,
    find,
    tick,
    width,
    now,
  }: {
    view: FleetPaneView;
    /** The `/` filter's buffer, drawn under the title. Separate from `view`
     *  because typing in it is the one keystroke this pane must repaint for. */
    find: Buffer | null;
    tick: number;
    width: number;
    now: number;
  }): ReactNode => {
    const iw = inside(width);
    const childKeyOf = (s: SessionSnapshot): string | null =>
      view.focused && s.id === view.selectedId ? view.focused.key : null;

    let blocks: ReactNode[];
    switch (view.body.t) {
      case "searching":
        // An answer that hasn't come back yet is not an answer of "none".
        blocks = [
          <Line key="empty" tone="dim">
            {"searching every session…"}
          </Line>,
        ];
        break;
      case "noMatch":
        blocks = [
          <Line key="empty" tone="dim">
            {"no sessions match — esc clears the filter"}
          </Line>,
        ];
        break;
      case "none":
        blocks = [
          <Text key="empty" tone="dim">
            {"no sessions yet — press "}
            <Text tone="accent">{"n"}</Text>
            {" to start one"}
          </Text>,
        ];
        break;
      case "rows":
        blocks = view.body.entries.map((entry, i) => {
          switch (entry.kind) {
            case "blank":
              return <Box key={`blank-${i}`} height={1} />;
            case "groupHeader":
              return (
                <Text key={`hdr-${entry.group.status}`} bold>
                  <Text color={statusLook(entry.group.status).color}>
                    {statusLook(entry.group.status).glyph + " "}
                  </Text>
                  <Text tone="dim">{entry.group.label.toUpperCase()}</Text>
                  <Text tone="faint">{`  ${entry.group.sessions.length}`}</Text>
                </Text>
              );
            case "session":
              return FleetRow({
                s: entry.s,
                selected: entry.s.id === view.selectedId,
                focused: childKeyOf(entry.s) != null,
                tick,
                iw,
                now,
                pcolor: view.providerColors,
                compacting: entry.s.compacting !== undefined,
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
                <Text key={`more-${entry.s.id}`} tone="faint">
                  {`  └ +${entry.extra} more`}
                </Text>
              );
          }
        });
        break;
      default:
        return absurd(view.body);
    }

    let title = "FLEET";
    if (view.focused) {
      title = `FLEET · ${shortId(view.selectedId ?? "")} ▸ ${childGlyph(view.focused)} ${truncate(
        view.focused.label.replace(/\s+/g, " ").trim(),
        Math.max(8, iw - 24),
      )}`;
    } else if (view.filterStatus !== null) {
      title = `FLEET · ${view.filterStatus}`;
    }

    return (
      <Panel flexShrink={0} width={width} tone="faint">
        <Line tone="dim">{title}</Line>
        {find ? (
          <Box marginTop={1} flexShrink={0}>
            <InputLine
              buf={find}
              room={Math.max(8, iw - 2)}
              placeholder="type to filter"
              multiline={false}
            />
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {blocks}
          {view.shown < view.total ? (
            <Line tone="faint">
              {`↕ ${view.offset + 1}–${view.offset + view.shown} of ${view.total}`}
            </Line>
          ) : null}
        </Box>
      </Panel>
    );
  },
);

/** Fleet-row cache dot: `⟢` graded green → amber → red by TTL left, blank otherwise. */
const cacheHeatTone = (h: "fresh" | "fading" | "expiring") => {
  switch (h) {
    case "fresh":
      return "good";
    case "fading":
      return "warn";
    case "expiring":
      return "bad";
  }
};

/**
 * Detail-pane cache row lede. A `live` cache has no deadline to count down to
 * — the turn in flight keeps rewriting the prefix — so it says what is
 * happening instead of a number that would only run the wrong way. It keeps
 * the warm colour at the call site: with the figure gone the `⟢` is all that
 * carries the state, and a faint one would read as cold.
 */
const cacheLede = (cs: CacheStatus): string => {
  if (cs.state === "live") return "⟢ warm  ·  writing";
  if (cs.state === "warm") return `⟢ warm ~${mmss(cs.remainingMs)}`;
  return "⟢ cold";
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
  pcolor: ReadonlyMap<string, string>;
  /** A compaction is in flight — show a `⇊` in the cache-dot slot. */
  compacting?: boolean;
}): ReactNode => {
  const C = useTheme();
  const look = statusLook(s.status.kind);
  const blocked = s.resumable === false;
  let glyph = look.glyph;
  if (["running", "starting"].includes(s.status.kind)) glyph = spinnerFrame(tick);
  if (blocked) glyph = "○";
  let titleColor = selected ? C.text : C.dim;
  if (blocked) titleColor = C.faint;
  const id = shortId(s.id);
  const cost =
    s.costSource === "none" || s.costSource === "partial"
      ? "--"
      : `${s.costSource === "provider" ? "" : "~"}$${s.costUsd.toFixed(2)}`;
  const heat = cacheHeat(cacheStatus(s, now));
  // Always 2 cols so titles stay aligned whether or not a session has a warm cache.
  const cacheColor = heat ? C[cacheHeatTone(heat)] : null;
  const idColor = blocked ? C.faint : pcolor.get(s.provider) || C.faint;
  const forked = s.parentId != null && s.forkTurn != null;
  const idText = forked ? `⑂${id}` : id;
  const room = Math.max(6, iw - (2 + 2 + idText.length + 2 + 2 + 2 + cost.length + 1));
  const title = truncate(titleLine(s.title), room).padEnd(room);

  return (
    <Line key={s.id}>
      <Text tone={selected && !focused ? "accent" : "faint"}>{selected ? "▍ " : "  "}</Text>
      <Text tone={s.status.kind === "running" ? "accent" : statusTone(s.status.kind)}>
        {glyph + " "}
      </Text>
      <Text color={idColor}>{`${idText}  `}</Text>
      {compacting ? (
        <Text tone="accent">{"⇊ "}</Text>
      ) : (
        <Text color={cacheColor ?? C.faint}>{cacheColor ? "⟢ " : "  "}</Text>
      )}
      <Text tone="faint">{s.comment ? "✎ " : "  "}</Text>
      <Text color={titleColor} bold={selected && !blocked}>
        {title}
      </Text>
      <Text tone="faint">{` ${cost}`}</Text>
    </Line>
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
    <Line key={rowKey}>
      <Text tone={sel ? "accent" : "faint"}>{sel ? "▍ " : "  "}</Text>
      <Text tone="faint">{isLast ? "└ " : "├ "}</Text>
      <Text tone="accentDim">{spinnerFrame(tick) + " "}</Text>
      <Text tone="faint">{childGlyph(c) + " "}</Text>
      <Text tone={sel ? "text" : "dim"} bold={sel}>
        {truncate(c.label.replace(/\s+/g, " ").trim(), room)}
      </Text>
    </Line>
  );
};

// ---------------------------------------------------------------------------
// detail (right column, top)
// ---------------------------------------------------------------------------

/** Left gutter (chars) for the label ∶ value rows in the Detail pane. */
const DETAIL_GUTTER = 8;

export const detailLayout = (
  s: SessionSnapshot | null,
  {
    width = 80,
    account = "",
    engineColor = "",
    queued = [],
    mode = null,
    compacting = s?.compacting ?? null,
  }: {
    width?: number;
    account?: string;
    engineColor?: string;
    queued?: readonly string[];
    mode?: SessionMode | null;
    compacting?: { startedAt: number; before: number } | null;
  } = {},
) => {
  type Content = (now: number) => ReactNode;
  const rows: LayoutRow<Content, "mode">[] = [];
  const add = (value: ReactNode | Content) =>
    rows.push({ tag: "content", value: typeof value === "function" ? value : () => value });
  const addLine = (children: ReactNode, tone: ThemeColor = "faint") =>
    add(<Line tone={tone}>{children}</Line>);
  const space = () => rows.push({ tag: "space" });
  const w = inside(width);
  const look = s ? statusLook(s.status.kind) : null;
  if (!s) {
    addLine("DETAIL", "dim");
    addLine("select a session with ↑/↓");
  } else {
    add(
      <Box>
        <Line tone="dim">{`DETAIL  ${shortId(s.id)}`}</Line>
        <Box flexGrow={1} justifyContent="flex-end">
          <Line>
            <Text tone="faint">engine </Text>
            <Text tone="faint" {...(engineColor ? { color: engineColor } : {})}>
              {s.provider}
            </Text>
            <Text tone="faint">{s.model ? ` / ${s.model}` : ""}</Text>
          </Line>
        </Box>
      </Box>,
    );
    if (account) addLine(account);
    addLine(truncate(titleLine(s.title), w), "text");
    if (s.parentId && s.forkTurn != null)
      addLine(`⑂ forked from ${shortId(s.parentId)} @ turn ${s.forkTurn}`);
    space();
    const status = `${look!.glyph} ${look!.label}${statusDetailSuffix(s)}`;
    const chip = `mode ${modeChipText(s.mode, mode)}`;
    rows.push({
      tag: "target",
      kind: "mode",
      x: [...status].length + 2,
      width: [...chip].length,
      value: () => (
        <Box gap={2}>
          <Line tone={statusTone(s.status.kind)} bold>
            {status}
          </Line>
          <Line>
            <Text tone="dim">mode </Text>
            <Text tone="warn">{modeChipText(s.mode, mode)}</Text>
          </Line>
          <Line tone="dim">{`${s.turns} turn${s.turns === 1 ? "" : "s"}`}</Line>
        </Box>
      ),
    });
    const frac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
    add(
      <Field label="context">
        <Text tone={contextHeatTone(frac)}>{bar(frac, 16)}</Text>
        <Text tone="dim">{`  ${Math.round(frac * 100)}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`}</Text>
      </Field>,
    );
    if (compacting)
      add((now) => (
        <Field label="">
          <Text tone="accent">{`⇊ compacting… ${Math.max(0, Math.round((now - compacting.startedAt) / 1000))}s`}</Text>
          <Text tone="faint">{`  from ${humanTokens(compacting.before)}`}</Text>
        </Field>
      ));
    if (cacheStatus(s, 0).state !== "unknown")
      add((now) => {
        const cs = cacheStatus(s, now);
        const hit = cs.lastHit
          ? `  ·  ${cs.lastHit === "hit" ? "last turn hit" : "last turn rewrote"}`
          : "";
        return (
          <Field label="cache" tone={cs.state === "cold" ? "faint" : "good"}>
            {`${cacheLede(cs)}${hit}${s.keepWarm ? "  ·  keep-warm" : ""}${cs.source === "config" ? "  ·  ttl assumed" : ""}`}
          </Field>
        );
      });
    const hitRate = cacheHitRate(s.usage);
    add(
      <Field
        label="tokens"
        tone="faint"
        suffix={
          <Line tone={s.costUsd ? "good" : "faint"}>
            {` ${s.costSource === "none" || s.costSource === "partial" ? "--" : `${s.costSource === "provider" ? "" : "~"}$${s.costUsd.toFixed(2)}`}`}
          </Line>
        }
      >
        {`${humanTokens(s.usage.input)} in · ${humanTokens(s.usage.output)} out · ${humanTokens(s.usage.cacheRead)} cr · ${humanTokens(s.usage.cacheWrite)} cw` +
          (hitRate == null ? "" : ` · ${Math.round(hitRate * 100)}% cached`)}
      </Field>,
    );
    // Reserve one row per window so clock ticks cannot change geometry.
    for (const [i, [window, rl]] of Object.entries(s.rateLimits).entries())
      add((now) => (
        <Field label={i === 0 ? "plan" : ""}>
          {(rl.resetsAt ?? (rl.observedAt !== undefined ? rl.observedAt + 300_000 : Infinity)) >
            now && (
            <Text
              tone={
                ({ rejected: "bad", allowed_warning: "warn", allowed: "faint" } as const)[rl.status]
              }
            >
              {`${window} ${rl.utilization != null ? `${Math.round(rl.utilization)}%` : "?%"}${rl.resetsAt != null ? `  ⟳ ${humanDuration(rl.resetsAt - now)}` : ""}`}
            </Text>
          )}
        </Field>
      ));
    space();
    add(
      <Box>
        <Text tone="faint">⌥ </Text>
        <Line tone="dim">{gitLineText(s)}</Line>
      </Box>,
    );
    if (s.git?.lastCommitSubject) addLine(`  “${truncate(s.git.lastCommitSubject, w - 4)}”`);
    if (s.comment)
      add(
        <Field label="comment" tone="accentDim">
          {truncate(s.comment.replace(/\s+/g, " ").trim(), w - DETAIL_GUTTER)}
        </Field>,
      );
    if (queued.length)
      addLine(
        `▸ ${queued.length} queued — “${truncate((queued[0] ?? "").replace(/\s+/g, " ").trim(), w - 16)}”`,
        "accentDim",
      );
    if (s.resumable === false)
      for (const line of wrapText(
        `Read-only: ${s.resumeBlockedReason ?? "Session cannot resume. Fork to continue."}`,
        w,
      ))
        addLine(line, "warn");
    if (s.subagents.length)
      addLine(
        `⑂ ${s.subagents.filter((a) => a.active).length}/${s.subagents.length} sub-agent${s.subagents.length === 1 ? "" : "s"} · ${truncate(s.subagents.map((a) => (a.active ? a.name : `${a.name} ✓`)).join(", "), w - 20)}`,
        "dim",
      );
    if (s.backgroundTasks.length)
      addLine(
        `◐ ${s.backgroundTasks.length} background task${s.backgroundTasks.length === 1 ? "" : "s"} · ${truncate(s.backgroundTasks.map((t) => t.title.replace(/\s+/g, " ").trim()).join(", "), w - 24)}`,
        "accentDim",
      );
  }
  const layout = rowLayout(width, rows, { x: 2, y: 1 });
  return {
    ...layout,
    render: (now: number): ReactNode => (
      <Panel width={width} tone={s ? statusTone(s.status.kind) : "faint"}>
        {layout.rows.map((row, i) => (
          <Box key={i} height={1} flexShrink={0}>
            {row.tag === "space" ? <Text> </Text> : row.value(now)}
          </Box>
        ))}
      </Panel>
    ),
  };
};

export type DetailLayout = ReturnType<typeof detailLayout>;

export const Detail = memo(
  ({
    session,
    fleet,
    box,
    mode,
    width,
    now,
  }: {
    session: SessionSnapshot | null;
    fleet: ClientState;
    box: Outbox;
    mode: SessionMode | null;
    width: number;
    now: number;
  }): ReactNode =>
    detailLayout(session, {
      width,
      queued: pending(box),
      mode,
      account: session ? providerAccountOf({ fleet }, session.provider) : "",
      engineColor: session ? providerColorOf({ fleet }, session.provider) : "",
    }).render(now),
);

// ---------------------------------------------------------------------------
// event log (right column, bottom)
// ---------------------------------------------------------------------------

export const EventLog = memo(
  ({ view, width, spinner }: { view: LogView; width: number; spinner?: ReactNode }): ReactNode => {
    const palette = useTheme();
    const { child, rows } = view;
    // Pane title: the focused child's name while drilled in, else the plain header.
    let title = "EVENTS";
    if (child) {
      title = `EVENTS · ${childGlyph(child)} ${truncate(
        child.label.replace(/\s+/g, " ").trim(),
        Math.max(8, inside(width) - 24),
      )}`;
    }

    return (
      <Panel width={width} tone={view.scrolled ? "accentDim" : "faint"} flexGrow={1}>
        <Box justifyContent="space-between">
          <Line tone="dim">{title}</Line>
          <Text tone="faint">{view.tag + (view.scrolled ? `  ·  ↑${view.above} more` : "")}</Text>
        </Box>
        {rows.length === 0 ? (
          <Text tone="faint">
            {child
              ? `  (no events from this ${child.source === "sub" ? "sub-agent" : "task"})`
              : "  (quiet)"}
          </Text>
        ) : (
          rows.map((r) =>
            r.first ? (
              <Line key={r.key}>
                <Text tone="faint">{r.ts}</Text>
                <Text color={toneColor(r.tone, palette)}>{`${r.glyph} `}</Text>
                <Text color={diffSegColor(r.kind, r.seg, toneColor(r.tone, palette), palette)}>
                  {r.seg}
                </Text>
              </Line>
            ) : (
              <Line key={r.key}>
                <Text>{" ".repeat(r.indent)}</Text>
                <Text color={diffSegColor(r.kind, r.seg, toneColor(r.tone, palette), palette)}>
                  {r.seg}
                </Text>
              </Line>
            ),
          )
        )}
        {view.spinning ? spinner : null}
      </Panel>
    );
  },
);

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
      <Text tone="text">{ln.slice(off, col)}</Text>
      <Text inverse>{ln.slice(col, col + 1) || " "}</Text>
      <Text tone="text">{ln.slice(col + 1, off + room)}</Text>
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
        <Text tone="accent">{"▍ "}</Text>
        <Text inverse> </Text>
        {placeholder ? (
          <Text tone="faint" wrap="hard">
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
        <Text tone="accent">{"▍ "}</Text>
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
            <Text tone="text" wrap="hard">
              {ln.length ? ln : " "}
            </Text>
          );
        return (
          <Box key={r}>
            <Text tone="accent">{gutter}</Text>
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

const MODE_HINT: Record<PromptKind, string> = {
  new: "start",
  send: "send",
  answer: "answer",
  questions: "answer",
  deny: "deny",
  title: "rename",
  comment: "save",
  discuss: "send",
  compact: "compact",
};

/** The `[mode]` chip: gold once it's off the mundane `manual` default (or once
 *  a change is pending), faint otherwise — the same chip the Detail pane shows
 *  for a live session. */
const modeChip = (mode: string | null | undefined, pending?: SessionMode | null): ReactNode => {
  const settled = !pending || pending === mode;
  return (
    <Line tone={!settled || (mode && mode !== "default") ? "warn" : "faint"}>
      {modeChipText(mode, pending)}
    </Line>
  );
};

const promptHints = (
  p: Prompt,
  queued: number,
  sessionMode?: string | null,
  pendingMode?: SessionMode | null,
): string => {
  if (p.feedback?.uncertain) return "esc close and review session — draft saved";
  if (p.feedback?.pending) return "Starting / sending… · esc hide (operation continues)";
  const bits = [`enter ${MODE_HINT[promptKind(p)]}`, "⌥⏎ newline", "⌥e editor"];
  // a new-session prompt has no session / log yet; an AskUserQuestion answer
  // opens the formatted question sheet rather than the event log
  if (p.t === "questions") bits.push("⌥o view");
  else if (p.t !== "new") bits.push("⌥o log");
  if (p.t === "new") {
    // ⇧⇥ cycles the mode the session starts in; ⌥m / ⌥p pick its model.
    bits.push(`⇧⇥ mode:${modeLabel(p.settings.mode)}`, "⌥p provider/model", "↑↓ history");
  } else if (p.t === "session" && p.kind === "send") {
    // ⇧⇥ re-modes the live session, ⌥m swaps its model, ⌥p its provider — all
    // without leaving the half-typed message.
    bits.push(
      `⇧⇥ mode:${modeText(sessionMode, pendingMode)}`,
      "⌥m model",
      "⌥p provider",
      "↑↓ history",
    );
    if (queued > 0) bits.push(`⌥x clear ${queued} queued`);
  }
  // Esc on an AskUserQuestion answer drops back to the request panel (where
  // ← / → move between questions), keeping what's been answered — it doesn't
  // abandon the whole call the way cancelling any other prompt does.
  bits.push(p.t === "questions" ? "esc back" : "esc cancel");
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

const feedbackLines = (p: Prompt, width: number): string[] => {
  if (!p.feedback) return [];
  const room = Math.max(8, width);
  const lines = wrapText(p.feedback.text, room);
  // Provider diagnostics can be very long. Keep the editor inside the frame.
  if (lines.length > 4) return [...lines.slice(0, 3), truncate("… more in daemon log", room)];
  return lines;
};
const PromptFeedback = ({ p, width }: { p: Prompt; width: number }): ReactNode => (
  <>
    {feedbackLines(p, width).map((line, i) => (
      <Text key={i} tone={p.feedback?.pending ? "accent" : "bad"}>
        {line}
      </Text>
    ))}
  </>
);

export const FooterArea = ({
  state,
  width,
  outbox = {},
  modes = {},
}: {
  state: TuiState;
  width: number;
  modes?: ModeChoices;
  outbox?: Outboxes;
}): ReactNode => {
  const palette = useTheme();
  const p = openPrompt(state.overlay);
  if (p && p.t !== "new") {
    // A reply to a session — the input lives on that session's EVENTS pane
    // (`PromptPane`, under the log); the footer keeps only the hints row.
    const send = p.t === "session" && p.kind === "send";
    const sess = send ? fleetSessions(state).find((x) => x.id === p.sessionId) : undefined;
    return (
      <Box width={width} paddingX={1}>
        <Line tone="faint">
          {promptHints(
            p,
            send ? queueFor({ ...state, outbox }, p.sessionId).length : 0,
            sess?.mode,
            pendingMode(modes, sess?.id),
          )}
        </Line>
      </Box>
    );
  }
  if (p) {
    // `new` is the one prompt with no session to sit beside, so it draws its
    // whole input group — label, provider/model chips, editor, hints — here.
    const prov = providerInfo(state, p.settings.provider ?? "");
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Box gap={1}>
          <Line tone="accent" bold>
            {p.label}
          </Line>
          {modeChip(p.settings.mode)}
          <Line tone="faint" {...(prov?.color ? { color: prov.color } : {})}>
            {`${prov?.tag ?? p.settings.provider ?? "?"} / ${
              p.settings.model || prov?.defaultModel || "auto"
            }`}
          </Line>
          <Text tone="faint">{"⌥p change"}</Text>
        </Box>
        <InputLine buf={p.buffer} room={editorRoom(width)} placeholder={PROMPT_PLACEHOLDER.new} />
        <PromptFeedback p={p} width={width - 2} />
        {/* Truncate, never wrap — this row is budgeted as exactly one line
            (see promptRows); wrapping it grows the frame past the terminal. */}
        <Line tone="faint">{promptHints(p, 0, null)}</Line>
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
          <Line color={toneColor(state.notice.tone, palette)}>
            {`${noticeGlyph(state.notice.tone)} ${state.notice.text}`}
          </Line>
        </Box>
      ) : null}
      <Text tone="faint">{"─".repeat(width)}</Text>
      <Box paddingX={1}>
        <Hints items={hints} />
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
  const p = openPrompt(state.overlay);
  if (!p) return 2 + (state.notice ? 1 : 0);
  // A reply prompt's input is budgeted on the EVENTS pane (promptPaneRows);
  // the footer carries just its hints row.
  if (p.t !== "new") return 1;
  const editor = Math.min(MAX_EDITOR_ROWS, layoutWrapped(p.buffer, editorRoom(cols)).rows.length);
  return 1 /* label */ + editor + 1 + feedbackLines(p, cols - 2).length; /* hints + feedback */
};

/** Columns the pane prompt wraps to: the right column minus its padding (2+2)
 *  and the 2-char caret gutter — mirrors `editorRoom` for the pane. */
const paneRoom = (width: number): number => Math.max(8, width - 6);

/** Rows a session-targeted prompt's input group occupies on the EVENTS pane:
 *  the label row plus the word-wrapped editor, capped like the footer editor.
 *  Keep in sync with {@link PromptPane}'s room. */
export const promptPaneRows = (state: TuiState, width: number): number => {
  const p = openPrompt(state.overlay);
  if (!p || p.t === "new") return 0;
  const editor = Math.min(MAX_EDITOR_ROWS, layoutWrapped(p.buffer, paneRoom(width)).rows.length);
  return 1 /* label */ + editor + feedbackLines(p, width - 4).length;
};

/** The input group for a session-targeted prompt — label + the session's mode
 *  chip, then the editor — drawn under that session's EVENTS log: you're
 *  replying to this agent, so the input sits with its transcript. */
export const PromptPane = ({
  state,
  width,
  modes = {},
}: {
  state: TuiState;
  width: number;
  modes?: ModeChoices;
}): ReactNode => {
  const p = openPrompt(state.overlay);
  if (!p || p.t === "new") return null;
  const sess =
    p.t === "session" && p.kind === "send"
      ? fleetSessions(state).find((x) => x.id === p.sessionId)
      : undefined;
  return (
    <Box flexDirection="column" width={width} paddingX={2}>
      <Box gap={1}>
        <Line tone="accent" bold>
          {p.label}
        </Line>
        {sess ? modeChip(sess.mode, pendingMode(modes, sess.id)) : null}
      </Box>
      <InputLine
        buf={p.buffer}
        room={paneRoom(width)}
        placeholder={PROMPT_PLACEHOLDER[promptKind(p)]}
      />
      <PromptFeedback p={p} width={width - 4} />
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
  let actionText = "quit and stop the daemon";
  if (confirm.action === "restart") actionText = "restart the daemon";
  else if (confirm.action === "gc") actionText = "remove the worktrees";
  else if (confirm.action === "deleteSession")
    actionText = confirm.deleteBranch ? "delete the session + branch" : "delete the session";
  return (
    <Panel width={width} tone={confirm.danger ? "bad" : "accent"} overlay title={confirm.title}>
      {confirm.body ? <Text tone="warn">{confirm.body}</Text> : null}
      {confirm.action === "deleteSession" && confirm.branchName ? (
        <Box gap={1} marginTop={1}>
          <Text tone="accent">{"b"}</Text>
          <Text tone={confirm.deleteBranch ? "bad" : "dim"}>
            {confirm.deleteBranch
              ? `will also delete branch ${confirm.branchName}`
              : `keep branch ${confirm.branchName}`}
          </Text>
        </Box>
      ) : null}
      <Box height={1} />
      <Hints
        gap={2}
        items={[
          { keys: "enter", label: actionText },
          { keys: "esc", label: "cancel" },
        ]}
      />
    </Panel>
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
  if (request === null) return null;
  const capacity = requestPanelRows(request, width, questionIdx) - REQUEST_PANEL_CHROME;
  const box = (title: string, body: string[], hint: string, context?: string): ReactNode => (
    <Panel width={width} tone="await_" title={title}>
      <Lines lines={body.slice(0, capacity)} tone="text" />
      {context && body.length < capacity && <Line tone="faint">{context}</Line>}
      <Line tone="faint">{hint}</Line>
    </Panel>
  );
  const lines = (text: string, max: number): string[] =>
    wrapText(text.replace(/\s+/g, " ").trim(), w).slice(0, max);
  // "…and N more" is the whole reason the panel takes a count: answering the
  // one on screen leaves the others outstanding and the turn still blocked.
  const alsoQueued = queued > 1 ? `  ·  ${queued - 1} more queued` : "";

  return foldInteraction<ReactNode>({
    onQuestion: (q) =>
      box(
        "? QUESTION",
        lines(q.question, 4),
        `a answer  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`,
        q.context ? truncate(q.context.replace(/\s+/g, " ").trim(), w) : undefined,
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
        describeAskUserQuestion(u.input, w, questionIdx),
        `a answer  ·  d deny${
          qs.length > 1 ? "  ·  ←/→ question" : ""
        }  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`,
      );
    },
    onPermission: (p) =>
      box(
        `⇱ PERMISSION — ${p.tool || "tool"}${queued > 1 ? ` (1 of ${queued})` : ""}`,
        describeRequest(p.input, w),
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
  return (
    <Panel width={width} tone="await_" overlay title={"❖ PLAN REVIEW"}>
      <Box height={1} />
      <Lines lines={body} tone="text" />
      <Line tone="faint">
        {overflow
          ? `  ↕ lines ${off + 1}–${off + body.length} of ${lines.length}  ·  PgUp/PgDn`
          : " "}
      </Line>
      <Box height={1} />
      {frac !== null && ctx ? (
        <Text>
          <Text tone={contextHeatTone(frac)}>{bar(frac, 16)}</Text>
          <Text tone="dim">
            {`  ${Math.round(frac * 100)}% context · ${humanTokens(ctx.used)}/${humanTokens(ctx.limit)}`}
          </Text>
        </Text>
      ) : null}
      <Line>
        {"implementation mode "}
        {modeChip(plan.mode)}
        <Text tone="faint">{"  ·  ⇧⇥ cycles"}</Text>
      </Line>
      <Line>
        {"implement fresh → "}
        {shown ? (
          <Text tone="faint" {...(target?.color ? { color: target.color } : {})}>
            {target?.tag ?? shown.provider}
          </Text>
        ) : (
          <Text tone="faint">{"the session's current model"}</Text>
        )}
        {shown?.model ? <Text tone="text">{` / ${shown.model}`}</Text> : null}
        {shown?.effort ? <Text tone="warn">{`  ·  ${shown.effort}`}</Text> : null}
        {diverged ? <Text tone="faint">{"  ·  differs from this session"}</Text> : null}
        <Text tone="faint">{"  ·  ⌥p retarget"}</Text>
      </Line>
      {providerForks ? (
        <Text tone="faint">{"  different provider — implements in a fresh forked session"}</Text>
      ) : null}
      <Box height={1} />
      <Fields
        width={4}
        labelTone="accent"
        wrap="truncate-end"
        rows={[
          ["i", "implement — the agent proceeds in this context"],
          ["f", "implement fresh — compact to the plan + goal first"],
          ["e", "edit the plan in $EDITOR, then implement what you saved"],
          ["d", "discuss — send a note back; the agent stays in plan mode"],
        ]}
      />
      <Box height={1} />
      <Line tone="faint">
        {"⌥o / o view read-only  ·  esc backs out — the review stays pending"}
      </Line>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// help overlay
// ---------------------------------------------------------------------------

/** The grammar in one screen — the five rules, then the keys they generate. */
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
    <Panel width={width} tone="accent" overlay title={`▸ ${picker.title.toUpperCase()}`}>
      {/* The prompt's input line, pinned to one row, so the filter reads as
          "type here" and takes the same readline motions. */}
      <InputLine buf={picker.filter} room={w - 4} placeholder="type to search" multiline={false} />
      <Text tone="faint">
        {picker.items.length === 0
          ? " "
          : `${vis.length}/${picker.items.length} match${vis.length === 1 ? "" : "es"}`}
      </Text>
      <Box height={1} />
      {shown.length === 0
        ? [
            <Text key="none" tone="faint" wrap="wrap">
              {picker.items.length === 0 ? (picker.emptyText ?? "nothing to pick") : "no matches"}
            </Text>,
          ]
        : shown.map((it, i) => {
            const on = start + i === picker.index;
            return (
              <Line key={it.id} tone={on ? "text" : "dim"} bold={on}>
                <Text tone={on ? "accent" : "faint"}>{on ? "▍ " : "  "}</Text>
                {truncate(it.label, Math.max(6, w - 32))}
                {it.hint ? <Text tone="faint">{`  ${truncate(it.hint, 28)}`}</Text> : null}
              </Line>
            );
          })}
      {start + shown.length < vis.length || start > 0 ? (
        <Text tone="faint">{`  … ${vis.length - shown.length} more`}</Text>
      ) : null}
      <Box height={1} />
      <Text tone="faint">
        {picker.items.length === 0
          ? "enter continue · esc cancel"
          : "type to filter · ↑↓ move · enter pick · esc cancel"}
      </Text>
    </Panel>
  );
};

export const Help = ({
  width,
  height,
  scroll,
}: {
  width: number;
  height: number;
  scroll: number;
}): ReactNode => {
  const capacity = Math.max(0, height - 1);
  const lines = helpLines(width);
  const start = Math.min(scroll, Math.max(0, lines.length - capacity));
  return (
    <Box width={width} height={height} flexDirection="column">
      <Lines lines={lines.slice(start, start + capacity)} tone="dim" />
      <Line tone="accent">↑↓ PgUp/PgDn scroll · Esc close</Line>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// doctor overlay — enabled tools, connector plugins, daemon vitals
// ---------------------------------------------------------------------------

export const Doctor = ({
  report,
  width,
}: {
  report: DoctorReport | null;
  width: number;
}): ReactNode => (
  <Panel width={width} tone="accent" overlay title="loom — doctor">
    {report ? <DoctorBody report={report} /> : <Line tone="faint">{"  querying the daemon…"}</Line>}
  </Panel>
);

const DoctorBody = ({ report }: { report: DoctorReport }): ReactNode => {
  const d = report.daemon;
  const ws = report.webSearch;
  return (
    <>
      <Section title="daemon">
        <Fields
          rows={[
            ["version", `${d.version}  ·  pid ${d.pid}  ·  up ${humanDuration(d.uptimeMs)}`],
            ["repo", d.repoRoot],
            [
              "clients",
              `${d.clients}  (${d.connections} connection${d.connections === 1 ? "" : "s"})`,
            ],
            ["events", d.eventSeq],
            ["sessions", `${d.sessions}  ·  ${d.runningSessions} running`],
          ]}
        />
      </Section>
      <Section title="connectors">
        <Fields
          rows={report.connectors.map((c) => [
            <Text tone={c.loaded ? "good" : "faint"}>{c.loaded ? "● loaded" : "○ idle"}</Text>,
            <>
              {c.pkg.replace(/^@loom\/connector-/, "")}
              <Text tone="faint">{`  ${c.providerIds.join(", ") || "—"}`}</Text>
            </>,
          ])}
        />
      </Section>
      <Section title="mcp servers">
        <Line tone="faint">{"  mounted into every session"}</Line>
        <Fields
          rows={report.mcp.flatMap((m) => [
            [
              <Text
                tone={m.status === "ok" ? "good" : "bad"}
              >{`${m.status === "ok" ? "✓" : "✗"} ${m.name}`}</Text>,
              m.resolved,
            ] as const,
            ["", m.note ? <Text tone="faint">{m.note}</Text> : null] as const,
          ])}
        />
      </Section>
      <Section title="tools">
        <Fields
          rows={[
            ["loom", report.tools.loom.join(", ")],
            [
              "claude",
              <>
                {report.tools.claude.join(", ")}
                <Line tone="faint">{"  + native"}</Line>
              </>,
            ],
            ["aisdk", report.tools.aisdk.join(", ")],
            [
              "disabled",
              <>
                {report.tools.claudeDisabled.join(", ")}
                <Line tone="faint">{"  (Claude — use fff)"}</Line>
              </>,
            ],
            [
              "web_search",
              <>
                <Line tone={ws.enabled ? "good" : "faint"}>
                  {ws.backend === "none"
                    ? "off"
                    : `${ws.backend} · ${ws.enabled ? "enabled" : "disabled"}`}
                </Line>
                {ws.note && <Line tone="faint">{`  ${ws.note}`}</Line>}
              </>,
            ],
          ]}
        />
      </Section>
      {report.configWarnings.length > 0 && (
        <Section title="config warnings">
          <Lines lines={report.configWarnings.map((w) => `  ${w}`)} tone="warn" wrap="wrap" />
        </Section>
      )}
    </>
  );
};
