/**
 * Ink components for the TUI. Written in JSX and run with no bundler — `@oxc-node`
 * transforms `.tsx` on the fly (the `loom`/`loomd` bins and the test runner both
 * load its hook), so the only build step is still "none". Every component is a
 * pure projection of the narrow view its pane is handed — see `views.ts`.
 */
import { createContext, useContext, memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { rowLayout, type LayoutRow } from "./layout.ts";
import { helpLines } from "./help.ts";
import { absurd } from "@loom/core/absurd";
import { cacheHitRate } from "@loom/core/cache";
import type { DoctorMcpServer, DoctorReport, SessionSnapshot } from "@loom/core/wire";
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
  C,
  humanDuration,
  humanTokens,
  mmss,
  modeChipText,
  modeLabel,
  modeText,
  shortId,
  spinnerFrame,
  statusLook,
  toneColor,
  truncate,
  inside,
  wrapText,
  type Tone,
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
  questions: 'type your answer — e.g. "a" or "a, but …"',
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

export const PaletteContext = createContext(C);

export const Header = memo(({ view, width }: { view: HeaderView; width: number }): ReactNode => {
  const C = useContext(PaletteContext);
  const lamp = lampFor(view.connection);
  return (
    <Box width={width} justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        <Text color={C.accent} bold wrap="truncate-end">
          {"▍ loom"}
        </Text>
        <Text color={C.dim} wrap="truncate-end">
          {`v${view.version}`}
        </Text>
        <Text color={C.faint}>{"·"}</Text>
        <Text color={C.text} wrap="truncate-end">
          {view.repo}
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={C.dim} wrap="truncate-end">
          {`${view.sessions} sessions`}
        </Text>
        {view.waiting ? <Text color={C.await_}>{`◆ ${view.waiting}`}</Text> : null}
        {view.running ? <Text color={C.accent}>{`● ${view.running}`}</Text> : null}
        {view.background ? <Text color={C.accentDim}>{`◐ ${view.background}`}</Text> : null}
        <Text color={C.faint}>{"·"}</Text>
        <Text color={lamp.color} wrap="truncate-end">
          {lamp.text}
        </Text>
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
    const C = useContext(PaletteContext);
    const iw = inside(width);
    const childKeyOf = (s: SessionSnapshot): string | null =>
      view.focused && s.id === view.selectedId ? view.focused.key : null;

    let blocks: ReactNode[];
    switch (view.body.t) {
      case "searching":
        // An answer that hasn't come back yet is not an answer of "none".
        blocks = [
          <Text key="empty" color={C.dim} wrap="truncate-end">
            {"searching every session…"}
          </Text>,
        ];
        break;
      case "noMatch":
        blocks = [
          <Text key="empty" color={C.dim} wrap="truncate-end">
            {"no sessions match — esc clears the filter"}
          </Text>,
        ];
        break;
      case "none":
        blocks = [
          <Text key="empty" color={C.dim}>
            {"no sessions yet — press "}
            <Text color={C.accent}>{"n"}</Text>
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
                  <Text color={C.dim}>{entry.group.label.toUpperCase()}</Text>
                  <Text color={C.faint}>{`  ${entry.group.sessions.length}`}</Text>
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
                <Text key={`more-${entry.s.id}`} color={C.faint}>
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
            <Text color={C.faint} wrap="truncate-end">
              {`↕ ${view.offset + 1}–${view.offset + view.shown} of ${view.total}`}
            </Text>
          ) : null}
        </Box>
      </Box>
    );
  },
);

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
  const cacheColor = heat ? cacheHeatColor(heat) : null;
  const idColor = blocked ? C.faint : pcolor.get(s.provider) || C.faint;
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
      <Text color={titleColor} bold={selected && !blocked}>
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
  const space = () => rows.push({ tag: "space" });
  const w = inside(width);
  const look = s ? statusLook(s.status.kind) : null;
  if (!s) {
    add(<Text color={C.dim}>DETAIL</Text>);
    add(<Text color={C.faint}>select a session with ↑/↓</Text>);
  } else {
    add(
      <Box>
        <Text color={C.dim} wrap="truncate-end">{`DETAIL  ${shortId(s.id)}`}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text wrap="truncate-end">
            <Text color={C.faint}>engine </Text>
            <Text color={engineColor || C.faint}>{s.provider}</Text>
            <Text color={C.faint}>{s.model ? ` / ${s.model}` : ""}</Text>
          </Text>
        </Box>
      </Box>,
    );
    if (account)
      add(
        <Text color={C.faint} wrap="truncate-end">
          {account}
        </Text>,
      );
    add(
      <Text color={C.text} wrap="truncate-end">
        {truncate(titleLine(s.title), w)}
      </Text>,
    );
    if (s.parentId && s.forkTurn != null)
      add(
        <Text
          color={C.faint}
          wrap="truncate-end"
        >{`⑂ forked from ${shortId(s.parentId)} @ turn ${s.forkTurn}`}</Text>,
      );
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
          <Text color={look!.color} bold wrap="truncate-end">
            {status}
          </Text>
          <Text wrap="truncate-end">
            <Text color={C.dim}>mode </Text>
            <Text color={C.warn}>{modeChipText(s.mode, mode)}</Text>
          </Text>
          <Text
            color={C.dim}
            wrap="truncate-end"
          >{`${s.turns} turn${s.turns === 1 ? "" : "s"}`}</Text>
        </Box>
      ),
    });
    const frac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
    add(
      <Field label="context">
        <Text wrap="truncate-end">
          <Text color={contextHeatColor(frac)}>{bar(frac, 16)}</Text>
          <Text
            color={C.dim}
          >{`  ${Math.round(frac * 100)}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`}</Text>
        </Text>
      </Field>,
    );
    if (compacting)
      add((now) => (
        <Field label="">
          <Text wrap="truncate-end">
            <Text
              color={C.accent}
            >{`⇊ compacting… ${Math.max(0, Math.round((now - compacting.startedAt) / 1000))}s`}</Text>
            <Text color={C.faint}>{`  from ${humanTokens(compacting.before)}`}</Text>
          </Text>
        </Field>
      ));
    if (cacheStatus(s, 0).state !== "unknown")
      add((now) => {
        const cs = cacheStatus(s, now);
        const hit = cs.lastHit
          ? `  ·  ${cs.lastHit === "hit" ? "last turn hit" : "last turn rewrote"}`
          : "";
        return (
          <Field label="cache">
            <Text color={cs.state === "cold" ? C.faint : C.good} wrap="truncate-end">
              {`${cacheLede(cs)}${hit}${s.keepWarm ? "  ·  keep-warm" : ""}${cs.source === "config" ? "  ·  ttl assumed" : ""}`}
            </Text>
          </Field>
        );
      });
    const hitRate = cacheHitRate(s.usage);
    add(
      <Box>
        <Text color={C.dim}>{"tokens".padEnd(DETAIL_GUTTER)}</Text>
        <Box flexGrow={1}>
          <Text color={C.faint} wrap="truncate-end">
            {`${humanTokens(s.usage.input)} in · ${humanTokens(s.usage.output)} out · ${humanTokens(s.usage.cacheRead)} cr · ${humanTokens(s.usage.cacheWrite)} cw` +
              (hitRate == null ? "" : ` · ${Math.round(hitRate * 100)}% cached`)}
          </Text>
        </Box>
        <Text color={s.costUsd ? C.good : C.faint} wrap="truncate-end">
          {` ${s.costSource === "none" || s.costSource === "partial" ? "--" : `${s.costSource === "provider" ? "" : "~"}$${s.costUsd.toFixed(2)}`}`}
        </Text>
      </Box>,
    );
    // Reserve one row while limits are in the snapshot, so clock ticks cannot change geometry.
    if (Object.keys(s.rateLimits).length)
      add((now) => (
        <Field label="plan">
          <Text wrap="truncate-end">
            {Object.entries(s.rateLimits)
              .filter(
                ([, r]) =>
                  (r.resetsAt ?? (r.observedAt !== undefined ? r.observedAt + 300_000 : Infinity)) >
                  now,
              )
              .map(([window, rl], i) => (
                <Text
                  key={window}
                  color={{ rejected: C.bad, allowed_warning: C.warn, allowed: C.faint }[rl.status]}
                >
                  {`${i ? "   " : ""}${window} ${rl.utilization != null ? `${Math.round(rl.utilization)}%` : "?%"}${rl.resetsAt != null ? `  ⟳ ${humanDuration(rl.resetsAt - now)}` : ""}`}
                </Text>
              ))}
          </Text>
        </Field>
      ));
    space();
    add(
      <Box>
        <Text color={C.faint}>⌥ </Text>
        <Text color={C.dim} wrap="truncate-end">
          {gitLineText(s)}
        </Text>
      </Box>,
    );
    if (s.git?.lastCommitSubject)
      add(
        <Text
          color={C.faint}
          wrap="truncate-end"
        >{`  “${truncate(s.git.lastCommitSubject, w - 4)}”`}</Text>,
      );
    if (s.comment)
      add(
        <Field label="comment">
          <Text color={C.accentDim} wrap="truncate-end">
            {truncate(s.comment.replace(/\s+/g, " ").trim(), w - DETAIL_GUTTER)}
          </Text>
        </Field>,
      );
    if (queued.length)
      add(
        <Text color={C.accentDim} wrap="truncate-end">
          {`▸ ${queued.length} queued — “${truncate((queued[0] ?? "").replace(/\s+/g, " ").trim(), w - 16)}”`}
        </Text>,
      );
    if (s.resumable === false)
      for (const line of wrapText(
        `Read-only: ${s.resumeBlockedReason ?? "Session cannot resume. Fork to continue."}`,
        w,
      ))
        add(<Text color={C.warn}>{line}</Text>);
    if (s.subagents.length)
      add(
        <Text color={C.dim} wrap="truncate-end">
          {`⑂ ${s.subagents.filter((a) => a.active).length}/${s.subagents.length} sub-agent${s.subagents.length === 1 ? "" : "s"} · ${truncate(s.subagents.map((a) => (a.active ? a.name : `${a.name} ✓`)).join(", "), w - 20)}`}
        </Text>,
      );
    if (s.backgroundTasks.length)
      add(
        <Text color={C.accentDim} wrap="truncate-end">
          {`◐ ${s.backgroundTasks.length} background task${s.backgroundTasks.length === 1 ? "" : "s"} · ${truncate(s.backgroundTasks.map((t) => t.title.replace(/\s+/g, " ").trim()).join(", "), w - 24)}`}
        </Text>,
      );
  }
  const layout = rowLayout(width, rows, { x: 2, y: 1 });
  return {
    ...layout,
    render: (now: number): ReactNode => (
      <Box
        width={width}
        borderStyle="round"
        borderColor={look?.color ?? C.faint}
        borderBackgroundColor={C.bg}
        paddingX={1}
        flexDirection="column"
      >
        {layout.rows.map((row, i) => (
          <Box key={i} height={1} flexShrink={0}>
            {row.tag === "space" ? <Text> </Text> : row.value(now)}
          </Box>
        ))}
      </Box>
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
    const C = useContext(PaletteContext);
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
      <Box
        width={width}
        borderStyle="round"
        borderColor={view.scrolled ? C.accentDim : C.faint}
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
            {view.tag + (view.scrolled ? `  ·  ↑${view.above} more` : "")}
          </Text>
        </Box>
        {rows.length === 0 ? (
          <Text color={C.faint}>
            {child
              ? `  (no events from this ${child.source === "sub" ? "sub-agent" : "task"})`
              : "  (quiet)"}
          </Text>
        ) : (
          rows.map((r) =>
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
        {view.spinning ? spinner : null}
      </Box>
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
    <Text wrap="truncate-end" color={!settled || (mode && mode !== "default") ? C.warn : C.faint}>
      {modeChipText(mode, pending)}
    </Text>
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
      <Text key={i} color={p.feedback?.pending ? C.accent : C.bad}>
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
  const p = openPrompt(state.overlay);
  if (p && p.t !== "new") {
    // A reply to a session — the input lives on that session's EVENTS pane
    // (`PromptPane`, under the log); the footer keeps only the hints row.
    const send = p.t === "session" && p.kind === "send";
    const sess = send ? fleetSessions(state).find((x) => x.id === p.sessionId) : undefined;
    return (
      <Box width={width} paddingX={1}>
        <Text color={C.faint} wrap="truncate-end">
          {promptHints(
            p,
            send ? queueFor({ ...state, outbox }, p.sessionId).length : 0,
            sess?.mode,
            pendingMode(modes, sess?.id),
          )}
        </Text>
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
          <Text color={C.accent} bold wrap="truncate-end">
            {p.label}
          </Text>
          {modeChip(p.settings.mode)}
          <Text color={prov?.color || C.faint} wrap="truncate-end">
            {`${prov?.tag ?? p.settings.provider ?? "?"} / ${
              p.settings.model || prov?.defaultModel || "auto"
            }`}
          </Text>
          <Text color={C.faint}>{"⌥p change"}</Text>
        </Box>
        <InputLine buf={p.buffer} room={editorRoom(width)} placeholder={PROMPT_PLACEHOLDER.new} />
        <PromptFeedback p={p} width={width - 2} />
        {/* Truncate, never wrap — this row is budgeted as exactly one line
            (see promptRows); wrapping it grows the frame past the terminal. */}
        <Text color={C.faint} wrap="truncate-end">
          {promptHints(p, 0, null)}
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
        <Text color={C.accent} bold wrap="truncate-end">
          {p.label}
        </Text>
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
      <Text color={C.await_} bold wrap="truncate-end">
        {title}
      </Text>
      {body.slice(0, requestPanelRows(request, width, questionIdx) - REQUEST_PANEL_CHROME)}
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
      <Text color={C.dim} wrap="truncate-end">
        {lines.slice(start, start + capacity).join("\n")}
      </Text>
      <Text color={C.accent} wrap="truncate-end">
        ↑↓ PgUp/PgDn scroll · Esc close
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
      <DocRow label="events">{d.eventSeq}</DocRow>
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
