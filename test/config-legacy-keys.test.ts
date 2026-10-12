import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  lintConfig,
  loadConfig,
  normalizeConfig,
  configKeyWarnings,
} from "@loom/daemon/config/config";
import { migrateConfigLayer } from "../backend/daemon/src/config/legacy-keys.ts";
import { makeHarness } from "@loom/harness";
import { setLogFile, setLogLevel, setLogStderr } from "@loom/core/logger";
import { LoomClient } from "@loom/client";

const withConfigFile = <T>(
  text: (dir: string) => string,
  run: (dir: string, file: string) => T,
) => {
  const dir = mkdtempSync(join(tmpdir(), "loom-legacy-keys-"));
  try {
    const file = join(dir, "config.jsonc");
    writeFileSync(file, text(dir));
    return run(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("session.isolation.enabled reads as session.defaults.isolation", () => {
  for (const [enabled, isolation] of [
    [true, "vm"],
    [false, "none"],
  ] as const) {
    const cfg = normalizeConfig({ session: { isolation: { enabled } } });
    assert.equal(cfg.defaults.isolation, isolation);
    assert.deepEqual(configKeyWarnings(cfg), [
      `session.isolation.enabled is deprecated; write session.defaults.isolation: "${isolation}" instead`,
    ]);
  }
  assert.throws(
    () => normalizeConfig({ session: { isolation: { enabled: "no" } } }),
    /session\.defaults\.isolation/,
  );
});

test("session.worktree.enabled and checkout.mode read as session.defaults.workspace", () => {
  const workspace = (session: Record<string, unknown>) =>
    normalizeConfig({ session }).defaults.workspace;
  assert.equal(workspace({ worktree: { enabled: false } }), "in-place");
  assert.equal(workspace({ worktree: { enabled: true } }), "worktree");
  // A non-boolean was ignored, never coerced to false.
  assert.equal(workspace({ worktree: { enabled: "no" } }), "worktree");
  assert.equal(workspace({ isolation: { checkout: { mode: "clone" } } }), "clone");
  assert.equal(workspace({ isolation: { checkout: { mode: "mount" } } }), "worktree");
  // Worktrees off always meant in place, whatever the VM checkout mode.
  assert.equal(
    workspace({ worktree: { enabled: false }, isolation: { checkout: { mode: "clone" } } }),
    "in-place",
  );
  const both = normalizeConfig({
    session: {
      worktree: { enabled: true },
      isolation: { checkout: { mode: "clone", visible_refs: ["refs/tags/"] } },
    },
  });
  assert.equal(both.defaults.workspace, "clone");
  assert.deepEqual(both.clone?.visibleRefs, ["refs/tags/"]);
  assert.deepEqual(configKeyWarnings(both), [
    'session.worktree.enabled is deprecated; write session.defaults.workspace: "clone" instead',
    'session.isolation.checkout.mode is deprecated; write session.defaults.workspace: "clone" instead',
    "session.isolation.checkout.visible_refs is deprecated; write session.clone.visible_refs instead",
  ]);
  assert.throws(
    () => normalizeConfig({ session: { isolation: { checkout: { mode: "other" } } } }),
    /session\.defaults\.workspace/,
  );
});

test("extra_allowed_hosts and network_presets read as session.isolation.network", () => {
  const legacy = normalizeConfig({
    session: {
      isolation: { extra_allowed_hosts: ["Example.COM"], network_presets: ["python"] },
    },
  });
  const current = normalizeConfig({
    session: {
      isolation: { network: { allowed_hosts: ["Example.COM"], presets: ["python"] } },
    },
  });
  assert.deepEqual(legacy.isolation.extraAllowedHosts, current.isolation.extraAllowedHosts);
  assert.deepEqual(legacy.isolation.extraAllowedHosts, [
    "example.com",
    "pypi.org",
    "files.pythonhosted.org",
  ]);
  assert.deepEqual(configKeyWarnings(legacy), [
    "session.isolation.extra_allowed_hosts is deprecated; write session.isolation.network.allowed_hosts instead",
    "session.isolation.network_presets is deprecated; write session.isolation.network.presets instead",
  ]);
  assert.deepEqual(configKeyWarnings(current), []);
});

test("an MCP server's grants.network host list reads as grants.network.allowed_hosts", () => {
  const server = (network: unknown) => ({
    mcp_servers: {
      docs: {
        source: { kind: "runtime", ref: "docs" },
        grants: { workspace: "read-only", network },
      },
    },
    session: { mcp_servers: ["docs"] },
  });
  const legacy = normalizeConfig(server(["API.Example.com"]));
  const current = normalizeConfig(server({ allowed_hosts: ["API.Example.com"] }));
  for (const cfg of [legacy, current]) {
    const [tool] = cfg.mcp;
    assert(tool && "grants" in tool);
    assert.deepEqual(tool.grants, { workspace: "read-only", network: ["api.example.com"] });
  }
  assert.deepEqual(configKeyWarnings(legacy), [
    "mcp_servers.docs.grants.network is deprecated; write mcp_servers.docs.grants.network.allowed_hosts instead",
  ]);
  assert.deepEqual(configKeyWarnings(current), []);
  const presets = normalizeConfig(server({ allowed_hosts: ["a.example"], presets: ["python"] }));
  const [tool] = presets.mcp;
  assert(tool && "grants" in tool);
  assert.deepEqual(tool.grants?.network, ["a.example", "pypi.org", "files.pythonhosted.org"]);
  assert.throws(() => normalizeConfig(server({ hosts: ["a.example"] })), /Unknown setting/);
});

test("a new key set beside its old name wins, and the old one is reported as ignored", () => {
  const cfg = normalizeConfig({
    session: {
      defaults: { isolation: "none", workspace: "worktree" },
      worktree: { enabled: false },
      isolation: {
        enabled: true,
        network: { allowed_hosts: ["new.example"] },
        extra_allowed_hosts: ["old.example"],
      },
    },
  });
  assert.deepEqual(cfg.defaults, { isolation: "none", workspace: "worktree" });
  assert.deepEqual(cfg.isolation.extraAllowedHosts, ["new.example"]);
  assert.deepEqual(configKeyWarnings(cfg), [
    "session.isolation.enabled is deprecated and ignored: session.defaults.isolation is also set and wins; remove session.isolation.enabled",
    "session.worktree.enabled is deprecated and ignored: session.defaults.workspace is also set and wins; remove session.worktree.enabled",
    "session.isolation.extra_allowed_hosts is deprecated and ignored: session.isolation.network.allowed_hosts is also set and wins; remove session.isolation.extra_allowed_hosts",
  ]);
});

test("removed settings parse, are ignored and are reported", () => {
  assert.deepEqual(configKeyWarnings(normalizeConfig({})), []);
  const cfg = normalizeConfig({
    db: ".loom/loom.db",
    session: {
      titles: { enabled: false },
      notify: { webhook: "https://example.com/hook" },
      isolation: { launcher: "legacy" },
    },
  });
  assert(!("titles" in cfg) && !("notify" in cfg) && !("db" in cfg));
  assert(!("launcher" in cfg.isolation));
  const warnings = configKeyWarnings(cfg);
  assert.deepEqual(
    warnings.map((w) => w.split(" ")[0]),
    ["db", "session.isolation.launcher", "session.titles", "session.notify"],
  );
  assert.match(warnings[2]!, /always generated\); remove it from the config$/);
  assert.match(warnings[3]!, /hooks entry with on: "waiting"/);
  // Reported on their own, once per daemon, not among the per-load lint warnings.
  assert(!lintConfig(cfg).some((line) => /titles|notify|launcher|db /.test(line)));
  // An emptied section is dropped with its key, so strict parsing still accepts it.
  assert.deepEqual(normalizeConfig({ session: { titles: {} } }).configKeyNotices, [
    { kind: "removed", key: "session.titles", reason: "session titles are always generated" },
  ]);
});

test("migrateConfigLayer leaves current keys and its input alone", () => {
  const layer = { session: { defaults: { isolation: "vm" }, environment: { auto_nix: true } } };
  const frozen = structuredClone(layer);
  assert.deepEqual(migrateConfigLayer(layer), { layer, notices: [] });
  const legacy = { session: { isolation: { enabled: true, idle_stop_minutes: 5 } } };
  const before = structuredClone(legacy);
  assert.deepEqual(migrateConfigLayer(legacy).layer, {
    session: { isolation: { idle_stop_minutes: 5 }, defaults: { isolation: "vm" } },
  });
  assert.deepEqual(legacy, before);
  assert.deepEqual(layer, frozen);
});

test("a repos[] entry's old keys map per layer and are reported under its path", () => {
  withConfigFile(
    (dir) =>
      JSON.stringify({
        session: { defaults: { isolation: "vm", workspace: "clone" } },
        repos: [
          {
            path: dir,
            session: {
              worktree: { enabled: false },
              isolation: { enabled: false, extra_allowed_hosts: ["repo.example"] },
            },
          },
        ],
      }),
    (dir, file) => {
      const repo = loadConfig(dir, file);
      // The entry's old keys override the global new ones, as they did before the rename.
      assert.deepEqual(repo.defaults, { isolation: "none", workspace: "in-place" });
      assert.deepEqual(repo.isolation.extraAllowedHosts, ["repo.example"]);
      assert.deepEqual(configKeyWarnings(repo), [
        `repos[${dir}].session.isolation.enabled is deprecated; write repos[${dir}].session.defaults.isolation: "none" instead`,
        `repos[${dir}].session.worktree.enabled is deprecated; write repos[${dir}].session.defaults.workspace: "in-place" instead`,
        `repos[${dir}].session.isolation.extra_allowed_hosts is deprecated; write repos[${dir}].session.isolation.network.allowed_hosts instead`,
      ]);
      const other = loadConfig(join(dir, "other"), file);
      assert.deepEqual(other.defaults, { isolation: "vm", workspace: "clone" });
      assert.deepEqual(configKeyWarnings(other), []);
    },
  );
  withConfigFile(
    (dir) =>
      JSON.stringify({
        session: { isolation: { enabled: true } },
        repos: [{ path: dir, session: { defaults: { isolation: "none" } } }],
      }),
    (dir, file) => {
      // A global old key still yields to the entry's new one.
      const repo = loadConfig(dir, file);
      assert.equal(repo.defaults.isolation, "none");
      assert.deepEqual(configKeyWarnings(repo), [
        'session.isolation.enabled is deprecated; write session.defaults.isolation: "vm" instead',
      ]);
    },
  );
});

test("auto_rebase, auto_resume and commit_reminder sections read as one value each", () => {
  const rebase = (auto_rebase: unknown) => normalizeConfig({ session: { auto_rebase } }).autoRebase;
  assert.equal(rebase({ enabled: true }), "rebase");
  assert.equal(rebase({ enabled: true, mode: "merge" }), "merge");
  assert.equal(rebase({ enabled: false, mode: "merge" }), "off");
  // mode meant nothing while enabled was off, its default.
  assert.equal(rebase({ mode: "merge" }), "off");
  assert.throws(() => rebase({ enabled: "yes" }), /session\.auto_rebase: expected one of/);
  assert.throws(() => rebase({ enabled: true, mode: "squash" }), /session\.auto_rebase/);
  const cfg = normalizeConfig({
    session: {
      auto_rebase: { enabled: true, mode: "merge" },
      auto_resume: { enabled: false },
      commit_reminder: { enabled: false },
    },
  });
  assert.equal(cfg.autoResume, false);
  assert.equal(cfg.commitReminder, false);
  assert.deepEqual(configKeyWarnings(cfg), [
    'session.auto_rebase.enabled is deprecated; write session.auto_rebase: "merge" instead',
    'session.auto_rebase.mode is deprecated; write session.auto_rebase: "merge" instead',
    "session.auto_resume.enabled is deprecated; write session.auto_resume instead",
    "session.commit_reminder.enabled is deprecated; write session.commit_reminder instead",
  ]);
});

test("timeouts and idle timers read under names with their units and one verb", () => {
  const cfg = normalizeConfig({
    daemon: { idle_shutdown_minutes: 5 },
    session: { isolation: { idle_timeout_minutes: 0 } },
    hooks: [
      { on: "turn_end", run: "lint", timeout: 90 },
      { on: "turn_end", run: "fmt", timeout: 1, timeout_seconds: 2 },
    ],
  });
  assert.equal(cfg.daemon.idleStopMinutes, 5);
  assert.equal(cfg.isolation.idleStopMinutes, 0);
  assert.deepEqual(
    cfg.hooks.map((h) => h.timeoutMs),
    [90_000, 2_000],
  );
  assert.deepEqual(configKeyWarnings(cfg), [
    "daemon.idle_shutdown_minutes is deprecated; write daemon.idle_stop_minutes instead",
    "session.isolation.idle_timeout_minutes is deprecated; write session.isolation.idle_stop_minutes instead",
    "hooks[0].timeout is deprecated; write hooks[0].timeout_seconds instead",
    "hooks[1].timeout is deprecated and ignored: hooks[1].timeout_seconds is also set and wins; remove hooks[1].timeout",
  ]);
});

test("clone publication policy and provider runtimes move out of session.isolation", () => {
  const legacy = normalizeConfig({
    session: {
      isolation: {
        checkout: { visible_refs: ["refs/tags/"], max_push_bytes: 2 * 1024 * 1024 },
        claude: { artifact: "/runtimes/claude" },
      },
    },
  });
  const current = normalizeConfig({
    session: {
      clone: { visible_refs: ["refs/tags/"], max_push_bytes: 2 * 1024 * 1024 },
      isolation: { runtimes: { claude: { artifact: "/runtimes/claude" } } },
    },
  });
  for (const cfg of [legacy, current]) {
    assert.deepEqual(cfg.clone, { visibleRefs: ["refs/tags/"], maxPushBytes: 2 * 1024 * 1024 });
    assert.equal(cfg.isolation.runtimes?.claude?.artifact, "/runtimes/claude");
  }
  assert.deepEqual(configKeyWarnings(legacy), [
    "session.isolation.checkout.visible_refs is deprecated; write session.clone.visible_refs instead",
    "session.isolation.checkout.max_push_bytes is deprecated; write session.clone.max_push_bytes instead",
    "session.isolation.claude is deprecated; write session.isolation.runtimes.claude instead",
  ]);
  assert.deepEqual(configKeyWarnings(current), []);
  assert.throws(
    () => normalizeConfig({ session: { isolation: { runtimes: { aisdk: { smolvm: "/s" } } } } }),
    /session\.isolation\.runtimes\.aisdk requires an artifact path/,
  );
});

test("permission_default reads as default_mode, which seeds new Claude sessions", () => {
  const mode = (permission_default: unknown) =>
    normalizeConfig({ providers: { claude: { permission_default } } });
  assert.equal(mode("manual").providers.claude.defaultMode, "default");
  assert.equal(mode("acceptEdits").providers.claude.defaultMode, "acceptEdits");
  // Never a session mode; it was never read either.
  const bypass = mode("bypassPermissions");
  assert.equal(bypass.providers.claude.defaultMode, undefined);
  assert.match(
    configKeyWarnings(bypass)[0]!,
    /^providers\.claude\.permission_default is no longer read \(bypassPermissions is not a session mode/,
  );
  assert.equal(
    normalizeConfig({ providers: { claude: { default_mode: "auto" } } }).providers.claude
      .defaultMode,
    "auto",
  );
  assert.equal(normalizeConfig({}).providers.claude.defaultMode, undefined);
  assert.throws(
    () => normalizeConfig({ providers: { claude: { default_mode: "bypassPermissions" } } }),
    /providers\.claude\.default_mode/,
  );
});

test('"" reads as unset where it always meant the default', () => {
  const cfg = normalizeConfig({
    default_provider: "",
    session: { worktree_dir: "", defaults: { base_branch: "" } },
    providers: {
      claude: {
        cli_path: "",
        title_model: "",
        prompt_cache_ttl: "",
        profiles: { work: { config_dir: "/w", color: "", tag: "Work" }, gone: { config_dir: "" } },
      },
      anthropic: { api_key_env: "", api_key: "k", model: "m", title_model: "", color: "" },
    },
  });
  assert.equal(cfg.defaultProvider, "claude");
  assert.equal(cfg.worktreeDir, "");
  assert.equal(cfg.baseBranch, undefined);
  assert.equal(cfg.providers.claude.cliPath, "");
  assert.equal(cfg.providers.claude.promptCacheTtl, "default");
  assert.deepEqual(
    cfg.claudeProfiles.map((p) => [p.name, p.color]),
    [["work", ""]],
  );
  assert.equal(cfg.providers.aisdk["anthropic"]?.apiKeyEnv, "");
  assert.deepEqual(configKeyWarnings(cfg), []);
});

test("provider_access.{only, disabled} read as allow and deny", () => {
  const legacy = normalizeConfig({
    session: { provider_access: { only: ["claude", "fake"], disabled: ["fake"] } },
  });
  assert.deepEqual(legacy.providerAccess, { allow: ["claude", "fake"], deny: ["fake"] });
  assert.deepEqual(configKeyWarnings(legacy), [
    "session.provider_access.only is deprecated; write session.provider_access.allow instead",
    "session.provider_access.disabled is deprecated; write session.provider_access.deny instead",
  ]);
  const both = normalizeConfig({
    session: { provider_access: { allow: ["claude"], only: ["fake"] } },
  });
  assert.deepEqual(both.providerAccess.allow, ["claude"]);
  assert.equal(configKeyWarnings(both).filter((w) => w.includes("is also set and wins")).length, 1);
});

test("providers.echo is shown by its presence; enabled: false hides it", () => {
  const echo = (value: unknown) => normalizeConfig({ providers: { echo: value } });
  assert.equal(echo({}).providers.echo, true);
  assert.equal(normalizeConfig({}).providers.echo, false);
  assert.equal(echo({ enabled: true }).providers.echo, true);
  const hidden = echo({ enabled: false });
  assert.equal(hidden.providers.echo, false);
  assert.deepEqual(configKeyWarnings(hidden), [
    "providers.echo.enabled is no longer read (the echo provider is shown only while providers.echo is set); remove it from the config",
  ]);
  assert.deepEqual(configKeyWarnings(echo({ enabled: true })), [
    "providers.echo.enabled is deprecated; write providers.echo instead",
  ]);
});

test("auto_nix and isolation.environment read as session.environment, key by key", () => {
  const legacy = normalizeConfig({
    session: {
      auto_nix: true,
      isolation: { environment: { cpus: 2, memory_mib: 4096, timeout_seconds: 60 } },
    },
  });
  const current = normalizeConfig({
    session: { environment: { auto_nix: true, cpus: 2, memory_mib: 4096, timeout_seconds: 60 } },
  });
  for (const cfg of [legacy, current]) {
    assert.equal(cfg.autoNix, true);
    assert.deepEqual(cfg.isolation.environment, {
      autoNix: true,
      commandPrefix: [],
      timeoutMs: 60_000,
      memoryMiB: 4096,
      cpus: 2,
    });
  }
  assert.deepEqual(
    configKeyWarnings(legacy).map((w) => w.split(" ")[0]),
    [
      "session.auto_nix",
      "session.isolation.environment.timeout_seconds",
      "session.isolation.environment.cpus",
      "session.isolation.environment.memory_mib",
    ],
  );
  // A new key wins over its old name; the others still move.
  const mixed = normalizeConfig({
    session: {
      environment: { cpus: 4 },
      isolation: { environment: { cpus: 2, memory_mib: 4096 } },
    },
  });
  assert.equal(mixed.isolation.environment?.cpus, 4);
  assert.equal(mixed.isolation.environment?.memoryMiB, 4096);
});

test("base_branch and worktree_dir read as session settings, per layer", () => {
  withConfigFile(
    (dir) =>
      JSON.stringify({
        session: { defaults: { base_branch: "main" }, worktree_dir: "/global" },
        repos: [{ path: dir, base_branch: "trunk", worktree_dir: "/repo" }],
      }),
    (dir, file) => {
      const repo = loadConfig(dir, file);
      assert.equal(repo.baseBranch, "trunk");
      assert.equal(repo.worktreeDir, "/repo");
      assert.deepEqual(configKeyWarnings(repo), [
        `repos[${dir}].base_branch is deprecated; write repos[${dir}].session.defaults.base_branch: "trunk" instead`,
        `repos[${dir}].worktree_dir is deprecated; write repos[${dir}].session.worktree_dir: "/repo" instead`,
      ]);
      const other = loadConfig(join(dir, "other"), file);
      assert.equal(other.baseBranch, "main");
      assert.equal(other.worktreeDir, "/global");
    },
  );
});

test("worker_allowed_hosts keeps replacing Claude's hosts; network.allowed_hosts adds", () => {
  const hosts = (claude: Record<string, unknown>) => normalizeConfig({ providers: { claude } });
  const replace = hosts({ worker_allowed_hosts: ["proxy.example"] });
  assert.deepEqual(replace.providers.claude.workerHosts, {
    kind: "replace",
    hosts: ["proxy.example"],
  });
  assert.match(
    configKeyWarnings(replace)[0]!,
    /^providers\.claude\.worker_allowed_hosts is deprecated and still read as before: it replaces Claude's built-in hosts/,
  );
  assert.deepEqual(
    hosts({ network: { allowed_hosts: ["a.example"] } }).providers.claude.workerHosts,
    {
      kind: "add",
      hosts: ["a.example"],
    },
  );
  const both = hosts({
    worker_allowed_hosts: ["proxy.example"],
    network: { allowed_hosts: ["a.example"] },
  });
  assert.deepEqual(both.providers.claude.workerHosts, { kind: "add", hosts: ["a.example"] });
  assert.deepEqual(configKeyWarnings(both), [
    "providers.claude.worker_allowed_hosts is deprecated and ignored: providers.claude.network.allowed_hosts is also set and wins; remove providers.claude.worker_allowed_hosts",
  ]);
  assert.equal(normalizeConfig({}).providers.claude.workerHosts, undefined);
});

test("an unknown key in a section is ignored and reported where it is written", () => {
  const cfg = normalizeConfig({
    tui: { compat: true, compt: true },
    session: { defaults: { isolaton: "vm" } },
    hooks: [{ on: "turn_end", run: "lint", tiemout_seconds: 5 }],
    surprise: 1,
  });
  assert.equal(cfg.tui.compat, true);
  assert.deepEqual(configKeyWarnings(cfg), [
    // A section's own keys are checked once its settings parse, so the top level comes last.
    "session.defaults.isolaton is not a Loom setting and is ignored; check its spelling and section",
    "tui.compt is not a Loom setting and is ignored; check its spelling and section",
    "hooks[0].tiemout_seconds is not a Loom setting and is ignored; check its spelling and section",
    "surprise is not a Loom setting and is ignored; check its spelling and section",
  ]);
  // A wrong type beside an unknown key is still an error.
  assert.throws(() => normalizeConfig({ tui: { compat: "yes", compt: true } }), /tui\.compat/);
  // Objects that were strict stay strict.
  assert.throws(
    () => normalizeConfig({ session: { isolaton: {} } }),
    /Unknown setting session\.isolaton/,
  );
  withConfigFile(
    (dir) =>
      JSON.stringify({
        tui: { compt: true },
        repos: [{ path: dir, hooks: [{ on: "turn_end", run: "x", tiemout: 1 }] }],
      }),
    (dir, file) => {
      assert.deepEqual(
        loadConfig(dir, file).configKeyNotices?.filter((n) => n.kind === "unknown"),
        [
          { kind: "unknown", key: "tui.compt" },
          { kind: "unknown", key: `repos[${dir}].hooks[0].tiemout` },
        ],
      );
    },
  );
});

test("the daemon logs each deprecated key once and config.check lists them", async () => {
  const hh = await makeHarness({
    config: '{"session": {"titles": {"enabled": false}, "worktree": {"enabled": false}}}',
  });
  const c = await LoomClient.connect({
    repoRoot: hh.repoRoot,
    sockPath: hh.sockPath,
    autospawn: false,
  });
  const logDir = mkdtempSync(join(tmpdir(), "loom-legacy-log-"));
  const logFile = join(logDir, "daemon.log");
  try {
    assert.equal(hh.daemon.config.defaults.workspace, "in-place");
    // The harness logs errors only; count the reloads' warnings from here, off stderr.
    setLogLevel("warn");
    setLogStderr(false);
    setLogFile(logFile);
    writeFileSync(logFile, "");
    const { warnings } = await c.request<{ warnings: string[] }>("config.check");
    assert(warnings.some((w) => w.startsWith("session.titles is no longer read")));
    assert(warnings.some((w) => w.startsWith("session.worktree.enabled is deprecated")));
    // A reload that keeps the key does not repeat the warning; one that adds a key reports it.
    writeFileSync(
      hh.configPath,
      '{"session": {"titles": {"enabled": false}, "worktree": {"enabled": false}, "auto_nix": true}}',
    );
    await waitFor(() => hh.daemon.config.autoNix);
    writeFileSync(
      hh.configPath,
      '{"session": {"titles": {"enabled": false}, "worktree": {"enabled": false}, "notify": {"webhook": "x"}}}',
    );
    await waitFor(() => !hh.daemon.config.autoNix);
    const log = readFileSync(logFile, "utf8");
    const count = (text: string) => log.split(text).length - 1;
    assert.equal(count("session.titles is no longer read"), 0);
    assert.equal(count("session.worktree.enabled is deprecated"), 0);
    assert.equal(count("session.notify is no longer read"), 1);
  } finally {
    setLogFile(null);
    setLogStderr(true);
    setLogLevel("error");
    rmSync(logDir, { recursive: true, force: true });
    await c.close();
    await hh.cleanup();
  }
});

const waitFor = async (ok: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
