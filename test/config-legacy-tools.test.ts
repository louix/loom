import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configKeyWarnings, loadConfig, normalizeConfig } from "@loom/daemon/config/config";
import { migrateConfigLayer } from "../backend/daemon/src/config/legacy-keys.ts";

const OLD_CATALOGS = {
  local_tools: { fff: { command: "fff-mcp", args: ["--stdio"], default_for: ["find"] } },
  vm_tools: { tilth: { runtime: "tilth", default_for: ["read"] } },
  remote_tools: {
    docs: { url: "https://docs.example/mcp", bearer_token_env: "DOCS_TOKEN" },
    open: { url: "https://open.example/mcp", bearer_token_env: "" },
    inline: { url: "https://inline.example/mcp", bearer_token: "inline-secret" },
  },
};

test("foldLegacyTools maps each old catalog entry onto an mcp_servers source kind", () => {
  // given
  const layer = {
    ...OLD_CATALOGS,
    mcp_servers: { kagi: { source: { kind: "http", url: "https://mcp.kagi.com/mcp" } } },
  };
  // when
  const { layer: migrated } = migrateConfigLayer(layer);
  // then
  assert.deepEqual(migrated, {
    mcp_servers: {
      kagi: { source: { kind: "http", url: "https://mcp.kagi.com/mcp" } },
      fff: {
        default_for: ["find"],
        source: { kind: "command", command: "fff-mcp", args: ["--stdio"] },
      },
      tilth: {
        default_for: ["read"],
        source: { kind: "runtime", ref: "tilth" },
        grants: { workspace: "read-write" },
      },
      docs: {
        source: { kind: "http", url: "https://docs.example/mcp" },
        auth: { bearer_token_env: "DOCS_TOKEN" },
      },
      open: { source: { kind: "http", url: "https://open.example/mcp" } },
      inline: {
        source: { kind: "http", url: "https://inline.example/mcp" },
        auth: { bearer_token: "inline-secret" },
      },
    },
  });
});

test("old selections fold into session.mcp_servers in launch order, each reported", () => {
  // given
  const raw = {
    ...OLD_CATALOGS,
    mcp_servers: { kagi: { source: { kind: "http", url: "https://mcp.kagi.com/mcp" } } },
    session: {
      mcp_servers: ["kagi", "docs"],
      remote_tools: ["docs"],
      vm_tools: ["tilth"],
      local_tools: ["fff"],
    },
  };
  // when
  const cfg = normalizeConfig(raw);
  // then
  assert.deepEqual(
    cfg.mcp.map((m) => m.name),
    ["fff", "tilth"],
  );
  assert.deepEqual(
    cfg.httpMcp.map((m) => m.name),
    ["docs", "kagi"],
  );
  assert.deepEqual(cfg.mcp[1], {
    name: "tilth",
    required: true,
    defaultFor: ["read"],
    runtime: "tilth",
    isolation: "vm",
    grants: { workspace: "read-write", network: [] },
  });
  assert.equal(cfg.httpMcp[0]?.bearerTokenEnv, "DOCS_TOKEN");
  assert.deepEqual(configKeyWarnings(cfg), [
    'local_tools.fff is deprecated; write mcp_servers.fff with source.kind "command" and its command and args instead',
    'vm_tools.tilth is deprecated; write mcp_servers.tilth with source.kind "runtime", ref: its runtime, and grants.workspace "read-write" instead',
    'remote_tools.docs is deprecated; write mcp_servers.docs with source.kind "http" and its url; bearer_token and bearer_token_env move under auth instead',
    'remote_tools.open is deprecated; write mcp_servers.open with source.kind "http" and its url; bearer_token and bearer_token_env move under auth instead',
    'remote_tools.inline is deprecated; write mcp_servers.inline with source.kind "http" and its url; bearer_token and bearer_token_env move under auth instead',
    "session.local_tools is deprecated; write session.mcp_servers with its names (one list for every kind of server; a repos[] entry's list replaces all of it) instead",
    "session.vm_tools is deprecated; write session.mcp_servers with its names (one list for every kind of server; a repos[] entry's list replaces all of it) instead",
    "session.remote_tools is deprecated; write session.mcp_servers with its names (one list for every kind of server; a repos[] entry's list replaces all of it) instead",
  ]);
});

test("a name in two catalogs is an error that names what to write, never a value", () => {
  for (const [raw, expected] of [
    [
      {
        local_tools: { tilth: { command: "tilth" } },
        vm_tools: { tilth: { runtime: "tilth" } },
      },
      /^local_tools\.tilth and vm_tools\.tilth share the name tilth, and mcp_servers has one entry per name: write mcp_servers\.tilth-host with source\.kind "command" and its command and args, and mcp_servers\.tilth-vm with source\.kind "runtime", ref: its runtime, and grants\.workspace "read-write"; then select the ones you want by those names in session\.mcp_servers$/,
    ],
    [
      {
        remote_tools: { kagi: { url: "https://mcp.kagi.com/mcp", bearer_token: "secret-token" } },
        mcp_servers: { kagi: { source: { kind: "http", url: "https://mcp.kagi.com/mcp" } } },
      },
      /^remote_tools\.kagi and mcp_servers\.kagi share the name kagi, and mcp_servers has one entry per name: write mcp_servers\.kagi-remote with/,
    ],
  ] as const)
    assert.throws(
      () => normalizeConfig(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /secret-token|mcp\.kagi\.com/);
        return true;
      },
    );
});

test("keys an old entry never had are rejected where its new form puts them", () => {
  for (const raw of [
    { vm_tools: { code: { runtime: "tilth", command: "tilth" } } },
    { vm_tools: { code: { runtime: "tilth", env: { TOKEN: "secret" } } } },
    { local_tools: { code: { runtime: "tilth" } } },
    { remote_tools: { code: { url: "https://user:secret@host/mcp" } } },
  ])
    assert.throws(() => normalizeConfig(raw), /mcp_servers\.code\.source/);
});

test("an empty old catalog is reported as removed; null still reads as absent", () => {
  // given
  const cfg = normalizeConfig({ local_tools: {}, vm_tools: null, session: { remote_tools: null } });
  // then
  assert.deepEqual(cfg.mcp, []);
  assert.deepEqual(configKeyWarnings(cfg), [
    "local_tools is no longer read (tools are mcp_servers entries now, and it defines none); remove it from the config",
    "session.remote_tools is deprecated; write session.mcp_servers with its names (one list for every kind of server; a repos[] entry's list replaces all of it) instead",
  ]);
});

test("a repos[] entry's old tool keys fold per layer and are reported under its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-legacy-tools-"));
  try {
    // given
    const file = join(dir, "config.jsonc");
    writeFileSync(
      file,
      JSON.stringify({
        vm_tools: { tilth: { runtime: "tilth" } },
        session: { vm_tools: ["tilth"] },
        repos: [
          {
            path: dir,
            local_tools: { fff: { command: "fff-mcp" } },
            session: { local_tools: ["fff"], vm_tools: ["tilth"] },
          },
        ],
      }),
    );
    // when
    const repo = loadConfig(dir, file);
    const other = loadConfig(join(dir, "elsewhere"), file);
    // then
    assert.deepEqual(
      repo.mcp.map((m) => m.name),
      ["fff", "tilth"],
    );
    assert.deepEqual(
      other.mcp.map((m) => m.name),
      ["tilth"],
    );
    assert.ok(
      configKeyWarnings(repo).includes(
        `repos[${dir}].local_tools.fff is deprecated; write repos[${dir}].mcp_servers.fff with source.kind "command" and its command and args instead`,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
