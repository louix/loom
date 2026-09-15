import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { normalizeConfig, lintConfig } from "@loom/daemon/config/config";
import { mcpToolPreferences, toolSteer } from "@loom/runtime/instructions";
import { codeModeInstructions } from "@loom/connector-chatgpt";
import { decodeWorkerRequest } from "../core/src/worker.ts";
import type { McpServerHandle } from "@loom/core/types";

const config = (s: string) => normalizeConfig(parse(s));
const http = `[session]
remote-tools = ["research"]
[remote-tools.research]
url = "https://mcp.example.com/mcp"
bearer_token_env = "SEARCH_CREDENTIAL"
default_for = ["web_search", "web_fetch"]`;

test("named tool definitions resolve selected transports and credential references", () => {
  const cfg = config(
    http.replace("[session]", '[session]\nlocal-tools = ["code"]') +
      `
[local-tools.code]
command = "/path with spaces/tool"
args = ["--mcp", "literal $HOME"]
default_for = ["read", "write", "edit"]`,
  );
  assert.deepEqual(cfg.httpMcp, [
    {
      name: "research",
      required: true,
      url: "https://mcp.example.com/mcp",
      bearerTokenEnv: "SEARCH_CREDENTIAL",
      defaultFor: ["web_search", "web_fetch"],
    },
  ]);
  assert.deepEqual(cfg.mcp, [
    {
      name: "code",
      required: true,
      command: "/path with spaces/tool",
      args: ["--mcp", "literal $HOME"],
      defaultFor: ["read", "write", "edit"],
    },
  ]);
  assert.ok(lintConfig(cfg, {}).some((s) => s.includes("SEARCH_CREDENTIAL")));
  assert.ok(
    !lintConfig(cfg, { SEARCH_CREDENTIAL: "secret" }).some((s) => s.includes("SEARCH_CREDENTIAL")),
  );
  assert.deepEqual(config("").mcp, []);
  assert.deepEqual(config("").httpMcp, []);
  const inline = config(http + '\nbearer_token = "inline-secret"');
  assert.equal(inline.httpMcp[0]?.bearerToken, "inline-secret");
  assert.ok(!lintConfig(inline, {}).some((s) => s.includes("SEARCH_CREDENTIAL")));
});

test("catalogs reject old syntax and malformed definitions even when unselected", () => {
  for (const text of [
    '[[mcp]]\nname = "old"\ncommand = "old"',
    "command-mcp = []",
    "http-mcp = []",
    '[search]\nbackend = "kagi"',
    http.replace('["web_search", "web_fetch"]', '["invented"]'),
    http.replace('bearer_token_env = "SEARCH_CREDENTIAL"', "bearer_token_env = 42"),
    http.replace("default_for =", "override ="),
    http.replace("https://mcp.example.com/mcp", "file:///tmp/key"),
    http.replace("https://mcp.example.com/mcp", "https://user:password@example.com/mcp"),
    '[local-tools.loom]\ncommand = "tool"',
    '[local-tools.broken]\ncommand = "tool"\nargs = [1]',
    '[local-tools.broken]\nruntime = "tilth"',
    '[vm-tools.broken]\nruntime = "tilth"\ncommand = "host"',
    '[session]\nexecution = "vm"',
    '[session]\nlocal-tools = ["missing"]',
    "local-tools = []",
  ])
    assert.throws(() => config(text), text);
});

test("capability preferences retain advertised schemas, fallbacks and connector-neutral names", () => {
  const mounts: McpServerHandle[] = [
    {
      name: "research",
      defaultFor: ["web_search"],
      spec: { transport: "http", url: "http://127.0.0.1:43210/mcp" },
    },
  ];
  const preference = mcpToolPreferences(mounts);
  assert.match(preference, /web_search.*research/);
  assert.match(preference, /actual tool names and argument schemas/);
  assert.match(preference, /fallbacks/);
  assert.match(preference, /permission policy/);
  assert.equal(mcpToolPreferences([]), "");
  const steer = toolSteer("/workspace", { askUser: true, commit: true, status: true });
  assert.doesNotMatch(steer, /Use tilth|Use fff/);
  assert.match(
    codeModeInstructions("/workspace", true, true, null, preference),
    /web_search.*research/,
  );
  const req = {
    kind: "request",
    id: 1,
    method: "create",
    args: [{ sessionId: "s", cwd: "/workspace", prompt: "", mode: "default", mcpServers: mounts }],
  };
  assert.deepEqual(decodeWorkerRequest(req), req);
  assert.throws(() =>
    decodeWorkerRequest({
      ...req,
      args: [{ ...req.args[0], mcpServers: [{ ...mounts[0], defaultFor: 42 }] }],
    }),
  );
});
