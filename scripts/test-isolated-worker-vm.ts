/**
 * One Loom vertical slice on the isolation launcher, against a real runtime: the
 * AISDK generic connector, with a synthetic local endpoint reached only through the
 * session's MCP relay. No provider credentials or traffic.
 *
 * create + send, idle suspension, resume from the host transcript in a fresh VM,
 * external stop, startup cancellation, guest worker crash and VM crash. After each
 * the worker's lease is released, the environment is stopped, the VM's runtime state
 * is reaped and no process still references it.
 *
 * Usage: deno run -A scripts/test-isolated-worker-vm.ts <session-runtime> <smolvm>
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createIsolatedWorkerLauncher,
  type IsolatedLaunchOptions,
} from "../backend/daemon/src/daemon/isolated-worker.ts";
import { leasedVmUsage } from "../backend/daemon/src/daemon/session-inspection.ts";
import { guestShellArgv } from "../runtime/src/session-vm/shell.ts";
import type { SessionExecutions } from "../core/src/connector.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import {
  sessionVmDirectory,
  stoppedSessionVm,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
import { listVms, stopVm } from "../runtime/src/session-vm/inventory.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { VmTerminationError } from "../core/src/vm-termination.ts";
import { processesUsing, supervisorPid } from "./lib/host-processes.ts";
import type { SessionRef } from "../core/src/types.ts";
import { gitFixture } from "./lib/git-fixture.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "Pass a rebuilt session runtime and smolvm");
const f = await gitFixture();
// Keep this run's VM inventory and session state out of the user's.
Deno.env.set("XDG_STATE_HOME", join(f.root, "xdg-state"));

let requests = 0;
let fixtureError: unknown;
let toolResult: string | undefined;
// What the worker's own children see: commit identity, the restored guest environment
// (proxy, caches beside the dev shell) and denied direct egress.
const probe = [
  'printf "%s\\n" "$GIT_AUTHOR_NAME" "$HTTPS_PROXY" "$XDG_CACHE_HOME" > probe.txt',
  "git var GIT_AUTHOR_IDENT | cut -d'>' -f1 >> probe.txt",
  "if curl -sS --max-time 10 https://example.com >/dev/null 2>&1; then echo egress-open >> probe.txt; fi",
].join("; ");
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    const body = await request.json();
    const text = JSON.stringify(body.messages);
    requests++;
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      }) +
      "\n\n";
    const stream = { headers: { "content-type": "text/event-stream" } };
    // First turn: run one command in the worker's environment, as the agent would.
    if (text.includes("Remember") && !text.includes("call-environment"))
      return new Response(
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-environment",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: probe }) },
              },
            ],
          },
          null,
        ) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
        stream,
      );
    toolResult ??= text.includes("call-environment") ? text : undefined;
    let reply = "OK";
    // A resumed session must carry the earlier turn from the host transcript.
    if (text.includes("Which colour")) reply = text.includes("cobalt") ? "cobalt" : "?";
    return new Response(
      chunk({ role: "assistant", content: reply }, null) +
        chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }) +
        "data: [DONE]\n\n",
      stream,
    );
  } catch (error) {
    fixtureError = error;
    return new Response("Fixture assertion failed", { status: 400 });
  }
});

const launcher = createIsolatedWorkerLauncher(f.repo);
const progress: string[] = [];
const transcript = new WorkerTranscript("isolated", () => {});
const profile = {
  connector: "@loom/connector-generic" as const,
  config: {
    sdk: "openai" as const,
    model: "fixture",
    models: ["fixture"],
    baseUrl: "http://127.0.0.1:3130/v1",
    apiKey: "synthetic-fixture-key",
  },
};
const launch = async (
  id: string,
  extra: Pick<IsolatedLaunchOptions, "signal" | "onStop" | "executions"> = {},
) => {
  await stoppedSessionVm(f.repo, id);
  return await launcher.launch({
    workspace: f.workspace,
    sessionId: id,
    provider: "fixture",
    artifact,
    smolvm,
    sessionDirectory: sessionVmDirectory(f.repo, id),
    repoRoot: f.repo,
    auth: {},
    providerHosts: [],
    mcpRelays: [{ port: server.addr.port, guestPort: 3130 }],
    gitIdentity: { GIT_AUTHOR_NAME: "Isolated author", GIT_AUTHOR_EMAIL: "author@example.invalid" },
    onProgress: (message) => progress.push(message),
    ...extra,
  });
};
const connect = async (id: string, worker: Awaited<ReturnType<typeof launch>>) => {
  const { session } = await RemoteWorkerSession.connect(
    id,
    "fixture",
    mockLaunchSpec(f.workspace),
    () => worker,
    { startupMs: 120_000, requestMs: 120_000 },
    profile,
  );
  return session;
};
const turn = async (session: RemoteWorkerSession) => {
  let text = "";
  for await (const event of session.events()) {
    if (event.type === "assistant_text") text += event.text;
    if (event.type === "error") throw fixtureError ?? new Error(event.message);
    if (event.type === "result") {
      assert.equal(event.kind, "ok");
      return text;
    }
  }
  throw new Error("missing result");
};
const eventually = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 40_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + what);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const gone = (path: string) =>
  Deno.lstat(path).then(
    () => false,
    (error) => {
      if (error instanceof Deno.errors.NotFound) return true;
      throw error;
    },
  );
/** Lease released, environment stopped, VM reaped and recorded, nothing left running. */
const assertCleaned = async (id: string, state: string) => {
  assert.equal(launcher.leases.has(id), false, "worker lease released");
  assert.equal(launcher.inspect(id).phase, "stopped");
  await eventually(() => gone(state), "VM runtime state reaped");
  await eventually(() => gone(join(sessionVmDirectory(f.repo, id), "active.json")), "no active VM");
  await eventually(
    async () => !(await processesUsing([state], { cwd: true })).length,
    "no VM processes",
  );
  const { vms, errors } = await listVms(await Deno.realPath(f.repo));
  assert.deepEqual(errors, []);
  for (const vm of vms.filter((vm) => vm.sessionId === id)) {
    assert.equal(vm.state, "stopped");
    assert.equal(vm.error, null);
  }
};
const options = (id: string) => ({ sessionId: id, cwd: f.workspace, mode: "default" as const });

