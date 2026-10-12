import { z } from "zod";
import { transcriptMessageSchema } from "./transcript.ts";
import { harnessEventSchema, planWindowSchema } from "./events.ts";
import { connectorWireConfigSchema } from "./connector.ts";
import { decode } from "./schema.ts";
import { sendOptionsSchema } from "./message-queue.ts";
import { environmentDiagnostics } from "./environment-diagnostic.ts";
import {
  adapterSnapshotSchema,
  agentCallResultSchema,
  createSessionOptionsSchema,
  sessionRefSchema,
  providerCapabilitiesSchema,
  discoveredModelSchema,
  sessionModeSchema,
  permissionDecisionSchema,
  planDecisionSchema,
  mcpServerHandleSchema,
  taskOutputSchema,
} from "./types.ts";

// v4: `send` takes the queued input's `{ inputId, midTurn }`.
// v5: `respondToAgentCall` answers a `loom-agents` tool call.
// v6: `setBase` renames a live session's base.
// v7: `refreshPlanUsage` polls a live session's plan windows; a `usage`
//     utility worker answers `readPlanUsage` with a `planUsage` frame.
// v8: `readTaskOutput` reads a background task's output tail, answered
//     with a `taskOutput` frame; `send`'s options gain `now`.
export const WORKER_VERSION = 8;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING = 128;

const diagnostics = {
  ...environmentDiagnostics,
  claudeCliPath:
    "providers.claude.cli_path is not an executable file. Set it to an installed Claude executable and restart the daemon.",
  claudeBundledCli:
    "Claude could not start. No claude executable was found on the daemon's PATH, and the SDK's bundled binary failed to launch. Install Claude or set providers.claude.cli_path, then restart the daemon.",
  claudeDiscovery:
    "Claude model discovery failed. Check that Claude can start and is authenticated; set providers.claude.cli_path if needed, then restart the daemon.",
} as const;

/** Only fixed, credential-free diagnostics may cross the worker boundary. */
export class WorkerDiagnostic extends Error {
  /** Fixed code; guest environments forward it without the worker protocol. */
  readonly diagnostic: keyof typeof diagnostics;
  constructor(code: keyof typeof diagnostics) {
    super(diagnostics[code]);
    this.diagnostic = code;
  }
}

/** Private connector protocol. Never route these frames through daemon admin RPC. */
export const workerRoleSchema = z.enum([
  "session",
  "title",
  "discovery",
  "enumeration",
  "capabilities",
  "usage",
]);
export type WorkerRole = z.infer<typeof workerRoleSchema>;
export const workerBindingSchema = z.object({
  generation: z.string(),
  providerId: z.string(),
  sessionId: z.string(),
  connector: z.enum([
    "@loom/connector-mock",
    "@loom/connector-echo",
    "@loom/connector-claude",
    "@loom/connector-generic",
    "@loom/connector-gemini",
    "@loom/connector-chatgpt",
  ]),
  config: connectorWireConfigSchema.strict(),
  role: workerRoleSchema,
  baseBranch: z.string().optional(),
});
export type WorkerBinding = z.infer<typeof workerBindingSchema>;
export type WorkerProfile = Pick<WorkerBinding, "connector" | "config" | "baseBranch">;

// Runtime MCP mounts must be resolved by the host before reaching a connector.
const mountedMcp = mcpServerHandleSchema.refine((m) => m.spec.transport !== "runtime");
const create = createSessionOptionsSchema.extend({ mcpServers: z.array(mountedMcp) });
const resume = sessionRefSchema.extend({ mcpServers: z.array(mountedMcp).optional() });
const command = <M extends string, A extends z.ZodType>(method: M, args: A) =>
  z.object({ method: z.literal(method), args });
export const workerCommandSchema = z.discriminatedUnion("method", [
  command("initialize", z.tuple([workerBindingSchema])),
  command("seedTranscript", z.tuple([z.array(transcriptMessageSchema)])),
  command("create", z.tuple([create])),
  command("resume", z.tuple([resume])),
  command("send", z.tuple([z.string(), sendOptionsSchema.optional()])),
  command("setModel", z.tuple([z.string()])),
  command("setEffort", z.tuple([z.string()])),
  command("setMode", z.tuple([sessionModeSchema])),
  command("compact", z.tuple([z.string().optional()])),
  command("rewind", z.tuple([z.int().nonnegative(), z.string().optional()])),
  command("respondToPermission", z.tuple([z.string(), permissionDecisionSchema])),
  command("answerQuestion", z.tuple([z.string(), z.string()])),
  command("respondToPlan", z.tuple([z.string(), planDecisionSchema])),
  command("respondToAgentCall", z.tuple([z.string(), agentCallResultSchema])),
  command("setBase", z.tuple([z.string()])),
  command("refreshPlanUsage", z.tuple([])),
  command("readTaskOutput", z.tuple([z.string().min(1).max(256)])),
  command("interrupt", z.tuple([])),
  command("close", z.tuple([])),
  command("listModels", z.tuple([])),
  command("listPersistedSessions", z.tuple([])),
  command("readPlanUsage", z.tuple([])),
]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
export const workerRequestSchema = workerCommandSchema.and(
  z.object({ kind: z.literal("request"), id: z.int().positive() }),
);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const workerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("transcript"),
    from: z.int().nonnegative(),
    messages: z.array(transcriptMessageSchema),
  }),
  z.object({ kind: z.literal("hello"), version: z.int() }),
  z.object({
    kind: z.literal("ready"),
    id: z.int().positive(),
    generation: z.string(),
    capabilities: providerCapabilitiesSchema,
  }),
  z.object({
    kind: z.literal("response"),
    id: z.int().positive(),
    error: z.object({ code: z.literal("operation_failed"), message: z.string() }).optional(),
  }),
  z.object({ kind: z.literal("state"), snapshot: adapterSnapshotSchema }),
  z.object({
    kind: z.literal("event"),
    seq: z.int().positive(),
    event: harnessEventSchema.refine(
      (e) => !["rewind", "provider_changed", "user_message"].includes(e.type),
    ),
  }),
  z.object({
    kind: z.literal("models"),
    id: z.int().positive(),
    models: z.array(discoveredModelSchema),
  }),
  z.object({ kind: z.literal("sessions"), id: z.int().positive(), sessions: z.array(resume) }),
  z.object({
    kind: z.literal("planUsage"),
    id: z.int().positive(),
    windows: z.array(planWindowSchema),
  }),
  z.object({ kind: z.literal("taskOutput"), id: z.int().positive(), output: taskOutputSchema }),
  z.object({ kind: z.literal("end") }),
]);
export type WorkerFrame = z.infer<typeof workerFrameSchema>;
export const decodeWorkerRequest = (value: unknown): WorkerRequest =>
  decode(workerRequestSchema, value, "invalid worker method or arguments");
export const decodeWorkerFrame = (value: unknown): WorkerFrame =>
  decode(workerFrameSchema, value, "invalid worker frame payload");
