import { z } from "zod";
import { workerFailureSchema } from "./worker-failure.ts";

export const relayDiagnosticSchema = z.object({
  kind: z.enum(["egress", "mcp", "git", "unknown"]),
  index: z.int().min(0).max(65535),
  event: z.enum([
    "accept_error",
    "accepted",
    "forwarded",
    "accept_exhausted",
    "accept_fatal",
    "closed",
    "accept_closed",
    "suppressed",
  ]),
  at: z.int().nonnegative(),
  incident: z.int().nonnegative(),
  error: workerFailureSchema.shape.name,
  consecutive: z.int().nonnegative(),
  failures: z.int().nonnegative(),
  active: z.int().nonnegative(),
  elapsedMs: z.int().nonnegative(),
  stopping: z.boolean(),
  hostStopping: z.boolean().optional(),
  suppressed: z.int().nonnegative(),
});
export type RelayDiagnostic = z.infer<typeof relayDiagnosticSchema>;

export const relayDiagnosticMessage = (info: RelayDiagnostic): string =>
  `VM relay ${info.kind}[${info.index}] ${info.event}: ${info.error}; at=${info.at}, incident=${info.incident}, consecutive=${info.consecutive}, failures=${info.failures}, active=${info.active}, elapsed=${info.elapsedMs}ms, stopping=${info.stopping}, hostStopping=${info.hostStopping ?? "unknown"}, suppressed=${info.suppressed}`;