let passed = false;
const deadline = setTimeout(() => {
  console.error("Isolated worker VM acceptance timed out\n" + progress.join("\n"));
  Deno.exit(1);
}, 900_000);
try {
  {
    console.error("create, send and idle suspension");
    const id = "isolated";
    const worker = await launch(id);
    assert(launcher.leases.has(id), "the worker holds a lease");
    assert.equal(launcher.inspect(id).phase, "ready");
    const session = await connect(id, worker);
    await session.attachTranscript(transcript);
    await session.start({
      method: "create",
      args: [
        {
          ...options(id),
          // Mount the first-party tools; let the fixture's bash call run unprompted.
          loomServer: true,
          mode: "auto",
          prompt: "Remember the colour cobalt. Reply OK.",
          mcpServers: [],
        },
      ],
    });
    assert.equal(await turn(session), "OK");
    // The worker's children run with the session's identity and the initialized
    // guest environment, and have no direct egress.
    const probed = await Deno.readTextFile(join(f.workspace, "probe.txt")).catch(() => "");
    assert.deepEqual(
      probed.split("\n"),
      [
        "Isolated author",
        "http://127.0.0.1:3128",
        "/storage/loom-cache",
        "Isolated author <author@example.invalid",
        "",
      ],
      "bash tool result: " + toolResult,
    );
    await Deno.remove(join(f.workspace, "probe.txt"));
    assert(session.providerRef, "provider reference");
    assert(progress.includes("Starting the agent…"), progress.join("\n"));
    const state = worker.binding.state;
    await session.close("idle_suspension");
    await assertCleaned(id, state);
    const records = (await listVms(await Deno.realPath(f.repo))).vms;
    assert.equal(records.filter((vm) => vm.sessionId === id).length, 1);
    assert(transcript.count(id) >= 2, "host transcript retained the turn");
  }
  {
    console.error("resume in a fresh VM from the host transcript");
    const id = "isolated";
    const worker = await launch(id);
    const session = await connect(id, worker);
    await session.attachTranscript(transcript);
    await session.start({
      method: "resume",
      args: [{ ...options(id), providerRef: id, mcpServers: [] } as SessionRef],
    });
    await session.send("Which colour did I ask you to remember?");
    assert.equal(await turn(session), "cobalt");
    const state = worker.binding.state;
    await session.close("session_close");
    await assertCleaned(id, state);
  }
  {
    console.error("shells, hooks and inspection beside the worker");
    const id = "executions";
    let executions: SessionExecutions | undefined;
    let withdrawn = 0;
    const worker = await launch(id, {
      executions: (published) => {
        executions = published;
        return () => void withdrawn++;
      },
    });
    assert(executions, "the running environment's executions are published");
    assert.equal(executions.workspace, await Deno.realPath(f.workspace));
    const session = await connect(id, worker);
    await session.attachTranscript(new WorkerTranscript(id, () => {}));
    await session.start({
      method: "create",
      args: [{ ...options(id), prompt: "", mcpServers: [] }],
    });
    // The session shell's own argv and wrapper, without a terminal: an interactive
    // shell reading its commands from the client's stdin.
    const open = () => {
      const owner = new AbortController();
      const target = executions!.open({ argv: guestShellArgv, stdin: true, tty: false }, owner);
      const child = new Deno.Command(target.vm.executable, {
        args: target.vm.args,
        env: target.vm.env,
        clearEnv: true,
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      return { owner, target, child };
    };
    const shell = open();
    // The worker takes a turn while the shell is open; neither disturbs the other.
    await session.send("Reply OK.");
    assert.equal(await turn(session), "OK");
    const input = shell.child.stdin.getWriter();
    await input.write(
      new TextEncoder().encode('printf "%s|%s|%s\\n" shell "$GIT_AUTHOR_NAME" "$PWD"; exit\n'),
    );
    await input.close();
    const shellOutput = new TextDecoder().decode((await shell.child.output()).stdout);
    assert.match(shellOutput, /^shell\|Isolated author\|\/.+$/m, shellOutput);
    executions.close(shell.target.token, shell.owner);
    assert(launcher.leases.has(id), "the worker keeps its own lease");
    // A daemon hook: a bounded guest command under its own lease, with hook variables.
    const hook = await executions.command(
      'printf "%s:%s" "$LOOM_HOOK" "$GIT_AUTHOR_NAME" > hook.txt && git status --short hook.txt',
      30_000,
      new AbortController().signal,
      { LOOM_HOOK: "check edits" },
    );
    assert.equal(hook.code, 0, hook.output);
    assert.equal(hook.output.trim(), "?? hook.txt");
    assert.equal(
      await Deno.readTextFile(join(f.workspace, "hook.txt")),
      "check edits:Isolated author",
    );
    await Deno.remove(join(f.workspace, "hook.txt"));
    // Inspection: the agent VM's guest counters run under a lease too.
    let record: Awaited<ReturnType<typeof listVms>>["vms"][number] | undefined;
    await eventually(async () => {
      record = (await listVms(await Deno.realPath(f.repo))).vms.find(
        (vm) => vm.sessionId === id && vm.state === "running",
      );
      return !!record;
    }, "the environment is running in the VM inventory");
    assert(record);
    const usage = await leasedVmUsage(executions)(record, new AbortController().signal);
    assert(usage.memoryTotal && usage.memoryTotal > 0, JSON.stringify(usage));
    await session.send("Reply OK again.");
    assert.equal(await turn(session), "OK");
    // The worker's VM ends under an open shell and a running hook, as before; every
    // lease is gone before the environment stops.
    const open2 = open();
    const sleeping = executions.command("sleep 600", 900_000, new AbortController().signal).then(
      (result) => "completed " + result.code,
      () => "cancelled",
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = worker.binding.state;
    await session.close("session_close");
    assert.equal(withdrawn, 1);
    // Killed with the VM: smolvm exec reports the signal, or the transport fails.
    assert.match(await sleeping, /^(completed (?!0$)\d+|cancelled)$/);
    const ended = await open2.child.status;
    assert(!ended.success, "the shell ended with its VM");
    await open2.child.stdin.close().catch(() => {});
    executions.close(open2.target.token, open2.owner);
    await assert.rejects(
      executions.command("true", 1000, new AbortController().signal),
      /not running/,
    );
    await assertCleaned(id, state);
  }
  {
    console.error("external stop suspends the session before the VM");
    const id = "stopped";
    const order: string[] = [];
    let session: RemoteWorkerSession | undefined;
    const worker = await launch(id, {
      // The daemon's vmLifecycle.stop: close the session first.
      onStop: async (isCurrent) => {
        order.push("suspend " + isCurrent());
        await session?.close("user_stop");
        order.push("lease " + launcher.leases.has(id));
      },
    });
    session = await connect(id, worker);
    const vm = (await listVms(await Deno.realPath(f.repo))).vms.find((vm) => vm.sessionId === id);
    assert(vm);
    await stopVm(vm.id);
    assert.deepEqual(order, ["suspend true", "lease false"]);
    await assertCleaned(id, worker.binding.state);
  }
  {
    console.error("startup cancellation");
    const id = "cancelled";
    const abort = new AbortController();
    const seen = progress.length;
    const pending = launch(id, { signal: abort.signal });
    await eventually(
      async () => progress.slice(seen).some((message) => message.startsWith("Starting VM")),
      "VM boot",
    );
    abort.abort(new Error("cancelled by test"));
    await assert.rejects(pending, /cancelled by test/);
    assert.equal(launcher.leases.has(id), false);
    assert.equal(launcher.inspect(id).phase, "stopped");
    const { vms } = await listVms(await Deno.realPath(f.repo));
    const vm = vms.find((vm) => vm.sessionId === id);
    assert(vm, "the cancelled VM was registered");
    await assertCleaned(id, vm.paths.state);
  }
  {
    console.error("guest worker crash");
    const id = "worker-crash";
    const worker = await launch(id);
    const session = await connect(id, worker);
    await session.start({
      method: "create",
      args: [{ ...options(id), prompt: "", mcpServers: [] }],
    });
    // Kill the worker inside the guest; the environment itself stays up until cleanup.
    const killed = await new Deno.Command(smolvm, {
      args: [
        "machine",
        "exec",
        "--name",
        "loom-session",
        "--",
        "/bin/sh",
        "-c",
        'for p in /proc/[0-9]*; do grep -qa "guest-worke[r].ts" $p/cmdline 2>/dev/null && kill -9 ${p#/proc/}; done; true',
      ],
      env: {
        HOME: join(worker.binding.state, "home"),
        XDG_CACHE_HOME: join(worker.binding.state, "cache"),
        XDG_DATA_HOME: join(worker.binding.state, "data"),
        XDG_CONFIG_HOME: join(worker.binding.state, "config"),
        PATH: "/usr/bin:/bin",
      },
      clearEnv: true,
      stdin: "null",
    }).output();
    assert(killed.success, new TextDecoder().decode(killed.stderr));
    const error = await (async () => {
      for await (const _ of session.events()) {
        /* drain */
      }
    })().then(
      () => undefined,
      (error) => error,
    );
    assert(error instanceof VmTerminationError, String(error));
    assert.equal(error.termination.reason, "guest_exit");
    assert.equal(error.termination.hostReason, "worker_failure");
    assert.equal(error.termination.guestExit?.code, 137);
    await session.close();
    await assertCleaned(id, worker.binding.state);
  }
  {
    console.error("VM crash");
    const id = "vm-crash";
    const worker = await launch(id);
    const session = await connect(id, worker);
    await session.start({
      method: "create",
      args: [{ ...options(id), prompt: "", mcpServers: [] }],
    });
    const state = worker.binding.state;
    const supervisor = await supervisorPid(state);
    assert(supervisor, "found the environment supervisor");
    Deno.kill(supervisor, "SIGKILL");
    const error = await (async () => {
      for await (const _ of session.events()) {
        /* drain */
      }
    })().then(
      () => undefined,
      (error) => error,
    );
    // The VM's own diagnosis, not the execution it took down.
    assert(error instanceof VmTerminationError, String(error));
    assert.equal(error.termination.supervisorExit?.signal, "SIGKILL");
    await session.close();
    await assertCleaned(id, state);
  }
  assert.equal(requests, 5, "guest requests reached the fixture only through the relay");
  passed = true;
  console.log(
    "Passed: create/send, idle suspension, transcript resume, shells/hooks/inspection beside the worker, external stop, startup cancellation, worker crash and VM crash on the isolation launcher, with lease/VM/process/state cleanup",
  );
} finally {
  clearTimeout(deadline);
  await launcher.close();
  await server.shutdown();
  if (passed) await f.close();
  else console.error("Retained fixture: " + f.root + "\n" + progress.join("\n"));
}
