/**
 * Live acceptance for Claude and Codex VM sessions on the isolation launcher.
 * Provider parity on top of
 * scripts/test-isolated-worker-vm.ts, which covers lifecycle with a synthetic AISDK
 * endpoint.
 *
 * Per provider: create and a native turn; a shell and a daemon hook beside the
 * worker, with a turn taken while the shell is open; a native tool write; optional
 * forced credential renewal delivered into the running VM; idle suspension; resume
 * in a fresh VM from the VM's own history; and lease/VM cleanup.
 *
 * Credentials are never taken from the environment or default profiles. Supply them
 * explicitly; a provider without them is skipped:
 *
 *   LOOM_TEST_CLAUDE_PROFILE   Claude config dir with OAuth .credentials.json
 *   LOOM_TEST_ANTHROPIC_API_KEY  or a static Anthropic API key instead
 *   LOOM_TEST_CODEX_PROFILE    CODEX_HOME with a ChatGPT auth.json
 *   LOOM_TEST_CODEX_CLI        host codex executable (the owner renews through it)
 *   LOOM_TEST_FORCE_RENEWAL=1  also force an OAuth renewal. This rotates the
 *                              supplied profile's tokens: use a dedicated profile.
 *
 * Usage: deno run -A scripts/test-isolated-providers-vm.ts <session-runtime> <smolvm>
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitFixture } from "./lib/git-fixture.ts";
import { withVmSessions } from "../backend/daemon/src/daemon/vm-provider.ts";
import { createClaudeWorkerProvider } from "../backend/daemon/src/daemon/claude-worker.ts";
import { ClaudeAuthOwner } from "../backend/daemon/src/daemon/claude-auth.ts";
import { CodexAuthOwner } from "../backend/daemon/src/daemon/codex-auth.ts";
import { createProvider as createCodexProvider } from "../connectors/chatgpt/src/index.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";
import { guestShellArgv } from "../runtime/src/session-vm/shell.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { ConnectorContext, SessionExecutions } from "../core/src/connector.ts";
import type { AgentProvider, AgentSession, SessionRef } from "../core/src/types.ts";

const [artifactArg, smolvmArg] = Deno.args;
assert(artifactArg && smolvmArg, "Pass a rebuilt session runtime and smolvm");
const artifact = await Deno.realPath(artifactArg);
const smolvm = await Deno.realPath(smolvmArg);
const env = (name: string) => Deno.env.get(name) || undefined;
const claudeProfile = env("LOOM_TEST_CLAUDE_PROFILE");
const claudeKey = env("LOOM_TEST_ANTHROPIC_API_KEY");
const codexProfile = env("LOOM_TEST_CODEX_PROFILE");
const codexCli = env("LOOM_TEST_CODEX_CLI");
const forceRenewal = env("LOOM_TEST_FORCE_RENEWAL") === "1";
// Ambient credentials must never be used: the providers read these as fallbacks.
for (const name of [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
])
  Deno.env.delete(name);
if (claudeKey) Deno.env.set("ANTHROPIC_API_KEY", claudeKey);

const plan: Array<"claude" | "codex"> = [];
if (claudeProfile || claudeKey) plan.push("claude");
else console.log("SKIP claude: set LOOM_TEST_CLAUDE_PROFILE or LOOM_TEST_ANTHROPIC_API_KEY");
if (codexProfile && codexCli) plan.push("codex");
else console.log("SKIP codex: set LOOM_TEST_CODEX_PROFILE and LOOM_TEST_CODEX_CLI");
if (!plan.length) {
  console.log("SKIPPED: no provider credentials were supplied");
  Deno.exit(0);
}

const turn = async (session: AgentSession) => {
  let text = "";
  for await (const event of session.events()) {
    if (event.type === "assistant_text") text += event.text;
    if (event.type === "error") throw new Error("provider error: " + event.message.slice(0, 200));
    if (event.type === "result") {
      assert.equal(event.kind, "ok");
      return text;
    }
  }
  throw new Error("stream ended");
};
const eventually = async (check: () => Promise<boolean>, what: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + what);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
const guest = async (executions: SessionExecutions, command: string) => {
  const result = await executions.command(command, 30_000, new AbortController().signal);
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
};

const accept = async (kind: "claude" | "codex") => {
  const f = await gitFixture();
  // Keep this run's VM inventory and session state out of the user's.
  Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));
  const published = new Map<string, SessionExecutions>();
  const ctx: ConnectorContext = {
    id: kind === "claude" ? "claude" : "chatgpt",
    logger: makeLogger("isolated-provider-acceptance"),
    config: {
      ...(kind === "claude"
        ? { configDir: claudeProfile ?? join(f.root, "no-claude-profile") }
        : { sdk: "chatgpt" as const, configDir: codexProfile!, codexCliPath: codexCli! }),
      sessionVm: { artifact, smolvm, repoRoot: f.repo },
    },
    vmLifecycle: {
      stop: async () => {},
      activity: () => "running",
      executions: (id, executions) => {
        published.set(id, executions);
        return () => {
          if (published.get(id) === executions) published.delete(id);
        };
      },
    },
  };
  const provider: AgentProvider =
    kind === "claude"
      ? await createClaudeWorkerProvider(ctx)
      : await withVmSessions(createCodexProvider(ctx), ctx, "codex");
  const id = "isolated-" + kind;
  let session: AgentSession | undefined;
  let passed = false;
  try {
    session = await provider.createSession({
      sessionId: id,
      cwd: f.workspace,
      prompt: "Remember the word cobalt. Reply with exactly OK. Do not use tools.",
      mode: "default",
      mcpServers: [],
    });
    await turn(session);
    console.log(kind + ": create and first turn passed");

    const executions = published.get(id);
    assert(executions, "the running environment's executions are published");
    // A shell (the session shell's own argv, without a terminal) stays open across a turn.
    const owner = new AbortController();
    const target = executions.open({ argv: guestShellArgv, stdin: true, tty: false }, owner);
    const shell = new Deno.Command(target.vm.executable, {
      args: target.vm.args,
      env: target.vm.env,
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    await session.send("Reply with exactly OK. Do not use tools.");
    await turn(session);
    const input = shell.stdin.getWriter();
    await input.write(new TextEncoder().encode('printf "shell:%s\\n" "$PWD"; exit\n'));
    await input.close();
    const output = new TextDecoder().decode((await shell.output()).stdout);
    assert.match(output, /^shell:\/.+$/m, output);
    executions.close(target.token, owner);
    const hook = await executions.command(
      'printf "%s" "$LOOM_HOOK" > hook.txt',
      30_000,
      new AbortController().signal,
      { LOOM_HOOK: "check" },
    );
    assert.equal(hook.code, 0, hook.output);
    assert.equal(await Deno.readTextFile(join(f.workspace, "hook.txt")), "check");
    await Deno.remove(join(f.workspace, "hook.txt"));
    console.log(kind + ": shell and hook beside the worker passed");

    await session.setMode("auto");
    await session.send(
      "Use your shell tool to write VM_OK to native-tool-check.txt in the working directory. Do not commit.",
    );
    await turn(session);
    assert.match(await Deno.readTextFile(join(f.workspace, "native-tool-check.txt")), /VM_OK/);
    console.log(kind + ": native tool write passed");

    const oauth = kind === "codex" || !claudeKey;
    if (oauth && forceRenewal) {
      // Only a digest crosses: the credential file never leaves the guest.
      const digest = () => guest(executions, "sha256sum /run/loom/private/auth.json | cut -c1-64");
      const before = await digest();
      const renewer =
        kind === "claude"
          ? new ClaudeAuthOwner({ profile: claudeProfile! })
          : new CodexAuthOwner({ profile: codexProfile!, cli: codexCli! });
      try {
        await renewer.current(true);
      } finally {
        await renewer.close();
      }
      // The session's own owner notices the renewed profile and delivers it.
      await eventually(async () => (await digest()) !== before, "renewed credentials delivered");
      await session.send("Reply with exactly OK. Do not use tools.");
      await turn(session);
      console.log(kind + ": forced renewal delivered into the running VM passed");
    } else if (oauth) console.log(kind + ": renewal not forced (LOOM_TEST_FORCE_RENEWAL=1)");

    const ref = session.providerRef!;
    await session.close("idle_suspension");
    session = undefined;
    assert(!published.has(id), "executions withdrawn with the worker");
    session = await provider.resumeSession({
      sessionId: id,
      providerRef: ref,
      cwd: f.workspace,
      mode: "default",
      mcpServers: [],
    } as SessionRef);
    await session.send(
      "What word did I ask you to remember? Reply only with that word. Do not use tools.",
    );
    assert.match((await turn(session)).toLowerCase(), /cobalt/);
    console.log(kind + ": idle suspension and fresh-VM resume passed");
    await session.close("session_close");
    session = undefined;
    const { vms, errors } = await listVms(await Deno.realPath(f.repo));
    assert.deepEqual(errors, []);
    for (const vm of vms) {
      assert.equal(vm.state, "stopped");
      assert.equal(vm.error, null);
    }
    passed = true;
  } finally {
    await session?.close().catch(() => {});
    await provider.close?.();
    if (passed) await f.close();
    else console.error("Retained fixture: " + f.root);
  }
};

const deadline = setTimeout(() => {
  console.error("Isolated provider acceptance timed out");
  Deno.exit(1);
}, 1_200_000);
try {
  for (const kind of plan) await accept(kind);
  console.log("Passed: " + plan.join(", ") + " on the isolation launcher");
} finally {
  clearTimeout(deadline);
}
