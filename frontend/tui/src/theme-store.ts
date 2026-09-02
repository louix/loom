/**
 * The theme choice (`t`) outlives the TUI: the mode is written to a small JSON
 * file in the repo's `.loom/` (the daemon's runtime dir) on every change and
 * read back when the fleet handle is built. Reads return `null` on anything
 * unusual — absent file, corrupt JSON, an unknown mode — and the caller falls
 * back to the default; writes are best-effort, since the palette is already
 * swapped in memory and a failed write only means the choice doesn't outlive
 * the process.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { THEME_MODES, type ThemeMode } from "./theme.ts";

/** The persisted theme, or `null` when there's nothing usable on disk. */
export const loadPersistedTheme = (path: string): ThemeMode | null => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { theme?: unknown };
    return typeof raw.theme === "string" && (THEME_MODES as readonly string[]).includes(raw.theme)
      ? (raw.theme as ThemeMode)
      : null;
  } catch {
    return null;
  }
};

/** Best-effort write of the theme choice; never throws. */
export const persistTheme = (path: string, mode: ThemeMode): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ theme: mode })}\n`);
  } catch {
    /* best effort — the in-memory palette is already switched */
  }
};
