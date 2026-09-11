/** Live acceptance: real refresh, two VM subscribers, uninterrupted Claude session. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { ClaudeAuthOwner } from "../backend/daemon/src/daemon/claude-auth.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";
import { gitFixture } from "./lib/git-fixture.ts";
const [artifact, smolvm, cli] = Deno.args;
assert(artifact && smolvm && cli, "Pass the Claude artifact, smolvm and host Claude executables");
const profile = Deno.env.get("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude");
const owner = new ClaudeAuthOwner({
  profile,
  cli,
  report: (code) => console.error(JSON.stringify({ auth: code })),
});
const fixtures: Awaited<ReturnType<typeof gitFixture>>[] = [];
const workers: Awaited<ReturnType<typeof launchSessionVm>>[] = [];
const sessions: RemoteWorkerSession[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  for (let i = 0; i < 2; i++) {
    const f = await gitFixture();
    fixtures.push(f);
    workers.push(
      await launchSessionVm({ artifact, smolvm, workspace: f.workspace, authOwner: owner }),
    );
  }
  for (let i = 0; i < 2; i++) {
    const connected = await RemoteWorkerSession.connect(
      `auth-acceptance-${i}`,
      i ? "mock" : "claude",
      mockLaunchSpec(fixtures[i]!.workspace),
      () => workers[i]!,
      120_000,
      i
        ? { connector: "@loom/connector-mock", config: {} }
        : {
            connector: "@loom/connector-claude",
            config: { cliPath: "", configDir: "/tmp/loom-home/.claude" },
          },
    );
    sessions.push(connected.session);
  }
  const session = sessions[0]!;
  timer = setTimeout(() => {
    for (const worker of workers) worker.terminate();
  }, 120_000);
  const events = session.events()[Symbol.asyncIterator]();
  const answer = async () => {
    let text = "";
    for (;;) {
      const { done, value: event } = await events.next();
      assert(!done);
      if (event.type === "assistant_text") text += event.text;
      if (event.type === "result") {
        assert.equal(event.kind, "ok");
        assert(text.includes("AUTH_OK"));
        return;
      }
    }
  };
  const prompt = "Reply with exactly AUTH_OK. Do not use tools.";
  await session.start({
    method: "create",
    args: [
      {
        sessionId: session.id,
        cwd: fixtures[0]!.workspace,
        mode: "default",
        mcpServers: [],
        model: "haiku",
        settingSources: [],
        prompt,
      },
    ],
  });
  await answer();
  console.log(JSON.stringify({ beforeRefresh: true }));
  const paths = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
  const deno = paths.find((path) => /-deno-[0-9]/.test(path)) + "/bin/deno";
  const guest = async (index: number, code: string) => {
    const result = await new Deno.Command(smolvm, {
      args: ["machine", "exec", "--name", sessionVmName, "--", deno, "eval", code],
      clearEnv: true,
      env: vmEnvironment(workers[index]!.binding.state),
      stdout: "piped",
      stderr: "null",
    }).output();
    assert(result.success, "Guest probe failed");
    return new TextDecoder().decode(result.stdout).trim();
  };
  const pidCode = `const pids=[];for await(const e of Deno.readDir("/proc")){if(!/^\\d+$/.test(e.name))continue;try{if((await Deno.readLink("/proc/"+e.name+"/exe")).includes("-claude-code-"))pids.push(Number(e.name));}catch{}}console.log(JSON.stringify(pids.sort()));`;
  const before = await guest(0, pidCode);
  assert.notEqual(before, "[]");
  const old = await owner.current();
  const fresh = await owner.current(true);
  assert(
    fresh.claudeAiOauth.accessToken !== old.claudeAiOauth.accessToken,
    "Refresh did not replace access token",
  );
  const deadline = Date.now() + 15_000;
  for (let i = 0; i < workers.length; i++)
    for (;;) {
      const file = JSON.parse(
        await Deno.readTextFile(join(workers[i]!.binding.state, "private/auth.json")),
      );
      const metadata = JSON.parse(
        await guest(
          i,
          `const auth=JSON.parse(await Deno.readTextFile("/tmp/loom-home/.claude/.credentials.json"));console.log(JSON.stringify({expiresAt:auth.claudeAiOauth.expiresAt,hasRefreshToken:"refreshToken" in auth.claudeAiOauth}));`,
        ),
      );
      assert(!metadata.hasRefreshToken);
      if (
        file.claudeAiOauth.accessToken === fresh.claudeAiOauth.accessToken &&
        metadata.expiresAt === fresh.claudeAiOauth.expiresAt
      )
        break;
      assert(Date.now() < deadline, "VM did not observe refreshed snapshot");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await session.send(prompt);
  await answer();
  assert.equal(await guest(0, pidCode), before, "Claude restarted during refresh");
  await owner.close();
  await Promise.all(workers.map((worker) => worker.exited));
  console.log(
    JSON.stringify({
      passed: true,
      realRefresh: true,
      ownerShutdownRevokedSessions: true,
      vmSubscribers: workers.length,
      sameClaudeProcess: true,
      refreshTokenInGuest: false,
    }),
  );
} finally {
  clearTimeout(timer);
  const results = await Promise.allSettled(sessions.map((session) => session.close()));
  for (const worker of workers) worker.terminate();
  results.push(...(await Promise.allSettled(workers.map((worker) => worker.cleanup?.()))));
  await owner.close();
  results.push(...(await Promise.allSettled(fixtures.map((f) => f.close()))));
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) {
    Deno.exitCode = 1;
    console.error("Auth acceptance cleanup failed");
  }
}
