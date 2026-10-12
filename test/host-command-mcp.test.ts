import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostCommandCwd,
  startHostCommandMcp,
} from "../backend/daemon/src/daemon/host-command-mcp.ts";
import type { ManagedMcp } from "../backend/daemon/src/daemon/mcp-worker.ts";
import { sessionCloneRoot } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { withExternalMcp } from "../backend/daemon/src/daemon/mcp-provider.ts";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { makeLogger } from "@loom/core/logger";
import type { CreateSessionOptions, McpServerHandle } from "@loom/core/types";

const FIXTURE = fileURLToPath(new URL("./fixtures/host-command-mcp.ts", import.meta.url));
const OWNER = fileURLToPath(new URL("./fixtures/host-command-owner.ts", import.meta.url));

interface Whoami {
  readonly pid: number;
  readonly grandchild: number;
  readonly cwd: string;
  readonly marker: string | null;
}

const mkFixtureSpec = (env: Record<string, string>) => ({
  transport: "stdio" as const,
  command: Deno.execPath(),
  args: ["run", "--quiet", "-A", FIXTURE],
  env,
});

const callTool = async (worker: ManagedMcp, name: string): Promise<string> => {
  if (worker.handle.spec.transport !== "http") throw new Error("expected an HTTP endpoint");
  const response = await fetch(worker.handle.spec.url, {
    method: "POST",
    headers: { ...worker.handle.spec.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name } }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { id: number; result: { content: [{ text: string }] } };
  assert.equal(body.id, 7);
  return body.result.content[0].text;
};

/** Gone, or a zombie nobody has reaped yet: either way, nothing left running. */
const isGone = (pid: number): boolean => {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state === "Z" || state === "X";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && Deno.build.os === "linux") return true;
  }
  try {
    // Signal 0 only checks; Deno's signal type does not list it.
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return false;
  } catch {
    return true;
  }
};

