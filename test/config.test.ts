import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
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

test("a named provider defaults to an OpenAI-compatible endpoint", () => {
  const c = cfg(`
[providers.deepseek]
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
base_url = "http://localhost:11434/v1"
model    = "qwen2.5-coder"
`);
  const p = c.providers.aisdk["local"];
  assert.ok(p);
  assert.deepEqual(p.models, ["qwen2.5-coder"]);
  assert.equal(p.tag, "local");
  assert.equal(p.apiKeyEnv, "");
});

test("an OpenAI-compatible profile needs a base_url", () => {
  const c = cfg(`
[providers.broken]
model   = "x"
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

test("include_usage defaults to true and can be turned off per provider", () => {
  const base = `[custom-provider.p]\nbase_url = "http://p/v1"\n`;
  assert.equal(cfg(base).providers.aisdk["p"]?.includeUsage, true);
  assert.equal(cfg(base + `include_usage = false\n`).providers.aisdk["p"]?.includeUsage, false);
  // a non-boolean value doesn't flip the default
  assert.equal(cfg(base + `include_usage = "no"\n`).providers.aisdk["p"]?.includeUsage, true);
});

test("prompt_cache_ttl on an aisdk profile takes 5m / 1h / off, else unset", () => {
  const base = `[custom-provider.p]\nbase_url = "http://p/v1"\n`;
  const ttl = (extra = "") => cfg(base + extra).providers.aisdk["p"]?.promptCacheTtl;
  // unset = cache at the API's own default lifetime, not "no caching"
  assert.equal(ttl(), "");
  assert.equal(ttl(`prompt_cache_ttl = "5m"\n`), "5m");
  assert.equal(ttl(`prompt_cache_ttl = "1h"\n`), "1h");
  assert.equal(ttl(`prompt_cache_ttl = "off"\n`), "off");
  // junk reads as unset rather than silently disabling the cache
  assert.equal(ttl(`prompt_cache_ttl = "60m"\n`), "");
  assert.equal(ttl(`prompt_cache_ttl = true\n`), "");
});

test("[providers.claude] prompt_cache_ttl is unset by default — the CLI decides", () => {
  assert.equal(cfg("").providers.claude.promptCacheTtl, "");
  assert.equal(
    cfg(`[providers.claude]\nprompt_cache_ttl = "1h"\n`).providers.claude.promptCacheTtl,
    "1h",
  );
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

test("[chatgpt] uses Codex OAuth instead of requiring an API key", () => {
  const c = cfg(`
[chatgpt]
model     = "gpt-5-codex"
models    = ["gpt-5-codex", "gpt-5"]
auth_path = "~/custom-codex/auth.json"
codex_cli_path = "~/bin/codex"
codex_builtin_web_search = true
`);
  const p = c.providers.aisdk["chatgpt"];
  assert.ok(p);
  assert.equal(p.sdk, "chatgpt");
  assert.equal(p.apiKey, "");
  assert.equal(p.apiKeyEnv, "");
  assert.equal(p.authPath, join(homedir(), "custom-codex/auth.json"));
  assert.equal(p.codexCliPath, join(homedir(), "bin/codex"));
  assert.equal(p.codexBuiltinWebSearch, true);
  assert.deepEqual(p.models, ["gpt-5-codex", "gpt-5"]);
  assert.deepEqual(lintConfig({ ...c, claudeProfiles: [] }), []);
});

test("[chatgpt] disables Codex web search unless explicitly enabled", () => {
  assert.equal(cfg(`[chatgpt]\n`).providers.aisdk["chatgpt"]?.codexBuiltinWebSearch, false);
  assert.equal(
    cfg(`[chatgpt]\ncodex_builtin_web_search = true\n`).providers.aisdk["chatgpt"]
      ?.codexBuiltinWebSearch,
    true,
  );
});

test("a low-level sdk = chatgpt profile routes without an API key", () => {
  const p = cfg(`
[providers.work]
sdk     = "chatgpt"
model   = "gpt-5-codex"
`).providers.aisdk["work"];
  assert.equal(p?.sdk, "chatgpt");
  assert.equal(p?.model, "gpt-5-codex");
});

test("named provider settings take precedence over shorthand with the same id", () => {
  const c = cfg(`
[custom-provider.dup]
base_url = "http://sugar/v1"
model    = "sugar-model"

[providers.dup]
base_url = "http://named/v1"
model    = "named-model"
`);
  assert.equal(c.providers.aisdk["dup"]?.baseUrl, "http://named/v1");
  assert.equal(c.providers.aisdk["dup"]?.model, "named-model");
});

test("openai and chatgpt profiles with no model/models are kept for auto-detection; google/anthropic dropped", () => {
  const c = cfg(`
[providers.auto]
base_url = "http://x/v1"

[providers.gem]
sdk     = "google"

[chatgpt]

[providers.ok]
base_url = "http://y/v1"
models   = ["m1", "m2"]
`);
  assert.equal(c.providers.aisdk["auto"]?.autoModels, true);
  assert.equal(c.providers.aisdk["chatgpt"]?.autoModels, true);
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
base_url    = "http://x/v1"
api_key_env = "DEFINITELY_UNSET_VAR"

[providers.auto]
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
base_url = "http://x/v1"
api_key  = "sk-inline"
model    = "m"
`);
  assert.deepEqual(lintConfig({ ...c2, claudeProfiles: [] }, {} as NodeJS.ProcessEnv), []);

  // a clean config lints clean
  assert.deepEqual(lintConfig({ ...cfg(""), claudeProfiles: [] }), []);
});

