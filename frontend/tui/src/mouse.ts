/**
 * SGR mouse reports. Ink hands them to the key handler as raw input with the
 * leading ESC stripped (`[<Cb;Cx;Cy(M|m)`). Any-motion tracking (`?1003`) is
 * on so the pointer can be followed for hover feedback; a motion report is
 * never a click.
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

/** Press/release, any-motion and SGR encoding — and their reverse. Without
 *  reporting, terminals turn the wheel into ↑/↓ on the alternate screen. */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
/** Bracketed paste, which the TUI turns on alongside the mouse. */
export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";
