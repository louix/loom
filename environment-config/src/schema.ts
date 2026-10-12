/**
 * Versioned environment configuration, ported from main-new's environment-config.
 *
 * Two files with two levels of trust. The project file (`loom.json` at the
 * checkout root) is repository content: it can only *request* setup and
 * network access. The user file (`$XDG_CONFIG_HOME/loom/environment.jsonc`) is
 * trusted host configuration: it selects the runtime, applies host defaults
 * and decides which project requests each repository may have.
 *
 * Neither file is Loom's `config.jsonc`, and Loom's daemon reads neither.
 */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { executionOptionsSchema } from "../../core/src/execution.ts";
import {
  extraHostsSchema,
  networkPresetsSchema,
} from "../../runtime/src/session-vm/network-policy.ts";

const text = z
  .string()
  .min(1)
  .max(65536)
  .refine((s) => !s.includes("\0"), "must not contain NUL");
const absolute = (what: string) => text.refine(isAbsolute, "must be an absolute " + what);
const names = z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)).max(64);

const resources = z.strictObject({
  cpus: z.int().min(1).max(64).optional(),
  memory_mib: z.int().min(512).max(65536).optional(),
});
const hook = z.strictObject({
  name: text.optional(),
  run: text.describe("Shell command run in the guest workspace."),
  timeout_seconds: z.int().min(1).max(3600).default(900),
});

/** What an environment needs. The same shape at every layer; setup fields need a grant from a project. */
export const environmentIntentSchema = z.strictObject({
  nix: z
    .strictObject({ auto: z.boolean() })
    .optional()
    .describe("Activate the checkout's devenv, flake, shell.nix or default.nix."),
  command_prefix: z
    .array(text)
    .min(1)
    .max(64)
    .optional()
    .describe("Literal argv that wraps activation; an alternative to nix.auto."),
  timeout_seconds: z.int().min(1).max(2_073_600).optional().describe("Activation timeout."),
  resources: resources.optional(),
  prepare: z
    .array(hook)
    .max(64)
    .optional()
    .describe("Workspace preparation hooks. Replaces any earlier layer's list."),
  start: z
    .array(hook)
    .max(64)
    .optional()
    .describe("Hooks run before each start becomes available. Replaces any earlier layer's list."),
});

/** Exact HTTPS destination names, written as presets and/or allowed_hosts. */
const network = z.strictObject({
  presets: networkPresetsSchema.unwrap().optional(),
  allowed_hosts: extraHostsSchema.unwrap().optional(),
});
export type EnvironmentNetwork = z.output<typeof network>;
const hostAccess = z
  .strictObject({ network: network.optional() })
  .describe("Network the host applies directly, without a project request.");

export const projectEnvironmentSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  environment: environmentIntentSchema.optional(),
  access: z
    .strictObject({
      network: network.optional(),
      // Accepted for main-new compatibility; no consumer attaches MCP servers yet.
      mcp: names.optional(),
    })
    .optional(),
  // Accepted for main-new compatibility; no consumer installs project skills yet.
  skills: z
    .array(
      text.refine(
        (p) => !isAbsolute(p) && !p.split(/[\\/]/).includes(".."),
        "must be a relative path within the checkout",
      ),
    )
    .max(64)
    .optional(),
});

const grants = z.strictObject({
  setup: z
    .boolean()
    .default(false)
    .describe("Let the project request nix.auto, command_prefix, prepare and start hooks."),
  network: network.optional().describe("Hosts the project may request."),
});

/**
 * Default workspace placement for applications that create workspaces. Absent
 * fields keep each consumer's own default: Loom stays on the host + worktree.
 */
const lifecycle = z.strictObject({
  workspace: z.enum(["in-place", "worktree", "clone"]).optional(),
  execution: z.enum(["vm", "none"]).optional().describe("vm, or none (on the host)."),
  idle_stop_minutes: z.int().min(0).max(1440).optional(),
});

export const profileNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .max(100);

export const environmentUserSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  backend: z
    .strictObject({
      kind: z.literal("smolvm").default("smolvm"),
      artifact: absolute("runtime path").optional(),
      executable: text.optional().describe("smolvm path, or a name searched on PATH."),
    })
    .optional(),
  environment: environmentIntentSchema.optional().describe("Host defaults for every environment."),
  access: hostAccess.optional(),
  profiles: z
    .record(
      profileNameSchema,
      z.strictObject({
        entrypoint: executionOptionsSchema.shape.argv.describe(
          "Literal argv; run arguments are appended.",
        ),
        artifact: absolute("runtime path").optional(),
        environment: environmentIntentSchema.optional(),
      }),
    )
    .default({}),
  limits: resources.optional().describe("Ceilings for resolved resources; never clamped."),
  lifecycle: lifecycle.optional(),
  repos: z
    .array(
      z.strictObject({
        path: absolute("repository path"),
        environment: environmentIntentSchema.optional().describe("Final host overrides."),
        access: hostAccess.optional(),
        lifecycle: lifecycle.optional(),
        grants: grants.prefault({}),
      }),
    )
    .max(1024)
    .default([]),
});

/** Editor schemas, generated into `environment-config/<name>.schema.json`. */
export const environmentEditorSchemas = {
  project: projectEnvironmentSchema,
  user: environmentUserSchema,
};

export type EnvironmentIntent = z.output<typeof environmentIntentSchema>;
export type ProjectEnvironmentConfig = z.output<typeof projectEnvironmentSchema>;
export type EnvironmentUserConfig = z.output<typeof environmentUserSchema>;
/** What a file may contain, before defaults; the converter emits this shape. */
export type EnvironmentUserInput = z.input<typeof environmentUserSchema>;
