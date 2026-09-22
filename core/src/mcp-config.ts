/** Trusted MCP definitions. Artifacts never carry grants. */
import { z } from "zod";

const text = z
  .string()
  .min(1)
  .refine((v) => v.trim() === v, "must not have surrounding whitespace");
const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i);
export const mcpGrantsSchema = z.strictObject({
  workspace: z.enum(["none", "read-only", "read-write"]).default("none"),
  network: z
    .array(hostname)
    .max(64)
    .default([])
    .transform((hosts) => [...new Set(hosts.map((h) => h.toLowerCase()))]),
});
export type McpGrants = z.output<typeof mcpGrantsSchema>;
export const nixMcpSourceSchema = z.strictObject({
  kind: z.literal("nix"),
  ref: text.refine(
    (v) => /^(github:|gitlab:|git\+https:\/\/|path:\/)/.test(v),
    "must be a Nix flake reference",
  ),
  executable: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/),
  args: z.array(z.string()).default([]),
});
export type NixMcpSource = z.output<typeof nixMcpSourceSchema>;
export const mcpSourceSchema = z.union([
  nixMcpSourceSchema,
  z.strictObject({ kind: z.literal("runtime"), ref: text }),
  z.strictObject({
    kind: z.literal("http"),
    url: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      } catch {
        return false;
      }
    }, "must be an HTTP(S) URL without credentials or a fragment"),
  }),
]);
/** Source-only identity: grants and session selections never invalidate artifacts. */
export const nixMcpRuntime = (source: NixMcpSource): string =>
  "nix-mcp:" + JSON.stringify(nixMcpSourceSchema.parse(source));
export const parseNixMcpRuntime = (source: string): NixMcpSource | undefined =>
  source.startsWith("nix-mcp:") ? nixMcpSourceSchema.parse(JSON.parse(source.slice(8))) : undefined;
