import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import {
  claudeProfileId,
  deepMerge,
  lintConfig,
  loadConfig,
  normalizeConfig,
  parseConfig,
  resolveApiKey,
  slugifyProfile,
} from "@loom/daemon/config/config";
import { scaffoldUserConfig, userConfigPath } from "@loom/daemon/scaffold";

const cfg = (text: string) => {
  return normalizeConfig(parseConfig(text || "{}"));
};

test("an empty config yields the defaults: claude default, no aisdk profiles", () => {
  const c = cfg("");
  assert.equal(c.defaultProvider, "claude");
  assert.deepEqual(c.providers.aisdk, {});
});

test("TUI editor event log defaults to false and accepts an opt-in", () => {
  assert.equal(cfg("").tui.includeEventLogInEditor, false);
  assert.equal(
    cfg('{"tui":{"include_event_log_in_editor":true}}').tui.includeEventLogInEditor,
    true,
  );
  assert.equal(
    cfg('{"tui":{"include_event_log_in_editor":false}}').tui.includeEventLogInEditor,
    false,
  );
  assert.equal(
    cfg('{"tui":{"include_event_log_in_editor":"yes"}}').tui.includeEventLogInEditor,
    false,
  );
});

test("[worktree] enabled defaults to true and parses a false override", () => {
  assert.equal(cfg("").worktree.enabled, true);
  assert.equal(
    cfg(`{
  "session": {
    "worktree": {
      "enabled": false
    }
  }
}`).worktree.enabled,
    false,
  );
  // a non-boolean is ignored, not coerced
  assert.equal(
    cfg(`{
  "session": {
    "worktree": {
      "enabled": "no"
    }
  }
}`).worktree.enabled,
    true,
  );
});

test("a named provider defaults to an OpenAI-compatible endpoint", () => {
  const c = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "deepseek": {
          "base_url": "https://api.deepseek.com/v1",
          "api_key_env": "DEEPSEEK_API_KEY",
          "model": "deepseek-chat",
          "models": [
            "deepseek-chat",
            "deepseek-reasoner"
          ],
          "tag": "ds",
          "title_model": "deepseek-chat"
        }
      }
    }
  }
}`);
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
  const c = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "local": {
          "base_url": "http://localhost:11434/v1",
          "model": "qwen2.5-coder"
        }
      }
    }
  }
}`);
  const p = c.providers.aisdk["local"];
  assert.ok(p);
  assert.deepEqual(p.models, ["qwen2.5-coder"]);
  assert.equal(p.tag, "local");
  assert.equal(p.apiKeyEnv, "");
});

test("an OpenAI-compatible profile needs a base_url", () => {
  const c = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "broken": {
          "model": "x"
        }
      }
    }
  }
}`);
  assert.deepEqual(c.providers.aisdk, {});
});

test("providers.openai_compatible.profiles is an OpenAI-compatible profile — no adapter / sdk keys", () => {
  const c = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "llmbase": {
          "base_url": "https://api.llmbase.ai/v1",
          "api_key": "sk-xyz",
          "models": [
            "big",
            "small"
          ],
          "tag": "lb"
        }
      }
    }
  }
}`);
  const p = c.providers.aisdk["llmbase"];
  assert.ok(p);
  assert.equal(p.sdk, "openai");
  assert.equal(p.baseUrl, "https://api.llmbase.ai/v1");
  assert.equal(p.apiKey, "sk-xyz");
  assert.deepEqual(p.models, ["big", "small"]);
  assert.equal(p.model, "big");
  assert.equal(p.tag, "lb");

  // no base_url → nothing to dial → dropped
  assert.deepEqual(
    cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "x": {
          "model": "m"
        }
      }
    }
  }
}`).providers.aisdk,
    {},
  );
  // model-less is still kept for auto-detection
  assert.equal(
    cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "y": {
          "base_url": "http://y/v1"
        }
      }
    }
  }
}`).providers.aisdk["y"]?.autoModels,
    true,
  );
});

test("include_usage defaults to true and can be turned off per provider", () => {
  const profile = (include_usage?: unknown) =>
    normalizeConfig({
      providers: {
        openai_compatible: {
          profiles: {
            p: {
              base_url: "http://p/v1",
              include_usage: include_usage,
            },
          },
        },
      },
    }).providers.aisdk.p;
  assert.equal(profile()?.includeUsage, true);
  assert.equal(profile(false)?.includeUsage, false);
  assert.equal(profile("no")?.includeUsage, true);
});

