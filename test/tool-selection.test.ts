import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig as parse } from "@loom/daemon/config/config";
import { normalizeConfig, loadConfig, lintConfig } from "@loom/daemon/config/config";
import { preflightTools, toolExecutionError } from "../backend/daemon/src/daemon/tool-preflight.ts";
import { withExternalMcp } from "../backend/daemon/src/daemon/mcp-provider.ts";
import { makeLogger } from "@loom/core/logger";
import { homedir } from "node:os";

const combine = (base: string, extra: string) =>
  JSON.stringify({ ...parse(base), ...parse(extra) });

const definitions = `{
  "mcp_servers": {
    "tilth-host": {
      "source": { "kind": "command", "command": "missing-host-tool" },
      "default_for": ["read"]
    },
    "tilth": {
      "source": { "kind": "runtime", "ref": "tilth" },
      "default_for": ["read"]
    },
    "docs": {
      "source": { "kind": "http", "url": "https://docs.example/mcp" },
      "auth": { "bearer_token_env": "LOOM_TEST_UNSET_TOOL_CREDENTIAL" }
    }
  }
}`;

test("definitions are inert until selected", async () => {
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

test("a repo's session.mcp_servers replaces the global list while definitions inherit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/config.jsonc`;
    await Deno.writeTextFile(
      file,
      combine(
        definitions,
        JSON.stringify({
          repos: [{ path: dir, session: { mcp_servers: ["tilth"] } }],
          session: { mcp_servers: ["tilth-host", "docs"] },
        }),
      ),
    );
    const local = loadConfig(dir, file);
    assert.deepEqual(
      local.mcp.map((m) => ("runtime" in m ? m.runtime : m.command)),
      ["tilth"],
    );
    assert.deepEqual(local.httpMcp, []);
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

test("selections reject duplicates, competing preferences and unknown names", () => {
  for (const selection of [["tilth", "tilth"], ["tilth", "tilth-host"], ["absent"], "docs"])
    assert.throws(() =>
      normalizeConfig({ ...parse(definitions), session: { mcp_servers: selection } }),
    );
  assert.throws(
    () => normalizeConfig({ ...parse(definitions), session: { mcp_servers: ["absent"] } }),
    /Unknown MCP server absent selected by session\.mcp_servers/,
  );
  assert.throws(
    () =>
      normalizeConfig({ ...parse(definitions), session: { mcp_servers: ["tilth", "tilth-host"] } }),
    /Multiple tool defaults for read/,
  );
});

test("a command source runs on the host with its env and working directory", () => {
  const config = normalizeConfig({
    mcp_servers: {
      files: {
        source: {
          kind: "command",
          command: "files-mcp",
          args: ["--stdio"],
          env: { FILES_MODE: "strict" },
          cwd: "~/tools",
        },
      },
      plain: { source: { kind: "command", command: "plain-mcp" } },
    },
    session: { mcp_servers: ["files", "plain"] },
  });
  assert.deepEqual(config.mcp, [
    {
      name: "files",
      required: true,
      defaultFor: [],
      command: "files-mcp",
      args: ["--stdio"],
      env: { FILES_MODE: "strict" },
      cwd: `${homedir()}/tools`,
    },
    { name: "plain", required: true, defaultFor: [], command: "plain-mcp", args: [] },
  ]);
  for (const source of [
    { kind: "command", command: "" },
    { kind: "command", command: "x", cwd: "relative/dir" },
    { kind: "command", command: "x", env: { "NOT-A-NAME": "1" } },
    { kind: "command", command: "x", runtime: "tilth" },
  ])
    assert.throws(() => normalizeConfig({ mcp_servers: { bad: { source } } }));
  assert.throws(
    () =>
      normalizeConfig({
        mcp_servers: {
          bad: { source: { kind: "command", command: "x" }, grants: { workspace: "read-only" } },
        },
      }),
    /host command runs unconfined/,
  );
});

test("host selection fails before runtime lookup for every VM engine, but works with host agents", async () => {
  const config = normalizeConfig({
    ...parse(definitions),
    providers: {
      codex: { model: "test" },
      openai_compatible: {
        profiles: { local: { base_url: "https://api.example/v1", model: "test" } },
      },
    },
    session: {
      mcp_servers: ["tilth-host"],
      defaults: { isolation: "vm" },
      isolation: {
        runtimes: {
          claude: { artifact: "/claude" },
          codex: { artifact: "/codex" },
          aisdk: { artifact: "/aisdk" },
        },
      },
    },
  });
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
      /host commands are selected: tilth-host\. Remove them from session\.mcp_servers/,
    );
  const host = {
    ...config,
    defaults: { ...config.defaults, isolation: "none" as const },
    isolation: { extraAllowedHosts: [] },
  };
  assert.equal(toolExecutionError(host, "claude"), undefined);
  await assert.rejects(
    preflightTools(host, "claude", {
      onPath: () => false,
      resolveRuntime: () => {
        throw new Error("unexpected runtime");
      },
    }),
    /MCP server tilth-host: host command missing-host-tool is unavailable/,
  );
});

test("selected runtime errors propagate, and required remote credentials are checked", async () => {
  const vm = normalizeConfig({ ...parse(definitions), session: { mcp_servers: ["tilth"] } });
  await assert.rejects(
    preflightTools(vm, "claude", {
      onPath: () => true,
      resolveRuntime: () => {
        throw new Error("runtime unavailable");
      },
    }),
    /runtime unavailable/,
  );
  const remote = normalizeConfig({ ...parse(definitions), session: { mcp_servers: ["docs"] } });
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
    /Host command host cannot/,
  );
  assert.equal(launches, 0);
});
