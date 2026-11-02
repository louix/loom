/* eslint-disable no-control-regex -- Decode terminal escape sequences. */
import { useEffect, useState } from "react";
import { useStdin } from "ink";

export type ProgramTab = "fleet" | "notes";
/** Ink suppresses function keys in useInput. Observe the raw stream without consuming it.
 * Keep partial escape sequences and bracketed-paste state across reads. */
export const programTabDecoder = (select: (tab: ProgramTab) => void) => {
  let pending = "",
    paste = false;
  return (chunk: string | Uint8Array) => {
    pending += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    while (pending) {
      const esc = pending.indexOf("\x1b");
      if (esc < 0) {
        pending = "";
        return;
      }
      pending = pending.slice(esc);
      if (pending.length === 1) return;
      const match = /^\x1b(?:O.|\[[0-9;:]*[A-Za-z~]|\[\[[A-Z])/.exec(pending);
      if (!match) {
        if (/^\x1b(?:O|\[[0-9;:]*|\[\[)$/.test(pending)) return;
        pending = pending.slice(1);
        continue;
      }
      const code = match[0];
      pending = pending.slice(code.length);
      if (code === "\x1b[200~") {
        paste = true;
        continue;
      }
      if (code === "\x1b[201~") {
        paste = false;
        continue;
      }
      if (paste) continue;
      if (/^\x1b(?:OP|\[P|\[1;1P|\[11~|\[\[A|\[57364u)$/.test(code)) select("fleet");
      if (/^\x1b(?:OS|\[S|\[1;1S|\[14~|\[\[D|\[57367u)$/.test(code)) select("notes");
    }
  };
};
export const useProgramTabs = () => {
  const [tab, setTab] = useState<ProgramTab>("fleet");
  const { stdin } = useStdin();
  useEffect(() => {
    const decode = programTabDecoder(setTab);
    stdin.on("data", decode);
    return () => {
      stdin.off("data", decode);
    };
  }, [stdin]);
  return [tab, setTab] as const;
};
