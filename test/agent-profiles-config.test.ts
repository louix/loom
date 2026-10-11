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
import { loadConfig, normalizeConfig, parseConfig } from "@loom/daemon/config/config";

const cfg = (value: unknown) => normalizeConfig(parseConfig(JSON.stringify(value)));

test("agents default to depth 2 and no configured profiles", () => {
  assert.deepEqual(cfg({}).agents, { maxDepth: 2, profiles: {} });
});

test("a profile keeps what it sets and follows the spawner for the rest", () => {
  const c = cfg({
    session: { local_tools: ["tilth"] },
    local_tools: { tilth: { command: "tilth" } },
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
          mcp: ["tilth"],
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
    mcp: ["tilth"],
    skills: ["pdf"],
    tools: { deny: ["WebFetch"] },
    prompt: "You implement exactly the task you are given.",
  });
  assert.deepEqual(c.agents.profiles["reviewer"], { description: "Sceptical" });
});

test("profiles are validated against the configured providers, MCP servers and settings", () => {
  const bad: Array<[unknown, RegExp]> = [
    [
      { implementer: { description: "x", provider: "claude:nope" } },
      /agents\.profiles\.implementer\.provider: "claude:nope" is not a configured provider \(configured: claude/,
    ],
    [
      { implementer: { description: "x", mcp: ["kagi"] } },
      /agents\.profiles\.implementer\.mcp: "kagi" is not one of the session's MCP servers \(loom-agents\)/,
    ],
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
    [{ implementer: { description: "x", mcp: ["a", "a"] } }, /duplicate MCP servers/],
  ];
  for (const [profiles, error] of bad)
    assert.throws(() => cfg({ providers: { codex: {} }, agents: { profiles } }), error);
  assert.throws(() => cfg({ agents: { max_depth: 0 } }), /agents\.max_depth/);
  assert.throws(
    () =>
      cfg({
        session: { provider_access: { disabled: ["codex"] } },
        providers: { codex: {} },
        agents: { profiles: { implementer: { description: "x", provider: "codex" } } },
      }),
    /"codex" is disabled by session\.provider_access/,
  );
  // loom-agents is always nameable: it is how a profile lets a child spawn.
  assert.deepEqual(
    cfg({ agents: { profiles: { lead: { description: "x", mcp: ["loom-agents"] } } } }).agents
      .profiles["lead"]?.mcp,
    ["loom-agents"],
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
    });
    assert.equal(loadConfig(dir, user).agents.maxDepth, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
