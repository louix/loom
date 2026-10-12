/** Config syntax and defaults. Filesystem and provider resolution belong in config.ts. */
import { z } from "zod";
import { mcpSourceSchema, mcpGrantsSchema } from "../../../../core/src/mcp-config.ts";
import { MCP_CAPABILITIES } from "@loom/core/types";
import { LOOM_AGENTS_SERVER, SELF_PROFILE } from "@loom/core/agents";
import { mcpOAuthConfigSchema } from "../daemon/mcp-oauth-model.ts";
import { validateOAuthUrl } from "../daemon/mcp-oauth-endpoint.ts";
import { sessionEnvironmentSchema } from "../../../../core/src/session-environment.ts";
import {
  networkPresetsSchema,
  extraHostsSchema,
} from "../../../../runtime/src/session-vm/network-policy.ts";
import { gitVisibleRefsSchema } from "../../../../runtime/src/session-vm/git-relay.ts";
import type { HookEvent, LoomConfig } from "./config.ts";
import { gitIdentitySchema } from "./git-identity.ts";

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
export const mcpDefinitionSchema = z
  .strictObject({
    ...toolDefaults,
    source: mcpSourceSchema,
    execution: z.literal("vm").optional(),
    grants: mcpGrantsSchema.optional(),
    auth: z
      .strictObject({
        bearer_token_env: requiredText.optional(),
        bearer_token: z.string().optional(),
        oauth: mcpOAuthConfigSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.auth?.oauth &&
      (value.auth.bearer_token !== undefined || value.auth.bearer_token_env !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "OAuth and bearer authentication are mutually exclusive",
      });
    if (value.source.kind === "http") {
      if (value.auth?.oauth) {
        try {
          validateOAuthUrl(value.source.url, true);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "OAuth requires HTTPS or a literal loopback HTTP URL",
          });
        }
      }
      if (value.execution || value.grants)
        ctx.addIssue({
          code: "custom",
          message: "Remote MCPs cannot receive local execution or filesystem/network grants",
        });
    } else {
      if (value.execution !== "vm")
        ctx.addIssue({ code: "custom", message: "Local MCPs require execution: vm" });
      if (value.auth)
        ctx.addIssue({ code: "custom", message: "Authentication is only supported for HTTP MCPs" });
    }
  });
