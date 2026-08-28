import { appendFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;
let fileSink: string | null = null;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

/** Tee log lines to a file as well as stderr (used by the daemon). */
export function setLogFile(path: string | null): void {
  fileSink = path;
}

function emit(level: LogLevel, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ?? {}),
  });
  process.stderr.write(line + "\n");
  if (fileSink) {
    try {
      appendFileSync(fileSink, line + "\n");
    } catch {
      // best effort; never let logging crash the daemon
    }
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function makeLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
    child: (sub) => makeLogger(`${scope}:${sub}`),
  };
}
