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
export const reportStartup = (stage: StartupStage) =>
  console.error(
    Deno.env.get("LOOM_PREPARATION_ONLY") === "1"
      ? startupStages[stage]
      : JSON.stringify({ loomStartup: stage }),
  );

/** Discard vendor diagnostics; only known phase names cross this channel. */
export const readStartupProgress = async (
  stream: ReadableStream<Uint8Array>,
  report: (stage: StartupStage) => void,
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
            report(value.loomStartup as StartupStage);
        } catch {
          /* Not a startup frame. */
        }
      }
      line = "";
      overflow = false;
    }
  }
};
