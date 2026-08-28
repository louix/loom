/**
 * Ink components for the TUI. Written with `createElement` (aliased `h`) rather
 * than JSX so the files run straight through Node's native TypeScript
 * type-stripping with no build step — the same constraint the rest of the
 * codebase keeps. Every component is a pure projection of {@link TuiState}.
 */
import { createElement as h, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { SessionSnapshot } from "../protocol/wire.ts";
import {
  actionsFor,
  clock,
  groupsOf,
  selectedSession,
  visibleLog,
  type LogLine,
  type TuiState,
} from "./model.ts";
import {
  bar,
  C,
  humanTokens,
  money,
  shortId,
  spinnerFrame,
  STATUS,
  TONE_COLOR,
  truncate,
} from "./theme.ts";

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

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
      h(Text, { color: C.text }, repo),
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
}: {
  state: TuiState;
  tick: number;
  width: number;
}): ReactNode {
  const groups = groupsOf(state.sessions);
  const rows: ReactNode[] = [];

  if (groups.length === 0) {
    rows.push(
      h(
        Box,
        { key: "empty" },
        h(Text, { color: C.dim }, "no sessions yet — press "),
        h(Text, { color: C.accent }, "n"),
        h(Text, { color: C.dim }, " to start one"),
      ),
    );
  }

  for (const g of groups) {
    rows.push(
      h(
        Box,
        { key: `g-${g.status}`, marginTop: rows.length ? 1 : 0 },
        h(Text, { color: STATUS[g.status].color, bold: true }, STATUS[g.status].glyph + " "),
        h(Text, { color: C.dim, bold: true }, g.label.toUpperCase()),
        h(Text, { color: C.faint }, `  ${g.sessions.length}`),
      ),
    );
    for (const s of g.sessions) {
      rows.push(FleetRow({ s, selected: s.id === state.selectedId, tick, width }));
    }
  }

  return h(
    Box,
    { flexDirection: "column", width, borderStyle: "round", borderColor: C.faint, paddingX: 1 },
    h(Text, { color: C.dim }, "FLEET"),
    h(Box, { flexDirection: "column", marginTop: 1 }, ...rows),
  );
}

function FleetRow({
  s,
  selected,
  tick,
  width,
}: {
  s: SessionSnapshot;
  selected: boolean;
  tick: number;
  width: number;
}): ReactNode {
  const look = STATUS[s.status];
  const glyph =
    s.status === "running" ? h(Text, { color: C.accent }, spinnerFrame(tick)) : h(Text, { color: look.color }, look.glyph);
  const title = truncate(s.title ?? "(untitled)", Math.max(8, width - 22));
  const cost = money(s.costUsd);

  return h(
    Box,
    { key: s.id, width },
    h(Text, { color: selected ? C.accent : C.faint }, selected ? "▍" : " "),
    h(Text, null, " "),
    glyph,
    h(Text, { color: C.faint }, ` ${shortId(s.id)} `),
    h(Text, { color: selected ? C.text : C.dim, bold: selected, wrap: "truncate-end" }, title),
    h(Box, { flexGrow: 1 }),
    h(Text, { color: C.faint }, cost),
  );
}

// ---------------------------------------------------------------------------
// detail (right column, top)
// ---------------------------------------------------------------------------

