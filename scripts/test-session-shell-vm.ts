/** Credential-free terminal smoke: CLI handoff locally and a real shell in both VM layouts.
 * Run with script(1) (util-linux on Linux), passing SESSION_RUNTIME SMOLVM. The VM
 * shell is an execution beside the worker, as the daemon opens it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import type { FakeProvider } from "@loom/connector-mock";
import type { SessionSnapshot } from "@loom/core/wire";
import { gitFixture } from "./lib/git-fixture.ts";
import { ptyCommand } from "./lib/host-processes.ts";
import { closeTestLaunchers, launchTestSessionVm } from "./lib/session-launch.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import type { SessionExecutions } from "../core/src/connector.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { guestShellArgv } from "../runtime/src/session-vm/shell.ts";

const [artifact, smolvm] = Deno.args;
const localOnly = Deno.args.includes("--local");
assert(localOnly || (artifact && smolvm), "Pass SESSION_RUNTIME SMOLVM (or --local)");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const terminal = async (
  command: string[],
  cwd: string,
  env?: Record<string, string>,
  tui = false,
  /** Only the given environment, as loom shell runs a VM transport. */
  clean = false,
) => {
  const pty = ptyCommand(command.map(quote).join(" "));
  const p = new Deno.Command(pty.command, {
    args: pty.args,
    ...(env ? { env, clearEnv: clean } : {}),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const bytes of stream) output += new TextDecoder().decode(bytes);
  };
  const drains = Promise.all([drain(p.stdout), drain(p.stderr)]);
  const writer = p.stdin.getWriter();
  const send = (s: string) => writer.write(new TextEncoder().encode(s));
  let expired = false;
  let exited = false;
  void p.status.then(() => {
    exited = true;
  });
  const timer = setTimeout(() => {
    expired = true;
    try {
      p.kill("SIGKILL");
    } catch {}
  }, 45000);
  const waitFor = async (needle: string) => {
    while (!output.includes(needle)) {
      if (expired || exited) throw new Error("Terminal ended before " + needle + ": " + output);
      await delay(20);
    }
  };
  try {
    if (tui) {
      await waitFor("more");
      await send("s");
    }
    while (!/[$#>] $/m.test(output)) {
      if (expired || exited) throw new Error("Shell prompt missing: " + output);
      await delay(20);
    }
    await send("printf 'LOOM_%s\\n' READY\n");
    await waitFor("LOOM_READY");
    await send(
      "pwd\ngit rev-parse --show-toplevel\ntest -t 0 && test -t 1 && printf 'LOOM_%s\\n' TTY\n",
    );
    await waitFor("LOOM_TTY");
    assert(output.includes(cwd), output);
    await send("sleep 30\n");
    await delay(200);
    await send("\x03");
    await delay(100);
    output = "";
    await send("printf 'LOOM_%s\\n' SURVIVED\nexit 0\n");
    await waitFor("LOOM_SURVIVED");
    if (tui) {
      await waitFor("\x1b[?1049h");
      await send("q");
    }
    assert.equal((await p.status).code, 0, output);
    await drains;
  } finally {
    clearTimeout(timer);
    try {
      await writer.close();
    } catch {
      /* exited */
    }
    try {
      p.kill("SIGKILL");
    } catch {
      /* exited */
    }
  }
};

const h = await makeHarness();
const client = await LoomClient.connect({
  repoRoot: h.repoRoot,
  sockPath: h.sockPath,
  autospawn: false,
});
try {
  for (const worktree of [false, true]) {
    const s = await client.request<SessionSnapshot>("session.create", {
      provider: "fake",
      prompt: "shell",
      worktree,
    });
    ((await h.daemon.providers.get("fake")) as FakeProvider).session(s.id)!.finishTurn();
    for (let n = 0; n < 100 && h.daemon.registry.get(s.id)?.status.kind === "starting"; n++)
      await delay(10);
    await terminal(
      [
        Deno.execPath(),
        "run",
        "-A",
        fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
        "--repo",
        h.repoRoot,
        "shell",
        s.id.slice(0, 8),
      ],
      s.worktree ?? h.repoRoot,
      { SHELL: "bash" },
    );
    await terminal(
      [
        Deno.execPath(),
        "run",
        "-A",
        fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
        "--repo",
        h.repoRoot,
        "tui",
      ],
      s.worktree ?? h.repoRoot,
      { SHELL: "bash", TERM: "xterm-256color" },
      true,
    );
    console.log("TUI shell passed:", worktree ? "worktree" : "in-place");
    await client.request("session.markDone", { id: s.id });
    console.log("Local shell passed:", worktree ? "worktree" : "in-place");
  }
} finally {
  await client.close();
  await h.cleanup();
}

if (localOnly) Deno.exit(0);
assert(artifact && smolvm);
const f = await gitFixture();
// Keep this run's VM inventory and session state out of the user's.
Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));
try {
  for (const workspace of [f.repo, f.workspace]) {
    let executions: SessionExecutions | undefined;
    const worker = await launchTestSessionVm({
      executions: (published) => (executions = published),
      artifact,
      smolvm,
      workspace,
      repoRoot: f.repo,
      sessionDirectory: sessionVmDirectory(
        f.repo,
        workspace === f.repo ? "in-place-profile" : "worktree-profile",
      ),
      auth: {},
      providerHosts: [],
    });
    try {
      const { session } = await RemoteWorkerSession.connect(
        "shell-check",
        "mock",
        mockLaunchSpec(workspace),
        () => worker,
        120000,
      );
      await session.start({
        method: "create",
        args: [
          {
            sessionId: "shell-check",
            cwd: workspace,
            prompt: "check",
            mode: "default",
            mcpServers: [],
          },
        ],
      });
      const owner = new AbortController();
      assert(executions, "the running worker publishes its executions");
      const { vm, token } = executions.open(
        { argv: guestShellArgv, stdin: true, tty: true },
        owner,
      );
      // A private XDG_STATE_HOME must not reach smolvm: it would look for another VM.
      await terminal(
        [vm.executable, ...vm.args],
        workspace,
        { ...vm.env, TERM: "xterm-256color" },
        false,
        true,
      );
      executions.close(token, owner);
      await session.close();
      console.log("VM shell passed:", workspace === f.repo ? "in-place" : "worktree");
    } finally {
      worker.terminate();
      await worker.cleanup?.();
    }
  }
} finally {
  await closeTestLaunchers();
  await f.close();
}
