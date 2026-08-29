/**
 * Entry point for the terminal UI (design spec §11.5). `loom` with no command
 * in an interactive terminal, or `loom tui` explicitly, lands here. The TUI is
 * "just another {@link LoomClient}" — it opens one with reconnect enabled and
 * renders {@link App} until the user quits; the daemon keeps running.
 *
 * Ink and React are imported here and nowhere else, and this module is loaded
 * lazily by the CLI so plain commands pay nothing for it. The `$EDITOR` handoff
 * lives in `App`, which drives it through Ink 7.1's `useApp().suspendTerminal`.
 */
import { createElement } from "react";
import { render } from "ink";
import type { LoomClient } from "../client/client.ts";
import { App } from "./app.ts";

export async function runTui(client: LoomClient): Promise<void> {
  // Ask the terminal to bracket pastes so a multi-line paste arrives as one
  // chunk instead of a stream of Enter-looking carriage returns.
  if (process.stdout.isTTY) process.stdout.write("\x1b[?2004h");

  const instance = render(createElement(App, { client }), { exitOnCtrlC: false });

  try {
    await instance.waitUntilExit();
  } finally {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
    await client.close();
  }
}
