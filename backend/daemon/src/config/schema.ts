/** Config syntax and defaults. Filesystem and provider resolution belong in config.ts. */
import { z } from "zod";
import { MCP_CAPABILITIES } from "@loom/core/types";
import { sessionEnvironmentSchema } from "../../../../core/src/session-environment.ts";
import {
  networkPresetsSchema,
  extraHostsSchema,
} from "../../../../runtime/src/session-vm/network-policy.ts";
import type { HookEvent, LoomConfig } from "./config.ts";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
// Tell JSON Schema about the values users write before our lenient preprocessing.
const editorInputs = new WeakMap<object, z.ZodType>();
const preprocess = <T extends z.ZodType>(
  fn: (v: unknown) => unknown,
  schema: T,
  input: z.ZodType = schema,
) => {
  const result = z.preprocess(fn, schema);
  editorInputs.set(result, input);
  return result;
};
const section = <T extends z.ZodRawShape>(shape: T) => preprocess(record, z.object(shape));
const text = (fallback = "") => z.string().catch(fallback);
const flag = (fallback: boolean) => z.boolean().catch(fallback);
const strings = (fallback: string[] = []) =>
  preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : v),
    z.array(z.string()).catch(fallback),
  );
const nonNegative = (fallback: number) => z.number().nonnegative().catch(fallback);
const ids = z
  .array(
    z
      .string()
      .min(1)
      .refine((v) => v.trim() === v),
  )
  .transform((v) => [...new Set(v)]);
const runtime = preprocess(
  record,
  z.strictObject({
    artifact: z
      .string()
      .refine((v) => !!v.trim(), "must name a path or executable")
      .optional(),
    smolvm: z
      .string({ error: "must name a path or executable" })
      .refine((v) => !!v.trim(), "must name a path or executable")
      .optional(),
  }),
);

const toolName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((v) => v !== "loom", "Reserved tool name");
const requiredText = z.string().refine((v) => !!v.trim(), "must not be empty");
const toolDefaults = { default_for: z.array(z.enum(MCP_CAPABILITIES)).default([]) };
const selections = preprocess(
  (v) => v ?? [],
  z.array(z.string()).refine((v) => new Set(v).size === v.length, "duplicate tool selections"),
);
export const toolSettingsSchema = z.object({
  session: preprocess(
    (v) => v ?? {},
    z.strictObject({
      local_tools: selections,
      vm_tools: selections,
      remote_tools: selections,
    }),
  ),
  local_tools: preprocess(
    (v) => v ?? {},
    z
      .record(
        toolName,
        z.strictObject({
          ...toolDefaults,
          command: requiredText,
          args: z.array(z.string()).default([]),
        }),
      )
      .default({}),
  ),
  vm_tools: preprocess(
    (v) => v ?? {},
    z.record(toolName, z.strictObject({ ...toolDefaults, runtime: requiredText })).default({}),
  ),
  remote_tools: preprocess(
    (v) => v ?? {},
    z
      .record(
        toolName,
        z.strictObject({
          ...toolDefaults,
          url: z.string().refine((value) => {
            try {
              const url = new URL(value);
              return (
                ["http:", "https:"].includes(url.protocol) &&
                !url.username &&
                !url.password &&
                !url.hash
              );
            } catch {
              return false;
            }
          }, "must be an HTTP(S) URL without embedded credentials or a fragment"),
          bearer_token: z.string().optional(),
          bearer_token_env: z.string().default(""),
        }),
      )
      .default({}),
  ),
});
export type ToolSettings = z.output<typeof toolSettingsSchema>;

const providerFields = {
  base_url: text(),
  api_key_env: text(),
  api_key: text(),
  model: text(),
  models: strings().optional(),
  tag: z.string().optional().catch(undefined),
  color: text(),
  include_usage: flag(true),
  prompt_cache_ttl: z.enum(["5m", "1h", "off", ""]).catch(""),
  title_model: text().describe(
    "Model for automatic session titles; omit to use this provider’s default.",
  ),
  config_dir: text(),
  cli_path: text(),
  builtin_web_search: flag(false),
};

