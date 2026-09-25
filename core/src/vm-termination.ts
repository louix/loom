import { z } from "zod";

/** Only fixed categories and process metadata cross the VM credential boundary. */
export const vmStopReasonSchema = z.enum([
  "guest_exit",
  "stdout_closed",
  "parent_disconnected",
  "signal",
  "startup_timeout",
  "input_error",
  "output_error",
  "diagnostics_error",
  "supervisor_error",
  "connection_closed",
]);
export const hostStopReasonSchema = z.enum([
  "idle_suspension",
  "credential_expired",
  "credential_setup_failed",
  "user_stop",
  "daemon_shutdown",
  "session_close",
  "worker_failure",
]);
export type HostStopReason = z.infer<typeof hostStopReasonSchema>;
export const vmExitSchema = z.object({
  code: z.int().min(0).max(255).nullable(),
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]{1,12}$/)
    .nullable(),
});
export const vmTerminationSchema = z.object({
  reason: vmStopReasonSchema,
  at: z.number().int().nonnegative(),
  phase: z.enum(["starting", "running", "unknown"]),
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]{1,12}$/)
    .optional(),
  /** Status of smolvm's guest execution process, observed before cleanup. */
  guestExit: vmExitSchema.optional(),
  supervisorExit: vmExitSchema.optional(),
  hostReason: hostStopReasonSchema.optional(),
  stage: z
    .string()
    .regex(/^[a-zA-Z]{1,32}$/)
    .optional(),
  activity: z
    .enum([
      "starting",
      "running",
      "idle",
      "working_background",
      "awaiting_input",
      "error",
      "interrupted",
      "done",
    ])
    .optional(),
  lastNetworkWarning: z
    .object({
      host: z.string().regex(/^[a-zA-Z0-9.:[\]? -]{1,200}$/),
      at: z.number().int().nonnegative(),
    })
    .optional(),
});
export type VmTermination = z.infer<typeof vmTerminationSchema>;
export type VmStopReason = VmTermination["reason"];

export const vmTerminationMessage = (info: VmTermination): string => {
  const reason = (info.hostReason ?? info.reason).replaceAll("_", " ");
  const exit = info.guestExit;
  const status = exit ? `; guest execution exited with ${exit.signal ?? `code ${exit.code}`}` : "";
  const warning = info.lastNetworkWarning
    ? `; last network warning: ${info.lastNetworkWarning.host}, ${Math.max(0, Math.round((info.at - info.lastNetworkWarning.at) / 1000))}s earlier (not an established cause)`
    : "";
  return `Session VM stopped: ${reason}${info.activity ? ` while ${info.activity}` : ` during ${info.phase}`}${status}${warning}.`;
};

export class VmTerminationError extends Error {
  readonly termination: VmTermination;
  constructor(termination: VmTermination, detail?: string) {
    super(vmTerminationMessage(termination) + (detail ? ` ${detail}` : ""));
    this.termination = termination;
  }
}
