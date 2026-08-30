/**
 * Entry point for the terminal UI (design spec §11.5). `loom` with no command
 * in an interactive terminal, or `loom tui` explicitly, lands here. The TUI is
 * "just another {@link LoomClient}" — it opens one with reconnect enabled and
 * renders {@link App} until the user quits; the daemon keeps running.
 *
 * Ink and React are imported here and nowhere else, and this module is loaded
 * lazily by the CLI so plain commands pay nothing for it. The `$EDITOR` handoff
 * lives in `App`, which drives it through Ink 7.1's `useApp().suspendTerminal`.
 *
 * `alternateScreen` puts the whole UI on the terminal's alternate buffer, so on
 * quit Ink restores the primary buffer exactly as it was before `loom` ran — no
 * half-erased frame left in the scrollback. Ink itself drops out of the alt
 * buffer around a `suspendTerminal` `$EDITOR` handoff and re-enters on return.
 * The option is a no-op when stdout isn't an interactive TTY (tests included).
 */
import { createElement } from "react";
import { render } from "ink";
import type { LoomClient } from "@loom/client";
import { App } from "./app.ts";

export async function runTui(client: LoomClient): Promise<void> {
  // Ask the terminal to bracket pastes so a multi-line paste arrives as one
  // chunk instead of a stream of Enter-looking carriage returns. Also turn on
  // SGR mouse reporting so the wheel arrives as its own escape sequence —
  // without it, terminals translate wheel scroll into Up/Down arrow keys on
  // the alt screen, which App's keymap reads as fleet-selection movement.
  if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h\x1b[?1000h\x1b[?1006h");

  const instance = render(createElement(App, { client }), {
    exitOnCtrlC: false,
    alternateScreen: true,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?2004l");
    await client.close();
  }
}
