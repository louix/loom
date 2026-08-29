import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { deepMerge, loadConfig, normalizeConfig } from "../src/config/config.ts";

function cfg(toml: string) {
  return normalizeConfig(parseToml(toml));
}

test("an empty config yields the defaults: claude default, no aisdk profiles", () => {
  const c = cfg("");
  assert.equal(c.defaultProvider, "claude");
  assert.deepEqual(c.providers.aisdk, {});
});

test("a [providers.<id>] table with adapter='aisdk' becomes a profile", () => {
  const c = cfg(`
[providers.deepseek]
adapter     = "aisdk"
base_url    = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"
model       = "deepseek-chat"
models      = ["deepseek-chat", "deepseek-reasoner"]
tag         = "ds"
title_model = "deepseek-chat"
`);
  const p = c.providers.aisdk["deepseek"];
  assert.ok(p);
  assert.equal(p.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(p.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(p.model, "deepseek-chat");
  assert.deepEqual(p.models, ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(p.tag, "ds");
  assert.equal(p.titleModel, "deepseek-chat");
});

test("models defaults to [model] and tag defaults to the id", () => {
  const c = cfg(`
[providers.local]
adapter  = "aisdk"
base_url = "http://localhost:11434/v1"
model    = "qwen2.5-coder"
`);
  const p = c.providers.aisdk["local"];
  assert.ok(p);
  assert.deepEqual(p.models, ["qwen2.5-coder"]);
  assert.equal(p.tag, "local");
  assert.equal(p.apiKeyEnv, "");
});

test("a profile without base_url or without the aisdk adapter is ignored", () => {
  const c = cfg(`
[providers.broken]
adapter = "aisdk"
model   = "x"

[providers.notours]
base_url = "http://x/v1"
model    = "y"
`);
  assert.deepEqual(c.providers.aisdk, {});
});

test("default_provider must be configured, else it falls back to claude", () => {
  assert.equal(cfg(`default_provider = "ghost"`).defaultProvider, "claude");
  assert.equal(
    cfg(`
default_provider = "openai"
[providers.openai]
adapter  = "aisdk"
base_url = "http://x/v1"
model    = "gpt-5"
`).defaultProvider,
    "openai",
  );
});

test("claude is never treated as an aisdk profile even if adapter is set", () => {
  const c = cfg(`
[providers.claude]
adapter = "aisdk"
model   = "claude-sonnet-5"
`);
  assert.deepEqual(c.providers.aisdk, {});
  assert.equal(c.providers.claude.model, "claude-sonnet-5");
});

// --- deepMerge / XDG layering --------------------------------------------

test("deepMerge: over wins, objects merge, arrays/scalars replace", () => {
  const merged = deepMerge(
    { a: 1, nested: { x: 1, y: 2 }, list: [1, 2], keep: "me" },
    { a: 2, nested: { y: 3, z: 4 }, list: [9] },
  );
  assert.deepEqual(merged, { a: 2, nested: { x: 1, y: 3, z: 4 }, list: [9], keep: "me" });
});

test("loadConfig layers the per-repo file over the user file", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  try {
    const userPath = join(dir, "user.toml");
    const repoPath = join(dir, "repo.toml");
    writeFileSync(
      userPath,
      `
default_provider = "deepseek"
base_branch = "trunk"

[providers.deepseek]
adapter     = "aisdk"
base_url    = "https://api.deepseek.com/v1"
api_key_env = "DEEPSEEK_API_KEY"
model       = "deepseek-chat"
`,
    );
    writeFileSync(
      repoPath,
      `
base_branch = "main"

[providers.deepseek]
model = "deepseek-reasoner"
`,
    );

    const c = loadConfig(repoPath, userPath);
    // repo wins on the scalar it sets
    assert.equal(c.baseBranch, "main");
    // user-only scalar survives
    assert.equal(c.defaultProvider, "deepseek");
    // the profile is merged: user's base_url + repo's model override
    assert.equal(c.providers.aisdk["deepseek"]?.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(c.providers.aisdk["deepseek"]?.model, "deepseek-reasoner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig works when the user file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  try {
    const repoPath = join(dir, "repo.toml");
    writeFileSync(repoPath, `base_branch = "dev"\n`);
    const c = loadConfig(repoPath, join(dir, "does-not-exist.toml"));
    assert.equal(c.baseBranch, "dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