export const providerSchema = section(providerFields);
// Profiles stay sparse until merged with their family defaults.
const sparseProviderSchema = z.strictObject(providerFields).partial();
const providerFamilySchema = sparseProviderSchema.extend({
  profiles: z.record(z.string(), sparseProviderSchema).optional(),
});

export const createConfigSchema = (d: LoomConfig, events: readonly HookEvent[]) => {
  const hook = section({
    run: z
      .string()
      .trim()
      .min(1)
      .max(65536)
      .refine((v) => !v.includes("\0"), "must not contain NUL"),
    kind: preprocess((v) => v ?? "notify", z.enum(["check", "notify"])),
    on: preprocess(
      (v) => (Array.isArray(v) ? v : [v]),
      z.array(z.enum(events)).min(1),
      z.union([z.enum(events), z.array(z.enum(events)).min(1)]),
    ).transform((v) => [...new Set(v)]),
    name: text().transform((v) => v.trim()),
    project: text().transform((v) => v.trim()),
    match: preprocess(
      (v) => (Array.isArray(v) ? v : [v]),
      strings(),
      z.union([z.string(), z.array(z.string())]).optional(),
    ),
    timeout: z
      .number()
      .catch(30)
      .describe("Hook timeout in seconds; clamped to 1–600.")
      .transform((v) => Math.min(600_000, Math.max(1_000, Math.round(v * 1000)))),
  }).refine(
    (h) => h.kind !== "check" || h.on.every((e) => ["init", "file_write", "turn_end"].includes(e)),
    "check hook: only init, file_write and turn_end are supported",
  );
  return section({
    ...toolSettingsSchema.shape,
    $schema: z.string().optional(),
    base_branch: text(d.baseBranch),
    worktree_dir: text(d.worktreeDir),
    db: text(d.db),
    default_provider: text(d.defaultProvider),
    daemon: section({ idle_shutdown_minutes: nonNegative(d.daemon.idleShutdownMinutes) }),
    tui: section({
      include_event_log_in_editor: flag(d.tui.includeEventLogInEditor).describe(
        "Open the event log alongside the input on Alt+E. Defaults to false; enabling this may require :wq! in Vim/Neovim.",
      ),
    }),
    session: preprocess(
      record,
      z.strictObject({
        auto_nix: z
          .boolean()
          .default(false)
          .describe(
            "Allow automatic project shell activation (devenv, flake.nix, shell.nix, default.nix), locally and in VMs. Does not grant network access.",
          ),
        local_tools: selections,
        vm_tools: selections,
        remote_tools: selections,
        worktree: section({ enabled: flag(d.worktree.enabled) }),
        auto_rebase: section({
          enabled: flag(d.autoRebase.enabled),
          mode: z.enum(["rebase", "merge"]).catch("rebase"),
        }),
        auto_resume: section({ enabled: flag(d.autoResume.enabled) }),
        commit_reminder: section({ enabled: flag(d.commitReminder.enabled) }),
        titles: section({ enabled: flag(d.titles.enabled) }),
        notify: section({ webhook: text(d.notify.webhook) }),
        provider_access: section({ only: ids.optional(), disabled: ids.default([]) }),
        isolation: section({
          enabled: z
            .boolean()
            .default(false)
            .describe(
              "Default all providers to VM execution in this project. Existing sessions keep their mode.",
            ),
          claude: runtime,
          aisdk: runtime,
          codex: runtime,
          extra_allowed_hosts: extraHostsSchema,
          network_presets: networkPresetsSchema,
          environment: sessionEnvironmentSchema,
        }),
      }),
    ),
    providers: preprocess(
      record,
      z.strictObject({
        claude: section({
          model: text(d.providers.claude.model),
          title_model: text(d.providers.claude.titleModel),
          models: strings(d.providers.claude.models),
          permission_default: preprocess(
            (v) => (v === "manual" ? "default" : v),
            z
              .enum(["default", "plan", "acceptEdits", "bypassPermissions"])
              .catch(d.providers.claude.permissionDefault),
            z.enum(["manual", "default", "plan", "acceptEdits", "bypassPermissions"]).optional(),
          ),
          setting_sources: strings(d.providers.claude.settingSources),
          disable_builtin: strings(d.providers.claude.disableBuiltin),
          cli_path: text(d.providers.claude.cliPath),
          worker_allowed_hosts: strings().optional(),
          prompt_cache_ttl: z.enum(["5m", "1h", ""]).catch(d.providers.claude.promptCacheTtl),
          profiles: preprocess(
            record,
            z.record(
              z.string(),
              section({
                config_dir: text().transform((v) => v.trim()),
                color: text().transform((v) => v.trim()),
              }),
            ),
          ),
        }),
        codex: providerFamilySchema.optional(),
        google: providerFamilySchema.optional(),
        anthropic: providerFamilySchema.optional(),
        openai_compatible: providerFamilySchema.optional(),
      }),
    ),
    hooks: z.array(hook).max(64).default([]),
    search: section({
      backend: preprocess(
        (v) => {
          if (v === "kagi")
            throw new Error(
              "Configure Kagi under remote_tools.kagi and select it in session.remote_tools",
            );
          return v;
        },
        z.enum(["none", "brave", "tavily"]).catch("none"),
      ),
      api_key_env: text(d.search.apiKeyEnv),
      api_key: text(d.search.apiKey),
      api_base: text(d.search.apiBase),
      max_results: nonNegative(d.search.maxResults).transform((v) => Math.max(1, v)),
    }),
  });
};