export const toolSettingsSchema = z.object({
  mcp_servers: z.record(toolName, mcpDefinitionSchema).default({}),
  session: preprocess(
    (v) => v ?? {},
    z.strictObject({
      local_tools: selections,
      vm_tools: selections,
      remote_tools: selections,
      mcp_servers: selections,
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

const providerTag = z.string().optional().catch(undefined);

const providerFields = {
  base_url: text(),
  api_key_env: text(),
  api_key: text(),
  model: text(),
  models: strings().optional(),
  tag: providerTag,
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

const names = (what: string) =>
  z
    .array(requiredText)
    .refine((v) => new Set(v).size === v.length, `duplicate ${what}`)
    .optional();

/** One `agents.profiles` entry: what a child started with it runs as. */
export const agentProfileSchema = z.strictObject({
  description: requiredText.describe(
    "What the profile is for, as the agents choosing a child read it.",
  ),
  provider: requiredText
    .optional()
    .describe("Provider id, e.g. claude:personal or codex; omitted runs on the spawner's own."),
  model: requiredText.optional().describe("Model id; omitted takes the provider's default."),
  effort: requiredText.optional().describe("Thinking effort, for models that accept one."),
  mode: preprocess(
    (v) => (v === "manual" ? "default" : v),
    z.enum(["default", "plan", "acceptEdits", "auto"]),
    z.enum(["manual", "default", "plan", "acceptEdits", "auto"]),
  )
    .optional()
    .describe("Permission mode; omitted takes the spawner's own (plan becomes manual)."),
  mcp: names("MCP servers").describe(
    `The session MCP servers it gets, by name, plus ${LOOM_AGENTS_SERVER} to let it start agents of its own. Omitted: all of them.`,
  ),
  skills: names("skills").describe(
    "Claude skills to enable, by name; omitted keeps the CLI's own.",
  ),
  tools: z
    .strictObject({
      allow: names("tools").describe("Built-in tools it may use; omitted allows them all."),
      deny: names("tools").describe("Built-in tools withheld from it."),
    })
    .optional(),
  prompt: z
    .string()
    .optional()
    .describe("Appended to the agent's own system prompt (developer instructions for Codex)."),
});

const agentsSchema = (maxDepth: number) =>
  section({
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(maxDepth)
      .describe(
        `How deep supervision may go: 1 starts no agents, 2 (the default) a supervisor and its children. Sessions at the limit get no ${LOOM_AGENTS_SERVER}.`,
      ),
    profiles: z
      // Names are checked in config.ts: a record key's own error says only
      // "Invalid key in record".
      .record(z.string(), agentProfileSchema)
      .default({})
      .describe(`Named agent profiles; ${SELF_PROFILE} (the spawner's own settings) is built in.`),
  });

export const createConfigSchema = (d: LoomConfig, events: readonly HookEvent[]) => {
  const hook = section({
    run: z
      .string()
      .trim()
      .min(1)
      .max(65536)
      .refine((v) => !v.includes("\0"), "must not contain NUL"),
    async: flag(false).describe("Run workspace_start alongside the agent; preparation must block."),
    kind: preprocess((v) => v ?? "notify", z.enum(["check", "notify"])),
    on: preprocess(
      (v) => (Array.isArray(v) ? v : [v]),
      z.array(z.enum(events)).min(1),
      z.union([z.enum(events), z.array(z.enum(events)).min(1)]),
    ).transform((v) => [...new Set(v)]),
    when: z
      .enum(["always", "unfocused", "disconnected"])
      .default("always")
      .describe("Notification hooks: always, no focused TUI, or no connected TUI."),
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
      .describe("Hook timeout in seconds; clamped to 1–3600.")
      .transform((v) => Math.min(3_600_000, Math.max(1_000, Math.round(v * 1000)))),
  })
    .refine(
      (h) =>
        h.kind !== "check" ||
        h.on.every((e) =>
          ["workspace_prepare", "workspace_start", "file_write", "turn_end"].includes(e),
        ),
      "check hook: only workspace_prepare, workspace_start, file_write and turn_end are supported",
    )
    .refine((h) => h.kind !== "check" || h.when === "always", "check hooks must use when: always")
    .refine(
      (h) => !h.async || h.on.every((e) => e === "workspace_start"),
      "async is only supported for workspace_start hooks",
    );
  return section({
    ...toolSettingsSchema.shape,
    $schema: z.string().optional(),
    base_branch: z
      .string()
      .optional()
      .catch(undefined)
      .describe(
        "The repository's default branch for new sessions: the alternative the new-session prompt's base toggle (Alt+B) offers to the checked-out branch, and the base of sessions created without one (loom run). Unset: the toggle offers the remote's default branch, else init.defaultBranch, else main, and a session created without a base starts from the checked-out branch (HEAD's commit when detached). Each session keeps the base it was created with. Restart to apply.",
      ),
    worktree_dir: text(d.worktreeDir).describe(
      "Exact worktree directory (absolute, ~/ or relative to the repository). Empty uses $XDG_DATA_HOME/loom/worktrees/<repo>-<hash>, defaulting to ~/.local/share. Existing sessions keep their paths. Restart to apply.",
    ),
    // Removed: older configs keep parsing, and Loom reports the key once.
    db: z
      .unknown()
      .optional()
      .meta({ deprecated: true })
      .describe(
        "No longer read. The database lives in $XDG_STATE_HOME/loom/repos/<repo>/loom.db; remove this setting.",
      ),
    git: gitIdentitySchema.optional(),
    default_provider: text(d.defaultProvider),
    daemon: section({ idle_shutdown_minutes: nonNegative(d.daemon.idleShutdownMinutes) }),
    tui: section({
      include_event_log_in_editor: flag(d.tui.includeEventLogInEditor).describe(
        "Open the event log alongside the input on Alt+E. Defaults to false; enabling this may require :wq! in Vim/Neovim.",
      ),
      compat: flag(d.tui.compat).describe(
        "Terminal compatibility mode, for mosh (e.g. from Termux): full redraws, and mouse reporting without any-motion tracking, so there is no hover underline. Clicks and the wheel still work. LOOM_TUI_COMPAT=1 turns it on too. Defaults to false. Restart the TUI to apply.",
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
        mcp_servers: selections,
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
              "Default new sessions to VM (true) or Local (false). This does not disable VM execution: each new session can override the default when a runtime is available. Existing sessions keep their mode.",
            ),
          claude: runtime,
          aisdk: runtime,
          codex: runtime,
          extra_allowed_hosts: extraHostsSchema,
          network_presets: networkPresetsSchema,
          environment: sessionEnvironmentSchema,
          idle_timeout_minutes: z
            .number()
            .int()
            .min(0)
            .max(1440)
            .default(10)
            .describe(
              "Stop idle session VMs after this many minutes; preserve their workspace and history. Zero disables idle shutdown. Open shells, active tasks and keep-warm sessions are excluded.",
            ),
          // Removed: older configs keep parsing, and Loom reports the key once.
          launcher: z
            .unknown()
            .optional()
            .meta({ deprecated: true })
            .describe(
              "No longer read. Session VMs always start through the isolation library; remove this setting.",
            ),
          checkout: section({
            mode: z
              .enum(["mount", "clone"])
              .default("mount")
              .describe(
                "How new VM sessions reach the repository. mount shares the worktree and the repository's Git directory with the guest. clone gives the guest a private clone whose only remote is a host relay limited to the session's own branch. Existing sessions keep their mode.",
              ),
            visible_refs: gitVisibleRefsSchema.describe(
              "Extra ref prefixes advertised to a clone session, such as refs/tags/. Its base and own branch are always advertised. Ref filtering is not a confidentiality boundary: clone sessions must be trusted to read repository history.",
            ),
            max_push_bytes: z
              .number()
              .int()
              .min(1024 * 1024)
              .max(64 * 1024 * 1024 * 1024)
              .default(512 * 1024 * 1024),
          }),
        }),
      }),
    ),
    providers: preprocess(
      record,
      z.strictObject({
        claude: section({
          tag: providerTag,
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
                tag: providerTag,
                color: text().transform((v) => v.trim()),
              }),
            ),
          ),
        }),
        echo: z.strictObject({ enabled: z.boolean().default(true) }).optional(),
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
              "Configure Kagi under mcp_servers.kagi and select it in session.mcp_servers",
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
    agents: agentsSchema(d.agents.maxDepth),
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
