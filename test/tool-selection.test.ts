import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { normalizeConfig, loadConfig, lintConfig } from "@loom/daemon/config/config";
import { preflightTools, toolExecutionError } from "../backend/daemon/src/daemon/tool-preflight.ts";
import { withExternalMcp } from "../backend/daemon/src/daemon/mcp-provider.ts";
import { makeLogger } from "@loom/core/logger";

const definitions = `
[tools.tilth]
command = "missing-host-tool"
default_for = ["read"]
[vm-tools.tilth]
runtime = "tilth"
default_for = ["read"]
[remote-tools.docs]
url = "https://docs.example/mcp"
bearer_token_env = "LOOM_TEST_UNSET_TOOL_CREDENTIAL"
`;

test("definitions are inert until selected; same name in different catalogs is allowed", async () => {
  const config = normalizeConfig(parse(definitions));
  assert.deepEqual(config.mcp, []);
  assert.deepEqual(config.httpMcp, []);
  assert.ok(
    !lintConfig(config, {}).some((line) => line.includes("LOOM_TEST_UNSET_TOOL_CREDENTIAL")),
  );
  await preflightTools(config, "claude", {
    onPath: () => {
      throw new Error("unselected host tool checked");
    },
    resolveRuntime: () => {
      throw new Error("unselected runtime checked");
    },
  });
});

test("repo lists replace independently while definitions and other selections inherit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/config.toml`;
    await Deno.writeTextFile(
      file,
      definitions +
        `
[session]
tools = ["tilth"]
remote-tools = ["docs"]
[[repo]]
path = ${JSON.stringify(dir)}
[repo.session]
tools = []
vm-tools = ["tilth"]
`,
    );
    const local = loadConfig(dir, file);
    assert.deepEqual(
      local.mcp.map((m) => ("runtime" in m ? m.runtime : m.command)),
      ["tilth"],
    );
    assert.deepEqual(
      local.httpMcp.map((m) => m.name),
      ["docs"],
    );
    const other = loadConfig(`${dir}/elsewhere`, file);
    assert.deepEqual(
      other.mcp.map((m) => ("command" in m ? m.command : m.runtime)),
      ["missing-host-tool"],
    );
    assert.deepEqual(
      other.httpMcp.map((m) => m.name),
      ["docs"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("selections reject duplicates, ambiguous preferences and unknown names", () => {
  for (const selection of [
    'tools = ["tilth", "tilth"]',
    'tools = ["tilth"]\nvm-tools = ["tilth"]',
    'vm-tools = ["absent"]',
    'remote-tools = "docs"',
  ])
    assert.throws(() => normalizeConfig(parse(definitions + `\n[session]\n${selection}`)));
  assert.throws(
    () =>
      normalizeConfig(
        parse(`
[tools.a]
command = "a"
default_for = ["read"]
[tools.b]
command = "b"
default_for = ["read"]
[session]
tools = ["a", "b"]
`),
      ),
    /Multiple tool defaults/,
  );
});

test("host selection fails before runtime lookup for every VM engine, but works with host agents", async () => {
  const config = normalizeConfig(
    parse(
      definitions +
        `
[session]
tools = ["tilth"]
[isolation.claude]
artifact = "/claude"
[isolation.codex]
artifact = "/codex"
[isolation.aisdk]
artifact = "/aisdk"
[chatgpt]
model = "test"
[custom-provider.local]
base_url = "https://api.example/v1"
model = "test"
`,
    ),
  );
  for (const provider of ["claude", "claude:work", "chatgpt", "local"])
    await assert.rejects(
      preflightTools(config, provider, {
        onPath: () => {
          throw new Error("should reject placement first");
        },
        resolveRuntime: () => {
          throw new Error("should reject placement first");
        },
      }),
      /host tools are selected/,
    );
  const host = { ...config, isolation: { extraAllowedHosts: [] } };
  assert.equal(toolExecutionError(host, "claude"), undefined);
  await assert.rejects(
    preflightTools(host, "claude", {
      onPath: () => false,
      resolveRuntime: () => {
        throw new Error("unexpected runtime");
      },
    }),
    /Required host tool tilth/,
  );
});

test("selected runtime errors propagate, and required remote credentials are checked", async () => {
  const vm = normalizeConfig(parse(definitions + '\n[session]\nvm-tools = ["tilth"]'));
  await assert.rejects(
    preflightTools(vm, "claude", {
      onPath: () => true,
      resolveRuntime: () => {
        throw new Error("runtime unavailable");
      },
    }),
    /runtime unavailable/,
  );
  const remote = normalizeConfig(parse(definitions + '\n[session]\nremote-tools = ["docs"]'));
  const old = Deno.env.get("LOOM_TEST_UNSET_TOOL_CREDENTIAL");
  Deno.env.delete("LOOM_TEST_UNSET_TOOL_CREDENTIAL");
  try {
    await assert.rejects(preflightTools(remote, "claude"), /LOOM_TEST_UNSET_TOOL_CREDENTIAL/);
  } finally {
    if (old !== undefined) Deno.env.set("LOOM_TEST_UNSET_TOOL_CREDENTIAL", old);
  }
});

test("VM tool placement validation precedes all MCP worker launches", async () => {
  let launches = 0;
  const provider = await withExternalMcp(
    async () => ({}) as never,
    {
      id: "test",
      logger: makeLogger("test"),
      config: { sessionVm: { repoRoot: "/repo", artifact: "/runtime", smolvm: "smolvm" } },
    },
    () => {
      launches++;
      throw new Error("must not launch");
    },
  );
  await assert.rejects(
    provider.createSession({
      sessionId: "test",
      cwd: "/repo",
      prompt: "",
      mode: "default",
      mcpServers: [
        { name: "docs", spec: { transport: "http", url: "https://docs.example/mcp" } },
        { name: "host", spec: { transport: "stdio", command: "tool" } },
      ],
    }),
    /Host tool host cannot/,
  );
  assert.equal(launches, 0);
});
