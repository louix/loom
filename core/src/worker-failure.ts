import { z } from "zod";

// No arbitrary messages, paths, URLs, or stack text may cross this channel.
export const workerFailureSchema = z.object({
  origin: z.enum(["worker_loop", "uncaught_error", "unhandled_rejection"]),
  name: z.enum([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "AggregateError",
    "BadResource",
    "BrokenPipe",
    "ConnectionAborted",
    "ConnectionRefused",
    "ConnectionReset",
    "Interrupted",
    "NotConnected",
    "NotFound",
    "PermissionDenied",
    "TimedOut",
    "OutOfMemory",
    "WriteZero",
    "UnexpectedEof",
    "unknown",
  ]),
  code: z.enum([
    "EMFILE",
    "ENFILE",
    "ENOSPC",
    "ENOMEM",
    "EIO",
    "EPIPE",
    "ECONNRESET",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EACCES",
    "EPERM",
    "ENOENT",
    "worker_output_overflow",
    "worker_frame_too_large",
    "connector_event_overflow",
    "unknown",
  ]),
  frames: z
    .array(
      z.object({
        module: z.enum([
          "runtime/src/worker/main.ts",
          "runtime/src/worker/serve.ts",
          "runtime/src/worker/transport.ts",
          "runtime/src/session-vm/guest.ts",
          "runtime/src/session-vm/guest-relay.ts",
          "connectors/claude/src/adapter.ts",
          "core/src/worker.ts",
          "claude-agent-sdk",
        ]),
        line: z.int().min(1).max(10000000),
        column: z.int().min(1).max(10000000),
      }),
    )
    .max(4),
});
export type WorkerFailure = z.infer<typeof workerFailureSchema>;
