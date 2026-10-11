/**
 * SGR mouse reports. Ink hands them to the key handler as raw input with the
 * leading ESC stripped (`[<Cb;Cx;Cy(M|m)`). Any-motion tracking (`?1003`) is
 * on, outside compat mode, so the pointer can be followed for hover feedback;
 * a motion report is never a click.
 */
export type MouseReport = {
  /** The button, with the shift/meta/ctrl and motion bits cleared. */
  readonly button: number;
  readonly x: number;
  readonly y: number;
} & (
  | { readonly kind: "wheel"; readonly pressed: false }
  | { readonly kind: "move"; readonly pressed: false }
  | { readonly kind: "button"; readonly pressed: boolean }
);

export const mouseReport = (input: string): MouseReport | null => {
  const match = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(input);
  if (!match) return null;
  const code = Number(match[1]);
  const point = { button: code & ~(4 | 8 | 16 | 32), x: Number(match[2]), y: Number(match[3]) };
  if (code & 64) return { ...point, kind: "wheel", pressed: false };
  // Bit 32 is motion: a plain move, or a drag with a button held.
  if (code & 32) return { ...point, kind: "move", pressed: false };
  return { ...point, kind: "button", pressed: match[4] === "M" };
};

/** Terminal modes the TUI owns: `on` at start and after every handoff, `off`
 *  before a handoff and at exit. */
export interface TerminalModes {
  readonly on: string;
  readonly off: string;
}

/**
 * Bracketed paste plus mouse reporting: press/release, any-motion and SGR
 * encoding — and their reverse. Without reporting, terminals turn the wheel
 * into ↑/↓ on the alternate screen.
 *
 * Compat mode leaves any-motion (`?1003`) out, as before hover existed: mosh
 * keeps a single tracking mode (the last one set) and would forward only
 * `?1003`, which Termux doesn't implement — leaving no reporting at all, so
 * swipes arrive as ↑/↓ and taps open the soft keyboard. No motion, no hover.
 */
export const terminalModes = (compat: boolean): TerminalModes =>
  compat
    ? { on: "\x1b[?2004h\x1b[?1000h\x1b[?1006h", off: "\x1b[?1006l\x1b[?1000l\x1b[?2004l" }
    : {
        on: "\x1b[?2004h\x1b[?1000h\x1b[?1003h\x1b[?1006h",
        off: "\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?2004l",
      };
