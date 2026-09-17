import type { Key } from "ink";
import type { FleetClient } from "./fleet-handle.ts";

/** Keep this terminal's last focus across daemon reconnects. */
export const terminalFocus = (client: Pick<FleetClient, "request" | "on">) => {
  let focused = true;
  let active = false;
  const report = (value: boolean | null): void => {
    // Older daemons may not support this RPC; reconnect will retry current state.
    void client.request("tui.focus", { focused: value }).catch(() => {});
  };
  return {
    start(): () => void {
      active = true;
      report(focused);
      const off = client.on("reconnect", () => report(focused));
      return () => {
        active = false;
        off();
        report(null);
      };
    },
    set(value: boolean): void {
      if (focused === value) return;
      focused = value;
      if (active) report(focused);
    },
  };
};

export const PASTE_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
