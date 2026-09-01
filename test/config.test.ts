import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  claudeProfileId,
  deepMerge,
  lintConfig,
  loadConfig,
  normalizeConfig,
  resolveApiKey,
  slugifyProfile,
} from "@loom/daemon/config/config";
import { exampleConfigPath, scaffoldUserConfig, userConfigPath } from "@loom/daemon/scaffold";

const cfg = (toml: string) => {
  return normalizeConfig(parseToml(toml));
};

test("an empty config yields the defaults: claude default, no aisdk profiles", () => {
  const c = cfg("");
  assert.equal(c.defaultProvider, "claude");
  assert.deepEqual(c.providers.aisdk, {});
});

test("[worktree] enabled defaults to true and parses a false override", () => {
  assert.equal(cfg("").worktree.enabled, true);
  assert.equal(cfg("[worktree]\nenabled = false\n").worktree.enabled, false);
  // a non-boolean is ignored, not coerced
  assert.equal(cfg('[worktree]\nenabled = "no"\n').worktree.enabled, true);
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

test("[custom-provider.<id>] is an OpenAI-compatible profile — no adapter / sdk keys", () => {
  const c = cfg(`
[custom-provider.llmbase]
base_url = "https://api.llmbase.ai/v1"
api_key  = "sk-xyz"
models   = ["big", "small"]
tag      = "lb"
`);
  const p = c.providers.aisdk["llmbase"];
  assert.ok(p);
  assert.equal(p.sdk, "openai");
  assert.equal(p.baseUrl, "https://api.llmbase.ai/v1");
  assert.equal(p.apiKey, "sk-xyz");
  assert.deepEqual(p.models, ["big", "small"]);
  assert.equal(p.model, "big");
  assert.equal(p.tag, "lb");

  // no base_url → nothing to dial → dropped
  assert.deepEqual(cfg(`[custom-provider.x]\nmodel = "m"\n`).providers.aisdk, {});
  // model-less is still kept for auto-detection
  assert.equal(
    cfg(`[custom-provider.y]\nbase_url = "http://y/v1"\n`).providers.aisdk["y"]?.autoModels,
    true,
  );
});

test("model_context parses per-model token sizes; junk rows are skipped", () => {
  const c = cfg(`
[custom-provider.sf]
base_url      = "https://sf.example/v1"
model_context = { "glm-5.3-flash" = 1048576, "glm-5" = "200000" }
`);
  const p = c.providers.aisdk["sf"];
  assert.deepEqual(p?.modelContext, { "glm-5.3-flash": 1_048_576, "glm-5": 200_000 });
  // junk: non-numeric, negative, empty key
  const junk = cfg(
    `[custom-provider.j]\nbase_url = "http://j/v1"\nmodel_context = { a = "nope", b = -5, "" = 7, c = 1000 }\n`,
  ).providers.aisdk["j"];
  assert.deepEqual(junk?.modelContext, { c: 1000 });
  // absent → empty map
  assert.deepEqual(
    cfg(`[custom-provider.z]\nbase_url = "http://z/v1"\n`).providers.aisdk["z"]?.modelContext,
    {},
  );
});

test("include_usage defaults to true and can be turned off per provider", () => {
  const base = `[custom-provider.p]\nbase_url = "http://p/v1"\n`;
  assert.equal(cfg(base).providers.aisdk["p"]?.includeUsage, true);
  assert.equal(cfg(base + `include_usage = false\n`).providers.aisdk["p"]?.includeUsage, false);
  // a non-boolean value doesn't flip the default
  assert.equal(cfg(base + `include_usage = "no"\n`).providers.aisdk["p"]?.includeUsage, true);
});

test("max_steps defaults to 50 and is clamped to 1–500", () => {
  const base = `[custom-provider.p]\nbase_url = "http://p/v1"\nmodel = "m"\n`;
  assert.equal(cfg(base).providers.aisdk["p"]?.maxSteps, 50);
  assert.equal(cfg(base + `max_steps = 120\n`).providers.aisdk["p"]?.maxSteps, 120);
  assert.equal(cfg(base + `max_steps = 0\n`).providers.aisdk["p"]?.maxSteps, 1);
  assert.equal(cfg(base + `max_steps = 9999\n`).providers.aisdk["p"]?.maxSteps, 500);
  assert.equal(cfg(base + `max_steps = 12.9\n`).providers.aisdk["p"]?.maxSteps, 12);
  assert.equal(cfg(base + `max_steps = "nope"\n`).providers.aisdk["p"]?.maxSteps, 50);
});

test("[google] / [anthropic] are one native profile each, id = the vendor", () => {
  const c = cfg(`
[google]
api_key_env = "GEMINI_KEY"
model       = "gemini-2.5-pro"

[anthropic]
api_key = "sk-ant"
model   = "claude-opus-5"
`);
  assert.equal(c.providers.aisdk["google"]?.sdk, "google");
  assert.equal(c.providers.aisdk["google"]?.model, "gemini-2.5-pro");
  assert.equal(c.providers.aisdk["anthropic"]?.sdk, "anthropic");
  assert.equal(c.providers.aisdk["anthropic"]?.model, "claude-opus-5");
  // native SDKs still need a model (no /models probe)
  assert.deepEqual(cfg(`[google]\napi_key = "k"\n`).providers.aisdk, {});
});

test("legacy [providers.<id>] adapter='aisdk' still works and wins a duplicate id", () => {
  const c = cfg(`
[custom-provider.dup]
base_url = "http://sugar/v1"
model    = "sugar-model"

[providers.dup]
adapter  = "aisdk"
base_url = "http://legacy/v1"
model    = "legacy-model"
`);
  assert.equal(c.providers.aisdk["dup"]?.baseUrl, "http://legacy/v1");
  assert.equal(c.providers.aisdk["dup"]?.model, "legacy-model");
});

test("an openai profile with no model/models is kept for auto-detection; google/anthropic dropped", () => {
  const c = cfg(`
[providers.auto]
adapter  = "aisdk"
base_url = "http://x/v1"

[providers.gem]
adapter = "aisdk"
sdk     = "google"

[providers.ok]
adapter  = "aisdk"
base_url = "http://y/v1"
models   = ["m1", "m2"]
`);
  assert.equal(c.providers.aisdk["auto"]?.autoModels, true);
  assert.equal(c.providers.aisdk["auto"]?.model, "");
  assert.deepEqual(c.providers.aisdk["auto"]?.models, []);
  assert.equal(c.providers.aisdk["gem"], undefined); // can't probe → dropped
  assert.equal(c.providers.aisdk["ok"]?.model, "m1"); // first of models
  assert.equal(c.providers.aisdk["ok"]?.autoModels, false);
  assert.deepEqual(c.providers.aisdk["ok"]?.models, ["m1", "m2"]);
});

test("resolveApiKey: inline api_key wins over api_key_env; else env; else empty", () => {
  const env = { MYKEY: "from-env" } as unknown as NodeJS.ProcessEnv;
  assert.equal(resolveApiKey({ apiKey: "inline", apiKeyEnv: "MYKEY" }, env), "inline");
  assert.equal(resolveApiKey({ apiKey: "", apiKeyEnv: "MYKEY" }, env), "from-env");
  assert.equal(resolveApiKey({ apiKey: "", apiKeyEnv: "MISSING" }, env), "");
  assert.equal(resolveApiKey({}, env), "");
});

test("lintConfig flags unset env vars, auto-detect, keyless search", () => {
  const c = cfg(`
[providers.p]
adapter     = "aisdk"
base_url    = "http://x/v1"
api_key_env = "DEFINITELY_UNSET_VAR"

[providers.auto]
adapter  = "aisdk"
base_url = "http://y/v1"

[search]
backend = "brave"
`);
  const w = lintConfig(c, {} as NodeJS.ProcessEnv);
  assert.ok(w.some((l) => /\$DEFINITELY_UNSET_VAR is not set/.test(l)));
  assert.ok(w.some((l) => /provider "auto".*auto-detect/.test(l)));
  assert.ok(w.some((l) => /search:.*web_search stays disabled/.test(l)));

  // an inline api_key silences the env-var warning
  const c2 = cfg(`
[providers.p]
adapter  = "aisdk"
base_url = "http://x/v1"
api_key  = "sk-inline"
model    = "m"
`);
  assert.deepEqual(lintConfig(c2, {} as NodeJS.ProcessEnv), []);

  // a clean config lints clean
  assert.deepEqual(lintConfig(cfg("")), []);
});

test("numeric config fields reject negatives / NaN; strArray keeps the valid entries", () => {
  const c = cfg(`
[daemon]
idle_shutdown_minutes = -5
event_buffer_size     = -1

[search]
max_results = -2

[providers.claude]
disable_builtin = ["Grep", 5, "Glob"]
`);
  assert.equal(c.daemon.idleShutdownMinutes, 30); // default
  assert.equal(c.daemon.eventBufferSize, 4096); // default (also clamped ≥ 1)
  assert.equal(c.search.maxResults, 5); // default
  assert.deepEqual(c.providers.claude.disableBuiltin, ["Grep", "Glob"]); // stray 5 dropped, not the whole list
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

// --- aisdk `sdk` backend selection --------------------------------------

test("sdk defaults to openai; google/anthropic don't need a base_url", () => {
  const c = cfg(`
[providers.openai]
adapter  = "aisdk"
base_url = "https://api.openai.com/v1"
model    = "gpt-5"

[providers.gemini]
adapter     = "aisdk"
sdk         = "google"
api_key_env = "GEMINI_API_KEY"
model       = "gemini-2.5-pro"

[providers.claude-api]
adapter = "aisdk"
sdk     = "anthropic"
model   = "claude-sonnet-5"

[providers.dropped]
adapter = "aisdk"
sdk     = "openai"
model   = "x"
`);
  assert.equal(c.providers.aisdk["openai"]?.sdk, "openai");
  assert.equal(c.providers.aisdk["gemini"]?.sdk, "google");
  assert.equal(c.providers.aisdk["gemini"]?.baseUrl, "");
  assert.equal(c.providers.aisdk["claude-api"]?.sdk, "anthropic");
  // an openai profile with no base_url is still dropped
  assert.equal(c.providers.aisdk["dropped"], undefined);
});

test("an unknown sdk value falls back to openai", () => {
  const c = cfg(`
[providers.weird]
adapter  = "aisdk"
sdk      = "cohere"
base_url = "http://x/v1"
model    = "m"
`);
  assert.equal(c.providers.aisdk["weird"]?.sdk, "openai");
});

// --- [search] ---------------------------------------------------------------

test("[search] parses a backend + key env + base; unknown backend → none", () => {
  const c = cfg(`
[search]
backend     = "brave"
api_key_env = "BRAVE_API_KEY"
api_base    = "http://localhost:7777"
max_results = 8
`);
  assert.equal(c.search.backend, "brave");
  assert.equal(c.search.apiKeyEnv, "BRAVE_API_KEY");
  assert.equal(c.search.apiBase, "http://localhost:7777");
  assert.equal(c.search.maxResults, 8);

  assert.equal(
    cfg(`[search]\nbackend = "kagi"\napi_key_env = "KAGI_API_KEY"\n`).search.backend,
    "kagi",
  );
  assert.equal(cfg(`[search]\nbackend = "google"\n`).search.backend, "none");
  assert.equal(cfg(``).search.backend, "none");
  assert.equal(cfg(``).search.maxResults, 5);
});

// --- [auto_rebase] --------------------------------------------------------

test("[auto_rebase] defaults off/rebase; parses enabled + mode, unknown mode → rebase", () => {
  assert.deepEqual(cfg("").autoRebase, { enabled: false, mode: "rebase" });

  const c = cfg(`
[auto_rebase]
enabled = true
mode    = "merge"
`);
  assert.deepEqual(c.autoRebase, { enabled: true, mode: "merge" });

  assert.equal(cfg(`[auto_rebase]\nmode = "cherry-pick"\n`).autoRebase.mode, "rebase");
  assert.equal(cfg(`[auto_rebase]\nenabled = "yes"\n`).autoRebase.enabled, false);
});

// --- claude profiles -----------------------------------------------------

test("slugifyProfile is kebab, trimmed, and collapses '' / 'claude' onto the base id", () => {
  assert.equal(slugifyProfile(""), "");
  assert.equal(slugifyProfile("Claude"), "");
  assert.equal(slugifyProfile("Work"), "work");
  assert.equal(slugifyProfile("  My Work Box! "), "my-work-box");
  assert.equal(claudeProfileId({ name: "" }), "claude");
  assert.equal(claudeProfileId({ name: "Work" }), "claude:work");
});

test("no [[claude_profiles]] → a single expanded ~/.claude profile with id 'claude'", () => {
  const c = cfg("");
  assert.equal(c.claudeProfiles.length, 1);
  assert.equal(c.claudeProfiles[0]?.dir, join(homedir(), ".claude"));
  assert.equal(claudeProfileId(c.claudeProfiles[0] ?? { name: "x" }), "claude");
});

test("a named profile gets id claude:<slug>; the first / unnamed one stays 'claude'", () => {
  const c = cfg(`
[[claude_profiles]]
dir = "~/.claude"

[[claude_profiles]]
dir   = "~/.claude-work"
name  = "Work"
color = "yellow"
`);
  assert.deepEqual(c.claudeProfiles.map(claudeProfileId), ["claude", "claude:work"]);
  assert.equal(c.claudeProfiles[1]?.dir, join(homedir(), ".claude-work"));
  assert.equal(c.claudeProfiles[1]?.color, "yellow");
});

test("claude_profiles: a blank dir is dropped and a colliding id is de-duplicated", () => {
  const c = cfg(`
[[claude_profiles]]
dir = ""

[[claude_profiles]]
dir = "/one/.claude"

[[claude_profiles]]
dir = "/two/.claude"
`);
  // both unnamed → both resolve to id "claude"; first wins, blank is gone
  assert.equal(c.claudeProfiles.length, 1);
  assert.equal(c.claudeProfiles[0]?.dir, "/one/.claude");
});

test("default_provider may name a claude profile id", () => {
  const c = cfg(`
default_provider = "claude:work"
[[claude_profiles]]
dir = "~/.claude"
[[claude_profiles]]
dir  = "~/.claude-work"
name = "Work"
`);
  assert.equal(c.defaultProvider, "claude:work");
  // an unconfigured id still falls back to claude
  assert.equal(cfg(`default_provider = "claude:ghost"`).defaultProvider, "claude");
});

test("a claude:<slug> id can't be claimed by an aisdk profile", () => {
  const c = cfg(`
[custom-provider."claude:work"]
base_url = "http://localhost:1234/v1"
model    = "x"
`);
  assert.deepEqual(c.providers.aisdk, {});
});

// --- first-run scaffold ----------------------------------------------------

test("scaffoldUserConfig drops the example at the XDG path once, never overwriting", () => {
  const saved = process.env["XDG_CONFIG_HOME"];
  const dir = mkdtempSync(join(tmpdir(), "loom-scaffold-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  try {
    const dest = userConfigPath();
    assert.ok(dest.startsWith(dir));

    const created = scaffoldUserConfig();
    assert.equal(created, dest);
    assert.equal(readFileSync(dest, "utf8"), readFileSync(exampleConfigPath(), "utf8"));

    // idempotent: a second call is a no-op and leaves edits intact
    writeFileSync(dest, 'base_branch = "trunk"\n');
    assert.equal(scaffoldUserConfig(), null);
    assert.match(readFileSync(dest, "utf8"), /trunk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = saved;
  }
});