const stillRunning = async (pids: number[], within_ms: number): Promise<number[]> => {
  const deadline = Date.now() + within_ms;
  for (;;) {
    const running = pids.filter((pid) => !isGone(pid));
    if (running.length === 0 || Date.now() > deadline) return running;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("hostCommandCwd: a worktree on the host is where the command starts", async () => {
  // given
  const worktree = await Deno.makeTempDir();
  try {
    // when
    const cwd = await hostCommandCwd(worktree, "/repo");
    // then
    assert.equal(cwd, worktree);
  } finally {
    await Deno.remove(worktree);
  }
});
test("hostCommandCwd: a private clone or a missing worktree falls back to home", async () => {
  // given: a clone is matched by its path alone, so none is made
  const repo = await Deno.makeTempDir();
  const clone = join(sessionCloneRoot(repo), "session/workspace/checkout");
  try {
    // when / then
    assert.equal(await hostCommandCwd(clone, repo), homedir());
    assert.equal(await hostCommandCwd(join(repo, "gone"), repo), homedir());
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

test("startHostCommandMcp: one process per start, serving tools until close ends its group", async () => {
  // given
  const cwd = await Deno.makeTempDir();
  const spec = mkFixtureSpec({ LOOM_TEST_MARKER: "relayed", LOOM_TEST_BIG_BYTES: "2097152" });
  try {
    // when
    const first = await startHostCommandMcp("fixture", spec, cwd);
    const second = await startHostCommandMcp("fixture", spec, cwd);
    try {
      const a = JSON.parse(await callTool(first, "whoami")) as Whoami;
      const b = JSON.parse(await callTool(second, "whoami")) as Whoami;
      // then
      assert.notEqual(a.pid, b.pid);
      assert.equal(a.cwd, await Deno.realPath(cwd));
      assert.equal(a.marker, "relayed");
      // A response over the worker protocol's 1 MiB frame, as a browser screenshot is.
      assert.equal((await callTool(first, "big")).length, 2_097_152);
      await first.close();
      assert.deepEqual(await stillRunning([first.pid, a.pid, a.grandchild], 10_000), []);
      assert.ok(!isGone(b.pid), "closing one session's server leaves another's running");
    } finally {
      await first.close();
      await second.close();
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

test("startHostCommandMcp: a command that ignores EOF and SIGTERM is killed after the grace", async () => {
  // given
  const worker = await startHostCommandMcp(
    "fixture",
    mkFixtureSpec({ LOOM_TEST_STUBBORN: "1" }),
    Deno.cwd(),
  );
  const who = JSON.parse(await callTool(worker, "whoami")) as Whoami;
  // when
  await worker.close();
  // then
  assert.deepEqual(await stillRunning([worker.pid, who.pid, who.grandchild], 10_000), []);
});

test("startHostCommandMcp: a command that fails names itself and its stderr", async () => {
  // given
  const spec = {
    transport: "stdio" as const,
    command: Deno.execPath(),
    args: ["eval", "console.error('no browser at /nowhere'); Deno.exit(3)"],
  };
  // when / then
  await assert.rejects(
    startHostCommandMcp("browser", spec, Deno.cwd()),
    /MCP server browser: host command .* failed to start for the VM session: (.|\n)*no browser at \/nowhere/,
  );
  await assert.rejects(
    startHostCommandMcp(
      "missing",
      { transport: "stdio", command: "loom-test-no-such-command" },
      Deno.cwd(),
    ),
    /MCP server missing: host command loom-test-no-such-command failed to start/,
  );
});

test("startHostCommandMcp: a daemon that dies leaves no orphan behind", async () => {
  // given: the command ignores SIGTERM, so only the group's SIGKILL ends it
  const owner = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "-A", OWNER],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = owner.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    line += value;
  }
  const reported = JSON.parse(line) as Whoami & { worker: number };
  assert.ok(!isGone(reported.pid) && !isGone(reported.grandchild));
  // when
  owner.kill("SIGKILL");
  await owner.status;
  await reader.cancel();
  // then
  assert.deepEqual(
    await stillRunning([reported.worker, reported.pid, reported.grandchild], 10_000),
    [],
  );
});

test("withExternalMcp: closing a VM session ends its host command", async () => {
  // given
  const seen: CreateSessionOptions[] = [];
  const workers: ManagedMcp[] = [];
  const fake = new FakeProvider();
  const provider = await withExternalMcp(
    async () => ({
      id: fake.id,
      capabilities: fake.capabilities,
      createSession: (options) => {
        seen.push(options);
        return fake.createSession(options);
      },
      resumeSession: (ref) => fake.resumeSession(ref),
      listPersistedSessions: () => fake.listPersistedSessions(),
    }),
    {
      id: "claude",
      logger: makeLogger("test"),
      config: { sessionVm: { repoRoot: "/repo", artifact: "/runtime", smolvm: "smolvm" } },
    },
    undefined,
    undefined,
    "/repo",
    [],
    async (...args: Parameters<typeof startHostCommandMcp>) => {
      const worker = await startHostCommandMcp(...args);
      workers.push(worker);
      return worker;
    },
  );
  const relayed: McpServerHandle = {
    name: "fixture",
    spec: {
      transport: "stdio",
      command: Deno.execPath(),
      args: ["run", "--quiet", "-A", FIXTURE],
      vmSessions: "relay",
    },
  };
  const session = await provider.createSession({
    sessionId: "lifecycle",
    cwd: Deno.cwd(),
    prompt: "",
    mode: "default",
    mcpServers: [relayed],
  });
  const endpoint = seen[0]?.mcpServers?.[0]?.spec;
  if (endpoint?.transport !== "http") throw new Error("expected a relayed endpoint");
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...endpoint.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami" },
    }),
  });
  const { result } = (await response.json()) as { result: { content: [{ text: string }] } };
  const { pid } = JSON.parse(result.content[0].text) as { pid: number };
  // when
  await session.close();
  // then
  assert.deepEqual(await stillRunning([workers[0]!.pid, pid], 10_000), []);
  await assert.rejects(fetch(endpoint.url));
});
