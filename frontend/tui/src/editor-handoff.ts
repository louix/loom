/**
 * The `$EDITOR` handoff, minus any Ink knowledge. `App` wraps `spawnEditor` in
 * `useApp().suspendTerminal(...)`, which flushes Ink's frame, hands the terminal
 * to the child, and forces a full redraw on return — the manual
 * `instance.clear()` + `rerender()` dance this used to do left Ink's `lastOutput`
 * stale, so a re-render that produced an identical frame wrote nothing and the
 * screen stayed blank until the next keystroke.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type EditorOpts = {
  /** Extension for the temp file, so the editor picks syntax / filetype. */
  ext?: string;
  /**
   * A second, read-only file to open alongside — purely to read/copy from. Its
   * contents are never read back; you only ever `:wq` the primary file.
   */
  aside?: { name: string; body: string };
};

export type EditorHandoff = (text: string, opts?: EditorOpts) => Promise<string | null>;

/**
 * Open `text` in `$EDITOR` (blocking); return the saved body, or `null` if the
 * editor couldn't run. Must be called with the terminal already handed over
 * (Ink suspended), so it does no screen management of its own.
 */
export function spawnEditor(text: string, opts: EditorOpts = {}): string | null {
  const ext = opts.ext ?? "md";
  const editor = process.env["VISUAL"] || process.env["EDITOR"] || "vi";
  const dir = mkdtempSync(join(tmpdir(), "loom-edit-"));
  const file = join(dir, `buffer.${ext}`);
  writeFileSync(file, text);
  const extra: string[] = [];
  if (opts.aside) {
    const asidePath = join(dir, opts.aside.name.replace(/[^\w.-]/g, "_"));
    writeFileSync(asidePath, opts.aside.body);
    try {
      chmodSync(asidePath, 0o444); // read-only: the editor won't let it go dirty
    } catch {
      /* best effort */
    }
    extra.push(asidePath);
  }
  try {
    const [cmd, ...pre] = editor.split(/\s+/).filter(Boolean);
    const r = spawnSync(cmd ?? "vi", [...pre, file, ...extra], { stdio: "inherit" });
    if (r.error) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
