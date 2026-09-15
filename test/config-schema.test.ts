import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ajv } from "npm:ajv@8.20.0";
import { configEditorSchema } from "../backend/daemon/src/config/schema.ts";
import {
  DEFAULT_CONFIG,
  HOOK_EVENTS,
  parseConfig,
  normalizeConfig,
} from "@loom/daemon/config/config";
import {
  exampleSchemaPath,
  exampleConfigPath,
  userConfigPath,
  userSchemaPath,
  scaffoldUserConfig,
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
    { "custom-provider": { local: { base_url: "http://localhost/v1" } } },
    { providers: { work: { sdk: "chatgpt" } }, chatgpt: {} },
    { providers: { claude: { permission_default: "manual" } } },
    { hooks: [{ on: "turn_end", run: "check", timeout: 30 }] },
    { hooks: [{ on: ["waiting", "permission"], run: "notify", match: "*.ts" }] },
    {
      repo: [{ path: "~/dev/project", isolation: { enabled: true }, session: { "vm-tools": [] } }],
    },
  ])
    assert.ok(validate(value), JSON.stringify(validate.errors));
  for (const value of [
    { isolation: { enabled: "yes" } },
    { repo: [{}] },
    { repo: { path: "/repo" } },
    { providers: { work: { sdk: "typo" } } },
    { "local-tools": { code: {} } },
    { hooks: [{ on: "typo", run: "check" }] },
    { hooks: [{ on: "turn_end" }] },
    { repo: [{ path: "/repo", repo: [] }] },
    { isolation: { environment: { cpus: 0 } } },
  ])
    assert.equal(validate(value), false, JSON.stringify(value));
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
    writeFileSync(userConfigPath(), '{"worktree": {"enabled": false}}');
    writeFileSync(userSchemaPath(), "{}");
    assert.equal(scaffoldUserConfig(), null);
    assert.equal(
      normalizeConfig(parseConfig(readFileSync(userConfigPath(), "utf8"))).worktree.enabled,
      false,
    );
    assert.equal(readFileSync(userSchemaPath(), "utf8"), readFileSync(exampleSchemaPath(), "utf8"));
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config validation errors identify fields without exposing credentials or hook commands", () => {
  for (const raw of [
    { "remote-tools": { private: { url: "https://user:secret-token@host/mcp" } } },
    { hooks: [{ run: "secret-token\0", on: "turn_end" }] },
  ])
    assert.throws(
      () => normalizeConfig(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.match(error.message, /remote-tools|hooks/);
        return true;
      },
    );
});

test("Zod retains the existing lenient defaults and null tool selections", () => {
  const config = normalizeConfig({
    worktree: "ignored",
    titles: { enabled: "ignored" },
    session: { "local-tools": null },
    "local-tools": null,
    "custom-provider": null,
    providers: { claude: { models: ["sonnet", 12, "haiku"] } },
  });
  assert.equal(config.worktree.enabled, true);
  assert.equal(config.titles.enabled, true);
  assert.deepEqual(config.mcp, []);
  assert.deepEqual(config.providers.claude.models, ["sonnet", "haiku"]);
  assert.deepEqual(normalizeConfig({ session: null }).mcp, []);
});
