import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  lintConfig,
  loadConfig,
  normalizeConfig,
  removedConfigWarnings,
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
    assert.deepEqual(removedConfigWarnings(cfg), [
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
  assert.deepEqual(both.isolation.checkout?.visibleRefs, ["refs/tags/"]);
  assert.deepEqual(removedConfigWarnings(both), [
    'session.worktree.enabled is deprecated; write session.defaults.workspace: "clone" instead',
    'session.isolation.checkout.mode is deprecated; write session.defaults.workspace: "clone" instead',
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
  assert.deepEqual(removedConfigWarnings(legacy), [
    "session.isolation.extra_allowed_hosts is deprecated; write session.isolation.network.allowed_hosts instead",
    "session.isolation.network_presets is deprecated; write session.isolation.network.presets instead",
  ]);
  assert.deepEqual(removedConfigWarnings(current), []);
});

test("an MCP server's grants.network host list reads as grants.network.allowed_hosts", () => {
  const server = (network: unknown) => ({
    mcp_servers: {
      docs: {
        source: { kind: "runtime", ref: "docs" },
        execution: "vm",
        grants: { workspace: "read-only", network },
      },
    },
    session: { mcp_servers: ["docs"] },
  });
  const legacy = normalizeConfig(server(["*.Example.com"]));
  const current = normalizeConfig(server({ allowed_hosts: ["*.Example.com"] }));
  for (const cfg of [legacy, current]) {
    const [tool] = cfg.mcp;
    assert(tool && "grants" in tool);
    assert.deepEqual(tool.grants, { workspace: "read-only", network: ["*.example.com"] });
  }
  assert.deepEqual(removedConfigWarnings(legacy), [
    "mcp_servers.docs.grants.network is deprecated; write mcp_servers.docs.grants.network.allowed_hosts instead",
  ]);
  assert.deepEqual(removedConfigWarnings(current), []);
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
  assert.deepEqual(removedConfigWarnings(cfg), [
    "session.isolation.enabled is deprecated and ignored: session.defaults.isolation is also set and wins; remove session.isolation.enabled",
    "session.worktree.enabled is deprecated and ignored: session.defaults.workspace is also set and wins; remove session.worktree.enabled",
    "session.isolation.extra_allowed_hosts is deprecated and ignored: session.isolation.network.allowed_hosts is also set and wins; remove session.isolation.extra_allowed_hosts",
  ]);
});

test("removed settings parse, are ignored and are reported", () => {
  assert.deepEqual(removedConfigWarnings(normalizeConfig({})), []);
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
  const warnings = removedConfigWarnings(cfg);
  assert.deepEqual(
    warnings.map((w) => w.split(" ")[0]),
    ["db", "session.isolation.launcher", "session.titles", "session.notify"],
  );
  assert.match(warnings[2]!, /always generated\); remove it from the config$/);
  assert.match(warnings[3]!, /hooks entry with on: "waiting"/);
  // Reported on their own, once per daemon, not among the per-load lint warnings.
  assert(!lintConfig(cfg).some((line) => /titles|notify|launcher|db /.test(line)));
  // An emptied section is dropped with its key, so strict parsing still accepts it.
  assert.deepEqual(normalizeConfig({ session: { titles: {} } }).deprecatedKeys, [
    { kind: "removed", key: "session.titles", reason: "session titles are always generated" },
  ]);
});

test("migrateConfigLayer leaves current keys and its input alone", () => {
  const layer = { session: { defaults: { isolation: "vm" }, auto_nix: true } };
  const frozen = structuredClone(layer);
  assert.deepEqual(migrateConfigLayer(layer), { layer, deprecated: [] });
  const legacy = { session: { isolation: { enabled: true, idle_timeout_minutes: 5 } } };
  const before = structuredClone(legacy);
  assert.deepEqual(migrateConfigLayer(legacy).layer, {
    session: { isolation: { idle_timeout_minutes: 5 }, defaults: { isolation: "vm" } },
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
      assert.deepEqual(removedConfigWarnings(repo), [
        `repos[${dir}].session.isolation.enabled is deprecated; write repos[${dir}].session.defaults.isolation: "none" instead`,
        `repos[${dir}].session.worktree.enabled is deprecated; write repos[${dir}].session.defaults.workspace: "in-place" instead`,
        `repos[${dir}].session.isolation.extra_allowed_hosts is deprecated; write repos[${dir}].session.isolation.network.allowed_hosts instead`,
      ]);
      const other = loadConfig(join(dir, "other"), file);
      assert.deepEqual(other.defaults, { isolation: "vm", workspace: "clone" });
      assert.deepEqual(removedConfigWarnings(other), []);
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
      assert.deepEqual(removedConfigWarnings(repo), [
        'session.isolation.enabled is deprecated; write session.defaults.isolation: "vm" instead',
      ]);
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
