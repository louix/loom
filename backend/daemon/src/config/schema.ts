/** Config syntax and defaults. Filesystem and provider resolution belong in config.ts. */
import { z } from "zod";
import {
  mcpSourceSchema,
  mcpGrantsSchema,
  mcpHostsSchema,
} from "../../../../core/src/mcp-config.ts";
import { MCP_CAPABILITIES } from "@loom/core/types";
import { LOOM_AGENTS_SERVER, SELF_PROFILE } from "@loom/core/agents";
import { mcpOAuthConfigSchema } from "../daemon/mcp-oauth-model.ts";
import { validateOAuthUrl } from "../daemon/mcp-oauth-endpoint.ts";
import { sessionEnvironmentFields } from "../../../../core/src/session-environment.ts";
import { sessionModeSchema } from "@loom/core/types";
import {
  networkPresetsSchema,
  extraHostsSchema,
} from "../../../../runtime/src/session-vm/network-policy.ts";
import { gitVisibleRefsSchema } from "../../../../runtime/src/session-vm/git-relay.ts";
import { branchPrefixSchema } from "../daemon/session-branch.ts";
import type { HookEvent, LoomConfig } from "./config.ts";
import { gitIdentitySchema } from "./git-identity.ts";

// Tell JSON Schema about the values users write before preprocessing.
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
// parseSettings drops a key flagged with this and reports it; the editor schema rejects it.
const UNKNOWN_KEY = "loom_unknown_key";
/** An object whose unknown keys are reported and ignored rather than rejected; null reads as absent. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  preprocess(
    (v) => v ?? {},
    z.looseObject(shape).superRefine((value, ctx) => {
      for (const key of Object.keys(value))
        if (!Object.hasOwn(shape, key))
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "unknown setting",
            params: { [UNKNOWN_KEY]: true },
          });
    }),
    z.strictObject(shape),
  );
const text = (fallback: string) => z.string().default(fallback);
/** `""` reads as unset, which is what it always meant. */
const optionalText = () =>
  preprocess((v) => (v === "" ? undefined : v), z.string().optional(), z.string().optional());
const flag = (fallback: boolean) => z.boolean().default(fallback);
const strings = (fallback: string[] = []) => z.array(z.string()).default(fallback);
const nonNegative = (fallback: number) => z.number().nonnegative().default(fallback);
// Removed and renamed keys never reach the schema (legacy-keys.ts drops or moves
// them first); listing them keeps editors from flagging an older config as invalid.
const deprecated = (description: string) =>
  z.unknown().optional().meta({ deprecated: true }).describe(description);
const ids = z
  .array(
    z
      .string()
      .min(1)
      .refine((v) => v.trim() === v),
  )
  .transform((v) => [...new Set(v)]);
const runtime = preprocess(
  (v) => v ?? {},
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
const mcpNetworkSchema = z
  .strictObject({
    allowed_hosts: mcpHostsSchema.describe(
      "Exact DNS names the tool VM may reach, on any port; a name grants only itself, not its subdomains.",
    ),
    presets: networkPresetsSchema.describe("Named host sets: nix, javascript, python, rust."),
  })
  .prefault({});
/** `mcp_servers.*.grants` as written; tool-selection.ts resolves it into McpGrants. */
export const mcpGrantsConfigSchema = z.strictObject({
  workspace: mcpGrantsSchema.shape.workspace,
  // A host list is the old form; legacy-keys.ts moves it to allowed_hosts first.
  network: preprocess(
    (v) => v,
    mcpNetworkSchema,
    z.union([
      mcpNetworkSchema,
      mcpHostsSchema.meta({ deprecated: true }).describe("Replaced by { allowed_hosts: [...] }."),
    ]),
  ),
});
export const mcpDefinitionSchema = z
  .strictObject({
    ...toolDefaults,
    source: mcpSourceSchema,
    execution: deprecated("No longer read: a local source always runs in a VM."),
    grants: mcpGrantsConfigSchema.optional(),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe(
        "Seconds one MCP request may take, 1–3600. Loom's relays for http, nix and runtime sources stop a request after this (omitted: 60); Claude and Codex get it as the server's tool-call timeout.",
      ),
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
      if (value.grants)
        ctx.addIssue({
          code: "custom",
          message: "Remote MCPs cannot receive filesystem/network grants",
        });
    } else if (value.auth)
      ctx.addIssue({ code: "custom", message: "Authentication is only supported for HTTP MCPs" });
    if (value.source.kind === "command" && value.grants)
      ctx.addIssue({
        code: "custom",
        message: "A host command runs unconfined; grants apply only to nix and runtime sources",
      });
  });
