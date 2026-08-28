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
  clock,
  groupsOf,
  selectedSession,
  visibleLog,
  type ConfirmState,
  type LogLine,
  type PromptState,
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

/** Inner width of a `borderStyle:"round"` + `paddingX:1` box. */
const inside = (w: number): number => Math.max(4, w - 4);

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

export function Fleet({ state, tick, width }: { state: TuiState; tick: number; width: number }): ReactNode {
  const groups = groupsOf(state.sessions);
  const iw = inside(width);

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
            ...g.sessions.map((s) => FleetRow({ s, selected: s.id === state.selectedId, tick, iw })),
          ),
        );

  return h(
    Box,
    { flexDirection: "column", width, borderStyle: "round", borderColor: C.faint, paddingX: 1 },
    h(Text, { color: C.dim }, "FLEET"),
    h(Box, { flexDirection: "column", marginTop: 1 }, ...blocks),
  );
}

function FleetRow({
  s,
  selected,
  tick,
  iw,
}: {
  s: SessionSnapshot;
  selected: boolean;
  tick: number;
  iw: number;
}): ReactNode {
  const look = STATUS[s.status];
  const glyph = s.status === "running" ? spinnerFrame(tick) : look.glyph;
  const id = shortId(s.id);
  const cost = money(s.costUsd);
  const room = Math.max(6, iw - (2 + 2 + id.length + 2 + cost.length + 1));
  const title = truncate(s.title ?? "(untitled)", room).padEnd(room);

  return h(
    Text,
    { key: s.id, wrap: "truncate-end" },
    h(Text, { color: selected ? C.accent : C.faint }, selected ? "▍ " : "  "),
    h(Text, { color: s.status === "running" ? C.accent : look.color }, glyph + " "),
    h(Text, { color: C.faint }, `${id}  `),
    h(Text, { color: selected ? C.text : C.dim, bold: selected }, title),
    h(Text, { color: C.faint }, ` ${cost}`),
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
  const w = inside(width);
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
    h(Text, { color: C.text, wrap: "truncate-end" }, truncate(s.title ?? "(untitled)", w)),
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
    h(
      Box,
      { gap: 2 },
      h(Text, { color: C.dim }, "tokens "),
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
      ? h(Text, { color: C.faint, wrap: "truncate-end" }, `  “${truncate(g.lastCommitSubject, w - 4)}”`)
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
  const all = visibleLog(state);
  const rows = Math.max(1, height - 3); // header line + top/bottom border + hint row
  const maxScroll = Math.max(0, all.length - rows);
  const off = Math.min(scroll, maxScroll);
  const end = all.length - off;
  const lines = all.slice(Math.max(0, end - rows), end);
  const above = Math.max(0, end - rows);

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
        (state.logFilter === "all" ? "all sessions" : "this session") +
          (off > 0 ? `  ·  ↑${above} more` : ""),
      ),
    ),
    ...(lines.length === 0
      ? [h(Text, { key: "none", color: C.faint }, "  (quiet)")]
      : lines.map((l) => LogRow({ l, tagged: state.logFilter === "all", iw: inside(width) }))),
  );
}

function LogRow({ l, tagged, iw }: { l: LogLine; tagged: boolean; iw: number }): ReactNode {
  const ts = `${clock(l.ts)} `;
  const tag = tagged ? `${shortId(l.sessionId)} ` : "";
  const room = Math.max(8, iw - ts.length - tag.length - 2);
  return h(
    Text,
    { key: `${l.seq}-${l.ts}`, wrap: "truncate-end" },
    h(Text, { color: C.faint }, ts + tag),
    h(Text, { color: TONE_COLOR[l.tone] }, `${l.glyph} `),
    h(Text, { color: TONE_COLOR[l.tone] }, truncate(l.text.replace(/\s+/g, " ").trim(), room)),
  );
}

// ---------------------------------------------------------------------------
// text editor view (used by the prompt)
// ---------------------------------------------------------------------------

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

  return h(
    Box,
    { flexDirection: "column" },
    ...lines.map((ln, r) => {
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
      return h(Box, { key: r }, h(Text, { color: C.accent }, "▍ "), content);
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
};

function promptHints(p: PromptState): string {
  const bits = [`enter ${MODE_HINT[p.kind]}`, "⌃E editor"];
  if (p.kind === "new") bits.push(`⇧⇥ mode:${p.mode ?? "default"}`);
  if (p.kind === "new" || p.kind === "send") bits.push("↑↓ history");
  bits.push("esc cancel");
  return bits.join("  ·  ");
}

export function FooterArea({ state, width }: { state: TuiState; width: number }): ReactNode {
  if (state.mode === "prompt" && state.prompt) {
    const p = state.prompt;
    const placeholder =
      p.kind === "deny" ? "reason (optional)" : p.kind === "new" ? "describe the task…" : "type a message…";
    return h(
      Box,
      { flexDirection: "column", width, paddingX: 1 },
      h(
        Box,
        { gap: 1 },
        h(Text, { color: C.accent, bold: true }, p.label),
        p.kind === "new" ? h(Text, { color: C.warn }, `[${p.mode ?? "default"}]`) : null,
      ),
      h(EditorView, { buf: p.buffer, width: width - 2, placeholder }),
      h(Text, { color: C.faint }, promptHints(p)),
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
  const editor = Math.min(8, Math.max(1, state.prompt.buffer.text.split("\n").length));
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
// help overlay
// ---------------------------------------------------------------------------

const HELP_ROWS: Array<[string, string]> = [
  ["↑ / ↓  ·  j / k", "move the selection"],
  ["PgUp / PgDn", "scroll the event log"],
  ["⇥", "toggle the fullscreen event log"],
  ["⌃e", "open the event log in $EDITOR (to copy text out)"],
  ["a  ·  d", "approve / answer  ·  deny a permission request"],
  ["s", "send a follow-up turn"],
  ["i  ·  r", "interrupt the turn  ·  resume an interrupted / errored session"],
  ["x", "mark the session done (worktree kept)"],
  ["⇧⇥  ·  m", "cycle the selected session's permission mode"],
  ["n", "start a new session"],
  ["f", "toggle the event log between this session and all"],
  ["R", "restart the daemon (with confirmation)"],
  ["Q", "quit the UI and stop the daemon (with confirmation)"],
  ["q  ·  ⌃c", "quit the UI — the daemon keeps running"],
  ["?  ·  esc", "toggle this help  ·  back out of any overlay"],
];

const EDIT_ROWS: Array<[string, string]> = [
  ["enter  ·  esc", "submit  ·  cancel"],
  ["⌃e", "hand the text to $EDITOR (`:wq` to return); nothing is sent until you press enter"],
  ["⌃a", "start of line     ⌃u / ⌃k  kill to start / end     ⌃w  delete word"],
  ["↑ / ↓  ·  ⇧⇥", "prompt history     ·     cycle the mode (new session)"],
];

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