export function Detail({ session, width }: { session: SessionSnapshot | null; width: number }): ReactNode {
  if (!session) {
    return h(
      Box,
      { width, borderStyle: "round", borderColor: C.faint, paddingX: 1, flexDirection: "column" },
      h(Text, { color: C.dim }, "DETAIL"),
      h(Text, { color: C.faint }, "select a session with ↑/↓"),
    );
  }

  const s = session;
  const look = STATUS[s.status];
  const ctxFrac = s.contextLimit > 0 ? s.contextUsed / s.contextLimit : 0;
  const ctxPct = Math.round(ctxFrac * 100);
  const g = s.git;

  const gitLine = g
    ? [
        g.branch ?? s.branch ?? "(detached)",
        `${g.commits} commit${g.commits === 1 ? "" : "s"}`,
        g.aheadOfBase ? `+${g.aheadOfBase}` : null,
        g.behindBase ? `-${g.behindBase} behind` : null,
        g.dirty ? "dirty" : "clean",
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "no worktree";

  return h(
    Box,
    { width, borderStyle: "round", borderColor: look.color, paddingX: 1, flexDirection: "column" },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: C.dim }, `DETAIL  ${shortId(s.id)}`),
      h(Text, { color: C.faint }, `${s.provider}${s.model ? `  ${s.model}` : ""}`),
    ),
    h(Text, { color: C.text, wrap: "truncate-end" }, truncate(s.title ?? "(untitled)", width - 4)),
    h(
      Box,
      { marginTop: 1, gap: 2 },
      h(Text, { color: look.color, bold: true }, `${look.glyph} ${look.label}${s.awaitReason ? ` · ${s.awaitReason}` : ""}`),
      h(Text, { color: C.dim }, `mode ${s.mode}`),
      h(Text, { color: C.dim }, `${s.turns} turn${s.turns === 1 ? "" : "s"}`),
    ),
    h(
      Box,
      { marginTop: 1, gap: 2 },
      h(Text, { color: C.dim }, "context "),
      h(Text, { color: ctxFrac > 0.85 ? C.bad : ctxFrac > 0.6 ? C.warn : C.accentDim }, bar(ctxFrac, 16)),
      h(Text, { color: C.dim }, `${ctxPct}%  ${humanTokens(s.contextUsed)}/${humanTokens(s.contextLimit)}`),
    ),
    h(
      Box,
      { gap: 2 },
      h(Text, { color: C.dim }, "tokens  "),
      h(
        Text,
        { color: C.faint },
        `${humanTokens(s.usage.input)} in · ${humanTokens(s.usage.output)} out · ${humanTokens(s.usage.cacheRead)} cr · ${humanTokens(s.usage.cacheWrite)} cw`,
      ),
      h(Text, { color: s.costUsd ? C.good : C.faint }, money(s.costUsd)),
    ),
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: C.faint }, "⌥ "),
      h(Text, { color: C.dim, wrap: "truncate-end" }, gitLine),
    ),
    g?.lastCommitSubject
      ? h(Text, { color: C.faint, wrap: "truncate-end" }, `  “${truncate(g.lastCommitSubject, width - 8)}”`)
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
}: {
  state: TuiState;
  width: number;
  height: number;
}): ReactNode {
  const all = visibleLog(state);
  const rows = Math.max(1, height - 2); // borders
  const lines = all.slice(-rows);

  return h(
    Box,
    { width, borderStyle: "round", borderColor: C.faint, paddingX: 1, flexDirection: "column", flexGrow: 1 },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { color: C.dim }, "EVENTS"),
      h(Text, { color: C.faint }, state.logFilter === "all" ? "all sessions" : "this session"),
    ),
    ...(lines.length === 0
      ? [h(Text, { key: "none", color: C.faint }, "  (quiet)")]
      : lines.map((l) => LogRow({ l, width, tagged: state.logFilter === "all" }))),
  );
}

function LogRow({ l, width, tagged }: { l: LogLine; width: number; tagged: boolean }): ReactNode {
  const prefix = `${clock(l.ts)} `;
  const tag = tagged ? `${shortId(l.sessionId)} ` : "";
  const room = Math.max(8, width - prefix.length - tag.length - 4);
  return h(
    Box,
    { key: `${l.seq}-${l.ts}`, width },
    h(Text, { color: C.faint }, prefix),
    tagged ? h(Text, { color: C.faint }, tag) : null,
    h(Text, { color: TONE_COLOR[l.tone] }, `${l.glyph} `),
    h(Text, { color: TONE_COLOR[l.tone], wrap: "truncate-end" }, truncate(l.text, room)),
  );
}

// ---------------------------------------------------------------------------
// footer: hints / prompt / notice
// ---------------------------------------------------------------------------

export function Footer({ state, width }: { state: TuiState; width: number }): ReactNode {
  if (state.mode === "prompt" && state.prompt) {
    return h(
      Box,
      { width, paddingX: 1 },
      h(Text, { color: C.accent, bold: true }, `${state.prompt.label} `),
      h(Text, { color: C.text }, state.prompt.value),
      h(Text, { color: C.accent }, "▎"),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: C.faint }, "enter submit · esc cancel"),
    );
  }

  const hints = actionsFor(selectedSession(state));
  return h(
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
  );
}

// ---------------------------------------------------------------------------
// help overlay
// ---------------------------------------------------------------------------

const HELP_ROWS: Array<[string, string]> = [
  ["↑ / ↓  ·  j / k", "move selection"],
  ["a", "approve a permission request / answer a question"],
  ["d", "deny a permission request"],
  ["s", "send a follow-up turn"],
  ["i", "interrupt the current turn"],
  ["r", "resume an interrupted session"],
  ["x", "mark the session done (worktree kept)"],
  ["n", "start a new session"],
  ["f", "toggle the event log between this session and all"],
  ["?", "toggle this help"],
  ["q  ·  ctrl-c", "quit the UI (the daemon keeps running)"],
];

export function Help({ width }: { width: number }): ReactNode {
  return h(
    Box,
    {
      width,
      borderStyle: "round",
      borderColor: C.accent,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
    },
    h(Text, { color: C.accent, bold: true }, "loom — keys"),
    h(Box, { height: 1 }),
    ...HELP_ROWS.map(([k, v], i) =>
      h(
        Box,
        { key: i, gap: 2 },
        h(Box, { width: 18 }, h(Text, { color: C.accent }, k)),
        h(Text, { color: C.dim }, v),
      ),
    ),
    h(Box, { height: 1 }),
    h(Text, { color: C.faint }, "loom drives worktrees only — it never pushes or touches your remotes."),
  );
}