export const toolSettingsSchema = z.object({
  mcp_servers: preprocess((v) => v ?? {}, z.record(toolName, mcpDefinitionSchema)),
  session: preprocess((v) => v ?? {}, z.object({ mcp_servers: selections })),
  local_tools: deprecated('Replaced by mcp_servers.<name> with source.kind "command".'),
  vm_tools: deprecated('Replaced by mcp_servers.<name> with source.kind "runtime".'),
  remote_tools: deprecated('Replaced by mcp_servers.<name> with source.kind "http".'),
});
export type ToolSettings = z.output<typeof toolSettingsSchema>;

const providerTag = z.string().optional();
const trimmedText = () => optionalText().transform((v) => v?.trim() || undefined);
/** One enum for every provider; `""` is what absent was spelled as before. */
const promptCacheTtl = preprocess(
  (v) => (v === "" ? undefined : v),
  z.enum(["default", "5m", "1h", "off"]).default("default"),
  z.enum(["default", "5m", "1h", "off"]).optional(),
).describe(
  "Prompt-cache lifetime: default (the provider's own choice), 5m, 1h, or off (no caching, full input price every turn).",
);

const providerFields = {
  base_url: optionalText(),
  api_key_env: optionalText(),
  api_key: optionalText(),
  model: optionalText(),
  models: z.array(z.string()).optional(),
  tag: providerTag,
  color: optionalText(),
  include_usage: flag(true),
  prompt_cache_ttl: promptCacheTtl,
  title_model: optionalText().describe(
    "Model for automatic session titles; omit to use this provider’s default.",
  ),
  config_dir: optionalText(),
  cli_path: optionalText(),
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

const sessionMode = preprocess(
  (v) => (v === "manual" ? "default" : v),
  sessionModeSchema,
  z.enum(["manual", ...sessionModeSchema.options]),
);

/** One `agents.profiles` entry: what a child started with it runs as. */
export const agentProfileSchema = z.strictObject({
  description: requiredText.describe(
    "What the profile is for, as supervisors choosing a sub-agent read it.",
  ),
  provider: requiredText
    .optional()
    .describe("Provider id, e.g. claude:personal or codex; omitted runs on the spawner's own."),
  model: requiredText.optional().describe("Model id; omitted takes the provider's default."),
  effort: requiredText.optional().describe("Thinking effort, for models that accept one."),
  mode: sessionMode
    .optional()
    .describe("Permission mode; omitted takes the spawner's own (plan becomes manual)."),
  mcp_servers: z
    .strictObject(
      {
        allow: names("MCP servers").describe(
          `Only these session MCP servers, by name; ${LOOM_AGENTS_SERVER} only if named. Omitted allows them all.`,
        ),
        deny: names("MCP servers").describe(
          `MCP servers withheld from it, applied after allow; denying ${LOOM_AGENTS_SERVER} stops it starting sub-agents.`,
        ),
      },
      {
        error: (issue) =>
          Array.isArray(issue.input)
            ? 'a list is no longer accepted: write { "allow": [...] } to keep only those servers, or { "deny": [...] } to withhold them'
            : undefined,
      },
    )
    .optional()
    .describe(
      `The session MCP servers it gets, plus ${LOOM_AGENTS_SERVER} to start sub-agents of its own (still subject to agents.max_depth). Omitted: all of them.`,
    ),
  skills: names("skills").describe(
    "Claude skills to load from the provider's <config_dir>/skills/<name>/SKILL.md, by name; omitted keeps the CLI's own.",
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
        `How deep supervision may go: 1 starts no sub-agents, 2 (the default) a supervisor and its sub-agents. Sessions at the limit get no ${LOOM_AGENTS_SERVER}.`,
      ),
    profiles: z
      // Names are checked in config.ts: a record key's own error says only
      // "Invalid key in record".
      .record(z.string(), agentProfileSchema)
      .default({})
      .describe(
        `Named sub-agent profiles; ${SELF_PROFILE} (the spawner's own settings) is built in.`,
      ),
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
    name: trimmedText(),
    project: trimmedText(),
    match: preprocess(
      (v) => (v === undefined || Array.isArray(v) ? v : [v]),
      strings(),
      z.union([z.string(), z.array(z.string())]).optional(),
    ),
    timeout: deprecated("Replaced by timeout_seconds."),
    timeout_seconds: z
      .number()
      .default(30)
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
  const runtimes = section({ claude: runtime, aisdk: runtime, codex: runtime });
  return section({
    ...toolSettingsSchema.shape,
    $schema: z.string().optional(),
    base_branch: deprecated("Replaced by session.defaults.base_branch."),
    worktree_dir: deprecated("Replaced by session.worktree_dir."),
    db: deprecated(
      "No longer read. The database lives in $XDG_STATE_HOME/loom/repos/<repo>/loom.db; remove this setting.",
    ),
    git: gitIdentitySchema.optional(),
    default_provider: optionalText().describe(
      "Provider id new sessions use when the client names none; omitted, or not a configured provider: claude.",
    ),
    daemon: section({
      idle_stop_minutes: nonNegative(d.daemon.idleStopMinutes).describe(
        "Stop the daemon after this many minutes with no client and no running session.",
      ),
      idle_shutdown_minutes: deprecated("Replaced by daemon.idle_stop_minutes."),
    }),
    tui: section({
      include_event_log_in_editor: flag(d.tui.includeEventLogInEditor).describe(
        "Open the event log alongside the input on Alt+E. Defaults to false; enabling this may require :wq! in Vim/Neovim.",
      ),
      compat: flag(d.tui.compat).describe(
        "Terminal compatibility mode, for mosh (e.g. from Termux): full redraws, and mouse reporting without any-motion tracking, so there is no hover underline. Clicks and the wheel still work. LOOM_TUI_COMPAT=1 turns it on too. Defaults to false. Restart the TUI to apply.",
      ),
    }),
    session: preprocess(
      (v) => v ?? {},
      z.strictObject({
        environment: z
          .strictObject({
            auto_nix: z
              .boolean()
              .default(false)
              .describe(
                "Allow automatic project shell activation (devenv, flake.nix, shell.nix, default.nix), locally and in VMs. Does not grant network access. Ignored while command_prefix is set.",
              ),
            ...sessionEnvironmentFields,
          })
          .prefault({}),
        auto_nix: deprecated("Replaced by session.environment.auto_nix."),
        local_tools: deprecated("Replaced by session.mcp_servers."),
        vm_tools: deprecated("Replaced by session.mcp_servers."),
        remote_tools: deprecated("Replaced by session.mcp_servers."),
        mcp_servers: selections,
        defaults: section({
          isolation: z
            .enum(["none", "vm"])
            .default(d.defaults.isolation)
            .describe(
              "Where new sessions run: none (on the host) or vm. Each new session can still choose the other when a VM runtime is available. Existing sessions keep theirs.",
            ),
          workspace: z
            .enum(["in-place", "worktree", "clone"])
            .default(d.defaults.workspace)
            .describe(
              "What new sessions work in: in-place (the repository's own checkout, no branch), worktree (a git worktree on its own branch), or clone (VM sessions only: a private clone whose only remote is a host relay limited to the session's branch; host sessions get a worktree). Each new session can override it. Existing sessions keep theirs.",
            ),
          base_branch: optionalText().describe(
            "The repository's default branch for new sessions: the alternative the new-session prompt's base toggle (Alt+B) offers to the checked-out branch, and the base of sessions created without one (loom run). Unset: the toggle offers the remote's default branch, else init.defaultBranch, else main, and a session created without a base starts from the checked-out branch (HEAD's commit when detached). Each session keeps the base it was created with. Restart to apply.",
          ),
        }),
        worktree_dir: optionalText().describe(
          "Exact worktree directory (absolute, ~/ or relative to the repository). Omitted: $XDG_DATA_HOME/loom/worktrees/<repo>-<hash>, defaulting to ~/.local/share. Existing sessions keep their paths. Restart to apply.",
        ),
        branch_prefix: branchPrefixSchema
          .prefault(d.branchPrefix.join("/"))
          .describe(
            'What the branches of new worktree and clone sessions are named under: <prefix>/<session id> at first, <prefix>/<title slug> once titled. "" for none (<session id>, then <title slug>); slashes nest (me/loom). Defaults to loom. Existing sessions keep their branch names, and a session titled later keeps the prefix it was created with. session.clone.visible_refs may not cover these branches.',
          ),
        worktree: deprecated("Replaced by session.defaults.workspace."),
        auto_rebase: z
          .enum(["off", "rebase", "merge"])
          .default(d.autoRebase)
          .describe(
            "Keep each idle session's branch current with its base: off, rebase (replay the branch) or merge. A conflict or an uncommitted worktree asks the agent to integrate instead.",
          ),
        auto_resume: flag(d.autoResume).describe(
          "After a daemon restart, revive sessions it cut off mid-turn and ask them to continue. Sessions waiting on a person stay interrupted.",
        ),
        commit_reminder: flag(d.commitReminder).describe(
          "Remind an agent that goes idle with uncommitted changes to commit, once per commit.",
        ),
        titles: deprecated("No longer read; session titles are always generated."),
        notify: deprecated(
          "No longer read; use a hooks entry (on: waiting) instead of the webhook.",
        ),
        provider_access: section({
          allow: ids
            .optional()
            .describe("Only these provider ids may start sessions; omitted allows every one."),
          deny: ids.default([]).describe("Provider ids that may not start sessions."),
          only: deprecated("Replaced by session.provider_access.allow."),
          disabled: deprecated("Replaced by session.provider_access.deny."),
        }),
        clone: section({
          visible_refs: gitVisibleRefsSchema.describe(
            "Extra ref prefixes advertised to a clone session, such as refs/tags/. Its base and own branch are always advertised. Ref filtering is not a confidentiality boundary: clone sessions must be trusted to read repository history.",
          ),
          max_push_bytes: z
            .number()
            .int()
            .min(1024 * 1024)
            .max(64 * 1024 * 1024 * 1024)
            .default(512 * 1024 * 1024)
            .describe("Largest push a clone session may publish to its branch, in bytes."),
        }),
        isolation: section({
          enabled: deprecated("Replaced by session.defaults.isolation."),
          runtimes: runtimes.describe(
            "Per-provider session VM runtime overrides: artifact (and smolvm) paths for claude, aisdk and codex.",
          ),
          claude: deprecated("Replaced by session.isolation.runtimes.claude."),
          aisdk: deprecated("Replaced by session.isolation.runtimes.aisdk."),
          codex: deprecated("Replaced by session.isolation.runtimes.codex."),
          network: section({
            allowed_hosts: extraHostsSchema.describe(
              "Exact DNS names VM sessions may reach over HTTPS (port 443); no URLs, IPs or wildcards.",
            ),
            presets: networkPresetsSchema.describe(
              "Named host sets: nix, javascript, python, rust.",
            ),
          }),
          extra_allowed_hosts: deprecated("Replaced by session.isolation.network.allowed_hosts."),
          network_presets: deprecated("Replaced by session.isolation.network.presets."),
          // Its settings moved to session.environment first; anything left is unknown.
          environment: preprocess(
            (v) => v,
            z.strictObject({}).optional(),
            z
              .strictObject(sessionEnvironmentFields)
              .optional()
              .meta({ deprecated: true })
              .describe("Replaced by session.environment."),
          ),
          idle_stop_minutes: z
            .number()
            .int()
            .min(0)
            .max(1440)
            .default(10)
            .describe(
              "Stop idle session VMs after this many minutes; preserve their workspace and history. Zero disables idle stopping. Open shells, active tasks and keep-warm sessions are excluded.",
            ),
          idle_timeout_minutes: deprecated("Replaced by session.isolation.idle_stop_minutes."),
          launcher: deprecated(
            "No longer read. Session VMs always start through the isolation library; remove this setting.",
          ),
          checkout: deprecated(
            "Replaced by session.defaults.workspace (mode) and session.clone (visible_refs, max_push_bytes).",
          ),
        }),
      }),
    ),
    providers: preprocess(
      (v) => v ?? {},
      z.strictObject({
        claude: section({
          tag: providerTag,
          model: text(d.providers.claude.model),
          title_model: optionalText(),
          models: strings(d.providers.claude.models),
          default_mode: sessionMode
            .optional()
            .describe(
              "Permission mode of a new Claude session when none is chosen and none has been used yet; afterwards the last one used. Omitted: default (manual).",
            ),
          permission_default: deprecated("Replaced by providers.claude.default_mode."),
          setting_sources: strings(d.providers.claude.settingSources),
          disable_builtin: strings(d.providers.claude.disableBuiltin),
          cli_path: optionalText(),
          network: section({
            allowed_hosts: z
              .array(z.string())
              .optional()
              .describe(
                "Hosts (host or host:port) the Claude worker may reach besides its built-in list: api.anthropic.com, claude.ai, platform.claude.com, registry.npmjs.org, npmjs.com.",
              ),
          }),
          worker_allowed_hosts: z
            .array(z.string())
            .optional()
            .meta({ deprecated: true })
            .describe(
              "Replaced by network.allowed_hosts, which adds to the built-in hosts; this one replaces them.",
            ),
          prompt_cache_ttl: promptCacheTtl,
          profiles: preprocess(
            (v) => v ?? {},
            z.record(
              z.string(),
              section({ config_dir: trimmedText(), tag: providerTag, color: trimmedText() }),
            ),
          ),
        }),
        echo: z
          .strictObject({ enabled: deprecated("Replaced by the presence of providers.echo.") })
          .optional()
          .describe("Present: show the local-only echo provider (no API calls or cost)."),
        codex: providerFamilySchema.optional(),
        google: providerFamilySchema.optional(),
        anthropic: providerFamilySchema.optional(),
        openai_compatible: providerFamilySchema.optional(),
      }),
    ),
    hooks: z.array(hook).max(64).default([]),
    search: deprecated(
      "No longer read: web search comes from a search MCP server under mcp_servers (brave, tavily, kagi).",
    ),
    agents: agentsSchema(d.agents.maxDepth),
  });
};

/** Unknown keys in lenient sections are dropped and reported, at their dotted path. */
const stripUnknownKeys = (
  schema: z.ZodType,
  raw: unknown,
  known: readonly string[] = [],
): {
  readonly result: ReturnType<z.ZodType["safeParse"]>;
  readonly unknownKeys: readonly string[];
} => {
  const result = schema.safeParse(raw);
  const unknown = (result.error?.issues ?? []).filter(
    (issue) => issue.code === "custom" && issue.params?.[UNKNOWN_KEY] === true,
  );
  if (unknown.length === 0) return { result, unknownKeys: known };
  const stripped = unknown.reduce((value, issue) => withoutKey(value, issue.path), raw);
  return stripUnknownKeys(schema, stripped, [...known, ...unknown.map((i) => showPath(i.path))]);
};

/**
 * Report paths and expectations, never input values (which may be credentials).
 * Unknown keys of a lenient section are not errors; they come back to be reported.
 */
export const parseSettings = <T extends z.ZodType>(
  schema: T,
  raw: unknown,
): { readonly value: z.output<T>; readonly unknownKeys: readonly string[] } => {
  const { result, unknownKeys } = stripUnknownKeys(schema, raw);
  // Sound: stripUnknownKeys parsed with `schema` itself.
  if (result.success) return { value: result.data as z.output<T>, unknownKeys };
  throw new Error(
    result.error.issues
      .map((issue) => {
        const path = showPath(issue.path) || "config";
        if (
          issue.code === "unrecognized_keys" &&
          path === "session.environment" &&
          issue.keys.includes("nix")
        )
          return "session.environment.nix has been replaced by session.environment.auto_nix (boolean, default false).";
        if (issue.code === "unrecognized_keys")
          return `Unknown setting ${path}.${issue.keys.join(", ")}`;
        // Zod's own wording starts with "Invalid input: expected …"; the path already says where.
        return `${path}: ${issue.message.replace(/^Invalid (input|option): /, "")}`;
      })
      .join("; "),
  );
};

/** The keys `parseSettings` would report as unknown, whatever else is wrong with `raw`. */
export const unknownSettingKeys = (schema: z.ZodType, raw: unknown): readonly string[] =>
  stripUnknownKeys(schema, raw).unknownKeys;

/** `hooks[2].name`, `session.auto_rebase` */
const showPath = (path: readonly PropertyKey[]): string =>
  path
    .map((key, i) => (typeof key === "number" ? `[${key}]` : `${i > 0 ? "." : ""}${String(key)}`))
    .join("");

const withoutKey = (value: unknown, path: readonly PropertyKey[]): unknown => {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(value) && typeof head === "number")
    return rest.length === 0
      ? value
      : value.map((entry, i) => (i === head ? withoutKey(entry, rest) : entry));
  if (!value || typeof value !== "object" || typeof head !== "string") return value;
  const { [head]: child, ...others } = value as Record<string, unknown>;
  return rest.length === 0 ? others : { ...others, [head]: withoutKey(child, rest) };
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
