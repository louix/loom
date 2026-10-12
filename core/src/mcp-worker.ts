import { z } from "zod";
import { decode } from "./schema.ts";

/** Private daemon → external MCP worker bootstrap; never supplied by a connector. */
export const MCP_WORKER_VERSION = 3;
/** A relay's per-request bound when `mcp_servers.<name>.timeout_seconds` is unset. */
export const MCP_REQUEST_TIMEOUT_DEFAULT_MS = 60_000;
/** Bounds what a relay accepts: config allows 1–3600 s, tests use shorter. */
export const mcpRequestTimeoutMsSchema = z.number().int().positive().max(3_600_000);
export const mcpOAuthRelayStateSchema = z.strictObject({
  generation: z.number().int().nonnegative(),
  accessToken: z
    .string()
    .min(1)
    .max(65536)
    .regex(/^[!-~]+$/)
    .optional(),
  expiresAt: z.number().finite().positive().optional(),
});
export type McpOAuthRelayState = z.infer<typeof mcpOAuthRelayStateSchema>;
export const mcpOAuthUpdateSchema = z.strictObject({
  kind: z.literal("token"),
  state: mcpOAuthRelayStateSchema,
  abortActive: z.boolean(),
});
export const mcpWorkerBindingSchema = z.object({
  version: z.literal(MCP_WORKER_VERSION),
  url: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash
      );
    } catch {
      return false;
    }
  }),
  headers: z.record(z.string(), z.string()).refine((value) => {
    try {
      new Headers(value);
      return true;
    } catch {
      return false;
    }
  }),
  token: z.string().min(32),
  requestTimeoutMs: mcpRequestTimeoutMsSchema,
  oauth: mcpOAuthRelayStateSchema.optional(),
});
export type McpWorkerBinding = z.infer<typeof mcpWorkerBindingSchema>;
export const decodeMcpBinding = (value: unknown): McpWorkerBinding =>
  decode(mcpWorkerBindingSchema, value, "invalid MCP binding");

/** Private daemon → host command worker bootstrap: one VM session's relayed stdio server. */
export const HOST_COMMAND_WORKER_VERSION = 1;
const hostCommandBindingSchema = z.strictObject({
  version: z.literal(HOST_COMMAND_WORKER_VERSION),
  command: z.string().min(1),
  args: z.array(z.string()),
  /** The whole environment: the command's own, not added to the worker's. */
  env: z.record(z.string(), z.string()),
  cwd: z.string().startsWith("/"),
  token: z.string().min(32),
  requestTimeoutMs: mcpRequestTimeoutMsSchema,
  maxServerFrameBytes: z.number().int().positive(),
});
export type HostCommandBinding = z.infer<typeof hostCommandBindingSchema>;
export const decodeHostCommandBinding = (value: unknown): HostCommandBinding =>
  decode(hostCommandBindingSchema, value, "invalid host command binding");
