import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { normalizeConfig, lintConfig } from "@loom/daemon/config/config";
import { mcpToolPreferences, toolSteer } from "@loom/runtime/instructions";
import { codeModeInstructions } from "@loom/connector-chatgpt";
import { resolveMcpSpec } from "../backend/daemon/src/daemon/mcp-fallback.ts";
import { decodeWorkerRequest } from "../core/src/worker.ts";
import type { McpServerHandle } from "@loom/core/types";

const config = (s: string) => normalizeConfig(parse(s));
const http = `[[http-mcp]]
name = "research"
url = "https://mcp.example.com/mcp"
bearer_token_env = "SEARCH_CREDENTIAL"
default_for = ["web_search", "web_fetch"]`;

test("MCP transport tables parse preferences and credentials without provider-specific behavior", () => {
  const cfg = config(
    http +
      `\n[[command-mcp]]
name = "code"
command = "/path with spaces/tool"
args = ["--mcp", "literal $HOME"]
default_for = ["read", "write", "edit"]`,
  );
  assert.deepEqual(cfg.httpMcp, [
    {
      name: "research",
      url: "https://mcp.example.com/mcp",
      bearerTokenEnv: "SEARCH_CREDENTIAL",
      defaultFor: ["web_search", "web_fetch"],
    },
  ]);
  assert.deepEqual(resolveMcpSpec(cfg.mcp[0]!), {
    command: "/path with spaces/tool",
    args: ["--mcp", "literal $HOME"],
  });
  assert.ok(lintConfig(cfg, {}).some((s) => s.includes("SEARCH_CREDENTIAL")));
  assert.ok(
    !lintConfig(cfg, { SEARCH_CREDENTIAL: "secret" }).some((s) => s.includes("SEARCH_CREDENTIAL")),
  );
  assert.deepEqual(config("command-mcp = []\nhttp-mcp = []").mcp, []);
  assert.deepEqual(config("").httpMcp, []);
});

test("MCP configuration rejects obsolete syntax, ambiguous defaults, duplicate names and malformed entries", () => {
  for (const text of [
    '[[mcp]]\nname = "old"\ncommand = "old"',
    '[search]\nbackend = "kagi"',
    http + '\n[[http-mcp]]\nname = "research"\nurl = "https://other.example/mcp"',
    http +
      '\n[[http-mcp]]\nname = "other"\nurl = "https://other.example/mcp"\ndefault_for = ["web_search"]',
    http.replace('["web_search", "web_fetch"]', '["invented"]'),
    http.replace('bearer_token_env = "SEARCH_CREDENTIAL"', "bearer_token_env = 42"),
    http.replace("default_for =", "override ="),
    http.replace("https://mcp.example.com/mcp", "file:///tmp/key"),
    http.replace("https://mcp.example.com/mcp", "https://user:password@example.com/mcp"),
    http.replace('name = "research"', 'name = "loom"'),
    '[[command-mcp]]\nname = "broken"\ncommand = "tool"\nargs = [1]',
  ])
    assert.throws(() => config(text));
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
