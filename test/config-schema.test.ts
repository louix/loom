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
  normalizeConfig,
  parseConfig,
} from "@loom/daemon/config/config";
import {
  exampleConfigPath,
  exampleSchemaPath,
  scaffoldUserConfig,
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
    { session: { isolation: { network_presets: ["rust"] } } },
    { session: { auto_nix: true, isolation: { network_presets: ["nix"] } } },
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
            vm_tools: [],
            isolation: {
              enabled: true,
              network_presets: ["nix", "rust"],
            },
          },
        },
      ],
    },
  ]) {
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
  for (const value of [
    { session: { auto_nix: "yes" } },
    { session: { environment: { nix: { auto_activate: true } } } },
    { session: { isolation: { environment: { nix: true } } } },
    {
      session: {
        isolation: {
          enabled: "yes",
        },
      },
    },
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
      local_tools: {
        code: {},
      },
    },
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
        isolation: {
          environment: {
            cpus: 0,
          },
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
      '{\n  "session": {\n    "worktree": {\n      "enabled": false\n    }\n  }\n}',
    );
    writeFileSync(userSchemaPath(), "{}");
    assert.equal(scaffoldUserConfig(), null);
    assert.equal(
      normalizeConfig(parseConfig(readFileSync(userConfigPath(), "utf8"))).worktree.enabled,
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(userSchemaPath(), "utf8")), schema);
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config validation errors identify fields without exposing credentials or hook commands", () => {
  for (const raw of [
    {
      remote_tools: {
        private: {
          url: "https://user:secret-token@host/mcp",
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
        assert.match(error.message, /remote_tools|hooks/);
        return true;
      },
    );
  }
});

test("Zod retains the existing lenient defaults and null tool selections", () => {
  const config = normalizeConfig({
    local_tools: null,
    providers: {
      claude: {
        models: ["sonnet", 12, "haiku"],
      },
    },
    session: {
      local_tools: null,
      worktree: "ignored",
      titles: {
        enabled: "ignored",
      },
    },
  });
  assert.equal(config.worktree.enabled, true);
  assert.equal(config.titles.enabled, true);
  assert.deepEqual(config.mcp, []);
  assert.deepEqual(config.providers.claude.models, ["sonnet", "haiku"]);
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
    const custom = '{"session":{"auto_resume":{"enabled":false}}}\n';
    writeFileSync(config, custom);
    writeFileSync(offlineSchema, "{}");
    run(Deno.execPath(), args);
    assert.equal(readFileSync(config, "utf8"), custom);
    assert.deepEqual(JSON.parse(readFileSync(offlineSchema, "utf8")), schema);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