/** Report paths and expectations, never input values (which may be credentials). */
export const parseSettings = <T extends z.ZodType>(schema: T, raw: unknown): z.output<T> => {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(
    result.error.issues
      .map((issue) => {
        if (
          issue.code === "unrecognized_keys" &&
          issue.path.join(".") === "session" &&
          issue.keys.includes("environment")
        )
          return "session.environment.nix has been replaced by session.auto_nix (boolean, default false). Remove session.environment; named shells can use an explicit VM command_prefix.";
        if (
          issue.code === "unrecognized_keys" &&
          issue.path.join(".") === "session.isolation.environment" &&
          issue.keys.includes("nix")
        )
          return "Remove session.isolation.environment.nix; Loom supplies the writable Nix store automatically. Use session.auto_nix to allow project shell activation.";
        const path = issue.path.join(".") || "config";
        return issue.code === "unrecognized_keys"
          ? `Unknown setting ${path}.${issue.keys.join(", ")}`
          : `${path}: ${issue.message}`;
      })
      .join("; "),
  );
};

/** Generate editor input schemas from the same Zod definitions used at runtime. */
export const editorSchema = (schema: z.ZodType): z.core.JSONSchema.BaseSchema =>
  z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const input = editorInputs.get(zodSchema);
      if (input) {
        for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
        Object.assign(jsonSchema, editorSchema(input));
      }
      if (zodSchema._zod.def.type === "object") {
        const shape = zodSchema._zod.def.shape;
        if (jsonSchema.required)
          jsonSchema.required = jsonSchema.required.filter(
            (key) => !z.safeParse(shape[key]!, undefined).success,
          );
        if (!jsonSchema.required?.length) delete jsonSchema.required;
        if (!zodSchema._zod.def.catchall) jsonSchema.additionalProperties = false;
      }
      delete jsonSchema.$schema; // only the document root needs a dialect declaration
    },
  });

export const configEditorSchema = (d: LoomConfig, events: readonly HookEvent[]) => {
  const settings = editorSchema(createConfigSchema(d, events));
  const repo = structuredClone(settings);
  delete repo.$schema;
  repo.properties = {
    path: {
      type: "string",
      minLength: 1,
      description: "Exact repository path, absolute or starting with ~/.",
    },
    ...repo.properties,
  };
  repo.required = ["path"];
  return {
    ...settings,
    title: "Loom configuration",
    description:
      "User defaults and exact project overrides. Objects merge; arrays replace inherited arrays.",
    properties: {
      ...settings.properties,
      repos: { type: "array", description: "Overrides for individual repositories.", items: repo },
    },
  };
};