test("prompt_cache_ttl on an aisdk profile takes 5m / 1h / off, else unset", () => {
  const ttl = (prompt_cache_ttl?: unknown) =>
    normalizeConfig({
      providers: {
        openai_compatible: {
          profiles: {
            p: {
              base_url: "http://p/v1",
              prompt_cache_ttl: prompt_cache_ttl,
            },
          },
        },
      },
    }).providers.aisdk.p?.promptCacheTtl;
  assert.equal(ttl(), "");
  for (const value of ["5m", "1h", "off"]) assert.equal(ttl(value), value);
  assert.equal(ttl("60m"), "");
  assert.equal(ttl(true), "");
});

test("[providers.claude] prompt_cache_ttl is unset by default — the CLI decides", () => {
  assert.equal(cfg("").providers.claude.promptCacheTtl, "");
  assert.equal(
    cfg(`{
  "providers": {
    "claude": {
      "prompt_cache_ttl": "1h"
    }
  }
}`).providers.claude.promptCacheTtl,
    "1h",
  );
});
test("[google] / [anthropic] are one native profile each, id = the vendor", () => {
  const c = cfg(`{
  "providers": {
    "google": {
      "api_key_env": "GEMINI_KEY",
      "model": "gemini-2.5-pro"
    },
    "anthropic": {
      "api_key": "sk-ant",
      "model": "claude-opus-5"
    }
  }
}`);
  assert.equal(c.providers.aisdk["google"]?.sdk, "google");
  assert.equal(c.providers.aisdk["google"]?.model, "gemini-2.5-pro");
  assert.equal(c.providers.aisdk["anthropic"]?.sdk, "anthropic");
  assert.equal(c.providers.aisdk["anthropic"]?.model, "claude-opus-5");
  // native SDKs still need a model (no /models probe)
  assert.deepEqual(
    cfg(`{
  "providers": {
    "google": {
      "api_key": "k"
    }
  }
}`).providers.aisdk,
    {},
  );
});

test("providers.codex uses Codex OAuth instead of requiring an API key", () => {
  const c = cfg(`{
  "providers": {
    "codex": {
      "model": "gpt-5-codex",
      "models": [
        "gpt-5-codex",
        "gpt-5"
      ],
      "config_dir": "~/custom-codex",
      "cli_path": "~/bin/codex",
      "builtin_web_search": true
    }
  }
}`);
  const p = c.providers.aisdk["codex"];
  assert.ok(p);
  assert.equal(p.sdk, "chatgpt");
  assert.equal(p.apiKey, "");
  assert.equal(p.apiKeyEnv, "");
  assert.equal(p.configDir, join(homedir(), "custom-codex"));
  assert.equal(p.codexCliPath, join(homedir(), "bin/codex"));
  assert.equal(p.codexBuiltinWebSearch, true);
  assert.deepEqual(p.models, ["gpt-5-codex", "gpt-5"]);
  assert.deepEqual(lintConfig({ ...c, claudeProfiles: [] }), []);
});

test("provider config rejects removed auth_path settings at family and profile scope", () => {
  for (const codex of [
    { auth_path: "/old/auth.json" },
    { profiles: { default: { auth_path: "/old/auth.json" } } },
  ]) {
    assert.throws(() => normalizeConfig({ providers: { codex } }), /Unknown setting.*auth_path/);
  }
});

test("providers.codex disables Codex web search unless explicitly enabled", () => {
  assert.equal(
    cfg(`{
  "providers": {
    "codex": {}
  }
}`).providers.aisdk["codex"]?.codexBuiltinWebSearch,
    false,
  );
  assert.equal(
    cfg(`{
  "providers": {
    "codex": {
      "builtin_web_search": true
    }
  }
}`).providers.aisdk["codex"]?.codexBuiltinWebSearch,
    true,
  );
});

test("a named Codex profile routes without an API key", () => {
  const p = cfg(`{
  "providers": {
    "codex": {
      "profiles": {
        "work": {
          "model": "gpt-5-codex"
        }
      }
    }
  }
}`).providers.aisdk["codex:work"];
  assert.equal(p?.sdk, "chatgpt");
  assert.equal(p?.model, "gpt-5-codex");
});