test("numeric config fields reject negatives / NaN; strArray keeps the valid entries", () => {
  const c = cfg(`
[daemon]
idle_shutdown_minutes = -5

[search]
max_results = -2

[providers.claude]
disable_builtin = ["Grep", 5, "Glob"]
`);
  assert.equal(c.daemon.idleShutdownMinutes, 30); // default
  assert.equal(c.search.maxResults, 5); // default
  assert.deepEqual(c.providers.claude.disableBuiltin, ["Grep", "Glob"]); // stray 5 dropped, not the whole list
});

test("default_provider must be configured, else it falls back to claude", () => {
  assert.equal(cfg(`default_provider = "ghost"`).defaultProvider, "claude");
  assert.equal(
    cfg(`
default_provider = "openai"
[providers.openai]
base_url = "http://x/v1"
model    = "gpt-5"
`).defaultProvider,
    "openai",
  );
});

test("claude is reserved for the native Claude provider", () => {
  const c = cfg(`
[providers.claude]
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

test("loadConfig merges an exact repo override from the user file and ignores repo files", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  try {
    const user = join(dir, "user.toml");
    mkdirSync(join(dir, ".loom"));
    writeFileSync(join(dir, ".loom/config.toml"), "invalid TOML [ never read");
    writeFileSync(
      user,
      `
base_branch = "trunk"
default_provider = "deepseek"
[local-tools.local]
command = "tool"
[session]
local-tools = []
[providers.deepseek]
base_url = "https://api.deepseek.com/v1"
model = "deepseek-chat"
[[repo]]
path = ${JSON.stringify(dir)}
base_branch = "main"
[repo.session]
local-tools = ["local"]
[repo.providers.deepseek]
model = "deepseek-reasoner"
[[repo]]
path = ${JSON.stringify(join(dir, "other"))}
base_branch = "other"
`,
    );
    const c = loadConfig(dir, user);
    assert.equal(c.baseBranch, "main");
    assert.equal(c.defaultProvider, "deepseek");
    assert.equal(c.providers.aisdk["deepseek"]?.baseUrl, "https://api.deepseek.com/v1");
    assert.equal(c.providers.aisdk["deepseek"]?.model, "deepseek-reasoner");
    assert.deepEqual(
      c.mcp.map((m) => m.name),
      ["local"],
    );
    const other = loadConfig(join(dir, "elsewhere"), user);
    assert.equal(other.baseBranch, "trunk");
    assert.equal(other.providers.aisdk["deepseek"]?.model, "deepseek-chat");
    assert.deepEqual(other.mcp, []);
    // A parent repo entry is not a prefix grant to nested repositories/worktrees.
    assert.equal(loadConfig(join(dir, "child"), user).baseBranch, "trunk");
    assert.equal(loadConfig(dir, join(dir, "missing.toml")).baseBranch, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo paths support home expansion and canonical symlink identity; duplicates are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  try {
    const repo = join(dir, "repo");
    const alias = join(dir, "alias");
    const user = join(dir, "user.toml");
    mkdirSync(repo);
    symlinkSync(repo, alias);
    const homePath = "~/" + relative(homedir(), repo);
    writeFileSync(user, `[[repo]]\npath=${JSON.stringify(homePath)}\nbase_branch="dev"\n`);
    assert.equal(loadConfig(alias, user).baseBranch, "dev");
    writeFileSync(
      user,
      `[[repo]]\npath=${JSON.stringify(repo)}\n[[repo]]\npath=${JSON.stringify(alias)}\n`,
    );
    assert.throws(() => loadConfig(repo, user), /Duplicate repo.path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid repo override shapes fail explicitly, including unmatched entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  const user = join(dir, "user.toml");
  try {
    for (const content of [
      'repo="bad"',
      '[repo]\npath="/repo"',
      "[[repo]]",
      "[[repo]]\npath=12",
      '[[repo]]\npath="relative/path"',
      '[[repo]]\npath=""',
      '[[repo]]\npath="/elsewhere"\nrepo=[]',
    ]) {
      writeFileSync(user, content);
      assert.throws(() => loadConfig(dir, user), /repo/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- aisdk `sdk` backend selection --------------------------------------

test("sdk defaults to openai; google/anthropic don't need a base_url", () => {
  const c = cfg(`
[providers.openai]
base_url = "https://api.openai.com/v1"
model    = "gpt-5"

[providers.gemini]
sdk         = "google"
api_key_env = "GEMINI_API_KEY"
model       = "gemini-2.5-pro"

[providers.claude-api]
sdk     = "anthropic"
model   = "claude-sonnet-5"

[providers.dropped]
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

  assert.throws(() => cfg(`[search]\nbackend = "kagi"\n`), /remote-tools/);
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

// --- [commit_reminder] --------------------------------------------------------

test("[commit_reminder] defaults on; parses enabled, non-bool → default", () => {
  assert.deepEqual(cfg("").commitReminder, { enabled: true });
  assert.equal(cfg(`[commit_reminder]\nenabled = false\n`).commitReminder.enabled, false);
  assert.equal(cfg(`[commit_reminder]\nenabled = "yes"\n`).commitReminder.enabled, true);
});

// --- [auto_resume] ----------------------------------------------------------

test("[auto_resume] defaults on; parses enabled, non-bool → default", () => {
  assert.deepEqual(cfg("").autoResume, { enabled: true });
  assert.equal(cfg(`[auto_resume]\nenabled = false\n`).autoResume.enabled, false);
  assert.equal(cfg(`[auto_resume]\nenabled = "yes"\n`).autoResume.enabled, true);
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

test("Claude VM routing is opt-in and requires explicit runtime paths", () => {
  assert.equal(cfg("").isolation.claude, undefined);
  assert.equal(cfg('[isolation.claude]\nartifact="/runtime"').isolation.claude, undefined);
  assert.deepEqual(
    cfg('[isolation]\nenabled=true\n[isolation.claude]\nartifact="/runtime"').isolation.claude,
    {
      artifact: "/runtime",
      smolvm: "smolvm",
    },
  );
  assert.throws(() => cfg('[isolation.claude]\nsmolvm="/bin/smolvm"'), /requires an artifact/);
  assert.throws(
    () => cfg('[isolation.claude]\nartifact="/runtime"\nsmolvm=false'),
    /must name a path or executable/,
  );
});

test("extra worktree VM hosts are scoped by repo and cannot grant wildcard or alternate-port access", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  const file = join(dir, "user.toml");
  try {
    writeFileSync(
      file,
      `[isolation.claude]\nartifact="/runtime"\n[[repo]]\npath=${JSON.stringify(dir)}\n[repo.isolation]\nextra_allowed_hosts=["Registry.Npmjs.Org", "registry.npmjs.org"]\n`,
    );
    assert.deepEqual(loadConfig(dir, file).isolation.extraAllowedHosts, ["registry.npmjs.org"]);
    assert.deepEqual(loadConfig(join(dir, "other"), file).isolation.extraAllowedHosts, []);
    for (const hosts of [
      true,
      "example.com",
      ["*.npmjs.org"],
      ["https://registry.npmjs.org"],
      ["registry.npmjs.org:443"],
      ["127.0.0.1"],
      ["::1"],
    ])
      assert.throws(
        () =>
          normalizeConfig({
            isolation: { extra_allowed_hosts: hosts },
          }),
        /extra_allowed_hosts/,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project provider allow/deny lists and explicit VM disable override inherited defaults", () => {
  const base = cfg(
    '[provider_access]\nonly=["claude:work"]\ndisabled=[]\n[isolation.claude]\nartifact="/tmp/runtime"',
  );
  assert.deepEqual(base.providerAccess, { only: ["claude:work"], disabled: [] });
  const raw = deepMerge(
    { isolation: { enabled: true, claude: { artifact: "/tmp/runtime" } } },
    { isolation: { enabled: false } },
  );
  assert.equal(normalizeConfig(raw).isolation.claude, undefined);
  assert.deepEqual(cfg("[provider_access]\nonly=[]").providerAccess.only, []);
  assert.throws(() => cfg('[provider_access]\ndisabled="claude"'), /array/);
  assert.throws(() => cfg('[isolation]\nenabled="no"'), /boolean/);
});

test("one project toggle controls all configured VM runtimes", () => {
  const raw = {
    isolation: {
      enabled: true,
      claude: { artifact: "/claude" },
      aisdk: { artifact: "/aisdk" },
      codex: { artifact: "/codex" },
    },
  };
  const enabled = normalizeConfig(raw);
  const disabled = normalizeConfig(deepMerge(raw, { isolation: { enabled: false } }));
  for (const name of ["claude", "aisdk", "codex"] as const) {
    assert.equal(enabled.isolation[name]?.artifact, `/${name}`);
    assert.equal(disabled.isolation[name], undefined);
    assert.equal(disabled.isolation.runtimes?.[name]?.artifact, `/${name}`);
  }
  assert.equal(cfg("").isolation.enabled, false);
  assert.throws(() => cfg("[isolation.claude]\nenabled=true"), /Unknown setting/);
});

test("project VM overrides inherit runtimes and leave other projects unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-vm-project-"));
  try {
    const file = join(dir, "config.toml");
    writeFileSync(
      file,
      `[isolation]
enabled=true
[isolation.claude]
artifact="/claude"
[isolation.aisdk]
artifact="/aisdk"
[isolation.codex]
artifact="/codex"
[[repo]]
path=${JSON.stringify(dir)}
[repo.isolation]
enabled=false
`,
    );
    const local = loadConfig(dir, file);
    const vm = loadConfig(join(dir, "other"), file);
    assert.equal(local.isolation.enabled, false);
    assert.equal(vm.isolation.enabled, true);
    for (const name of ["claude", "aisdk", "codex"] as const) {
      assert.equal(local.isolation[name], undefined);
      assert.equal(vm.isolation[name]?.artifact, `/${name}`);
      assert.deepEqual(local.isolation.runtimes?.[name], vm.isolation.runtimes?.[name]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled session VMs resolve package bundles while explicit paths and disable win", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-bundle-config-"));
  const previous = Deno.env.get("LOOM_BUNDLED_RUNTIMES");
  try {
    const manifest = join(dir, "bundles.json");
    writeFileSync(
      manifest,
      JSON.stringify(
        Object.fromEntries(
          ["claude", "codex", "aisdk"].map((source) => [
            source,
            {
              version: 1,
              source,
              artifact: `/bundle/${source}`,
              smolvm: "/bundle/smolvm",
              preparedAt: "bundled",
            },
          ]),
        ),
      ),
    );
    Deno.env.set("LOOM_BUNDLED_RUNTIMES", manifest);
    for (const name of ["claude", "codex", "aisdk"] as const) {
      assert.deepEqual(cfg(`[isolation]\nenabled=true`).isolation[name], {
        artifact: `/bundle/${name}`,
        smolvm: "/bundle/smolvm",
      });
      assert.equal(cfg(`[isolation]\nenabled=false`).isolation[name], undefined);
      assert.deepEqual(
        cfg(
          `[isolation]\nenabled=true\n[isolation.${name}]\nartifact="/custom"\nsmolvm="/custom/smolvm"`,
        ).isolation[name],
        { artifact: "/custom", smolvm: "/custom/smolvm" },
      );
    }
    Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    assert.equal(cfg("[isolation]\nenabled=true").isolation.enabled, true);
  } finally {
    if (previous === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("title models are scoped to providers, including Claude profiles", () => {
  const c = cfg(`
[titles]
enabled = false
[providers.claude]
title_model = "haiku"
[providers.work]
sdk = "chatgpt"
title_model = "gpt-5-mini"
[custom-provider.local]
base_url = "http://localhost/v1"
title_model = "small-local-model"
`);
  assert.deepEqual(c.titles, { enabled: false });
  assert.equal(c.providers.claude.titleModel, "haiku");
  assert.equal(c.providers.aisdk.work?.titleModel, "gpt-5-mini");
  assert.equal(c.providers.aisdk.local?.titleModel, "small-local-model");
  assert.equal(cfg("").providers.claude.titleModel, "");
});
