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
import { render, Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import { Picker } from "./components.tsx";
import { applyKey } from "./editor.ts";
import { pickerCurrent, pickerVisible } from "./overlay.ts";
import { repositoryPicker } from "./repositories.ts";
import type { LoomClient } from "@loom/client";
import { App } from "./app.tsx";

const encoder = new TextEncoder();
const writeStdout = (s: string): void => void Deno.stdout.writeSync(encoder.encode(s));

export const runTui = async (
  client: LoomClient,
  /** `logs` — absolute daemon + TUI log paths for the "view logs" command;
   *  `themeState` — the TUI preference file the `t` theme choice persists to. */
  opts: {
    logs?: { daemon: string; tui: string };
    themeState?: string;
    includeEventLogInEditor?: boolean;
    openShell?: (id: string) => Promise<number>;
    prepareEnvironment?: () => Promise<number>;
    repositories?: () => string[];
    checkEnvironment?: () => Promise<string | null>;
  } = {},
): Promise<string | null> => {
  let nextRepository: string | null = null;
  try {
    // Ask the terminal to bracket pastes so a multi-line paste arrives as one
    // chunk instead of a stream of Enter-looking carriage returns. Also turn on
    // SGR mouse reporting so the wheel arrives as its own escape sequence —
    // without it, terminals translate wheel scroll into Up/Down arrow keys on
    // the alt screen, which App's keymap reads as fleet-selection movement.
    if (Deno.stdout.isTerminal()) writeStdout("\x1b[?2004h\x1b[?1000h\x1b[?1006h");

    const environmentWarning = (await opts.checkEnvironment?.()) ?? null;
    const instance = render(
      <App
        client={client}
        includeEventLogInEditor={opts.includeEventLogInEditor ?? false}
        environmentWarning={environmentWarning}
        {...(opts.checkEnvironment ? { checkEnvironment: opts.checkEnvironment } : {})}
        {...(opts.logs ? { logs: opts.logs } : {})}
        {...(opts.themeState ? { themeState: opts.themeState } : {})}
        {...(opts.openShell ? { openShell: opts.openShell } : {})}
        {...(opts.prepareEnvironment ? { prepareEnvironment: opts.prepareEnvironment } : {})}
        {...(opts.repositories ? { repositories: opts.repositories } : {})}
        switchRepository={(path) => {
          nextRepository = path;
          instance.unmount();
        }}
      />,
      {
        exitOnCtrlC: false,
        alternateScreen: true,
        // Mosh ignores Ink's CSI E row skips and has no unique environment
        // marker. LOOM_TUI_COMPAT=1 opts into full redraws for such terminals.
        incrementalRendering: Deno.env.get("LOOM_TUI_COMPAT") !== "1",
      },
    );
    await instance.waitUntilExit();
    return nextRepository;
  } finally {
    if (Deno.stdout.isTerminal()) writeStdout("\x1b[?1006l\x1b[?1000l\x1b[?2004l");
    await client.close();
  }
};

/** The startup screen uses the same picker and filter as the fleet overlay. */
export const RepositoryMenu = ({
  repositories,
  onDone,
}: {
  repositories: string[];
  onDone: (path: string | null) => void;
}) => {
  const [picker, setPicker] = useState(() => repositoryPicker(repositories));
  const { stdout } = useStdout();
  const width = stdout.columns || 100;
  const height = stdout.rows || 30;
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return onDone(null);
    if (key.return) {
      const current = pickerCurrent(picker);
      if (current) onDone(current.id);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setPicker((p) => ({
        ...p,
        index: Math.max(0, Math.min(pickerVisible(p).length - 1, p.index + (key.upArrow ? -1 : 1))),
      }));
      return;
    }
    const result = applyKey(picker.filter, input, key, { multiline: false });
    if (result.kind === "buffer") setPicker({ ...picker, filter: result.buffer, index: 0 });
  });
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={2} paddingTop={1}>
      <Picker picker={picker} width={Math.max(1, width - 4)} height={Math.max(6, height - 4)} />
      <Text dimColor>Type to filter · ↑/↓ select · Enter open · Esc quit</Text>
    </Box>
  );
};

export const pickRepository = async (repositories: string[]): Promise<string | null> => {
  let selected: string | null = null;
  const instance = render(
    <RepositoryMenu
      repositories={repositories}
      onDone={(path) => {
        selected = path;
        instance.unmount();
      }}
    />,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      incrementalRendering: Deno.env.get("LOOM_TUI_COMPAT") !== "1",
    },
  );
  await instance.waitUntilExit();
  return selected;
};
