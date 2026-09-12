import { z } from "zod";
import { decode } from "./schema.ts";

/** Private daemon → external MCP worker bootstrap; never supplied by a connector. */
export const MCP_WORKER_VERSION = 1;
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
});
export type McpWorkerBinding = z.infer<typeof mcpWorkerBindingSchema>;
export const decodeMcpBinding = (value: unknown): McpWorkerBinding =>
  decode(mcpWorkerBindingSchema, value, "invalid MCP binding");
