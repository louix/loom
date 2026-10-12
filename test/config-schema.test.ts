// test-run: own-process — points XDG_CONFIG_HOME at its fixture for config code that reads Deno.env.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ajv } from "npm:ajv@8.20.0";
import { configEditorSchema } from "../backend/daemon/src/config/schema.ts";
import {
  DEFAULT_CONFIG,
  HOOK_EVENTS,
  lintConfig,
  normalizeConfig,
  parseConfig,
} from "@loom/daemon/config/config";
import {
  exampleConfigPath,
  exampleSchemaPath,
  scaffoldUserConfig,
  SEARCH_MCP_SERVERS,
  userConfigPath,
  userSchemaPath,
} from "@loom/daemon/scaffold";

const schema = configEditorSchema(DEFAULT_CONFIG, HOOK_EVENTS);

test("shipped editor schema is generated from the current Zod config definitions", () => {
  assert.deepEqual(JSON.parse(readFileSync(exampleSchemaPath(), "utf8")), schema);
});

test("editor schema validates user inputs, optional defaults, and repo overrides", () => {
  const validate = new Ajv({ strict: false }).compile(schema);
  for (const value of [
    {},
    parseConfig(readFileSync(exampleConfigPath(), "utf8")),
    {
      providers: {
        openai_compatible: {
          profiles: {
            local: {
              base_url: "http://localhost/v1",
            },
          },
        },
      },
    },
    {
      providers: {
        codex: {
          profiles: {
            work: {},
          },
        },
      },
    },
    {
      providers: {
        claude: {
          permission_default: "manual",
          tag: "Claude account",
          profiles: { work: { config_dir: "~/.claude-work", tag: "Work Claude" } },
        },
      },
    },
    { session: { isolation: { network: { presets: ["rust"] } } } },
    {
      session: {
        environment: { auto_nix: true, cpus: 2 },
        isolation: { network: { presets: ["nix"], allowed_hosts: [] } },
      },
    },
    {
      session: {
        auto_rebase: "merge",
        auto_resume: false,
        commit_reminder: false,
        worktree_dir: "",
        defaults: { base_branch: "main" },
        provider_access: { allow: ["claude"], deny: [] },
        clone: { visible_refs: ["refs/tags/"] },
        isolation: { idle_stop_minutes: 0, runtimes: { claude: { artifact: "/runtime" } } },
      },
      daemon: { idle_stop_minutes: 5 },
      default_provider: "",
      providers: {
        echo: {},
        claude: {
          default_mode: "auto",
          prompt_cache_ttl: "off",
          cli_path: "",
          network: { allowed_hosts: ["localhost:9876"] },
        },
        anthropic: { prompt_cache_ttl: "default", api_key_env: "ANTHROPIC_API_KEY" },
      },
      hooks: [{ on: "turn_end", run: "check", timeout_seconds: 30 }],
      agents: { profiles: { solo: { description: "Alone", mcp_servers: { allow: [] } } } },
    },
    // Editors accept deprecated keys; Loom reads them under their new names and says so.
    {
      session: {
        worktree: { enabled: false },
        titles: { enabled: false },
        notify: { webhook: "" },
        isolation: { enabled: true, network_presets: ["nix"], checkout: { mode: "clone" } },
        auto_nix: true,
        provider_access: { only: ["claude"], disabled: [] },
      },
      base_branch: "main",
      worktree_dir: "",
      daemon: { idle_shutdown_minutes: 30 },
      providers: {
        echo: { enabled: true },
        claude: { permission_default: "bypassPermissions", worker_allowed_hosts: ["x.example"] },
      },
    },
    {
      mcp_servers: {
        docs: {
          source: { kind: "runtime", ref: "docs" },
          execution: "vm",
          grants: { network: ["api.example.com"] },
        },
      },
    },
    { hooks: [{ on: "turn_end", run: "check", timeout: 30 }] },
    {
      hooks: [
        {
          on: ["waiting", "permission"],
          run: "notify",
          match: "*.ts",
        },
      ],
    },
    {
      repos: [
        {
          path: "~/dev/project",
          session: {
            mcp_servers: [],
            defaults: { isolation: "vm" },
            isolation: {
              network: { presets: ["nix", "rust"] },
            },
          },
        },
      ],
    },
  ]) {
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
  for (const value of [
    { session: { environment: { auto_nix: "yes" } } },
    { session: { environment: { nix: { auto_activate: true } } } },
    { session: { auto_rebase: { enabled: true } } },
    { session: { auto_resume: "no" } },
    { providers: { claude: { prompt_cache_ttl: "60m" } } },
    { agents: { profiles: { solo: { description: "Alone", mcp_servers: ["tilth"] } } } },
    // Unknown keys only warn at runtime, but editors still flag them.
    { tui: { compat: true, typo: 1 } },
    {
      session: {
        defaults: {
          isolation: "yes",
        },
      },
    },
    { session: { isolation: { network: { hosts: ["example.com"] } } } },
    {
      repos: [{}],
    },
    {
      repos: {
        path: "/repo",
      },
    },
    {
      providers: {
        typo: {
          profiles: {
            work: {},
          },
        },
      },
    },
    {
      mcp_servers: {
        code: {},
      },
    },
    { mcp_servers: { code: { source: { kind: "command" } } } },
    { hooks: [{ on: "typo", run: "check" }] },
    { hooks: [{ on: "turn_end" }] },
    {
      repos: [
        {
          path: "/repo",
          repos: [],
        },
      ],
    },
    {
      session: {
        environment: {
          cpus: 0,
        },
      },
    },
  ]) {
    assert.equal(validate(value), false, JSON.stringify(value));
  }
});

test("scaffolding refreshes the offline schema without overwriting user settings", () => {
  const previous = Deno.env.get("XDG_CONFIG_HOME");
  const dir = mkdtempSync(join(tmpdir(), "loom-schema-"));
  Deno.env.set("XDG_CONFIG_HOME", dir);
  try {
    scaffoldUserConfig();
    assert.equal(
      parseConfig(readFileSync(userConfigPath(), "utf8")).$schema,
      "./config.schema.json",
    );
    writeFileSync(
      userConfigPath(),
      '{\n  "session": {\n    "defaults": {\n      "workspace": "in-place"\n    }\n  }\n}',
    );
    writeFileSync(userSchemaPath(), "{}");
    assert.equal(scaffoldUserConfig(), null);
    assert.equal(
      normalizeConfig(parseConfig(readFileSync(userConfigPath(), "utf8"))).defaults.workspace,
      "in-place",
    );
    assert.deepEqual(JSON.parse(readFileSync(userSchemaPath(), "utf8")), schema);
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the starter and example configs define brave and tavily search, valid and unselected", () => {
  const previous = Deno.env.get("XDG_CONFIG_HOME");
  const dir = mkdtempSync(join(tmpdir(), "loom-starter-"));
  Deno.env.set("XDG_CONFIG_HOME", dir);
  try {
    // given
    scaffoldUserConfig();
    const validate = new Ajv({ strict: false }).compile(schema);
    for (const raw of [
      parseConfig(readFileSync(userConfigPath(), "utf8")),
      parseConfig(readFileSync(exampleConfigPath(), "utf8")),
    ]) {
      // then
      assert.ok(validate(raw), JSON.stringify(validate.errors));
      const config = normalizeConfig(raw);
      assert.deepEqual(
        { brave: config.mcpServers?.["brave"], tavily: config.mcpServers?.["tavily"] },
        normalizeConfig({ mcp_servers: SEARCH_MCP_SERVERS }).mcpServers,
      );
      assert.deepEqual(
        [...config.mcp, ...config.httpMcp].filter((m) => m.name === "brave" || m.name === "tavily"),
        [],
      );
    }
    // when selected, each needs only its key
    const selected = (name: string) =>
      normalizeConfig({ mcp_servers: SEARCH_MCP_SERVERS, session: { mcp_servers: [name] } });
    assert.deepEqual(selected("brave").mcp, [
      {
        name: "brave",
        required: true,
        defaultFor: ["web_search"],
        command: "npx",
        args: ["--yes", "@brave/brave-search-mcp-server@2.1.4", "--transport", "stdio"],
        passEnv: ["BRAVE_API_KEY"],
      },
    ]);
    assert.deepEqual(selected("tavily").httpMcp, [
      {
        name: "tavily",
        required: true,
        defaultFor: ["web_search", "web_fetch"],
        url: "https://mcp.tavily.com/mcp/",
        bearerTokenEnv: "TAVILY_API_KEY",
      },
    ]);
    assert.ok(
      lintConfig(selected("brave"), {}).includes(
        'MCP "brave": $BRAVE_API_KEY is not set — session creation will fail',
      ),
    );
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config validation errors identify fields without exposing credentials or hook commands", () => {
  for (const raw of [
    {
      mcp_servers: {
        private: {
          source: { kind: "http", url: "https://user:secret-token@host/mcp" },
        },
      },
    },
    { hooks: [{ run: "secret-token\0", on: "turn_end" }] },
  ]) {
    assert.throws(
      () => normalizeConfig(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.match(error.message, /mcp_servers|hooks/);
        return true;
      },
    );
  }
});

test("null reads as absent; a wrong type is an error naming the key", () => {
  const config = normalizeConfig({
    mcp_servers: null,
    tui: null,
    providers: {
      claude: {
        models: ["sonnet", "haiku"],
      },
    },
    session: {
      mcp_servers: null,
    },
  });
  assert.deepEqual(config.mcp, []);
  assert.deepEqual(config.providers.claude.models, ["sonnet", "haiku"]);
  assert.throws(
    () => normalizeConfig({ providers: { claude: { models: ["sonnet", 12] } } }),
    /^Error: providers\.claude\.models\[1\]: expected string, received number$/,
  );
  assert.deepEqual(
    normalizeConfig({
      session: null,
    }).mcp,
    [],
  );
});

test("CLI launch creates config and refreshes schema without starting a daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-launch-config-"));
  const run = (command: string, args: string[]) => {
    const result = new Deno.Command(command, {
      args,
      cwd: dir,
      env: { XDG_CONFIG_HOME: dir },
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  };
  try {
    run("git", ["init", "--quiet"]);
    const entry = new URL("../cli/src/loom.ts", import.meta.url).pathname;
    const args = [
      "run",
      "-A",
      "--deny-net",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      entry,
      "stop",
    ];
    run(Deno.execPath(), args);
    const config = join(dir, "loom/config.jsonc");
    const offlineSchema = join(dir, "loom/config.schema.json");
    assert.equal(parseConfig(readFileSync(config, "utf8")).$schema, "./config.schema.json");
    const custom = '{"session":{"auto_resume":false}}\n';
    writeFileSync(config, custom);
    writeFileSync(offlineSchema, "{}");
    run(Deno.execPath(), args);
    assert.equal(readFileSync(config, "utf8"), custom);
    assert.deepEqual(JSON.parse(readFileSync(offlineSchema, "utf8")), schema);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
