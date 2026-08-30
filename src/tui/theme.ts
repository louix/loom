/**
 * Visual vocabulary for the terminal UI (design spec §11.5): the palette,
 * per-status glyphs and colours, and a handful of pure formatting helpers.
 * No React in here — components read these constants, and the formatting
 * helpers are unit-tested directly.
 */
import type { SessionStatus } from "@loom/core/events";

/** Truecolour palette. One accent (teal); everything else stays quiet. */
export const C = {
  accent: "#5eead4",
  accentDim: "#2dd4bf",
  await_: "#c084fc",
  good: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  text: "#e5e7eb",
  dim: "#6b7280",
  faint: "#4b5563",
} as const;

export type Tone = "plain" | "dim" | "accent" | "good" | "warn" | "bad" | "think";

export const TONE_COLOR: Record<Tone, string> = {
  plain: C.text,
  dim: C.dim,
  accent: C.accent,
  good: C.good,
  warn: C.warn,
  bad: C.bad,
  think: C.faint,
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

export const STATUS: Record<SessionStatus, StatusLook> = {
  awaiting_input: { glyph: "◆", color: C.await_, label: "awaiting input" },
  running: { glyph: "●", color: C.accent, label: "running" },
  starting: { glyph: "◌", color: C.accentDim, label: "starting" },
  interrupted: { glyph: "⊘", color: C.warn, label: "interrupted" },
  idle: { glyph: "○", color: C.good, label: "idle" },
  error: { glyph: "✕", color: C.bad, label: "error" },
  done: { glyph: "✓", color: C.faint, label: "done" },
};

/** Braille spinner frames for running rows. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(tick: number): string {
  const i = ((tick % SPINNER.length) + SPINNER.length) % SPINNER.length;
  return SPINNER[i] as string;
}

// ---------------------------------------------------------------------------
// pure formatting helpers (unit-tested)
// ---------------------------------------------------------------------------

/** `abcdef12-…` → `abcdef12`. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Clip to `n` columns, adding an ellipsis when it had to cut. */
export function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n === 1) return "…";
  return s.slice(0, n - 1) + "…";
}

/** Greedy word wrap to `width` columns; hard-breaks any token longer than it. */
export function wrapText(s: string, width: number): string[] {
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
}

/** 12345 → "12.3k", 2_000_000 → "2.0M", <1000 stays exact. */
export function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A unicode meter: `▰▰▰▱▱▱▱▱`. `frac` is clamped to [0,1]. */
export function bar(frac: number, width = 10): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const filled = Math.round(f * width);
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled));
}

/** A duration in ms → `M:SS` (minutes uncapped), for countdowns. */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

/** ms epoch → local `HH:MM:SS`. */
export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "$0.42", or "—" for a zero / missing cost. */
export function money(usd: number): string {
  return usd && Number.isFinite(usd) ? `$${usd.toFixed(2)}` : "—";
}

/** How a permission mode reads in the UI. The wire / SDK value stays `default`;
 *  we call it `manual` — you approve everything yourself. */
export function modeLabel(mode: string | null | undefined): string {
  return !mode || mode === "default" ? "manual" : mode;
}
