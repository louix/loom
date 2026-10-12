/**
 * `agents` in the Loom user config (docs/loom-agents.md): defaults, the
 * per-repository merge, and validation of each profile against what the
 * config can actually run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  availableProfiles,
  loadConfig,
  normalizeConfig,
  parseConfig,
} from "@loom/daemon/config/config";
import { profileInfos } from "@loom/daemon/daemon/agents";

const cfg = (value: unknown) => normalizeConfig(parseConfig(JSON.stringify(value)));

test("agents default to depth 2 and no configured profiles", () => {
  assert.deepEqual(cfg({}).agents, { maxDepth: 2, profiles: {} });
});

test("a profile keeps what it sets and follows the spawner for the rest", () => {
  const c = cfg({
    session: { mcp_servers: ["tilth"] },
    mcp_servers: { tilth: { source: { kind: "command", command: "tilth" } } },
    providers: { claude: { profiles: { personal: { config_dir: "~/.claude-personal" } } } },
    agents: {
      max_depth: 3,
      profiles: {
        implementer: {
          description: "  Cheap; give it a specific, verifiable task ",
          provider: "claude:personal",
          model: "claude-sonnet-5-5",
          effort: "medium",
          mode: "manual",
          mcp_servers: { allow: ["tilth", "loom-agents"], deny: ["loom-agents"] },
          skills: ["pdf"],
          tools: { deny: ["WebFetch"] },
          prompt: "You implement exactly the task you are given.\n",
        },
        reviewer: { description: "Sceptical" },
      },
    },
  });
  assert.equal(c.agents.maxDepth, 3);
  assert.deepEqual(c.agents.profiles["implementer"], {
    description: "Cheap; give it a specific, verifiable task",
    provider: "claude:personal",
    model: "claude-sonnet-5-5",
    effort: "medium",
    mode: "default",
    mcpServers: { allow: ["tilth", "loom-agents"], deny: ["loom-agents"] },
    skills: ["pdf"],
    tools: { deny: ["WebFetch"] },
    prompt: "You implement exactly the task you are given.",
  });
  assert.deepEqual(c.agents.profiles["reviewer"], {
    description: "Sceptical",
    mcpServers: { deny: [] },
  });
});

test("profiles are validated against the configured providers, MCP servers and settings", () => {
  const bad: Array<[unknown, RegExp]> = [
    [
      { implementer: { description: "x", provider: "claude:nope" } },
      /agents\.profiles\.implementer\.provider: "claude:nope" is not a configured provider \(configured: claude/,
    ],
    [
      { implementer: { description: "x", mcp_servers: { allow: ["kagi"] } } },
      /agents\.profiles\.implementer\.mcp_servers\.allow: "kagi" is not one of the session's MCP servers \(loom-agents\)/,
    ],
    [
      { implementer: { description: "x", mcp_servers: { deny: ["kagi"] } } },
      /agents\.profiles\.implementer\.mcp_servers\.deny: "kagi" is not one of the session's MCP servers \(loom-agents\)/,
    ],
    [
      { implementer: { description: "x", mcp_servers: ["loom-agents"] } },
      /agents\.profiles\.implementer\.mcp_servers: a list is no longer accepted: write \{ "allow": \[\.\.\.\] \} to keep only those servers, or \{ "deny": \[\.\.\.\] \} to withhold them/,
    ],
    [
      { implementer: { description: "x", mcp_servers: { only: [] } } },
      /Unknown setting agents\.profiles\.implementer\.mcp_servers\.only/,
    ],
    [{ implementer: { description: "x", mcp: [] } }, /Unknown setting.*mcp/],
    [
      { implementer: { description: "x", provider: "codex", skills: ["pdf"] } },
      /agents\.profiles\.implementer\.skills: skills are only supported for Claude providers/,
    ],
    [
      { implementer: { description: "x", provider: "codex", tools: { deny: ["shell"] } } },
      /agents\.profiles\.implementer\.tools: tool allow\/deny lists are not supported for Codex/,
    ],
    [{ implementer: { description: " " } }, /agents\.profiles\.implementer\.description/],
    [{ implementer: { description: "x", mode: "yolo" } }, /agents\.profiles\.implementer\.mode/],
    [{ implementer: { description: "x", colour: "red" } }, /Unknown setting.*colour/],
    [{ self: { description: "x" } }, /self is built in/],
    [{ "a b": { description: "x" } }, /letters, digits/],
    [
      { implementer: { description: "x", mcp_servers: { deny: ["a", "a"] } } },
      /duplicate MCP servers/,
    ],
  ];
  for (const [profiles, error] of bad)
    assert.throws(() => cfg({ providers: { codex: {} }, agents: { profiles } }), error);
  assert.throws(() => cfg({ agents: { max_depth: 0 } }), /agents\.max_depth/);
  // loom-agents is always nameable: it is how a profile lets a child spawn.
  for (const mcp_servers of [{ allow: ["loom-agents"] }, { deny: ["loom-agents"] }])
    assert.deepEqual(
      cfg({ agents: { profiles: { lead: { description: "x", mcp_servers } } } }).agents.profiles[
        "lead"
      ]?.mcpServers,
      { deny: [], ...mcp_servers },
    );
});

/** `fn` with a user config file and a repository directory under a temp dir. */
const withUserConfig = (
  config: Record<string, unknown>,
  fn: (repo: string, user: string) => void,
) => {
  const dir = mkdtempSync(join(tmpdir(), "loom-agents-config-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const user = join(dir, "user.jsonc");
    const repos = (config.repos as Array<Record<string, unknown>> | undefined) ?? [];
    writeFileSync(
      user,
      JSON.stringify({ ...config, repos: repos.map((r) => ({ path: repo, ...r })) }),
    );
    fn(repo, user);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a global profile on a provider a repository does not allow is unavailable there", () => {
  withUserConfig(
    {
      providers: {
        claude: { profiles: { personal: { config_dir: "~/.claude-personal" } } },
        codex: {},
      },
      agents: {
        profiles: {
          opus: { description: "Opus", provider: "claude:personal", model: "claude-opus-5-5" },
          // Skills are for Claude only; not checked where codex is not allowed.
          coder: { description: "Codex", provider: "codex", skills: ["pdf"] },
          follower: { description: "Follows its spawner" },
        },
      },
      repos: [{ session: { provider_access: { allow: ["fake"] } } }],
    },
    (repo, user) => {
      const config = loadConfig(repo, user);
      assert.deepEqual(Object.keys(availableProfiles(config)), ["follower"]);
      assert.deepEqual(Object.keys(availableProfiles(config, "fake")), ["follower"]);
      assert.deepEqual(Object.keys(availableProfiles(config, "codex")), []);
      assert.deepEqual(
        profileInfos(config).map((p) => p.name),
        ["follower"],
      );
    },
  );
  // Disabled rather than left out of `only`: the same.
  const c = cfg({
    session: { provider_access: { deny: ["codex"] } },
    providers: { codex: {} },
    agents: { profiles: { implementer: { description: "x", provider: "codex", skills: ["pdf"] } } },
  });
  assert.deepEqual(availableProfiles(c), {});
  assert.deepEqual(Object.keys(availableProfiles({ ...c, providerAccess: { deny: [] } })), [
    "implementer",
  ]);
});

test("a repository's own profile on a provider it disables is a config error", () => {
  withUserConfig(
    {
      providers: { codex: {} },
      agents: { profiles: { coder: { description: "global coder" } } },
      repos: [
        {
          session: { provider_access: { deny: ["codex"] } },
          agents: { profiles: { coder: { provider: "codex" } } },
        },
      ],
    },
    (repo, user) =>
      assert.throws(
        () => loadConfig(repo, user),
        /agents\.profiles\.coder\.provider: this repository's entry names "codex", which its session\.provider_access disables/,
      ),
  );
  // Disabled globally and not re-allowed by the repository: still its own contradiction.
  withUserConfig(
    {
      session: { provider_access: { deny: ["codex"] } },
      providers: { codex: {} },
      repos: [{ agents: { profiles: { coder: { description: "x", provider: "codex" } } } }],
    },
    (repo, user) =>
      assert.throws(() => loadConfig(repo, user), /which its session\.provider_access disables/),
  );
});

test("a repository's profiles merge over the global ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-agents-config-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const user = join(dir, "user.jsonc");
    writeFileSync(
      user,
      JSON.stringify({
        agents: {
          profiles: {
            implementer: { description: "global implementer", effort: "low" },
            verifier: { description: "global verifier" },
          },
        },
        repos: [
          {
            path: repo,
            agents: {
              max_depth: 3,
              profiles: {
                implementer: { description: "repo implementer" },
                docs: { description: "repo docs writer" },
              },
            },
          },
        ],
      }),
    );
    const agents = loadConfig(repo, user).agents;
    assert.equal(agents.maxDepth, 3);
    assert.deepEqual(Object.keys(agents.profiles).sort(), ["docs", "implementer", "verifier"]);
    assert.deepEqual(agents.profiles["implementer"], {
      description: "repo implementer",
      effort: "low",
      mcpServers: { deny: [] },
    });
    assert.equal(loadConfig(dir, user).agents.maxDepth, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
