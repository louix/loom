/**
 * Entry point for the terminal UI (design spec §11.5). `loom` with no command
 * in an interactive terminal, or `loom tui` explicitly, lands here. The TUI is
 * "just another {@link LoomClient}" — it opens one with reconnect enabled and
 * renders {@link App} until the user quits; the daemon keeps running.
 *
 * Ink and React are imported here and nowhere else, and this module is loaded
 * lazily by the CLI so plain commands pay nothing for it.
 */
import { createElement } from "react";
import { render } from "ink";
import type { LoomClient } from "../client/client.ts";
import { App } from "./app.ts";

export async function runTui(client: LoomClient): Promise<void> {
  const instance = render(createElement(App, { client }), {
    // The App owns Ctrl-C so it can close the client before unmounting.
    exitOnCtrlC: false,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    await client.close();
  }
}
