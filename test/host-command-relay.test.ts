// test-run: own-process — sets and clears a variable that tool preflight reads from Deno.env.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConfig } from "@loom/daemon/config/config";
import { preflightTools, toolExecutionError } from "../backend/daemon/src/daemon/tool-preflight.ts";
import { withExternalMcp } from "../backend/daemon/src/daemon/mcp-provider.ts";
import type { ManagedMcp } from "../backend/daemon/src/daemon/mcp-worker.ts";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { makeLogger } from "@loom/core/logger";
import type { ConnectorContext } from "@loom/core/connector";
import type { AgentProvider, CreateSessionOptions, McpServerHandle } from "@loom/core/types";

const vmContext: ConnectorContext = {
  id: "claude",
  logger: makeLogger("test"),
  config: { sessionVm: { repoRoot: "/repo", artifact: "/runtime", smolvm: "smolvm" } },
};
const hostContext: ConnectorContext = { id: "claude", logger: makeLogger("test"), config: {} };

const browser: McpServerHandle = {
  name: "browser",
  spec: { transport: "stdio", command: "npx", args: ["browser-mcp"], vmSessions: "relay" },
};
const files: McpServerHandle = { name: "files", spec: { transport: "stdio", command: "fff-mcp" } };

const mkSession = (sessionId: string, mcpServers: McpServerHandle[]): CreateSessionOptions => ({
  sessionId,
  cwd: "/nowhere/worktree",
  prompt: "",
  mode: "default",
  mcpServers,
});

/** A FakeProvider that records what each created session was given. */
const mkRecordingProvider = (seen: CreateSessionOptions[]): AgentProvider => {
  const fake = new FakeProvider();
  return {
    id: fake.id,
    capabilities: fake.capabilities,
    createSession: (options) => {
      seen.push(options);
      return fake.createSession(options);
    },
    resumeSession: (ref) => fake.resumeSession(ref),
    listPersistedSessions: () => fake.listPersistedSessions(),
  };
};

/** A started relay that only records its start and close. */
const mkFakeRelay = (port: number, closed: string[]): ManagedMcp => ({
  handle: {
    name: "browser",
    spec: {
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: "Bearer relay" },
    },
  },
  pid: port,
  exited: new Promise(() => {}),
  close: async () => {
    closed.push(String(port));
  },
});

test("vm_sessions is an opt-in of command sources only", () => {
  // given
  const definitions = {
    browser: { source: { kind: "command", command: "npx" }, vm_sessions: "relay" },
    refused: { source: { kind: "command", command: "fff-mcp" }, vm_sessions: "refuse" },
    plain: { source: { kind: "command", command: "fff-mcp" } },
  };
  // when
  const config = normalizeConfig({
    mcp_servers: definitions,
    session: { mcp_servers: ["browser", "refused", "plain"] },
  });
  // then
  assert.deepEqual(
    config.mcp.map((m) => ("command" in m ? (m.vmSessions ?? "absent") : "runtime")),
    ["relay", "absent", "absent"],
  );
  for (const source of [
    { kind: "nix", ref: "path:/tools", executable: "tool" },
    { kind: "runtime", ref: "tilth" },
    { kind: "http", url: "https://docs.example/mcp" },
  ])
    assert.throws(
      () => normalizeConfig({ mcp_servers: { bad: { source, vm_sessions: "relay" } } }),
      new RegExp(`vm_sessions applies only to command sources; a ${source.kind} source`),
    );
  assert.throws(() =>
    normalizeConfig({
      mcp_servers: { bad: { source: { kind: "command", command: "x" }, vm_sessions: true } },
    }),
  );
});

