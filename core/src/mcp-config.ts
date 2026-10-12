/** Trusted MCP definitions. Artifacts never carry grants. */
import { z } from "zod";

const text = z
  .string()
  .min(1)
  .refine((v) => v.trim() === v, "must not have surrounding whitespace");
// An exact DNS name, or `*.` plus one: every subdomain of that name, not the name itself.
const hostPattern = z
  .string()
  .max(253)
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
  );
export const mcpHostPatternsSchema = z
  .array(hostPattern)
  .max(64)
  .default([])
  .transform((hosts) => [...new Set(hosts.map((h) => h.toLowerCase()))]);
/** Resolved grants, as launches carry them: `network` is every allowed host pattern. */
export const mcpGrantsSchema = z.strictObject({
  workspace: z.enum(["none", "read-only", "read-write"]).default("none"),
  network: mcpHostPatternsSchema,
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
/** A host executable: unconfined, so only sessions that run on the host can use it. */
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const commandMcpSourceSchema = z.strictObject({
  kind: z.literal("command"),
  command: text.describe("Executable: a name looked up on PATH, or an absolute path."),
  args: z.array(z.string()).default([]).describe("Arguments; never a shell command string."),
  env: z
    .record(envName, z.string())
    .default({})
    .describe("Literal variables added to the environment it inherits."),
  pass_env: z
    .array(envName)
    .default([])
    .describe(
      "Variables copied from the daemon's environment when a session starts, such as an API key; one that is unset fails the launch.",
    ),
  cwd: z
    .string()
    .refine((v) => v.startsWith("/") || v.startsWith("~/"), "must be absolute or start with ~/")
    .optional()
    .describe("Working directory, absolute or ~/; omitted: the session's worktree."),
});
export const mcpSourceSchema = z.union([
  nixMcpSourceSchema,
  commandMcpSourceSchema,
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
