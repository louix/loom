/**
 * Entry point for the terminal UI (design spec §11.5). `loom` with no command
 * in an interactive terminal, or `loom tui` explicitly, lands here. The TUI is
 * "just another {@link LoomClient}" — it opens one with reconnect enabled and
 * renders {@link App} until the user quits; the daemon keeps running.
 *
 * Ink and React are imported here and nowhere else, and this module is loaded
 * lazily by the CLI so plain commands pay nothing for it. This module also owns
 * the `$EDITOR` handoff, since suspending Ink's hold on the terminal has to
 * happen around the `render()` instance.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render, type Instance } from "ink";
import type { LoomClient } from "../client/client.ts";
import { App } from "./app.ts";

/**
 * Open `text` in `$EDITOR`, blocking until it exits; returns the saved body (or
 * `null` if it couldn't run). The `text` file is always the first argument, so
 * it's the buffer the editor lands on. `aside`, when given, is written as a
 * second file argument (mode `0444`, so the editor marks it read-only and won't
 * let it go dirty) purely to copy from — its contents are never read back, and
 * you only ever need to `:wq` the primary file.
 */
export type EditorHandoff = (
  text: string,
  opts?: { ext?: string; aside?: { name: string; body: string } },
) => string | null;

export async function runTui(client: LoomClient): Promise<void> {
  let instance: Instance;

  const openEditor: EditorHandoff = (text, opts = {}) => {
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
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    try {
      instance.clear();
      if (stdin.isTTY) stdin.setRawMode(false);
      const [cmd, ...pre] = editor.split(/\s+/).filter(Boolean);
      const r = spawnSync(cmd ?? "vi", [...pre, file, ...extra], { stdio: "inherit" });
      if (r.error) return null;
      return readFileSync(file, "utf8");
    } catch {
      return null;
    } finally {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      rmSync(dir, { recursive: true, force: true });
      // The editor scribbled all over the screen and left Ink's cursor
      // bookkeeping stale — hard-clear and force a full repaint from the top.
      instance.clear();
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      instance.rerender(createElement(App, { client, openEditor }));
    }
  };

  // Ask the terminal to bracket pastes so a multi-line paste arrives as one
  // chunk instead of a stream of Enter-looking carriage returns.
  if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");

  instance = render(createElement(App, { client, openEditor }), { exitOnCtrlC: false });

  try {
    await instance.waitUntilExit();
  } finally {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
    await client.close();
  }
}
