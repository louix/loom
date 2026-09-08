/** Live spike: valid -> invalid -> valid access token through a read-only VM mount. */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitFixture } from "./lib/git-bridge-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { sessionVmName, vmEnvironment } from "../runtime/src/packaged/vm.ts";
const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass the Claude artifact and smolvm executable");
const source = JSON.parse(
  await Deno.readTextFile(
    join(Deno.env.get("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude"), ".credentials.json"),
  ),
).claudeAiOauth;
assert(
  typeof source?.accessToken === "string" && source.expiresAt > Date.now(),
  "Need a valid host access token",
);
const f = await gitFixture();
let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
let session: RemoteWorkerSession | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  worker = await launchSessionVm({ artifact, smolvm, workspace: f.workspace, auth: {} });
  const { state } = worker.binding;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await worker.status()).phase === "running") break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (Date.now() > deadline) throw new Error("VM did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const paths = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
  const deno = paths.find((path) => /-deno-[0-9]/.test(path)) + "/bin/deno";
  const guest = async (code: string) => {
    const result = await new Deno.Command(smolvm, {
      args: ["machine", "exec", "--name", sessionVmName, "--", deno, "eval", code],
      clearEnv: true,
      env: vmEnvironment(state),
      stdout: "piped",
      stderr: "null",
    }).output();
    assert(result.success, "Guest probe failed");
    return new TextDecoder().decode(result.stdout).trim();
  };
  let generation = 0;
  const write = async (token: string) => {
    generation++;
    await Deno.writeTextFile(
      join(state, "private/access.tmp"),
      JSON.stringify({
        loomAuthGeneration: generation,
        claudeAiOauth: { accessToken: token, expiresAt: source.expiresAt, scopes: source.scopes },
      }),
      { mode: 0o600 },
    );
    await Deno.rename(join(state, "private/access.tmp"), join(state, "private/access.json"));
  };
  await write(source.accessToken);
  const direct = Deno.args[2] !== "sync";
  const sync = `
    await Deno.mkdir("/tmp/loom-home/.claude", {recursive:true});
    let previous = "";
    for (;;) {
      const next = await Deno.readTextFile("/run/loom/private/access.json");
      if (next !== previous) {
        JSON.parse(next);
        await Deno.writeTextFile("/tmp/loom-home/.claude/credentials.tmp", next, {mode:0o600});
        await Deno.rename("/tmp/loom-home/.claude/credentials.tmp", "/tmp/loom-home/.claude/.credentials.json");
        previous = next;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  `;
  if (direct)
    await guest(
      `await Deno.mkdir("/tmp/loom-home/.claude", {recursive:true}); await Deno.symlink("/run/loom/private/access.json", "/tmp/loom-home/.claude/.credentials.json");`,
    );
  else
    await guest(
      `const child = new Deno.Command(Deno.execPath(), {args:["eval", ${JSON.stringify(sync)}], stdin:"null", stdout:"null", stderr:"null"}).spawn(); console.log(child.pid); Deno.exit(0);`,
    );
  const installed = async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await guest(
        `try {console.log(JSON.parse(await Deno.readTextFile("/tmp/loom-home/.claude/.credentials.json")).loomAuthGeneration);} catch {console.log(0);}`,
      );
      if (value === String(generation)) break;
      if (Date.now() > deadline) throw new Error("Guest did not observe new credential generation");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Allow credential caches/watchers to settle after the new generation is visible.
    // This is an observed spike delay, not a production delivery guarantee.
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  await installed();
  ({ session } = await RemoteWorkerSession.connect(
    "auth-vm-spike",
    "claude",
    mockLaunchSpec(f.workspace),
    () => worker!,
    30_000,
    {
      connector: "@loom/connector-claude",
      config: { cliPath: "", configDir: "/tmp/loom-home/.claude" },
    },
  ));
  timer = setTimeout(() => {
    void session?.close();
  }, 120_000);
  const events = session.events()[Symbol.asyncIterator]();
  const result = async () => {
    let text = "",
      failure = false;
    for (;;) {
      const { value: event, done } = await events.next();
      assert(!done, "Worker ended before a turn result");
      if (event.type === "error") failure = true;
      if (event.type === "assistant_text") text += event.text;
      if (event.type === "result")
        return { kind: event.kind, answer: text.includes("AUTH_OK"), failure };
    }
  };
  const prompt = "Reply with exactly AUTH_OK. Do not use any tools.";
  await session.start({
    method: "create",
    args: [
      {
        sessionId: session.id,
        cwd: f.workspace,
        mode: "default",
        mcpServers: [],
        model: "haiku",
        settingSources: [],
        prompt,
      },
    ],
  });
  const first = await result();
  console.log(JSON.stringify({ turn: 1, ...first }));
  assert(first.answer && first.kind === "ok");
  const pidCode = `const pids=[]; for await(const e of Deno.readDir("/proc")){if(!/^\\d+$/.test(e.name))continue; try{if((await Deno.readLink("/proc/"+e.name+"/exe")).includes("-claude-code-"))pids.push(Number(e.name));}catch{}} console.log(JSON.stringify(pids.sort()));`;
  const before = await guest(pidCode);
  assert.notEqual(before, "[]", "No native Claude process found");
  await write("sk-ant-oat01-loom-auth-spike-invalid");
  await installed();
  await session.send(prompt);
  const second = await result();
  console.log(JSON.stringify({ turn: 2, ...second }));
  assert(!second.answer, "CLI continued using cached valid credentials after replacement");
  await write(source.accessToken);
  await installed();
  await session.send(prompt);
  const third = await result();
  console.log(JSON.stringify({ turn: 3, ...third }));
  assert(third.answer && third.kind === "ok");
  assert.equal(await guest(pidCode), before, "Claude restarted rather than reloading credentials");
  console.log(
    JSON.stringify({
      passed: true,
      guestLocalSync: !direct,
      sameClaudeProcess: true,
      refreshTokenCopied: false,
      credentialMountReadOnly: true,
    }),
  );
} finally {
  clearTimeout(timer);
  try {
    await session?.close();
  } finally {
    worker?.terminate();
    await worker?.cleanup?.();
    await f.close();
  }
}
