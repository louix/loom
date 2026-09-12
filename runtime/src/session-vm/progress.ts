/** Fixed startup messages shared by the host supervisor and guest bootstrap. */
export const startupStages = {
  restore: "Restoring prepared environment…",
  init: "Running session init hooks…",
  runtime: "Preparing VM runtime…",
  clone: "Creating writable disks from the prepared environment…",
  copy: "Copying VM disks…",
  cold: "No compatible prepared environment; starting from the generic runtime…",
  boot: "Starting VM…",
  nix: "Initializing Nix…",
  activate: "Entering the repo environment…",
  prepare: "Running the prepare command…",
  provider: "Starting the agent…",
  ready: "Session ready.",
} as const;
export type StartupStage = keyof typeof startupStages;
export const startupFailures = {
  devices:
    "The VM backend ran out of virtual devices (IRQs). Use a worktree inside the repo to reduce filesystem mounts.",
  space: "The VM backend ran out of disk space. Free space on the host before retrying.",
  permission:
    "The VM backend could not access a required file or device. Check host filesystem and virtualization permissions.",
  disk: "The VM disk or filesystem is invalid. Run loom environment prepare to rebuild the prepared base.",
  backend: "The VM backend failed before the agent could start.",
} as const;
export type StartupFailure = keyof typeof startupFailures;
/** Classify host backend errors; raw stderr never crosses the credential boundary. */
export const classifyStartupFailure = (error: unknown): StartupFailure => {
  const message = error instanceof Error ? error.message : String(error);
  if (/no more IRQs|too many.*devices/i.test(message)) return "devices";
  if (/no space left|ENOSPC/i.test(message)) return "space";
  if (/permission denied|EACCES|operation not permitted/i.test(message)) return "permission";
  if (
    /filesystem.*(?:corrupt|size)|bad superblock|short read|invalid.*(?:qcow|disk)/i.test(message)
  )
    return "disk";
  return "backend";
};
export const startupMessage = (stage: StartupStage, elapsedSeconds?: number) =>
  startupStages[stage] + (elapsedSeconds === undefined ? "" : ` (${elapsedSeconds}s elapsed)`);
export const reportStartup = (stage: StartupStage, elapsedSeconds?: number) =>
  console.error(
    Deno.env.get("LOOM_PREPARATION_ONLY") === "1"
      ? startupMessage(stage, elapsedSeconds)
      : JSON.stringify({ loomStartup: stage, elapsedSeconds }),
  );

/** Discard vendor diagnostics; only known phase names cross this channel. */
export const readStartupProgress = async (
  stream: ReadableStream<Uint8Array>,
  report: (stage: StartupStage, elapsedSeconds?: number) => void,
  failure?: (code: StartupFailure) => void,
) => {
  let line = "";
  let overflow = false;
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
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
          )
            report(
              value.loomStartup as StartupStage,
              Number.isInteger(value.elapsedSeconds) &&
                value.elapsedSeconds >= 0 &&
                value.elapsedSeconds <= 86400
                ? value.elapsedSeconds
                : undefined,
            );
          if (
            typeof value?.loomStartupFailure === "string" &&
            Object.hasOwn(startupFailures, value.loomStartupFailure)
          )
            failure?.(value.loomStartupFailure as StartupFailure);
        } catch {
          /* Not a startup frame. */
        }
      }
      line = "";
      overflow = false;
    }
  }
};