test("OpenAI-compatible endpoint profiles expose their configured model and URL", () => {
  const c = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "dup": {
          "base_url": "http://named/v1",
          "model": "named-model"
        }
      }
    }
  }
}`);
  assert.equal(c.providers.aisdk["dup"]?.baseUrl, "http://named/v1");
  assert.equal(c.providers.aisdk["dup"]?.model, "named-model");
});

test("openai and chatgpt profiles with no model/models are kept for auto-detection; google/anthropic dropped", () => {
  const c = cfg(`{
  "providers": {
    "codex": {},
    "openai_compatible": {
      "profiles": {
        "auto": {
          "base_url": "http://x/v1"
        },
        "ok": {
          "base_url": "http://y/v1",
          "models": [
            "m1",
            "m2"
          ]
        }
      }
    },
    "google": {
      "profiles": {
        "gem": {}
      }
    }
  }
}`);
  assert.equal(c.providers.aisdk["auto"]?.autoModels, true);
  assert.equal(c.providers.aisdk["codex"]?.autoModels, true);
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
  const c = cfg(`{
  "search": {
    "backend": "brave"
  },
  "providers": {
    "openai_compatible": {
      "profiles": {
        "p": {
          "base_url": "http://x/v1",
          "api_key_env": "DEFINITELY_UNSET_VAR"
        },
        "auto": {
          "base_url": "http://y/v1"
        }
      }
    }
  }
}`);
  const w = lintConfig(c, {} as NodeJS.ProcessEnv);
  assert.ok(w.some((l) => /\$DEFINITELY_UNSET_VAR is not set/.test(l)));
  assert.ok(w.some((l) => /provider "auto".*auto-detect/.test(l)));
  assert.ok(w.some((l) => /search:.*web_search stays disabled/.test(l)));

  // an inline api_key silences the env-var warning
  const c2 = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "p": {
          "base_url": "http://x/v1",
          "api_key": "sk-inline",
          "model": "m"
        }
      }
    }
  }
}`);
  assert.deepEqual(lintConfig({ ...c2, claudeProfiles: [] }, {} as NodeJS.ProcessEnv), []);

  // a clean config lints clean
  assert.deepEqual(lintConfig({ ...cfg(""), claudeProfiles: [] }), []);
});

test("numeric config fields reject negatives / NaN; strArray keeps the valid entries", () => {
  const c = cfg(`{
  "daemon": {
    "idle_shutdown_minutes": -5
  },
  "search": {
    "max_results": -2
  },
  "providers": {
    "claude": {
      "disable_builtin": [
        "Grep",
        5,
        "Glob"
      ]
    }
  }
}`);
  assert.equal(c.daemon.idleShutdownMinutes, 30); // default
  assert.equal(c.search.maxResults, 5); // default
  assert.deepEqual(c.providers.claude.disableBuiltin, ["Grep", "Glob"]); // stray 5 dropped, not the whole list
});

test("default_provider must be configured, else it falls back to claude", () => {
  assert.equal(
    cfg(`{
  "default_provider": "ghost"
}`).defaultProvider,
    "claude",
  );
  assert.equal(
    cfg(`{
  "default_provider": "openai",
  "providers": {
    "openai_compatible": {
      "profiles": {
        "openai": {
          "base_url": "http://x/v1",
          "model": "gpt-5"
        }
      }
    }
  }
}`).defaultProvider,
    "openai",
  );
});

test("claude is reserved for the native Claude provider", () => {
  const c = cfg(`{
  "providers": {
    "claude": {
      "model": "claude-sonnet-5"
    }
  }
}`);
  assert.deepEqual(c.providers.aisdk, {});
  assert.equal(c.providers.claude.model, "claude-sonnet-5");
});

// --- deepMerge / XDG layering --------------------------------------------

test("deepMerge: over wins, objects merge, arrays/scalars replace", () => {
  const merged = deepMerge(
    { a: 1, nested: { x: 1, y: 2 }, list: [1, 2], keep: "me" },
    { a: 2, nested: { y: 3, z: 4 }, list: [9] },
  );
  assert.deepEqual(merged, {
    a: 2,
    nested: { x: 1, y: 3, z: 4 },
    list: [9],
    keep: "me",
  });
});