test("a VM agent may select a relayed host command, which preflight still checks", async () => {
  // given
  const config = normalizeConfig({
    mcp_servers: {
      browser: {
        source: { kind: "command", command: "npx", pass_env: ["LOOM_TEST_RELAY_KEY"] },
        vm_sessions: "relay",
      },
      files: { source: { kind: "command", command: "fff-mcp" } },
    },
    session: {
      mcp_servers: ["browser"],
      defaults: { isolation: "vm" },
      isolation: { runtimes: { claude: { artifact: "/claude" } } },
    },
  });
  const both = normalizeConfig({
    mcp_servers: {
      browser: { source: { kind: "command", command: "npx" }, vm_sessions: "relay" },
      files: { source: { kind: "command", command: "fff-mcp" } },
    },
    session: { mcp_servers: ["browser", "files"], defaults: { isolation: "vm" } },
  });
  const dependencies = (onPath: boolean) => ({
    onPath: () => onPath,
    resolveRuntime: () => {
      throw new Error("unexpected runtime");
    },
  });
  // when / then
  assert.equal(toolExecutionError(config, "claude"), undefined);
  assert.match(
    toolExecutionError(both, "claude") ?? "",
    /host commands are selected: files\. .*set vm_sessions: "relay"/,
  );
  await assert.rejects(
    preflightTools(config, "claude", dependencies(false)),
    /MCP server browser: host command npx is unavailable/,
  );
  await assert.rejects(
    preflightTools(config, "claude", dependencies(true)),
    /MCP server browser: LOOM_TEST_RELAY_KEY is not set/,
  );
  Deno.env.set("LOOM_TEST_RELAY_KEY", "set");
  try {
    await preflightTools(config, "claude", dependencies(true));
  } finally {
    Deno.env.delete("LOOM_TEST_RELAY_KEY");
  }
});

test("withExternalMcp: a VM session gets its own relayed endpoint, and refuses an unrelayed command", async () => {
  // given
  const seen: CreateSessionOptions[] = [];
  const started: Array<{
    name: string;
    cwd: string | undefined;
    requestTimeoutMs: number | undefined;
  }> = [];
  const closed: string[] = [];
  const provider = await withExternalMcp(
    async () => mkRecordingProvider(seen),
    vmContext,
    undefined,
    undefined,
    "/repo",
    () => [],
    async (name, spec) => {
      started.push({ name, cwd: spec.cwd, requestTimeoutMs: spec.requestTimeoutMs });
      return mkFakeRelay(4100 + started.length, closed);
    },
  );
  // when
  const first = await provider.createSession(mkSession("first", [browser]));
  const second = await provider.createSession(
    mkSession("second", [
      {
        name: "browser",
        requestTimeoutMs: 120_000,
        spec: { transport: "stdio", command: "npx", cwd: "/srv/tools", vmSessions: "relay" },
      },
    ]),
  );
  // then: the agent sees the loopback endpoint the VM relays, one per session
  assert.deepEqual(
    seen.map((options) => options.mcpServers?.map((h) => h.spec)),
    [
      [
        {
          transport: "http",
          url: "http://127.0.0.1:4101/mcp",
          headers: { Authorization: "Bearer relay" },
        },
      ],
      [
        {
          transport: "http",
          url: "http://127.0.0.1:4102/mcp",
          headers: { Authorization: "Bearer relay" },
        },
      ],
    ],
  );
  // The session's worktree never reaches the command; a configured cwd does.
  assert.deepEqual(
    started.map((s) => [s.name, s.cwd]),
    [
      ["browser", undefined],
      ["browser", "/srv/tools"],
    ],
  );
  // timeout_seconds reaches the session's bridge; unset, the bridge keeps its default.
  assert.deepEqual(
    started.map((s) => s.requestTimeoutMs),
    [undefined, 120_000],
  );
  await first.close();
  assert.deepEqual(closed, ["4101"]);
  await second.close();
  assert.deepEqual(closed, ["4101", "4102"]);
  await assert.rejects(
    provider.createSession(mkSession("refused", [browser, files])),
    /Host command files cannot be used by a VM agent; set vm_sessions: "relay"/,
  );
  assert.equal(started.length, 2, "nothing starts for a refused selection");
});

test("withExternalMcp: a host session runs a relayed command itself, unrelayed", async () => {
  // given
  const seen: CreateSessionOptions[] = [];
  const provider = await withExternalMcp(
    async () => mkRecordingProvider(seen),
    hostContext,
    undefined,
    undefined,
    "/repo",
    () => [],
    async () => {
      throw new Error("must not relay for a host session");
    },
  );
  // when
  const session = await provider.createSession(mkSession("host", [browser, files]));
  await session.close();
  // then
  assert.deepEqual(seen[0]?.mcpServers, [browser, files]);
});
