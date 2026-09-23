/** Fixed startup messages shared by the host supervisor and guest bootstrap. */
import { decodeTextStream } from "../../../core/src/text-stream.ts";
import { isFileLimitError, fileLimitDiagnostic } from "./file-limit.ts";
import { fileLimitScanner } from "./file-limit-scanner.ts";
export const startupStages = {
  init: "Running session init hooks…",
  runtime: "Preparing VM runtime…",
  clone: "Creating writable disks from the prepared environment…",
  copy: "Copying VM disks…",
  cold: "No compatible prepared environment; starting from the generic runtime…",
  boot: "Starting VM…",
  checkout: "Preparing the session clone…",
  nix: "Initializing Nix…",
  networkBlocked: "VM network policy blocked a request; check network presets and allowed hosts.",
  activate: "Entering the repo environment…",
  devenv: "Activating devenv…",
  flake: "Activating Nix flake.nix…",
  shell: "Activating Nix shell.nix…",
  default: "Activating Nix default.nix…",
  prepare: "Running the prepare command…",
  provider: "Starting the agent…",
  ready: "Session ready.",
} as const;
export type StartupStage = keyof typeof startupStages;
export const startupFailures = {
  files: fileLimitDiagnostic,
  devices:
    "The VM backend ran out of virtual devices (IRQs). Use a worktree inside the repo to reduce filesystem mounts.",
  space: "The VM backend ran out of disk space. Free space on the host before retrying.",
  permission:
    "The VM backend could not access a required file or device. Check host filesystem and virtualization permissions.",
  disk: "The VM disk or filesystem is invalid. Run loom vm prepare to rebuild the prepared base.",
  backend: "The VM backend failed before the agent could start.",
} as const;
export type StartupFailure = keyof typeof startupFailures;
/** Classify host backend errors; raw stderr never crosses the credential boundary. */
export const classifyStartupFailure = (error: unknown): StartupFailure => {
  const message = error instanceof Error ? error.message : String(error);
  if (isFileLimitError(error)) return "files";
  if (/no more IRQs|too many.*devices/i.test(message)) return "devices";
  if (/no space left|ENOSPC/i.test(message)) return "space";
  if (/permission denied|EACCES|operation not permitted/i.test(message)) {
    return "permission";
  }
  if (
    /filesystem.*(?:corrupt|size)|bad superblock|short read|invalid.*(?:qcow|disk)/i.test(message)
  ) {
    return "disk";
  }
  return "backend";
};
/** Egress already reduces blocked authorities to this alphabet; anything else is dropped. */
const safeHost = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9.:[\]? -]{1,200}$/.test(value) ? value : undefined;
export const startupMessage = (stage: StartupStage, elapsedSeconds?: number, host?: string) =>
  (stage === "networkBlocked" && host
    ? `VM network policy blocked a request to ${host}; check network presets and allowed hosts.`
    : startupStages[stage]) + (elapsedSeconds === undefined ? "" : ` (${elapsedSeconds}s elapsed)`);
export const reportStartup = (stage: StartupStage, elapsedSeconds?: number, host?: string) =>
  console.error(
    Deno.env.get("LOOM_PREPARATION_ONLY") === "1"
      ? startupMessage(stage, elapsedSeconds, host)
      : JSON.stringify({
          loomStartup: stage,
          elapsedSeconds,
          host: safeHost(host),
        }),
  );

/** Discard vendor diagnostics; only known phase names (and sanitized hosts) cross this channel. */
export const readStartupProgress = async (
  stream: ReadableStream<Uint8Array>,
  report: (stage: StartupStage, elapsedSeconds?: number, host?: string) => void,
  failure?: (code: StartupFailure) => void,
) => {
  let line = "";
  let overflow = false;
  const scan = fileLimitScanner();
  let reportedFiles = false;
  for await (const chunk of decodeTextStream(stream)) {
    // Recognize split/long stderr diagnostics without forwarding any vendor text.
    if (!reportedFiles && scan(chunk)) {
      reportedFiles = true;
      failure?.("files");
    }
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!overflow) {
        line += part;
        if (line.length > 256) overflow = true;
      }
      if (!part.endsWith("\n")) continue;
      if (!overflow) {
        try {
          const value = JSON.parse(line);
          if (
            typeof value?.loomStartup === "string" &&
            Object.hasOwn(startupStages, value.loomStartup)
          ) {
            report(
              value.loomStartup as StartupStage,
              Number.isInteger(value.elapsedSeconds) &&
                value.elapsedSeconds >= 0 &&
                value.elapsedSeconds <= 86400
                ? value.elapsedSeconds
                : undefined,
              safeHost(value.host),
            );
          }
          if (
            typeof value?.loomStartupFailure === "string" &&
            Object.hasOwn(startupFailures, value.loomStartupFailure)
          ) {
            failure?.(value.loomStartupFailure as StartupFailure);
          }
        } catch {
          /* Not a startup frame. */
        }
      }
      line = "";
      overflow = false;
    }
  }
  if (!reportedFiles && scan("", true)) failure?.("files");
};