test("loadConfig merges an exact repo override from the user file and ignores repo files", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  try {
    const user = join(dir, "user.jsonc");
    mkdirSync(join(dir, ".loom"));
    writeFileSync(join(dir, ".loom/config.jsonc"), "invalid TOML [ never read");
    writeFileSync(
      user,
      `{
  "base_branch": "trunk",
  "default_provider": "deepseek",
  "local_tools": {
    "local": {
      "command": "tool"
    }
  },
  "repos": [
    {
      "path": ${JSON.stringify(dir)},
      "base_branch": "main",
      "providers": {
        "openai_compatible": {
          "profiles": {
            "deepseek": {
              "model": "deepseek-reasoner"
            }
          }
        }
      },
      "session": {
        "local_tools": [
          "local"
        ]
      }
    },
    {
      "path": ${JSON.stringify(join(dir, "other"))},
      "base_branch": "other"
    }
  ],
  "providers": {
    "openai_compatible": {
      "profiles": {
        "deepseek": {
          "base_url": "https://api.deepseek.com/v1",
          "model": "deepseek-chat"
        }
      }
    }
  },
  "session": {
    "local_tools": []
  }
}`,
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
    assert.equal(loadConfig(dir, join(dir, "missing.jsonc")).baseBranch, "main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo hooks append to global hooks without changing other array inheritance", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  const user = join(dir, "user.jsonc");
  const globalHook = {
    name: "shared",
    on: ["waiting", "turn_end"],
    when: "unfocused",
    run: "true",
  };
  const repoHook = { name: "shared", on: "init", run: "echo setup" };
  const write = (hooks: unknown, repo: Record<string, unknown>) =>
    writeFileSync(
      user,
      JSON.stringify({
        hooks,
        session: { provider_access: { disabled: ["global-provider"] } },
        repos: [{ path: dir, ...repo }],
      }),
    );
  try {
    write([globalHook], {
      hooks: [repoHook],
      session: { provider_access: { disabled: ["repo-provider"] } },
    });
    const config = loadConfig(dir, user);
    assert.deepEqual(
      config.hooks.map((h) => [h.name, h.run, h.when]),
      [
        ["shared", "true", "unfocused"],
        ["shared", "echo setup", "always"],
      ],
    );
    assert.deepEqual(config.hooks, loadConfig(dir, user).hooks, "reload must not accumulate hooks");
    assert.deepEqual(
      loadConfig(join(dir, "other"), user).hooks.map((h) => h.run),
      ["true"],
    );
    assert.deepEqual(config.providerAccess.disabled, ["repo-provider"]);

    for (const repo of [{}, { hooks: [] }]) {
      write([globalHook], repo);
      assert.deepEqual(
        loadConfig(dir, user).hooks.map((h) => h.run),
        ["true"],
      );
    }
    write(undefined, { hooks: [repoHook] });
    assert.deepEqual(
      loadConfig(dir, user).hooks.map((h) => h.run),
      ["echo setup"],
    );
    write(undefined, {});
    assert.deepEqual(loadConfig(dir, user).hooks, []);

    for (const invalid of [null, "bad", {}, [{ on: "waiting" }]]) {
      write(invalid, { hooks: [repoHook] });
      assert.throws(() => loadConfig(dir, user));
      write([globalHook], { hooks: invalid });
      assert.throws(() => loadConfig(dir, user));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo paths support home expansion and canonical symlink identity; duplicates are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  try {
    const repo = join(dir, "repo");
    const alias = join(dir, "alias");
    const user = join(dir, "user.jsonc");
    mkdirSync(repo);
    symlinkSync(repo, alias);
    const homePath = "~/" + relative(homedir(), repo);
    writeFileSync(
      user,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(homePath)},
      "base_branch": "dev"
    }
  ]
}`,
    );
    assert.equal(loadConfig(alias, user).baseBranch, "dev");
    writeFileSync(
      user,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(repo)}
    },
    {
      "path": ${JSON.stringify(alias)}
    }
  ]
}`,
    );
    assert.throws(() => loadConfig(repo, user), /Duplicate repos.path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid repo override shapes fail explicitly, including unmatched entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  const user = join(dir, "user.jsonc");
  try {
    for (const content of [
      `{
  "repos": "bad"
}`,
      `{
  "repos": {
    "path": "/repo"
  }
}`,
      `{
  "repos": [
    {}
  ]
}`,
      `{
  "repos": [
    {
      "path": 12
    }
  ]
}`,
      `{
  "repos": [
    {
      "path": "relative/path"
    }
  ]
}`,
      `{
  "repos": [
    {
      "path": ""
    }
  ]
}`,
      `{
  "repos": [
    {
      "path": "/elsewhere",
      "repos": []
    }
  ]
}`,
    ]) {
      writeFileSync(user, content);
      assert.throws(() => loadConfig(dir, user), /repo/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- aisdk `sdk` backend selection --------------------------------------

test("provider families select their SDK; google/anthropic don't need a base_url", () => {
  const c = cfg(`{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "openai": {
          "base_url": "https://api.openai.com/v1",
          "model": "gpt-5"
        },
        "dropped": {
          "model": "x"
        }
      }
    },
    "google": {
      "profiles": {
        "gemini": {
          "api_key_env": "GEMINI_API_KEY",
          "model": "gemini-2.5-pro"
        }
      }
    },
    "anthropic": {
      "profiles": {
        "claude-api": {
          "model": "claude-sonnet-5"
        }
      }
    }
  }
}`);
  assert.equal(c.providers.aisdk["openai"]?.sdk, "openai");
  assert.equal(c.providers.aisdk["google:gemini"]?.sdk, "google");
  assert.equal(c.providers.aisdk["google:gemini"]?.baseUrl, "");
  assert.equal(c.providers.aisdk["anthropic:claude-api"]?.sdk, "anthropic");
  // an openai profile with no base_url is still dropped
  assert.equal(c.providers.aisdk["dropped"], undefined);
});

test("unknown provider families are rejected", () => {
  assert.throws(
    () => normalizeConfig({ providers: { cohere: { model: "m" } } }),
    /Unknown setting providers.cohere/,
  );
});

// --- [search] ---------------------------------------------------------------

test("[search] parses a backend + key env + base; unknown backend → none", () => {
  const c = cfg(`{
  "search": {
    "backend": "brave",
    "api_key_env": "BRAVE_API_KEY",
    "api_base": "http://localhost:7777",
    "max_results": 8
  }
}`);
  assert.equal(c.search.backend, "brave");
  assert.equal(c.search.apiKeyEnv, "BRAVE_API_KEY");
  assert.equal(c.search.apiBase, "http://localhost:7777");
  assert.equal(c.search.maxResults, 8);

  assert.throws(
    () =>
      cfg(`{
  "search": {
    "backend": "kagi"
  }
}`),
    /remote_tools/,
  );
  assert.equal(
    cfg(`{
  "search": {
    "backend": "google"
  }
}`).search.backend,
    "none",
  );
  assert.equal(cfg(``).search.backend, "none");
  assert.equal(cfg(``).search.maxResults, 5);
});

// --- [auto_rebase] --------------------------------------------------------

test("[auto_rebase] defaults off/rebase; parses enabled + mode, unknown mode → rebase", () => {
  assert.deepEqual(cfg("").autoRebase, { enabled: false, mode: "rebase" });

  const c = cfg(`{
  "session": {
    "auto_rebase": {
      "enabled": true,
      "mode": "merge"
    }
  }
}`);
  assert.deepEqual(c.autoRebase, { enabled: true, mode: "merge" });

  assert.equal(
    cfg(`{
  "session": {
    "auto_rebase": {
      "mode": "cherry-pick"
    }
  }
}`).autoRebase.mode,
    "rebase",
  );
  assert.equal(
    cfg(`{
  "session": {
    "auto_rebase": {
      "enabled": "yes"
    }
  }
}`).autoRebase.enabled,
    false,
  );
});

// --- [commit_reminder] --------------------------------------------------------

test("[commit_reminder] defaults on; parses enabled, non-bool → default", () => {
  assert.deepEqual(cfg("").commitReminder, { enabled: true });
  assert.equal(
    cfg(`{
  "session": {
    "commit_reminder": {
      "enabled": false
    }
  }
}`).commitReminder.enabled,
    false,
  );
  assert.equal(
    cfg(`{
  "session": {
    "commit_reminder": {
      "enabled": "yes"
    }
  }
}`).commitReminder.enabled,
    true,
  );
});

// --- [auto_resume] ----------------------------------------------------------

test("[auto_resume] defaults on; parses enabled, non-bool → default", () => {
  assert.deepEqual(cfg("").autoResume, { enabled: true });
  assert.equal(
    cfg(`{
  "session": {
    "auto_resume": {
      "enabled": false
    }
  }
}`).autoResume.enabled,
    false,
  );
  assert.equal(
    cfg(`{
  "session": {
    "auto_resume": {
      "enabled": "yes"
    }
  }
}`).autoResume.enabled,
    true,
  );
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

test("no providers.claude.profiles → a single expanded ~/.claude profile with id 'claude'", () => {
  const c = cfg("");
  assert.equal(c.claudeProfiles.length, 1);
  assert.equal(c.claudeProfiles[0]?.dir, join(homedir(), ".claude"));
  assert.equal(claudeProfileId(c.claudeProfiles[0] ?? { name: "x" }), "claude");
});

test("a named profile gets id claude:<slug>; the first / unnamed one stays 'claude'", () => {
  const c = cfg(`{
  "providers": {
    "claude": {
      "profiles": {
        "default": {
          "config_dir": "~/.claude"
        },
        "Work": {
          "config_dir": "~/.claude-work",
          "color": "yellow"
        }
      }
    }
  }
}`);
  assert.deepEqual(c.claudeProfiles.map(claudeProfileId), ["claude", "claude:work"]);
  assert.equal(c.claudeProfiles[1]?.dir, join(homedir(), ".claude-work"));
  assert.equal(c.claudeProfiles[1]?.color, "yellow");
});

test("Claude profile names normalize to stable ids and blank directories are dropped", () => {
  const c = normalizeConfig({
    providers: {
      claude: {
        profiles: {
          missing: { config_dir: "" },
          Work: { config_dir: "/one/.claude" },
          work: { config_dir: "/two/.claude" },
        },
      },
    },
  });
  assert.equal(c.claudeProfiles.length, 1);
  assert.equal(claudeProfileId(c.claudeProfiles[0]!), "claude:work");
  assert.equal(c.claudeProfiles[0]?.dir, "/one/.claude");
});

test("default_provider may name a claude profile id", () => {
  const c = cfg(`{
  "default_provider": "claude:work",
  "providers": {
    "claude": {
      "profiles": {
        "default": {
          "config_dir": "~/.claude"
        },
        "Work": {
          "config_dir": "~/.claude-work"
        }
      }
    }
  }
}`);
  assert.equal(c.defaultProvider, "claude:work");
  // an unconfigured id still falls back to claude
  assert.equal(
    cfg(`{
  "default_provider": "claude:ghost"
}`).defaultProvider,
    "claude",
  );
});

test("a Claude id cannot be claimed by an endpoint profile", () => {
  assert.throws(
    () =>
      normalizeConfig({
        providers: {
          openai_compatible: {
            profiles: {
              "claude:work": { base_url: "http://localhost/v1" },
            },
          },
        },
      }),
    /Reserved or duplicate provider id/,
  );
});

// --- first-run scaffold ----------------------------------------------------

test("scaffoldUserConfig creates a starter at the XDG path once, never overwriting", () => {
  const saved = process.env["XDG_CONFIG_HOME"];
  const dir = mkdtempSync(join(tmpdir(), "loom-scaffold-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  try {
    const dest = userConfigPath();
    assert.ok(dest.startsWith(dir));

    const created = scaffoldUserConfig();
    assert.equal(created, dest);
    assert.equal(parseConfig(readFileSync(dest, "utf8")).$schema, "./config.schema.json");

    // idempotent: a second call is a no-op and leaves edits intact
    writeFileSync(
      dest,
      `{
  "base_branch": "trunk"
}`,
    );
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
  assert.equal(
    cfg(`{
  "session": {
    "isolation": {
      "claude": {
        "artifact": "/runtime"
      }
    }
  }
}`).isolation.claude,
    undefined,
  );
  assert.deepEqual(
    cfg(`{
  "session": {
    "isolation": {
      "enabled": true,
      "claude": {
        "artifact": "/runtime"
      }
    }
  }
}`).isolation.claude,
    {
      artifact: "/runtime",
      smolvm: "smolvm",
    },
  );
  assert.throws(
    () =>
      cfg(`{
  "session": {
    "isolation": {
      "claude": {
        "smolvm": "/bin/smolvm"
      }
    }
  }
}`),
    /requires an artifact/,
  );
  assert.throws(
    () =>
      cfg(`{
  "session": {
    "isolation": {
      "claude": {
        "artifact": "/runtime",
        "smolvm": false
      }
    }
  }
}`),
    /must name a path or executable/,
  );
});

test("extra worktree VM hosts are scoped by repo and cannot grant wildcard or alternate-port access", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  const file = join(dir, "user.jsonc");
  try {
    writeFileSync(
      file,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(dir)},
      "session": {
        "isolation": {
          "extra_allowed_hosts": [
            "Registry.Npmjs.Org",
            "registry.npmjs.org"
          ]
        }
      }
    }
  ],
  "session": {
    "isolation": {
      "claude": {
        "artifact": "/runtime"
      }
    }
  }
}`,
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
    ]) {
      assert.throws(
        () =>
          normalizeConfig({
            session: {
              isolation: {
                extra_allowed_hosts: hosts,
              },
            },
          }),
        /extra_allowed_hosts/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project provider allow/deny lists and explicit VM disable override inherited defaults", () => {
  const base = cfg(
    `{
  "session": {
    "provider_access": {
      "only": [
        "claude:work"
      ],
      "disabled": []
    },
    "isolation": {
      "claude": {
        "artifact": "/tmp/runtime"
      }
    }
  }
}`,
  );
  assert.deepEqual(base.providerAccess, {
    only: ["claude:work"],
    disabled: [],
  });
  const raw = deepMerge(
    {
      session: {
        isolation: {
          enabled: true,
          claude: {
            artifact: "/tmp/runtime",
          },
        },
      },
    },
    {
      session: {
        isolation: {
          enabled: false,
        },
      },
    },
  );
  assert.equal(normalizeConfig(raw).isolation.claude, undefined);
  assert.deepEqual(
    cfg(`{
  "session": {
    "provider_access": {
      "only": []
    }
  }
}`).providerAccess.only,
    [],
  );
  assert.throws(
    () =>
      cfg(`{
  "session": {
    "provider_access": {
      "disabled": "claude"
    }
  }
}`),
    /array/,
  );
  assert.throws(
    () =>
      cfg(`{
  "session": {
    "isolation": {
      "enabled": "no"
    }
  }
}`),
    /boolean/,
  );
});

test("one project toggle controls all configured VM runtimes", () => {
  const raw = {
    session: {
      isolation: {
        enabled: true,
        claude: {
          artifact: "/claude",
        },
        aisdk: {
          artifact: "/aisdk",
        },
        codex: {
          artifact: "/codex",
        },
      },
    },
  };
  const enabled = normalizeConfig(raw);
  const disabled = normalizeConfig(
    deepMerge(raw, {
      session: {
        isolation: {
          enabled: false,
        },
      },
    }),
  );
  for (const name of ["claude", "aisdk", "codex"] as const) {
    assert.equal(enabled.isolation[name]?.artifact, `/${name}`);
    assert.equal(disabled.isolation[name], undefined);
    assert.equal(disabled.isolation.runtimes?.[name]?.artifact, `/${name}`);
  }
  assert.equal(cfg("").isolation.enabled, false);
  assert.throws(
    () =>
      cfg(`{
  "session": {
    "isolation": {
      "claude": {
        "enabled": true
      }
    }
  }
}`),
    /Unknown setting/,
  );
});

test("project VM overrides inherit runtimes and leave other projects unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-vm-project-"));
  try {
    const file = join(dir, "config.jsonc");
    writeFileSync(
      file,
      `{
  "repos": [
    {
      "path": ${JSON.stringify(dir)},
      "session": {
        "isolation": {
          "enabled": false
        }
      }
    }
  ],
  "session": {
    "isolation": {
      "enabled": true,
      "claude": {
        "artifact": "/claude"
      },
      "aisdk": {
        "artifact": "/aisdk"
      },
      "codex": {
        "artifact": "/codex"
      }
    }
  }
}`,
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
      assert.deepEqual(
        cfg(`{
  "session": {
    "isolation": {
      "enabled": true
    }
  }
}`).isolation[name],
        {
          artifact: `/bundle/${name}`,
          smolvm: "/bundle/smolvm",
        },
      );
      assert.equal(
        cfg(`{
  "session": {
    "isolation": {
      "enabled": false
    }
  }
}`).isolation[name],
        undefined,
      );
      assert.deepEqual(
        cfg(
          `{"session": {"isolation": {"enabled": true, "${name}": {"artifact": "/custom", "smolvm": "/custom/smolvm"}}}}`,
        ).isolation[name],
        { artifact: "/custom", smolvm: "/custom/smolvm" },
      );
    }
    Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    assert.equal(
      cfg(`{
  "session": {
    "isolation": {
      "enabled": true
    }
  }
}`).isolation.enabled,
      true,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("LOOM_BUNDLED_RUNTIMES");
    else Deno.env.set("LOOM_BUNDLED_RUNTIMES", previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("title models are scoped to providers, including Claude profiles", () => {
  const c = cfg(`{
  "providers": {
    "claude": {
      "title_model": "haiku"
    },
    "openai_compatible": {
      "profiles": {
        "local": {
          "base_url": "http://localhost/v1",
          "title_model": "small-local-model"
        }
      }
    },
    "codex": {
      "profiles": {
        "work": {
          "title_model": "gpt-5-mini"
        }
      }
    }
  },
  "session": {
    "titles": {
      "enabled": false
    }
  }
}`);
  assert.deepEqual(c.titles, { enabled: false });
  assert.equal(c.providers.claude.titleModel, "haiku");
  assert.equal(c.providers.aisdk["codex:work"]?.titleModel, "gpt-5-mini");
  assert.equal(c.providers.aisdk.local?.titleModel, "small-local-model");
  assert.equal(cfg("").providers.claude.titleModel, "");
});

test("JSONC accepts comments, trailing commas and a BOM without changing strings", () => {
  const raw = parseConfig(
    "\uFEFF" +
      `{
    // Comment before settings.
    "base_branch": "trunk",
    "session": {"notify": {"webhook": "https://example.com/a//b/*literal*/"},},
    "repos": [{"path": "/repo", "hooks": [],},],
  }`,
  );
  assert.equal(raw.base_branch, "trunk");
  assert.deepEqual(raw.session, {
    notify: { webhook: "https://example.com/a//b/*literal*/" },
  });
  assert.deepEqual(raw.repos, [{ path: "/repo", hooks: [] }]);
});

test("JSONC rejects malformed or non-object configs instead of using partial results", () => {
  for (const text of [
    "",
    "// only a comment",
    "[]",
    "null",
    "false",
    '"text"',
    "123",
    '{"worktree": {"enabled": false}',
    '{"a": 1} garbage',
    "{unquoted: true}",
    '{"a": /* unfinished',
    'base_branch = "main"',
  ]) {
    assert.throws(() => parseConfig(text), /JSONC|JSON object/);
  }
  assert.throws(
    () => parseConfig('{\n  "api_key": "secret-value",\n  "broken": ,\n}'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /line 3, column/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});

test("Codex profiles inherit family defaults and can override or clear them", () => {
  const config = normalizeConfig({
    providers: {
      codex: {
        cli_path: "~/bin/codex",
        config_dir: "~/.codex",
        title_model: "small",
        models: ["one", "two"],
        builtin_web_search: true,
        profiles: {
          default: {},
          work: {
            config_dir: "~/.codex-work",
            models: ["three"],
            builtin_web_search: false,
          },
          clean: { cli_path: "", title_model: "" },
        },
      },
    },
  });
  const profiles = config.providers.aisdk;
  assert.deepEqual(Object.keys(profiles), ["codex", "codex:work", "codex:clean"]);
  assert.equal(profiles.codex?.codexCliPath, join(homedir(), "bin/codex"));
  assert.equal(profiles["codex:work"]?.codexCliPath, profiles.codex?.codexCliPath);
  assert.equal(profiles["codex:work"]?.configDir, join(homedir(), ".codex-work"));
  assert.equal(profiles["codex:work"]?.titleModel, "small");
  assert.deepEqual(profiles["codex:work"]?.models, ["three"]);
  assert.equal(profiles["codex:work"]?.codexBuiltinWebSearch, false);
  assert.equal(profiles["codex:clean"]?.codexCliPath, "");
  assert.equal(profiles["codex:clean"]?.titleModel, "");
  assert.deepEqual(normalizeConfig({ providers: { codex: { profiles: {} } } }).providers.aisdk, {});
});

test("repository overrides merge family and named profile settings before defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-profile-"));
  const file = join(dir, "config.jsonc");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          codex: {
            cli_path: "/bin/codex",
            profiles: { work: { config_dir: "/account", model: "one" } },
          },
        },
        session: { auto_resume: { enabled: true } },
        repos: [
          {
            path: dir,
            providers: {
              codex: {
                title_model: "small",
                profiles: { work: { model: "two" } },
              },
            },
            session: { auto_resume: { enabled: false } },
          },
        ],
      }),
    );
    const selected = loadConfig(dir, file);
    assert.equal(selected.providers.aisdk["codex:work"]?.model, "two");
    assert.equal(selected.providers.aisdk["codex:work"]?.configDir, "/account");
    assert.equal(selected.providers.aisdk["codex:work"]?.codexCliPath, "/bin/codex");
    assert.equal(selected.providers.aisdk["codex:work"]?.titleModel, "small");
    assert.equal(selected.autoResume.enabled, false);
    assert.equal(loadConfig(join(dir, "other"), file).providers.aisdk["codex:work"]?.model, "one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude and Codex labels use tag, then profile name, then provider name", () => {
  for (const family of ["claude", "codex"] as const) {
    const label = family === "claude" ? "Claude" : "Codex";
    const labels = (settings: unknown) => {
      const c = normalizeConfig({ providers: { [family]: settings } });
      return family === "claude"
        ? c.claudeProfiles.map((p) => [claudeProfileId(p), p.tag])
        : Object.entries(c.providers.aisdk).map(([id, p]) => [id, p.tag]);
    };
    assert.deepEqual(labels({}), [[family, label]]);
    assert.deepEqual(labels({ tag: "Account" }), [[family, "Account"]]);
    const profiles = {
      default: { config_dir: "/profiles/default" },
      work: { config_dir: "/profiles/work" },
      custom: { config_dir: "/profiles/custom", tag: "My account" },
      blank: { config_dir: "/profiles/blank", tag: "" },
    };
    assert.deepEqual(labels({ profiles }), [
      [family, label],
      [family + ":work", "work"],
      [family + ":custom", "My account"],
      [family + ":blank", ""],
    ]);
    assert.deepEqual(labels({ tag: "Inherited", profiles }), [
      [family, "Inherited"],
      [family + ":work", "Inherited"],
      [family + ":custom", "My account"],
      [family + ":blank", ""],
    ]);
  }
});
