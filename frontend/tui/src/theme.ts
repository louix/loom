/**
 * Visual vocabulary for the terminal UI (design spec §11.5): the palette,
 * per-status glyphs and colours, and a handful of pure formatting helpers.
 * No React in here — components read these constants, and the formatting
 * helpers are unit-tested directly.
 */
import type { SessionStatus } from "@loom/core/events";

export type ThemeMode = "dark" | "light";

type Palette = {
  accent: string;
  accentDim: string;
  await_: string;
  good: string;
  warn: string;
  bad: string;
  text: string;
  dim: string;
  faint: string;
  /** Screen background — painted explicitly (`Layout`'s root `Box`, and every
   *  bordered panel's `borderBackgroundColor`) because a terminal's own
   *  background is whatever the user already has it set to, usually dark; a
   *  "light theme" that only changes foreground hues would still be dark text
   *  read against that dark background. `undefined` leaves the terminal's own
   *  background untouched. */
  bg: string | undefined;
};

const DARK: Palette = {
  accent: "#5eead4",
  accentDim: "#2dd4bf",
  await_: "#c084fc",
  good: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  text: "#e5e7eb",
  dim: "#6b7280",
  faint: "#4b5563",
  bg: undefined,
};

/** Same roles, darkened/saturated for legibility against the explicit light `bg`. */
const LIGHT: Palette = {
  accent: "#0f766e",
  accentDim: "#0d9488",
  await_: "#7c3aed",
  good: "#15803d",
  warn: "#b45309",
  bad: "#b91c1c",
  text: "#111827",
  dim: "#4b5563",
  faint: "#9ca3af",
  bg: "#f4f4f5",
};

let mode: ThemeMode = "dark";

/** Truecolour palette. Mutated in place on {@link setThemeMode} so every
 *  `C.xxx` read across the TUI — most of them inline in JSX — picks up the
 *  new colours on the next render without any prop drilling. */
export const C: Palette = { ...DARK };

export const themeMode = (): ThemeMode => mode;

export const setThemeMode = (m: ThemeMode): void => {
  mode = m;
  Object.assign(C, m === "light" ? LIGHT : DARK);
};

export type Tone = "plain" | "dim" | "accent" | "good" | "warn" | "bad" | "think";

/** Ink colour for a log tone, read fresh so a theme switch takes effect immediately. */
export const toneColor = (t: Tone): string => {
  switch (t) {
    case "plain":
      return C.text;
    case "dim":
      return C.dim;
    case "accent":
      return C.accent;
    case "good":
      return C.good;
    case "warn":
      return C.warn;
    case "bad":
      return C.bad;
    case "think":
      return C.faint;
  }
};

export interface StatusLook {
  glyph: string;
  color: string;
  label: string;
}

/** Fleet-view group order — mirrors the daemon's registry ranking. */
export const STATUS_ORDER: readonly SessionStatus[] = [
  "awaiting_input",
  "running",
  "starting",
  "interrupted",
  "idle",
  "error",
  "done",
];

/** Glyph + label per status — unlike the colour, these don't depend on the theme. */
const STATUS_TEXT: Record<SessionStatus, { glyph: string; label: string }> = {
  awaiting_input: { glyph: "◆", label: "awaiting input" },
  running: { glyph: "●", label: "running" },
  starting: { glyph: "◌", label: "starting" },
  interrupted: { glyph: "⊘", label: "interrupted" },
  idle: { glyph: "○", label: "idle" },
  error: { glyph: "✕", label: "error" },
  done: { glyph: "✓", label: "done" },
};

const statusColor = (s: SessionStatus): string => {
  switch (s) {
    case "awaiting_input":
      return C.await_;
    case "running":
      return C.accent;
    case "starting":
      return C.accentDim;
    case "interrupted":
      return C.warn;
    case "idle":
      return C.good;
    case "error":
      return C.bad;
    case "done":
      return C.faint;
  }
};

/** Glyph + colour + label for a session status, read fresh (colour follows the theme). */
export const statusLook = (s: SessionStatus): StatusLook => ({
  ...STATUS_TEXT[s],
  color: statusColor(s),
});

/** Braille spinner frames for running rows. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const spinnerFrame = (tick: number): string => {
  const i = ((tick % SPINNER.length) + SPINNER.length) % SPINNER.length;
  return SPINNER[i] as string;
};

// ---------------------------------------------------------------------------
// pure formatting helpers (unit-tested)
// ---------------------------------------------------------------------------

/** `abcdef12-…` → `abcdef12`. */
export const shortId = (id: string): string => {
  return id.slice(0, 8);
};

/** Clip to `n` columns, adding an ellipsis when it had to cut. */
export const truncate = (s: string, n: number): string => {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n === 1) return "…";
  return s.slice(0, n - 1) + "…";
};

/** Greedy word wrap to `width` columns; hard-breaks any token longer than it. */
export const wrapText = (s: string, width: number): string[] => {
  if (width <= 0) return [s];
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if (word.length > width) {
      if (line) {
        out.push(line);
        line = "";
      }
      let rest = word;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      line = rest;
    } else if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
};

/** 12345 → "12.3k", 2_000_000 → "2.0M", <1000 stays exact. */
export const humanTokens = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** A unicode meter: `▰▰▰▱▱▱▱▱`. `frac` is clamped to [0,1]. */
export const bar = (frac: number, width = 10): string => {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const filled = Math.round(f * width);
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled));
};

/** A duration in ms → `M:SS` (minutes uncapped), for countdowns. */
export const mmss = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
};

/** A duration in ms → `Nd Nh` / `Nh Nm` / `Nm`, for "resets in …" labels. */
export const humanDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 60_000)); // minutes
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/** ms epoch → local `HH:MM:SS`. */
export const clock = (ts: number): string => {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** "$0.42", or "—" for a zero / missing cost. */
export const money = (usd: number): string => {
  return usd && Number.isFinite(usd) ? `$${usd.toFixed(2)}` : "—";
};

/** How a permission mode reads in the UI. The wire / SDK value stays `default`;
 *  we call it `manual` — you approve everything yourself. */
export const modeLabel = (mode: string | null | undefined): string => {
  return !mode || mode === "default" ? "manual" : mode;
};
