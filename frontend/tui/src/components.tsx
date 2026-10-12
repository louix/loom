import { SessionTabs } from "./session-tabs.tsx";
import type { SessionTab } from "../../../core/src/session-inspection.ts";
/**
 * Ink components for the TUI. Written in JSX and run with no bundler — `@oxc-node`
 * transforms `.tsx` on the fly (the `loom`/`loomd` bins and the test runner both
 * load its hook), so the only build step is still "none". Every component is a
 * pure projection of the narrow view its pane is handed — see `views.ts`.
 */
import { memo, useMemo, type ReactNode } from "react";
import stringWidth from "string-width";
import { Box } from "ink";
import {
  FloatingLayer,
  modalWidth,
  modalPosition,
  Field,
  Fields,
  Hints,
  Line,
  Lines,
  Panel,
  Section,
  Text,
  StyledText,
  useTheme,
} from "./ui.tsx";
export { PaletteContext } from "./ui.tsx";
import { markdownText, plainText } from "./markdown.ts";
import type { TextRow } from "./text-layout.ts";
import { rowLayout, type LayoutRow } from "./layout.ts";
import { composerBar, footerHints, type BarItem, type CommandContext } from "./commands.ts";
import { absurd } from "@loom/core/absurd";
import { cacheHitRate } from "@loom/core/cache";
import type { DoctorReport, SessionSnapshot } from "@loom/core/wire";
import type { SessionMode } from "@loom/core/types";
import type { SessionStateKind } from "@loom/core/events";
import { foldInteraction, type SessionInteraction } from "@loom/core/interaction";
import { layout, layoutWrapped, type Buffer } from "./editor.ts";
import { diffSegColor } from "./transcript.ts";
import type { ClientState } from "@loom/client";
import type { ModeChoices } from "./mode-control.ts";
import type { FleetPaneView, HeaderView, LogView } from "./views.ts";
import {
  fleetSessions,
  cacheHeat,
  cacheStatus,
  providerAccountOf,
  providerColorOf,
  type CacheStatus,
  type Connection,
  type FleetChild,
  type TuiState,
} from "./model.ts";
import { parseAskUserQuestions, type AskUserQuestionItem } from "./interactions.ts";
import { pendingMode } from "./mode-control.ts";
import { forkIsolationLocked } from "./fork-flow.ts";
import { newSessionHeader } from "./new-session-header.ts";
import {
  openPrompt,
  pickerCurrent,
  pickerVisible,
  promptKind,
  type ChildrenChoice,
  type Confirm as ConfirmState,
  type PickItem,
  type Picker as PickerState,
  type Prompt,
  type PromptKind,
} from "./overlay.ts";
import {
  bar,
  costScope,
  humanDuration,
  humanTokens,
  mmss,
  modeChipText,
  modeText,
  sessionCost,
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
    archiving = [],
    hover = null,
  }: {
    view: FleetPaneView;
    /** The `/` filter's buffer, drawn under the title. Separate from `view`
     *  because typing in it is the one keystroke this pane must repaint for. */
    find: Buffer | null;
    tick: number;
    width: number;
    now: number;
    archiving?: readonly string[];
    /** The hovered target (`hitKey`), underlined if it is one of these rows. */
    hover?: string | null;
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
                status: entry.status,
                ...(entry.nest ? { nest: entry.nest } : {}),
                ...(entry.agents ? { agents: entry.agents } : {}),
                selected: entry.s.id === view.selectedId,
                focused: childKeyOf(entry.s) != null,
                tick,
                iw,
                now,
                pcolor: view.providerColors,
                compacting: entry.s.compacting !== undefined,
                archiving: archiving.includes(entry.s.id),
                hovered: hover === `session:${entry.s.id}`,
              });
            case "child":
              return FleetChildRow({
                rowKey: `${entry.s.id}:${entry.c.key}`,
                c: entry.c,
                isLast: entry.isLast,
                sel: entry.c.key === childKeyOf(entry.s),
                tick,
                iw,
                hovered: hover === `child:${entry.s.id}:${entry.c.key}`,
              });
            case "childMore":
              return (
                <Text
                  key={`more-${entry.s.id}`}
                  tone="faint"
                  underline={hover === `childMore:${entry.s.id}`}
                >
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
  status,
  nest,
  agents,
  selected,
  focused = false,
  tick,
  iw,
  now,
  pcolor,
  compacting = false,
  archiving = false,
  hovered = false,
}: {
  s: SessionSnapshot;
  /** What the row shows: a supervisor whose agents still work shows as working. */
  status: SessionStateKind;
  /** A Loom agent under its supervisor: indented behind a tree branch, like
   *  the work rows a session fans out, but a session row in full. */
  nest?: { depth: number; isLast: boolean };
  /** A supervisor's open agents in words, and its spend with theirs. */
  agents?: { cost: Pick<SessionSnapshot, "costUsd" | "costSource"> };
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
  archiving?: boolean;
  /** Under the mouse pointer: a click selects it. */
  hovered?: boolean;
}): ReactNode => {
  const C = useTheme();
  const look = statusLook(status);
  const blocked = s.resumable === false || archiving;
  let glyph = look.glyph;
  if (["running", "starting"].includes(status)) glyph = spinnerFrame(tick);
  if (blocked) glyph = "○";
  if (s.stopping || archiving) glyph = "◌";
  let titleColor = selected ? C.text : C.dim;
  // An archived agent, drawn while its supervisor is entered, stays dimmed.
  if (blocked || (nest && status === "done" && !selected)) titleColor = C.faint;
  const id = shortId(s.id);
  // A supervisor's figure is its spend with its agents'.
  const cost = agents ? `Σ${sessionCost(agents.cost)}` : sessionCost(s);
  const heat = cacheHeat(cacheStatus(s, now));
  // Always 2 cols so titles stay aligned whether or not a session has a warm cache.
  const cacheColor = heat ? C[cacheHeatTone(heat)] : null;
  const idColor = blocked ? C.faint : pcolor.get(s.provider) || C.faint;
  const forked = s.parentId != null && s.forkTurn != null;
  const idText = forked ? `⑂${id}` : id;
  const branch = nest ? `${"  ".repeat(nest.depth - 1)}${nest.isLast ? "└ " : "├ "}` : "";
  const width = Math.max(
    6,
    iw - (2 + branch.length + 2 + idText.length + 3 + 2 + 2 + cost.length + 1),
  );
  const room = width;
  const title = truncate(
    archiving ? "archiving… " + titleLine(s.title) : titleLine(s.title),
    room,
  ).padEnd(room);
  let glyphTone: ThemeColor = status === "running" ? "accent" : statusTone(status);
  if (archiving) glyphTone = "dim";

  return (
    <Line key={s.id}>
      <Text tone={selected && !focused ? "accent" : "faint"}>{selected ? "▍ " : "  "}</Text>
      {branch ? <Text tone="faint">{branch}</Text> : null}
      <Text tone={glyphTone}>{glyph + " "}</Text>
      <Text color={idColor}>{idText}</Text>
      <Text tone="faint">{s.isolation === "vm" ? " ◇ " : "   "}</Text>
      {compacting ? (
        <Text tone="accent">{"⇊ "}</Text>
      ) : (
        <Text color={cacheColor ?? C.faint}>{cacheColor ? "⟢ " : "  "}</Text>
      )}
      <Text tone="faint">{s.comment ? "✎ " : "  "}</Text>
      <Text color={hovered ? C.text : titleColor} bold={selected && !blocked} underline={hovered}>
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

/** How a fork carried its parent's conversation, as DETAIL's lineage line says it. */
const FORK_KIND = {
  native: " · native history",
  handoff: " · handoff (summary, not native history)",
} as const;

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
  hovered = false,
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
  /** Under the mouse pointer: a click selects it. */
  hovered?: boolean;
}): ReactNode => {
  const room = Math.max(6, iw - 8);
  return (
    <Line key={rowKey}>
      <Text tone={sel ? "accent" : "faint"}>{sel ? "▍ " : "  "}</Text>
      <Text tone="faint">{isLast ? "└ " : "├ "}</Text>
      <Text tone="accentDim">{spinnerFrame(tick) + " "}</Text>
      <Text tone="faint">{childGlyph(c) + " "}</Text>
      <Text tone={sel || hovered ? "text" : "dim"} bold={sel} underline={hovered}>
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
    mode = null,
    compacting = s?.compacting ?? null,
    archiving = false,
  }: {
    width?: number;
    account?: string;
    engineColor?: string;
    mode?: SessionMode | null;
    compacting?: { startedAt: number; before: number } | null;
    archiving?: boolean;
  } = {},
) => {
  // `hovered`: the mouse pointer is over this row's click target.
  type Content = (now: number, hovered?: boolean) => ReactNode;
  const rows: LayoutRow<Content, "mode">[] = [];
  const add = (value: ReactNode | Content) =>
    rows.push({ tag: "content", value: typeof value === "function" ? value : () => value });
  const addLine = (children: ReactNode, tone: ThemeColor = "faint") =>
    add(<Line tone={tone}>{children}</Line>);
  const space = () => rows.push({ tag: "space" });
  const w = inside(width);
  mode ??= s?.pendingMode ?? null;
  const look = s ? statusLook(s.status.kind) : null;
  if (!s) {
    addLine("DETAIL", "dim");
    addLine("select a session with ↑/↓");
  } else {
    add(
      <Box>
        <Line tone="dim">
          {`DETAIL  ${shortId(s.id)}`}
          <Text tone="faint">{s.isolation === "vm" ? " · ◇ VM " : " · local "}</Text>
        </Line>
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
    if (s.parentId && s.forkTurn != null) {
      const how = s.forkKind ? FORK_KIND[s.forkKind] : "";
      addLine(truncate(`⑂ forked from ${shortId(s.parentId)} @ turn ${s.forkTurn}${how}`, w));
    }
    if (s.worktreeOwner)
      addLine(truncate(`⑂ shares the worktree of ${shortId(s.worktreeOwner)}`, w));
    if (s.supervisorId || s.agentProfile) {
      const parts = [
        ...(s.supervisorId ? [`agent of ${shortId(s.supervisorId)}`] : []),
        ...(s.agentProfile ? [`profile ${s.agentProfile}`] : []),
        ...(s.taskId ? [`task ${s.taskId}`] : []),
      ];
      addLine(truncate(`↳ ${parts.join(" · ")}`, w));
    }
    space();
    let status = `${look!.glyph} ${look!.label}${statusDetailSuffix(s)}`;
    if (s.stopFailed) status = "⚠ stop failed — press i to retry";
    if (s.stopping) status = "◌ stopping…";
    if (archiving) status = "◌ archiving…";
    const chip = `mode ${modeChipText(s.mode, mode)}`;
    rows.push({
      tag: "target",
      kind: "mode",
      x: [...status].length + 2,
      width: [...chip].length,
      value: (_now, hovered = false) => (
        <Box gap={2}>
          <Line tone={archiving ? "dim" : statusTone(s.status.kind)} bold={!archiving}>
            {status}
          </Line>
          <Line>
            <Text tone="dim">mode </Text>
            <Text tone={mode != null ? "dim" : "warn"} underline={hovered}>
              {modeChipText(s.mode, mode)}
            </Text>
          </Line>
          <Line tone="dim">{`${s.turns} turn${s.turns === 1 ? "" : "s"}`}</Line>
        </Box>
      ),
    });
    const frac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
    add(
      <Field label="context">
        <Text tone={contextHeatTone(frac)}>{bar(frac, 16)}</Text>
        <Text tone="dim">
          {s.contextLimit > 0
            ? `  ${Math.round(frac * 100)}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`
            : `  ${humanTokens(s.contextUsed)}/unknown`}
        </Text>
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
          <Line>
            <Text tone={s.costUsd ? "good" : "faint"}>{` ${sessionCost(s)}`}</Text>
            <Text tone="faint">{` ${costScope(s.costSource)}`}</Text>
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
    // The session's queue, off its snapshot: how many wait, whether they are
    // held, and the next to go.
    const queued = s.queue?.entries ?? [];
    if (queued.length || s.queue?.hold) {
      const head = (queued[0]?.preview ?? "").replace(/\s+/g, " ").trim();
      const count = s.queue?.hold
        ? `▸ ${queued.length ? `${queued.length} ` : ""}held · q review`
        : `▸ ${queued.length} queued`;
      addLine(head ? `${count} — “${truncate(head, w - count.length - 6)}”` : count, "accentDim");
    }
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
    /** `hover`: the frame's hovered target (`hitKey`). */
    render: (now: number, hover: string | null = null): ReactNode => (
      <Panel width={width} tone={s ? statusTone(s.status.kind) : "faint"}>
        {layout.rows.map((row, i) => (
          <Box key={i} height={1} flexShrink={0}>
            {row.tag === "space" ? (
              <Text> </Text>
            ) : (
              row.value(now, row.tag === "target" && hover === row.kind)
            )}
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
    mode,
    width,
    now,
  }: {
    session: SessionSnapshot | null;
    fleet: ClientState;
    mode: SessionMode | null;
    width: number;
    now: number;
  }): ReactNode =>
    detailLayout(session, {
      width,
      mode,
      account: session ? providerAccountOf({ fleet }, session.provider) : "",
      engineColor: session ? providerColorOf({ fleet }, session.provider) : "",
    }).render(now),
);

// ---------------------------------------------------------------------------
// event log (right column, bottom)
// ---------------------------------------------------------------------------

export const EventLog = memo(
  ({
    view,
    width,
    spinner,
    hoverTab = null,
  }: {
    view: LogView;
    width: number;
    spinner?: ReactNode;
    /** The session tab under the mouse pointer. */
    hoverTab?: SessionTab | null;
  }): ReactNode => {
    const palette = useTheme();
    const { child, rows } = view;
    let empty = child
      ? `  (no events from this ${child.source === "sub" ? "sub-agent" : "task"})`
      : "  (quiet)";
    if (view.loading) empty = "  (loading history…)";
    // Pane title: the focused child's name while drilled in, else the plain header.
    let title = "Chat";
    if (child) {
      title = `Chat · ${childGlyph(child)} ${truncate(
        child.label.replace(/\s+/g, " ").trim(),
        Math.max(8, inside(width) - 24),
      )}`;
    }

    return (
      <Panel width={width} tone={view.scrolled ? "accentDim" : "faint"} flexGrow={1}>
        <SessionTabs active="chat" hover={hoverTab} />
        <Box justifyContent="space-between">
          <Line tone="dim">{title}</Line>
          <Text tone="faint">{view.tag + (view.scrolled ? `  ·  ↑${view.above} more` : "")}</Text>
        </Box>
        {rows.length === 0 ? (
          <Text tone="faint">{empty}</Text>
        ) : (
          rows.map((r) =>
            r.first ? (
              <Line key={r.key}>
                <Text tone="faint">{r.ts}</Text>
                <Text color={toneColor(r.tone, palette)}>{`${r.glyph} `}</Text>
                <Text color={diffSegColor(r.kind, r.seg, toneColor(r.tone, palette), palette)}>
                  {r.spans ? <StyledText spans={r.spans} subdued={r.kind === "thinking"} /> : r.seg}
                </Text>
              </Line>
            ) : (
              <Line key={r.key}>
                <Text>{" ".repeat(r.indent)}</Text>
                <Text color={diffSegColor(r.kind, r.seg, toneColor(r.tone, palette), palette)}>
                  {r.spans ? <StyledText spans={r.spans} subdued={r.kind === "thinking"} /> : r.seg}
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

/** Default editor row budget. Panes and the modal reserve wrapped rows up to
 *  this limit; longer drafts scroll around the caret. */
export const MAX_EDITOR_ROWS = 8;

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
  maxRows = MAX_EDITOR_ROWS,
}: {
  buf: Buffer;
  room: number;
  placeholder?: string;
  multiline?: boolean;
  maxRows?: number;
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

  // Keep the caret in the row budget reserved by the containing pane or modal.
  const start =
    rows.length <= maxRows
      ? 0
      : Math.min(Math.max(0, row - Math.floor(maxRows / 2)), rows.length - maxRows);
  const shown = rows.slice(start, start + maxRows);
  const moreAbove = start > 0;
  const moreBelow = start + maxRows < rows.length;

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
// footer hints and prompt feedback
// ---------------------------------------------------------------------------

const MODE_HINT: Record<Exclude<PromptKind, "new">, string> = {
  send: "send",
  answer: "answer",
  deny: "deny",
  title: "rename",
  comment: "save",
  discuss: "send",
  compact: "compact",
};

/** Show the selected mode in grey until the server confirms the change. */
const modeChip = (
  mode: string | null | undefined,
  pending?: SessionMode | null,
  hovered = false,
): ReactNode => {
  const settledTone = mode && mode !== "default" ? "warn" : "faint";
  return (
    <Line tone={pending != null ? "dim" : settledTone} underline={hovered}>
      {modeChipText(mode, pending)}
    </Line>
  );
};

const pendingPromptHint = (p: Prompt): string | null => {
  if (p.feedback?.uncertain) return "esc close and review session — draft saved";
  if (p.feedback?.pending) return "Starting / sending… · esc hide (operation continues)";
  return null;
};

/**
 * The bar under an open reply prompt. Its editing controls are the prompt's
 * own; on a send prompt the session's commands follow — the same descriptions
 * the fleet's bar and keymap use for that session, under their composer keys,
 * so a command offered here is offered (or not) for the same reason there.
 */
export const promptBar = (
  p: Exclude<Prompt, { t: "new" }>,
  ctx: CommandContext,
  modes: ModeChoices = {},
): BarItem[] => {
  const pending = pendingPromptHint(p);
  if (pending) return [{ keys: "", label: pending }];
  // Editing a queued message saves it back into the queue.
  const editing = p.t === "session" && p.edit !== undefined;
  const items: BarItem[] = [
    {
      keys: "enter",
      label: editing ? "save" : MODE_HINT[promptKind(p) as Exclude<PromptKind, "new">],
    },
    { keys: "⌥⏎", label: "newline" },
    { keys: "⌥e", label: "editor" },
    { keys: "⌥o", label: "log" },
  ];
  if (p.t === "session" && p.kind === "send" && !editing) {
    const sess = fleetSessions(ctx).find((x) => x.id === p.sessionId);
    for (const item of composerBar(ctx, p.sessionId)) {
      if (item.command?.id === "mode") {
        const pending = pendingMode(modes, sess?.id) ?? sess?.pendingMode;
        items.push({ ...item, label: `mode:${modeText(sess?.mode, pending)}` });
      } else items.push(item);
    }
    items.push({ keys: "↑↓", label: "history" });
  }
  items.push({ keys: "esc", label: "cancel" });
  return items;
};

/** The footer's key bar for whatever is open: a reply prompt's, nothing under
 *  the floating new-session prompt, else the fleet's or the overlay's. */
export const footerBar = (ctx: CommandContext, modes: ModeChoices = {}): BarItem[] => {
  const p = openPrompt(ctx.overlay);
  if (p?.t === "new") return [];
  return p ? promptBar(p, ctx, modes) : footerHints(ctx);
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
  modes = {},
  bar,
  hover = null,
}: {
  state: TuiState;
  width: number;
  modes?: ModeChoices;
  /** The bar the frame's click targets were measured from (see `FleetView`);
   *  computed here when the caller has none. */
  bar?: readonly BarItem[];
  /** The frame's hovered target (`hitKey`); a bar chip under it is underlined. */
  hover?: string | null;
}): ReactNode => {
  const palette = useTheme();
  const p = openPrompt(state.overlay);
  if (p?.t === "new") return <Box height={2} />;
  const items = bar ?? footerBar(state, modes);
  const hovered = items.findIndex((item) => item.command && `bar:${item.command.id}` === hover);
  if (p) {
    // A reply to a session — the input lives on that session's EVENTS pane
    // (`PromptPane`, under the log); the footer keeps only the hints row.
    return (
      <Box width={width} paddingX={1}>
        <Hints items={items} hover={hovered} />
      </Box>
    );
  }
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
        <Hints items={items} hover={hovered} />
      </Box>
    </Box>
  );
};

/** New-session input floats above the body; only replies reserve a hint row. */
export const promptRows = (state: TuiState): number => {
  const p = openPrompt(state.overlay);
  if (!p) return 2 + (state.notice ? 1 : 0);
  return p.t === "new" ? 2 : 1;
};

/** Shared geometry for the floating composer, its settings rows and its
 *  clickable mode chip. */
export const newSessionLayout = (
  state: TuiState,
  p: Extract<Prompt, { t: "new" }>,
  cols: number,
  rows: number,
) => {
  const compact = rows < 22;
  const width = modalWidth(cols);
  const padding = compact || width < 60 ? 1 : 2;
  const inner = Math.max(1, width - 2 - padding * 2);
  const room = Math.max(1, inner - 2);
  const feedback = feedbackLines(p, inner);
  // Border and title, with the subtitle, hints and spacing when not compact.
  const chrome = compact ? 4 : 11;
  const wrapped = newSessionHeader(state, p.settings, inner, { compact, tight: false });
  // Too short for the wrapped rows and a line to type in: who runs it on one row.
  const header =
    chrome + wrapped.rows.length + 1 + feedback.length > rows
      ? newSessionHeader(state, p.settings, inner, { compact, tight: true })
      : wrapped;
  const fixed = chrome + header.rows.length;
  const maxRows = Math.max(1, Math.min(MAX_EDITOR_ROWS, rows - fixed - feedback.length));
  const editorRows = Math.min(maxRows, layoutWrapped(p.buffer, room).rows.length);
  const height = Math.min(rows, fixed + editorRows + feedback.length);
  const { left, top } = modalPosition(cols, rows, width, height);
  return {
    compact,
    width,
    padding,
    room,
    header,
    maxRows,
    height,
    left,
    top,
    // 1-based: the border, the top padding, title, subtitle and spacer.
    modeY: top + (compact ? 3 : 6) + header.mode.row,
    modeX: left + padding + 2 + header.mode.col,
  };
};

export const NewSessionModal = ({
  state,
  cols,
  rows,
  hover = false,
}: {
  state: TuiState;
  cols: number;
  rows: number;
  /** The mouse pointer is over the mode chip. */
  hover?: boolean;
}): ReactNode => {
  const palette = useTheme();
  const p = openPrompt(state.overlay);
  if (p?.t !== "new") return null;
  const g = newSessionLayout(state, p, cols, rows);
  return (
    <FloatingLayer left={g.left} top={g.top} width={g.width} height={g.height}>
      <Box
        width={g.width}
        height={g.height}
        flexDirection="column"
        borderStyle="round"
        borderColor={palette.accent}
        backgroundColor={palette.bg}
        borderBackgroundColor={palette.bg}
        paddingX={g.padding}
        paddingY={g.compact ? 0 : 1}
        overflow="hidden"
      >
        <Line tone="accent" bold>
          ✦ new session
        </Line>
        {!g.compact && <Line tone="dim">Start a fresh conversation</Line>}
        {!g.compact && <Box height={1} flexShrink={0} />}
        {g.header.rows.map((row, i) =>
          row.length === 0 ? (
            <Box key={i} height={1} flexShrink={0} />
          ) : (
            <Line key={i}>
              {row.map((seg, j) => (
                <Text
                  key={j}
                  tone={seg.tone}
                  {...(seg.color ? { color: seg.color } : {})}
                  underline={seg.mode === true && hover}
                >
                  {seg.text}
                </Text>
              ))}
            </Line>
          ),
        )}
        {!g.compact && <Box height={1} flexShrink={0} />}
        <InputLine
          buf={p.buffer}
          room={g.room}
          maxRows={g.maxRows}
          placeholder={truncate(PROMPT_PLACEHOLDER.new, Math.max(1, g.room - 2))}
        />
        <PromptFeedback p={p} width={g.width - 2 - g.padding * 2} />
        {!g.compact && <Box height={1} flexShrink={0} />}
        {p.feedback?.pending || p.feedback?.uncertain ? (
          <Line tone="warn">{pendingPromptHint(p)}</Line>
        ) : (
          <Hints
            items={[
              { keys: "enter", label: "start session" },
              { keys: "esc", label: "cancel" },
            ]}
          />
        )}
        {!g.compact && <Line tone="faint">⌥⏎ newline · ⌥e editor · ↑↓ history</Line>}
      </Box>
    </FloatingLayer>
  );
};

/** Columns the pane prompt wraps to: the right column minus its padding (2+2)
 *  and the 2-char caret gutter. */
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
  hover = false,
}: {
  state: TuiState;
  width: number;
  modes?: ModeChoices;
  /** The mouse pointer is over the mode chip. */
  hover?: boolean;
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
        {sess ? modeChip(sess.mode, pendingMode(modes, sess.id) ?? sess.pendingMode, hover) : null}
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

type DeleteConfirmState = Extract<ConfirmState, { action: "deleteSession" }>;

// Use the same wrapped copy to size and paint the dialog.
const deletionLayout = (confirm: DeleteConfirmState, width: number) => {
  const room = Math.max(1, width - 6);
  const history = wrapText("Session history will be permanently deleted.", room);
  const worktree = confirm.deleteWorktree
    ? wrapText(
        confirm.force
          ? "Worktree and uncommitted changes will be lost."
          : "Worktree will be removed.",
        room,
      )
    : [];
  const agents = confirm.children ? wrapText(childrenLine(confirm.children), room) : [];
  return {
    history,
    worktree,
    agents,
    height:
      9 +
      history.length +
      worktree.length +
      (confirm.branchName ? 4 : 0) +
      (agents.length ? agents.length + 1 : 0),
  };
};

/** What closing a supervisor does to its open agents, as its confirm says it. */
const childrenLine = (c: ChildrenChoice): string => {
  const n = `${c.count} open agent${c.count === 1 ? "" : "s"}`;
  return c.choice === "stop"
    ? `It supervises ${n}: they are stopped and archived with it.`
    : `It supervises ${n}: they are detached and keep running as sessions of their own.`;
};

const DeleteSessionConfirm = ({
  confirm,
  width,
  height,
}: {
  confirm: DeleteConfirmState;
  width: number;
  height?: number;
}): ReactNode => {
  const content = deletionLayout(confirm, width);
  const compact = height !== undefined && height < content.height;
  const gap = compact ? 0 : 1;
  return (
    <Panel
      width={width}
      {...(height !== undefined ? { height } : {})}
      flexShrink={0}
      tone="bad"
      overlay
      paddingY={gap}
      overflow="hidden"
      title={confirm.title}
    >
      <Line tone="text" bold>
        {confirm.body}
      </Line>
      <Box flexDirection="column" marginTop={gap} flexShrink={0}>
        <Lines tone="text" lines={content.history} />
        <Lines tone={confirm.force ? "warn" : "dim"} lines={content.worktree} />
      </Box>
      {content.agents.length ? (
        <Box flexDirection="column" marginTop={gap} flexShrink={0}>
          <Lines
            tone={confirm.children?.choice === "stop" ? "warn" : "dim"}
            lines={content.agents}
          />
        </Box>
      ) : null}
      {confirm.branchName ? (
        <Box flexDirection="column" marginTop={gap} flexShrink={0}>
          <Line tone={confirm.deleteBranch ? "warn" : "dim"}>
            <Text bold>{confirm.deleteBranch ? "[x]" : "[ ]"}</Text>
            {" Also delete branch"}
          </Line>
          <Line tone="dim">
            {"    "}
            {confirm.branchName}
          </Line>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={gap} flexShrink={0}>
        {confirm.branchName ? <Hints items={[{ keys: "b", label: "toggle branch" }]} /> : null}
        {confirm.children ? (
          <Hints
            items={[
              {
                keys: "c",
                label: confirm.children.choice === "stop" ? "detach agents" : "stop agents",
              },
            ]}
          />
        ) : null}
        <Hints
          items={[
            { keys: "enter", label: "delete" },
            { keys: "esc", label: "cancel" },
          ]}
        />
      </Box>
    </Panel>
  );
};

export const Confirm = ({
  confirm,
  width,
  height,
}: {
  confirm: ConfirmState;
  width: number;
  height?: number;
}): ReactNode => {
  if (confirm.action === "deleteSession") {
    return (
      <DeleteSessionConfirm
        confirm={confirm}
        width={width}
        {...(height !== undefined ? { height } : {})}
      />
    );
  }
  const compact = height !== undefined && height < 12;
  // A body may hold several lines (the fork summary); each wraps on its own.
  // A supervisor's archive says what happens to its agents last.
  const agents =
    confirm.action === "archiveSession" && confirm.children ? confirm.children : undefined;
  const body = [confirm.body ?? "", ...(agents ? [childrenLine(agents)] : [])]
    .join("\n")
    .split("\n")
    .flatMap((line) => wrapText(line, Math.max(1, width - 6)));
  const capacity = height === undefined ? body.length : Math.max(0, height - (compact ? 5 : 7));
  const shownBody = body.slice(0, capacity);
  if (body.length > capacity && shownBody.length) {
    shownBody[shownBody.length - 1] = truncate(`${shownBody.at(-1)} …`, Math.max(1, width - 6));
  }
  let actionText = "quit and stop the daemon";
  if (confirm.action === "restart") actionText = "restart the daemon";
  else if (confirm.action === "forkSession")
    actionText = `fork with ${confirm.fork.isolation === "vm" ? "VM" : "Local"} isolation${
      forkIsolationLocked(confirm.fork) ? "" : " (i to change)"
    }`;
  else if (confirm.action === "gc") actionText = "remove the worktrees";
  else if (confirm.action === "archiveSession") actionText = "archive";
  return (
    <Panel
      width={width}
      {...(height !== undefined ? { height } : {})}
      flexShrink={0}
      tone={confirm.danger ? "bad" : "accent"}
      overlay
      paddingY={compact ? 0 : 1}
      overflow="hidden"
      title={confirm.title}
    >
      {confirm.body ? <Lines tone="warn" lines={shownBody} /> : null}
      <Box height={1} />
      <Hints
        gap={2}
        items={[
          { keys: "enter", label: actionText },
          ...(agents
            ? [{ keys: "c", label: agents.choice === "stop" ? "detach agents" : "stop agents" }]
            : []),
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
/** Ceiling on the request panel's body. Questions and plans grow the panel to
 *  fit their formatted content, but never past
 *  this — the fleet list would otherwise scroll off screen. `⌥o` shows the
 *  whole call, and ← / → cycle the other questions into view one at a time. */
const REQUEST_PANEL_MAX_BODY = 14;

/** Height reserved for {@link RequestPanel} for a permission
 *  request. Questions and plans size dynamically — see {@link requestPanelRows}. */
export const REQUEST_PANEL_ROWS = REQUEST_PANEL_CHROME + REQUEST_PANEL_MIN_BODY;

/** Format content separately from the fixed option numbers — the numbers the
 *  answer sheet chooses them by. */
const askQuestionRows = (qs: AskUserQuestionItem[], active: number, w: number): TextRow[] => {
  const q = qs[Math.max(0, Math.min(qs.length - 1, active))];
  if (!q) return [];
  const rows = [...markdownText(q.question).layout(w)];
  q.options.forEach((opt, oi) => {
    const prefix = `  ${oi + 1}) `;
    const source = opt.label + (opt.description ? ` — ${opt.description}` : "");
    const gutter = w > prefix.length ? prefix : "";
    markdownText(source)
      .layout(Math.max(1, w - gutter.length))
      .forEach((r, i) => {
        const lead = i === 0 ? gutter : " ".repeat(gutter.length);
        rows.push({ text: lead + r.text, spans: [{ text: lead }, ...r.spans] });
      });
  });
  return rows;
};

export const askQuestionLines = (qs: AskUserQuestionItem[], active: number, w: number): string[] =>
  askQuestionRows(qs, active, w).map((r) => r.text);

/** Shared geometry for question/plan previews and their painted rows. */
const prepareRequestRows = (
  request: SessionInteraction,
  w: number,
  active: number,
): readonly TextRow[] | null => {
  if (request.kind === "question") {
    return markdownText(
      request.question + (request.context ? "\n\n" + request.context : ""),
    ).layout(w);
  }
  if (request.kind === "plan_review") return markdownText(request.plan).layout(w);
  if (request.kind === "user_question") {
    const qs = parseAskUserQuestions(request.input);
    if (qs.length) return askQuestionRows(qs, active, w);
  }
  return null;
};

// Requests are immutable snapshots. Share the last layout between measurement,
// painting and animation frames without retaining resolved requests.
const requestLayoutCache = new WeakMap<
  SessionInteraction,
  {
    width: number;
    active: number;
    rows: readonly TextRow[] | null;
  }
>();
const requestDocumentRows = (
  request: SessionInteraction,
  width: number,
  active: number,
): readonly TextRow[] | null => {
  const hit = requestLayoutCache.get(request);
  if (hit?.width === width && hit.active === active) return hit.rows;
  const rows = prepareRequestRows(request, width, active);
  requestLayoutCache.set(request, { width, active, rows });
  return rows;
};

export const requestPanelRows = (
  request: SessionInteraction | null,
  width: number,
  questionIdx = 0,
): number => {
  const rows = request && requestDocumentRows(request, inside(width), questionIdx);
  return (
    REQUEST_PANEL_CHROME +
    Math.max(
      REQUEST_PANEL_MIN_BODY,
      Math.min(REQUEST_PANEL_MAX_BODY, rows?.length ?? REQUEST_PANEL_MIN_BODY),
    )
  );
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
  const documentRows = requestDocumentRows(request, w, questionIdx);
  const box = (title: string, body: string[], hint: string): ReactNode => (
    <Panel width={width} tone="await_" title={title}>
      <Box height={capacity} flexDirection="column" overflow="hidden">
        {(documentRows ?? body.flatMap((s) => plainText(s).layout(w)))
          .slice(0, capacity)
          .map((r, i) => (
            <Line key={i} tone="text">
              <StyledText spans={r.spans} />
            </Line>
          ))}
      </Box>
      <Line tone="faint">{hint}</Line>
    </Panel>
  );
  // "…and N more" is the whole reason the panel takes a count: answering the
  // one on screen leaves the others outstanding and the turn still blocked.
  const alsoQueued = queued > 1 ? `  ·  ${queued - 1} more queued` : "";

  return foldInteraction<ReactNode>({
    onQuestion: () =>
      box("? QUESTION", [], `a answer  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`),
    onPlanReview: () =>
      box("❖ PLAN REVIEW", [], `a review  ·  ⌥o / o view  ·  i interrupt${alsoQueued}`),
    onUserQuestion: (u) => {
      const qs = parseAskUserQuestions(u.input);
      // Title position marker: which question of this call we're on, plus —
      // when others are queued behind it — where this one sits in the queue.
      const pos = [
        qs.length > 1 ? `${Math.min(questionIdx, qs.length - 1) + 1}/${qs.length}` : "",
        queued > 1 ? `1 of ${queued}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return box(
        `? QUESTION${pos ? ` (${pos})` : ""}`,
        documentRows ? [] : describeRequest(u.input, w),
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
  const document = useMemo(() => markdownText(plan.text), [plan.text]);
  const lines = document.layout(w);
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
  // Border (2), title/spacers/position (5), target + mode (2), actions (4),
  // and final spacer/hint (2). Optional metadata consumes one row each.
  const window = Math.max(0, height - 15 - Number(frac !== null) - Number(providerForks));
  const off = Math.min(Math.max(0, scroll ?? 0), Math.max(0, lines.length - window));
  const body = lines.slice(off, off + window);
  const overflow = lines.length > window;
  return (
    <Panel
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
      tone="await_"
      title={"❖ PLAN REVIEW"}
    >
      <Box height={1} />
      <Box height={window} flexShrink={0} flexDirection="column" overflow="hidden">
        {body.map((line, i) => (
          <Line key={i} tone="text">
            <StyledText spans={line.spans} />
          </Line>
        ))}
      </Box>
      <Line tone="faint">
        {overflow
          ? `  ↕ lines ${off + 1}–${off + body.length} of ${lines.length}  ·  PgUp/PgDn`
          : " "}
      </Line>
      <Box height={1} />
      {frac !== null && ctx ? (
        <Line>
          <Text tone={contextHeatTone(frac)}>{bar(frac, 16)}</Text>
          <Text tone="dim">
            {`  ${Math.round(frac * 100)}% context · ${humanTokens(ctx.used)}/${humanTokens(ctx.limit)}`}
          </Text>
        </Line>
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
        <Line tone="faint">{"  different provider — implements in a fresh forked session"}</Line>
      ) : null}
      <Box height={1} />
      <Fields
        width={4}
        labelTone="accent"
        wrap="truncate-end"
        rows={[
          ["i", "implement — the agent proceeds in this context"],
          ["f", "implement fresh — start from the plan + goal"],
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

/** A palette row reads faint while it cannot be chosen. */
const rowTone = (it: { disabled?: string }, on: boolean): ThemeColor => {
  if (it.disabled) return "faint";
  return on ? "text" : "dim";
};

interface PaletteColumns {
  /** Spaces after the KEY and COMMAND cells. */
  gap: number;
  keyW: number;
  nameW: number;
  /** Whether the row has room for a DESCRIPTION after the name. */
  described: boolean;
}

/** Column widths from every row, not just the matches, so typing a filter
 *  never shifts a column. COMMAND fits the longest name up to a cap; a narrow
 *  palette gives the name the whole row and drops the description. */
const paletteColumns = (items: readonly PickItem[], room: number): PaletteColumns => {
  const gap = room < 56 ? 1 : 2;
  const keyW = Math.max(3, ...items.map((it) => stringWidth(it.hint ?? "")));
  const body = Math.max(1, room - 2 - keyW - gap);
  const cap = Math.max(7, Math.min(26, Math.floor(body * 0.4)));
  const nameW = Math.min(cap, Math.max(7, ...items.map((it) => stringWidth(it.label))));
  const described = body - nameW - gap >= 16;
  return { gap, keyW, nameW: described ? nameW : Math.max(1, body - gap), described };
};

const PaletteCell = ({
  width,
  gap,
  children,
}: {
  width: number;
  gap: number;
  children: ReactNode;
}): ReactNode => (
  <Box width={width} marginRight={gap} flexShrink={0} overflow="hidden">
    {children}
  </Box>
);

/** One command: its key, its name, then what it does — or, while it cannot
 *  run, why not: the line that explains a faint row. */
const PaletteRow = ({
  item,
  on,
  columns,
}: {
  item: PickItem;
  on: boolean;
  columns: PaletteColumns;
}): ReactNode => (
  <Box>
    <Box flexShrink={0}>
      <Text tone={on ? "accent" : "faint"}>{on ? "▍ " : "  "}</Text>
    </Box>
    <PaletteCell width={columns.keyW} gap={columns.gap}>
      <Line tone={on && !item.disabled ? "accent" : "faint"}>{item.hint ?? ""}</Line>
    </PaletteCell>
    <PaletteCell width={columns.nameW} gap={columns.gap}>
      <Line tone={rowTone(item, on)} bold={on}>
        {item.label}
      </Line>
    </PaletteCell>
    {columns.described ? (
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Line tone={item.disabled ? "faint" : "dim"}>
          {item.disabled ?? item.description ?? ""}
        </Line>
      </Box>
    ) : null}
  </Box>
);

/** A picker's list as drawn: its items, each with its index into the visible
 *  ones, and a heading wherever they move into a new section. */
type PickerLine =
  | { readonly t: "section"; readonly text: string }
  | { readonly t: "item"; readonly item: PickItem; readonly index: number };

const pickerLines = (vis: readonly PickItem[]): PickerLine[] =>
  vis.flatMap((item, index): PickerLine[] => {
    const heading = item.section !== undefined && item.section !== vis[index - 1]?.section;
    return [
      ...(heading ? [{ t: "section" as const, text: item.section! }] : []),
      { t: "item", item, index },
    ];
  });

export const Picker = ({
  picker,
  width,
  height,
}: {
  picker: PickerState;
  width: number;
  height: number;
}): ReactNode => {
  const compact = height < 16;
  const padding = width < 60 ? 1 : 2;
  const room = Math.max(1, width - 2 - padding * 2);
  const vis = pickerVisible(picker);
  const current = pickerCurrent(picker);
  // The command palette reads as a table: KEY, COMMAND, DESCRIPTION.
  const columns = picker.step === "command" ? paletteColumns(picker.items, room) : null;
  const header = columns !== null && !compact;
  const rows = Math.max(1, height - (compact ? 9 : 11) - (header ? 1 : 0));
  // The visible items with a heading wherever they move into a new section;
  // the window keeps the highlighted item in view, headings counted.
  const lines = pickerLines(vis);
  const at = Math.max(
    0,
    lines.findIndex((l) => l.t === "item" && l.index === picker.index),
  );
  const start = Math.max(0, Math.min(Math.max(0, lines.length - rows), at - Math.floor(rows / 2)));
  const shown = lines.slice(start, start + rows);
  const hidden = vis.length - shown.filter((l) => l.t === "item").length;

  return (
    <Panel
      width={width}
      height={height}
      flexShrink={0}
      tone="accent"
      overlay
      paddingX={padding}
      paddingY={compact ? 0 : 1}
      overflow="hidden"
      title={`▸ ${picker.title.toUpperCase()}`}
    >
      {/* The prompt's input line, pinned to one row, so the filter reads as
          "type here" and takes the same readline motions. */}
      <InputLine
        buf={picker.filter}
        room={Math.max(1, room - 2)}
        placeholder={truncate("type to search", Math.max(1, room - 4))}
        multiline={false}
      />
      <Line tone="faint">
        {picker.items.length === 0
          ? " "
          : `${vis.length}/${picker.items.length} match${vis.length === 1 ? "" : "es"}`}
      </Line>
      <Box height={1} />
      {header ? (
        <Box flexShrink={0}>
          <Box width={2} flexShrink={0} />
          <PaletteCell width={columns.keyW} gap={columns.gap}>
            <Line tone="faint">KEY</Line>
          </PaletteCell>
          <PaletteCell width={columns.nameW} gap={columns.gap}>
            <Line tone="faint">COMMAND</Line>
          </PaletteCell>
          {columns.described ? <Line tone="faint">DESCRIPTION</Line> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" height={rows} flexShrink={0} overflow="hidden">
        {shown.length === 0
          ? [
              <Lines
                key="none"
                tone="faint"
                lines={wrapText(
                  picker.items.length === 0
                    ? (picker.emptyText ?? "nothing to pick")
                    : "no matches",
                  room,
                ).slice(0, rows)}
              />,
            ]
          : shown.map((line) => {
              if (line.t === "section")
                return (
                  <Line key={`§${line.text}`} tone="faint">
                    {`── ${line.text} ${"─".repeat(Math.max(0, room - line.text.length - 4))}`}
                  </Line>
                );
              const { item: it } = line;
              const on = line.index === picker.index;
              if (columns) return <PaletteRow key={it.id} item={it} on={on} columns={columns} />;
              return (
                <Box key={it.id}>
                  <Box flexShrink={0}>
                    <Text tone={on ? "accent" : "faint"}>{on ? "▍ " : "  "}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Line tone={rowTone(it, on)} bold={on}>
                      {it.label}
                    </Line>
                  </Box>
                  {it.hint || it.disabled ? (
                    // A disabled row says why in place; its reason yields room first.
                    <Box marginLeft={2} flexShrink={it.disabled ? 3 : 1} minWidth={0}>
                      <Line tone="faint">{[it.hint, it.disabled].filter(Boolean).join(" · ")}</Line>
                    </Box>
                  ) : null}
                </Box>
              );
            })}
      </Box>
      {hidden > 0 ? (
        <Line tone="faint">{`  … ${hidden} more`}</Line>
      ) : (
        <Box height={1} flexShrink={0} />
      )}
      {picker.note ? (
        <Line tone={picker.note.startsWith("last refresh failed") ? "warn" : "faint"}>
          {truncate(picker.note, room)}
        </Line>
      ) : (
        <Box height={1} />
      )}
      {current?.disabled ? (
        <Line tone="warn">{current.disabled}</Line>
      ) : (
        <Line tone="faint">
          {picker.items.length === 0
            ? "enter continue · esc cancel"
            : "enter pick · esc cancel · ↑↓ move"}
        </Line>
      )}
    </Panel>
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
      <Section title="selected tools">
        <Line tone="faint">
          {report.mcp.length ? "  required for each session" : "  No external tools selected"}
        </Line>
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
      <Section title="built-in tools">
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
                {report.tools.claudeDisabled.join(", ") || "none"}
                <Line tone="faint">{"  (Claude)"}</Line>
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

/** Selection and confirmation dialogs float above the unchanged fleet layout. */
export const SelectionModal = ({
  state,
  cols,
  rows,
}: {
  state: TuiState;
  cols: number;
  rows: number;
}): ReactNode => {
  const o = state.overlay;
  if (o.t !== "picker" && o.t !== "confirm") return null;
  const width = modalWidth(cols);
  const available = Math.max(1, rows - (rows >= 14 ? 2 : 0));
  const height =
    o.t === "picker"
      ? Math.min(
          available,
          // The command palette's column header takes a row of its own.
          (o.picker.step === "command" ? 12 : 11) + Math.max(1, Math.min(8, o.picker.items.length)),
        )
      : Math.min(
          available,
          o.confirm.action === "deleteSession"
            ? deletionLayout(o.confirm, width).height
            : 8 + wrapText(o.confirm.body ?? "", Math.max(1, width - 6)).length,
        );
  return (
    <FloatingLayer {...modalPosition(cols, rows, width, height)} width={width} height={height}>
      {o.t === "picker" ? (
        <Picker picker={o.picker} width={width} height={height} />
      ) : (
        <Confirm confirm={o.confirm} width={width} height={height} />
      )}
    </FloatingLayer>
  );
};
