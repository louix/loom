/**
 * Host side of one foreground execution. The transport child runs in its own
 * session, so terminal-generated signals reach only loom-isolate, which forwards
 * them to the guest command itself rather than killing the transport.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";

export type HostSignal = "SIGINT" | "SIGQUIT" | "SIGTERM" | "SIGHUP";
const hostSignals: HostSignal[] = ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"];

export const signalStatus = (signal: string) =>
  128 + (constants.signals[signal as keyof typeof constants.signals] ?? 0);

/**
 * Route host signals, and treat losing the parent process like a hangup: a
 * foreground environment must not outlive whoever started it.
 */
export const routeSignals = (handle: (signal: HostSignal) => void): (() => void) => {
  const listeners = hostSignals.map((signal) => [signal, () => handle(signal)] as const);
  for (const [signal, listener] of listeners) Deno.addSignalListener(signal, listener);
  const parent = Deno.ppid;
  const watch = setInterval(() => {
    if (Deno.ppid === parent) return;
    clearInterval(watch);
    handle("SIGHUP");
  }, 500);
  return () => {
    clearInterval(watch);
    for (const [signal, listener] of listeners) Deno.removeSignalListener(signal, listener);
  };
};

/** Guest wrapper: publish the command's guest PID for signal delivery, then exec argv unchanged. */
export const guestCommand = (pidFile: string, argv: string[]) => [
  "/bin/sh",
  "-c",
  `echo $$ > ${pidFile} && exec "$@"`,
  "loom-isolate",
  ...argv,
];
/** A bounded wait covers a signal that arrives before the wrapper has started. */
export const guestSignalScript = (pidFile: string, signal: "INT" | "QUIT" | "TERM" | "HUP") =>
  `i=0; while [ ! -s ${pidFile} ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ` +
  `[ -s ${pidFile} ] && kill -${signal} "$(cat ${pidFile})"`;

export interface ForegroundChild {
  status: Promise<number>;
  kill(signal: "SIGKILL" | "SIGWINCH"): void;
}

/** Inherited stdio; the guest's status, or 128+n when the transport itself was killed. */
export const spawnForeground = (
  target: { executable: string; args: string[]; env: Record<string, string> },
  stdin: boolean,
): ForegroundChild => {
  const child = spawn(target.executable, target.args, {
    env: target.env,
    detached: true,
    stdio: [stdin ? "inherit" : "ignore", "inherit", "inherit"],
  });
  const status = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? signalStatus(signal ?? "")));
  });
  let exited = false;
  const settle = () => {
    exited = true;
  };
  void status.then(settle, settle);
  return {
    status,
    kill(signal) {
      // Not ChildProcess.kill: its exit report would name the last signal sent, even SIGWINCH.
      if (exited || !child.pid) return;
      try {
        Deno.kill(child.pid, signal);
      } catch {
        /* exited */
      }
    },
  };
};
