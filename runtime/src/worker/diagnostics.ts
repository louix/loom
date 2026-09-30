import { workerFailureSchema, type WorkerFailure } from "../../../core/src/worker-failure.ts";

/** Classify locally; never serialize an exception or its arbitrary properties. */
export const describeWorkerFailure = (
  error: unknown,
  origin: WorkerFailure["origin"],
): WorkerFailure => {
  let name: WorkerFailure["name"] = "unknown";
  let code: WorkerFailure["code"] = "unknown";
  const frames: WorkerFailure["frames"] = [];
  try {
    if (error instanceof Error) {
      const parsedName = workerFailureSchema.shape.name.safeParse(error.name);
      if (parsedName.success) name = parsedName.data;
      const candidate = "code" in error ? error.code : undefined;
      const parsedCode = workerFailureSchema.shape.code.safeParse(candidate);
      if (parsedCode.success) code = parsedCode.data;
      else {
        const known = [
          ["worker output overflow", "worker_output_overflow"],
          ["worker frame too large", "worker_frame_too_large"],
          ["connector event overflow", "connector_event_overflow"],
        ] as const;
        code = known.find(([message]) => message === error.message)?.[1] ?? "unknown";
        if (code === "unknown") {
          const match = error.message.match(
            /\b(?:EMFILE|ENFILE|ENOSPC|ENOMEM|EIO|EPIPE|ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EACCES|EPERM|ENOENT)\b/,
          );
          if (match) code = workerFailureSchema.shape.code.parse(match[0]);
          else if (/too many open files(?! in system)|os error 24\b/i.test(error.message))
            code = "EMFILE";
          else if (/no space left on device|os error 28\b/i.test(error.message)) code = "ENOSPC";
        }
      }
      const modules = workerFailureSchema.shape.frames.element.shape.module.options;
      for (const line of (error.stack ?? "").slice(0, 16384).split("\n").slice(1)) {
        const position = line.match(/:(\d+):(\d+)\)?$/);
        if (!position) continue;
        const module = modules.find((m) =>
          m === "claude-agent-sdk"
            ? line.includes("/@anthropic-ai/claude-agent-sdk/") ||
              line.includes("/@anthropic-ai+claude-agent-sdk@")
            : line.includes("/" + m + ":"),
        );
        if (!module) continue;
        const frame = workerFailureSchema.shape.frames.element.safeParse({
          module,
          line: Number(position[1]),
          column: Number(position[2]),
        });
        if (frame.success) frames.push(frame.data);
        if (frames.length === 4) break;
      }
    }
  } catch {
    // Even hostile getters must not hide the original failure or print vendor data.
  }
  return { origin, name, code, frames };
};

let reported = false;
export const reportWorkerFailure = (error: unknown, origin: WorkerFailure["origin"]) => {
  if (reported) return;
  reported = true;
  try {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ loomWorkerFailure: describeWorkerFailure(error, origin) }) + "\n",
    );
    // Fatal exception paths exit immediately; do not leave this buffered in a promise.
    let offset = 0;
    while (offset < bytes.length) offset += Deno.stderr.writeSync(bytes.subarray(offset));
  } catch {
    // The diagnostic channel itself may already be closed.
  }
};

let installed = false;
export const installWorkerDiagnostics = () => {
  if (installed) return;
  installed = true;
  // Observe only: retain Deno's normal nonzero exit on fatal errors.
  addEventListener("error", (event) => reportWorkerFailure(event.error, "uncaught_error"));
  addEventListener("unhandledrejection", (event) =>
    reportWorkerFailure(event.reason, "unhandled_rejection"),
  );
};
