/** Opt-in live experiment. Credentials are copied privately and never logged. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { gitFixture } from "./lib/git-fixture.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { vmEnvironment, sessionVmName } from "../runtime/src/packaged/vm.ts";

const artifact = await Deno.realPath(Deno.args[0] ?? "/tmp/loom-claude-session-artifact");
const smolvmPath =
  Deno.args[1] ??
  (Deno.env.get("PATH") ?? "")
    .split(":")
    .filter(Boolean)
    .map((path) => join(path, "smolvm"))
    .find((path) => {
      try {
        return Deno.statSync(path).isFile;
      } catch {
        return false;
      }
    });
assert(smolvmPath, "Run in nix develop, or pass the smolvm executable as the second argument");
const smolvm = await Deno.realPath(smolvmPath);
const f = await gitFixture();
let worker: Awaited<ReturnType<typeof launchSessionVm>> | undefined;
let session: RemoteWorkerSession | undefined;
let passed = false;
try {
  const auth: Record<string, string> = {};
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  const token = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
  if (key) auth.ANTHROPIC_API_KEY = key;
  else if (token) auth.CLAUDE_CODE_OAUTH_TOKEN = token;
  else {
    const profile = Deno.env.get("CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
    const credentials = JSON.parse(await Deno.readTextFile(join(profile, ".credentials.json")));
    assert.equal(
      typeof credentials.claudeAiOauth?.accessToken,
      "string",
      "No Claude credentials available",
    );
    auth.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeAiOauth.accessToken;
  }
  worker = await launchSessionVm({ workspace: f.workspace, artifact, smolvm, auth });
  const { binding } = worker;
  const state = binding.state;
  const command = async (args: string[]) => {
    const output = await new Deno.Command(smolvm, {
      args,
      clearEnv: true,
      env: vmEnvironment(state),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout);
  };
  const connected = await RemoteWorkerSession.connect(
    "vm-live-test",
    "claude",
    mockLaunchSpec(f.workspace),
    () => worker!,
    120_000,
    {
      connector: "@loom/connector-claude",
      config: { cliPath: "", configDir: "/tmp/loom-home/.claude" },
    },
  );
  session = connected.session;
  const inventory = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
  const deno = inventory.find((path) => /-deno-[0-9]/.test(path)) + "/bin/deno";
  const probe = `
    if (!(await Deno.stat(${JSON.stringify(join(f.commonDir, "config"))})).isFile)
      throw new Error("Repository Git config unavailable");
    for (const path of ${JSON.stringify([join(homedir(), ".claude/.credentials.json")])}) {
      try { await Deno.stat(path); throw new Error("Host credentials exposed"); }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
    }
    const conn = await Deno.connect({hostname:"127.0.0.1",port:3128});
    await conn.write(new TextEncoder().encode("CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n"));
    const bytes = new Uint8Array(1024); const n = await conn.read(bytes);
    if (!new TextDecoder().decode(bytes.subarray(0,n)).includes("403 Forbidden")) throw new Error("Unapproved proxy destination accessible");
    conn.close();
    let timer;
    try {
      await Promise.race([
        Deno.connect({hostname:"1.1.1.1",port:443}).then(c => {c.close(); throw new Error("Direct guest networking accessible");}, error => {
          if (!/network is unreachable|networkunreachable/i.test(String(error))) throw error;
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Direct IP probe timed out: isolation result inconclusive")), 1500); })
      ]);
    } finally { clearTimeout(timer); }
    console.log("Repository metadata available; host credentials, direct IP and unapproved proxy destination blocked");
    Deno.exit(0);
  `;
  console.error(
    await command(["machine", "exec", "--name", sessionVmName, "--", deno, "eval", probe]),
  );
  const timeout = setTimeout(() => {
    void session?.close();
  }, 180_000);
  try {
    await session.start({
      method: "create",
      args: [
        {
          sessionId: session.id,
          cwd: f.workspace,
          mode: "acceptEdits",
          mcpServers: [],
          model: "haiku",
          settingSources: [],
          prompt: `Isolation acceptance test. The worktree is ${f.workspace}. Create the exact absolute path ${join(f.workspace, "vm-proof.txt")} containing exactly hello from isolated Claude followed by a newline. Then run git -C ${f.workspace} add vm-proof.txt and git -C ${f.workspace} commit -m 'isolated Claude proof'. Do not write outside this worktree, inspect credentials or other files. Report success briefly.`,
        },
      ],
    });
    for await (const event of session.events()) {
      if (event.type === "permission_request")
        await session.respondToPermission(event.id, { behavior: "allow" });
      if (event.type === "tool_call") console.error(`tool: ${event.name}`);
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "result") {
        assert.equal(event.kind, "ok", event.kind === "error" ? event.error : "");
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(
    await Deno.readTextFile(join(f.workspace, "vm-proof.txt")),
    "hello from isolated Claude\n",
  );
  assert.equal(await f.git("-C", f.workspace, "log", "-1", "--format=%s"), "isolated Claude proof");
  const { network: attempts } = await worker.status();
  assert(attempts.some((a) => a.allowed));
  console.log(JSON.stringify({ passed: true, network: attempts, hostVisibleCommit: true }));
  passed = true;
} finally {
  try {
    if (session) await session.close();
  } finally {
    worker?.terminate();
    await worker?.cleanup?.();
  }
  if (passed) await f.close();
  else console.error(`Retained non-secret Git fixture: ${f.root}`);
}
