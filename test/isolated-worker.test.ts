import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createIsolatedWorkerLauncher,
  type ExecutionChild,
  type IsolatedLaunchOptions,
  type IsolatedWorkerBackend,
} from "../backend/daemon/src/daemon/isolated-worker.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import type { VmEnvironment } from "../runtime/src/session-vm/environment-launch.ts";
import type { SessionVmOptions } from "../runtime/src/session-vm/launch.ts";
import { classifyStartupFailure, startupFailures } from "../runtime/src/session-vm/progress.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";
import { VmTerminationError, type HostStopReason } from "../core/src/vm-termination.ts";
import { WorkerDiagnostic } from "../core/src/worker.ts";
import { environmentDiagnostics } from "../core/src/environment-diagnostic.ts";
import type { SessionRef } from "../core/src/types.ts";
import type { SessionExecutions } from "../core/src/connector.ts";
import { guestShellArgv } from "../runtime/src/session-vm/shell.ts";
import type { SessionAuth } from "../runtime/src/session-vm/auth.ts";
import { ClaudeAuthOwner } from "../backend/daemon/src/daemon/claude-auth.ts";
import { CodexAuthOwner } from "../backend/daemon/src/daemon/codex-auth.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
const argv = [
  "/nix/store/" + "a".repeat(32) + "-loom-session/bin/loom-session",
  "/guest-worker.ts",
];

/** A VM environment whose readiness, exit and cleanup the test controls. */
class FakeEnvironment implements VmEnvironment {
  static count = 0;
  readonly binding: VmBinding;
  readonly pid = 1;
  readonly #ready = Promise.withResolvers<void>();
  readonly #exited = Promise.withResolvers<void>();
  readonly ready = this.#ready.promise;
  readonly exited = this.#exited.promise;
  readonly reasons: HostStopReason[] = [];
  readonly closes: string[] = [];
  closeFailures = 0;
  /** Lease state observed at each close: the worker must never outlive this. */
  busyAtClose: boolean[] = [];
  busy = () => false;
  readonly options: SessionVmOptions;
  constructor(options: SessionVmOptions, ready = true) {
    this.options = options;
    const n = ++FakeEnvironment.count;
    this.binding = {
      version: 1,
      artifact: "/fake/artifact",
      smolvm: "/fake/smolvm",
      workspace: "/fake/workspace",
      state: "/fake/state-" + n,
      token: "token-" + n,
    } as VmBinding;
    void this.ready.catch(() => {});
    if (ready) this.#ready.resolve();
  }
  becomeReady() {
    this.#ready.resolve();
  }
  failStartup(error: Error) {
    this.#ready.reject(error);
    this.#exited.resolve();
  }
  /** Runtime cleanup once the VM has gone, such as ending its credential delivery. */
  teardown: (() => Promise<void>) | undefined;
  /** The VM dies on its own. */
  crash() {
    this.#exited.resolve();
    void this.teardown?.();
  }
  status = async () => ({ phase: "running", network: [] });
  /** Like the supervisor, the first recorded reason wins. */
  setStopReason(reason: HostStopReason) {
    if (!this.reasons.length) this.reasons.push(reason);
  }
  async failure() {
    return new VmTerminationError({
      reason: "signal",
      at: 1,
      phase: "running",
      ...(this.reasons[0] ? { hostReason: this.reasons[0] } : {}),
    });
  }
  async close(reason?: HostStopReason) {
    this.closes.push(reason ?? "");
    this.busyAtClose.push(this.busy());
    if (this.closeFailures > 0) {
      this.closeFailures--;
      throw new Error("fake cleanup failure");
    }
    this.#ready.reject(new Error("Environment closed"));
    this.#exited.resolve();
    await this.teardown?.();
  }
}

/** A worker execution whose exit the test controls; kill() ends it. */
const fakeChild = () => {
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const stderr = new TransformStream<Uint8Array, Uint8Array>();
  const status = Promise.withResolvers<{ code: number; signal: Deno.Signal | null }>();
  const errors = stderr.writable.getWriter();
  const output = stdout.writable.getWriter();
  const kills: Deno.Signal[] = [];
  void stdin.readable.pipeTo(new WritableStream()).catch(() => {});
  let done = false;
  const exit = (code: number, signal: Deno.Signal | null = null) => {
    if (done) return;
    done = true;
    void output.close().catch(() => {});
    void errors.close().catch(() => {});
    status.resolve({ code, signal });
  };
  const child: ExecutionChild = {
    stdin: stdin.writable,
    stdout: stdout.readable,
    stderr: stderr.readable,
    pid: 4242,
    status: status.promise,
    kill(signal: Deno.Signal = "SIGTERM") {
      kills.push(signal);
      exit(143, signal);
    },
  };
  void stdout.readable.pipeTo(new WritableStream()).catch(() => {});
  return { child, kills, exit, errors };
};

const harness = async (
  options: {
    ready?: boolean;
    command?: IsolatedWorkerBackend["command"];
    /** Whether the VM still runs a command once its worker has ended by itself. */
    answers?: IsolatedWorkerBackend["answers"];
    /** Stands in for the runtime's own launch-time work, such as credential delivery. */
    launched?: (environment: FakeEnvironment) => Promise<void>;
  } = {},
) => {
  const state = await Deno.makeTempDir({ prefix: "loom-isolated-worker-" });
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", state);
  const environments: FakeEnvironment[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawned: string[][] = [];
  let launched = Promise.withResolvers<FakeEnvironment>();
  const backend: Partial<IsolatedWorkerBackend> = {
    launch: async (vm) => {
      const environment = new FakeEnvironment(vm, options.ready ?? true);
      environment.busy = () => launcher.leases.has(vm.sessionId!);
      environments.push(environment);
      await options.launched?.(environment);
      launched.resolve(environment);
      return environment;
    },
    command: options.command ?? (async () => ({ code: 0, output: "", timedOut: false })),
    spawn: (target) => {
      spawned.push(target.args);
      const child = fakeChild();
      children.push(child);
      return child.child;
    },
    workerArgv: async () => argv,
    answers: options.answers ?? (async () => true),
  };
  const launcher = createIsolatedWorkerLauncher(join(state, "repo"), backend);
  const progress: string[] = [];
  const launch = (id = "session", extra: Partial<IsolatedLaunchOptions> = {}) =>
    launcher.launch({
      workspace: "/fake/workspace",
      artifact: "/fake/artifact",
      smolvm: "/fake/smolvm",
      sessionId: id,
      onProgress: (message) => progress.push(message),
      ...extra,
    });
  return {
    launcher,
    environments,
    children,
    spawned,
    progress,
    launch,
    nextLaunch: () => {
      launched = Promise.withResolvers();
      return launched.promise;
    },
    async [Symbol.asyncDispose]() {
      await launcher.close();
      if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", previous);
      await Deno.remove(state, { recursive: true });
    },
  };
};

Deno.test("worker exit is not VM exit: cleanup reaps the worker, releases its lease, then stops the VM", async () => {
  await using h = await harness();
  // Trusted composition reaches the VM unchanged: credential owner, MCP relays,
  // commit identity and network grants.
  const authOwner = {
    current: async () => ({ ANTHROPIC_API_KEY: "test" }),
    subscribe: async () => async () => {},
  };
  const grants = {
    authOwner,
    mcpRelays: [{ port: 4100, guestPort: 3130 }],
    gitIdentity: { GIT_AUTHOR_NAME: "Author" },
    extraAllowedHosts: ["registry.npmjs.org"],
  };
  const worker = await h.launch("session", grants);
  const [environment] = h.environments;
  for (const [key, value] of Object.entries(grants))
    assert.equal(environment!.options[key as keyof typeof grants], value);
  // The existing guest worker runs as an execution inside the ready environment.
  assert.deepEqual(h.spawned[0]!.slice(-argv.length - 1), ["loom-exec", ...argv]);
  assert.equal(h.launcher.inspect("session").phase, "ready");
  assert(h.launcher.leases.has("session"));
  assert.equal(worker.binding, environment!.binding);
  // Agent sessions keep provider egress unless their launcher names other hosts.
  assert.deepEqual(environment!.options.providerHosts, ["api.anthropic.com"]);
  // RemoteWorkerSession.close: record the reason, then terminate and clean up.
  worker.setStopReason?.("idle_suspension");
  worker.terminate();
  await worker.exited;
  assert.deepEqual(h.children[0]!.kills, ["SIGTERM"]);
  assert.equal(h.launcher.leases.has("session"), false);
  await worker.cleanup?.();
  assert.deepEqual(environment!.reasons, ["idle_suspension"]);
  assert.deepEqual(environment!.closes, ["idle_suspension"]);
  assert.deepEqual(environment!.busyAtClose, [false]);
  assert.equal(h.launcher.inspect("session").phase, "stopped");
});

Deno.test("a VM failure cancels the worker's lease and reports the VM's own diagnosis", async () => {
  await using h = await harness();
  const worker = await h.launch();
  const [environment] = h.environments;
  environment!.crash();
  await worker.exited;
  assert.deepEqual(h.children[0]!.kills, ["SIGTERM"]);
  await worker.cleanup?.();
  const failure = await worker.failure?.();
  assert(failure instanceof VmTerminationError);
  assert.equal(failure.termination.reason, "signal");
  assert.equal(h.launcher.inspect("session").phase, "stopped");
  assert.equal(h.launcher.leases.has("session"), false);
});

Deno.test("a crashed worker stops its VM, and the diagnosis names the worker execution", async () => {
  await using h = await harness();
  const worker = await h.launch();
  const [environment] = h.environments;
  const child = h.children[0]!;
  await child.errors.write(encode({ loomStartup: "provider" }));
  await child.errors.write(new TextEncoder().encode("vendor secret on stderr\n"));
  await child.errors.write(
    encode({
      loomWorkerFailure: { origin: "worker_loop", name: "Error", code: "EIO", frames: [] },
    }),
  );
  child.exit(17);
  const failure = await worker.failure?.();
  assert(failure instanceof VmTerminationError);
  assert.equal(failure.termination.reason, "guest_exit");
  assert.equal(failure.termination.hostReason, "worker_failure");
  assert.deepEqual(failure.termination.guestExit, { code: 17, signal: null });
  assert.equal(failure.termination.workerFailure?.code, "EIO");
  assert.deepEqual(environment!.closes, ["worker_failure"]);
  assert.deepEqual(environment!.busyAtClose, [false]);
  // Only fixed progress frames cross; raw guest stderr does not.
  assert(h.progress.includes("Starting the agent…"));
  assert(!h.progress.some((message) => message.includes("secret")));
});

Deno.test("a worker that ends before its failing VM's exit is observed gets the VM's diagnosis", async () => {
  // The VM's exit is observed well after the worker's, beyond any fixed grace: on
  // Linux a killed VMM ends its executions about half a second before its supervisor.
  const asked: string[] = [];
  let environment: FakeEnvironment | undefined;
  await using h = await harness({
    answers: async (binding) => {
      asked.push(binding.state);
      setTimeout(() => environment!.crash(), 1200);
      return false;
    },
  });
  const worker = await h.launch();
  environment = h.environments[0]!;
  h.children[0]!.exit(1);
  const failure = await worker.failure?.();
  assert.deepEqual(asked, [environment.binding.state]);
  // The VM's own record, not one the adapter built for its execution.
  assert(failure instanceof VmTerminationError);
  assert.equal(failure.termination.reason, "signal");
  assert.equal(failure.termination.guestExit, undefined);
  assert.equal(h.launcher.inspect("session").phase, "stopped");
  assert.equal(h.launcher.leases.has("session"), false);
});

Deno.test("a worker that ends by itself beside a VM that still answers is diagnosed at once", async () => {
  const asked: string[] = [];
  await using h = await harness({
    answers: async (binding) => {
      asked.push(binding.state);
      return true;
    },
  });
  const worker = await h.launch();
  const started = performance.now();
  h.children[0]!.exit(3);
  await worker.settled;
  // No timer stands between the worker's exit and its diagnosis.
  assert(performance.now() - started < 500, "settled without waiting on the VM");
  const failure = await worker.failure?.();
  assert(failure instanceof VmTerminationError);
  assert.equal(failure.termination.reason, "guest_exit");
  assert.deepEqual(failure.termination.guestExit, { code: 3, signal: null });
  assert.equal(asked.length, 1);
  // A worker the host asked to stop is never probed.
  const second = await h.launch("other");
  second.terminate("session_close");
  await second.cleanup!();
  assert.equal(asked.length, 1);
});

Deno.test("failed VM cleanup is retried, and a stale callback never stops its replacement", async () => {
  await using h = await harness();
  const first = await h.launch();
  const [old] = h.environments;
  old!.closeFailures = 2;
  first.terminate("session_close");
  await assert.rejects(first.cleanup!(), /fake cleanup failure/);
  assert.equal(h.launcher.inspect("session").phase, "failed");
  // An explicit retry goes back to the same generation's environment.
  await assert.rejects(first.cleanup!(), /fake cleanup failure/);
  assert.equal(old!.closes.length, 2);
  // Resume finishes the retained cleanup before starting a new generation.
  const second = await h.launch();
  const [, replacement] = h.environments;
  assert.equal(old!.closes.length, 3);
  assert.equal(h.launcher.inspect("session").phase, "ready");
  // Late callbacks of the first generation: cleanup retry, termination, VM exit and
  // the inventory stop handler it registered.
  await first.cleanup!();
  first.terminate("user_stop");
  old!.crash();
  await old!.options.onStop!(() => true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(replacement!.closes, []);
  assert.equal(h.launcher.inspect("session").phase, "ready");
  assert(h.launcher.leases.has("session"));
  second.terminate("session_close");
  await second.cleanup!();
  // The precise host reason is recorded before the coordinator's coarser one.
  assert.deepEqual(replacement!.reasons, ["session_close"]);
  assert.equal(replacement!.closes.length, 1);
});

Deno.test("cancelling startup stops the starting VM and never opens a worker lease", async () => {
  await using h = await harness({ ready: false });
  const abort = new AbortController();
  const starting = h.nextLaunch();
  const pending = h.launch("session", { signal: abort.signal });
  const environment = await starting;
  abort.abort(new Error("cancelled by user"));
  await assert.rejects(pending, /cancelled by user/);
  assert.deepEqual(environment.closes, ["user_stop"]);
  assert.equal(h.children.length, 0);
  assert.equal(h.launcher.leases.lastActivity("session"), 0);
  assert.equal(h.launcher.inspect("session").phase, "stopped");
  // The session can start again afterwards.
  const next = h.nextLaunch();
  const resumed = h.launch();
  (await next).becomeReady();
  const worker = await resumed;
  worker.terminate("session_close");
  await worker.cleanup!();
});

Deno.test("specific startup diagnostics reach the session's startup error", async () => {
  await using h = await harness({ ready: false });
  const starting = h.nextLaunch();
  const pending = h.launch();
  const environment = await starting;
  const diagnostic = environmentDiagnostics.sessionCheckoutFailed;
  environment.failStartup(
    new VmTerminationError({ reason: "guest_exit", at: 1, phase: "starting" }, diagnostic),
  );
  const error = await pending.catch((error) => error);
  assert(error instanceof VmTerminationError);
  assert(error.message.endsWith(diagnostic), error.message);
  assert.equal(h.launcher.inspect("session").phase, "stopped");
  // An environment guest classifies the same WorkerDiagnostic codes legacy workers send.
  for (const code of Object.keys(
    environmentDiagnostics,
  ) as (keyof typeof environmentDiagnostics)[]) {
    assert.equal(classifyStartupFailure(new WorkerDiagnostic(code)), code);
    assert.equal(startupFailures[code], new WorkerDiagnostic(code).message);
  }
});

Deno.test("an external VM stop suspends the session before the coordinator stops the VM", async () => {
  await using h = await harness();
  const order: string[] = [];
  const worker = await h.launch("session", {
    onStop: async (isCurrent) => {
      order.push("suspend " + isCurrent() + " " + h.launcher.leases.has("session"));
      worker.setStopReason?.("user_stop");
      worker.terminate();
      await worker.cleanup!();
      order.push("closed " + h.launcher.leases.has("session"));
    },
  });
  const [environment] = h.environments;
  await environment!.options.onStop!(() => true);
  assert.deepEqual(order, ["suspend true true", "closed false"]);
  assert.deepEqual(environment!.closes, ["user_stop"]);
  assert.deepEqual(environment!.busyAtClose, [false]);
  // Without a daemon callback, the adapter itself ends the worker first.
  const bare = await h.launch("bare");
  const [, other] = h.environments;
  await other!.options.onStop!(() => true);
  await bare.exited;
  assert.equal(h.launcher.leases.has("bare"), false);
});

Deno.test("closing the provider ends workers before stopping their VMs", async () => {
  const h = await harness();
  try {
    const worker = await h.launch();
    const [environment] = h.environments;
    await h.launcher.close();
    await worker.exited;
    assert.deepEqual(environment!.reasons, ["daemon_shutdown"]);
    assert.deepEqual(environment!.busyAtClose, [false]);
    await assert.rejects(h.launch("later"), /shutting down/);
  } finally {
    await h[Symbol.asyncDispose]();
  }
});

Deno.test("the unchanged worker protocol runs over the adapter: create, send, idle suspend, resume, crash", async () => {
  await using h = await harness();
  const fixture = join(root, "test/fixtures/connector-worker.ts");
  // Execute the scripted connector worker locally in place of the guest execution.
  const spawn = (): ExecutionChild =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--quiet", "--config=" + join(root, "deno.json"), fixture],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  const local = createIsolatedWorkerLauncher(join(root, "unused-repo"), {
    launch: async (vm) => {
      const environment = new FakeEnvironment(vm);
      environment.busy = () => local.leases.has(vm.sessionId!);
      h.environments.push(environment);
      return environment;
    },
    spawn,
    answers: async () => true,
    workerArgv: async () => argv,
  });
  try {
    const connect = async () => {
      const worker = await local.launch({
        workspace: root,
        artifact: "/fake/artifact",
        smolvm: "/fake/smolvm",
        sessionId: "remote",
      });
      const { session } = await RemoteWorkerSession.connect(
        "remote",
        "mock",
        mockLaunchSpec(root),
        () => worker,
        10_000,
      );
      return { worker, session };
    };
    const reply = async (session: RemoteWorkerSession, input: string) => {
      await session.send(input);
      for await (const event of session.events())
        if (event.type === "assistant_text") return event.text;
    };
    const options = { sessionId: "remote", cwd: root, mode: "default" as const, mcpServers: [] };
    const first = await connect();
    await first.session.start({ method: "create", args: [{ ...options, prompt: "" }] });
    assert.equal(await reply(first.session, "hello"), "hello");
    await first.session.close("idle_suspension");
    assert.deepEqual(h.environments.at(-1)!.reasons, ["idle_suspension"]);
    assert.deepEqual(h.environments.at(-1)!.busyAtClose, [false]);
    assert.equal(local.inspect("remote").phase, "stopped");

    const second = await connect();
    await second.session.start({
      method: "resume",
      args: [{ ...options, providerRef: first.session.providerRef! } as SessionRef],
    });
    assert.equal(second.session.providerRef, first.session.providerRef);
    // The worker dies on its own; its session fails with the execution's diagnosis.
    Deno.kill(second.worker.pid, "SIGKILL");
    await assert.rejects(
      (async () => {
        for await (const _ of second.session.events()) {
          /* until the worker dies */
        }
      })(),
      (error: unknown) =>
        error instanceof VmTerminationError &&
        error.termination.reason === "guest_exit" &&
        error.termination.guestExit?.signal === "SIGKILL",
    );
    await second.session.close();
    assert.deepEqual(h.environments.at(-1)!.closes, ["worker_failure"]);
    assert.equal(local.leases.has("remote"), false);
    assert.equal(local.inspect("remote").phase, "stopped");
  } finally {
    await local.close();
  }
});

/** A guest command that runs until released or cancelled, like a hook in the guest. */
const gatedCommands = () => {
  const calls: Array<{ command: string; state: string; env: Record<string, string> }> = [];
  let gate = Promise.withResolvers<void>();
  const command: IsolatedWorkerBackend["command"] = async (binding, command, _ms, signal, env) => {
    calls.push({ command, state: binding.state, env: env ?? {} });
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    await Promise.race([gate.promise, aborted]);
    return { code: 0, output: "ran " + command, timedOut: false };
  };
  return {
    calls,
    command,
    release: () => {
      gate.resolve();
      gate = Promise.withResolvers();
    },
  };
};
const shellRequest = { argv: guestShellArgv, stdin: true, tty: true };
const publisher = () => {
  const published: SessionExecutions[] = [];
  let withdrawn = 0;
  return {
    published,
    withdrawals: () => withdrawn,
    executions: (executions: SessionExecutions) => {
      published.push(executions);
      return () => void withdrawn++;
    },
  };
};

Deno.test("shells and hooks are independent executions beside the worker, each under its own lease", async () => {
  const guest = gatedCommands();
  await using h = await harness({ command: guest.command });
  const publish = publisher();
  const worker = await h.launch("session", { executions: publish.executions });
  const [environment] = h.environments;
  const [executions] = publish.published;
  assert(executions, "the running environment is published");
  assert.equal(executions.workspace, environment!.binding.workspace);
  // A shell is a client-run terminal execution in the same environment.
  const client = new AbortController();
  const shell = executions.open(shellRequest, client);
  assert.equal(shell.vm.executable, environment!.binding.smolvm);
  assert.deepEqual(shell.vm.args.slice(-guestShellArgv.length - 1), [
    "loom-exec",
    ...guestShellArgv,
  ]);
  assert(shell.vm.args.includes("-t"));
  // A daemon hook runs in the guest under its own lease while worker and shell go on.
  const hook = executions.command("make check", 1000, new AbortController().signal, {
    LOOM_HOOK: "check",
  });
  assert.deepEqual(guest.calls, [
    { command: "make check", state: environment!.binding.state, env: { LOOM_HOOK: "check" } },
  ]);
  guest.release();
  assert.deepEqual(await hook, { code: 0, output: "ran make check", timedOut: false });
  // Closing the shell, or losing its client, leaves the worker and its lease alone.
  executions.close(shell.token, client);
  const dropped = new AbortController();
  executions.open(shellRequest, dropped);
  dropped.abort();
  assert.deepEqual(h.children[0]!.kills, []);
  assert(h.launcher.leases.has("session"), "the worker keeps its own lease");
  assert.equal(h.children.length, 1);
  // With every shell and hook finished, ending the worker leaves no lease at all.
  worker.terminate("session_close");
  await worker.exited;
  assert.equal(h.launcher.leases.has("session"), false);
  assert.equal(publish.withdrawals(), 1, "withdrawn once the worker is reaped");
  assert.throws(() => executions.open(shellRequest, client), /not running/);
  await assert.rejects(executions.command("true", 1000, client.signal), /not running/);
  await worker.cleanup!();
  assert.deepEqual(environment!.reasons, ["session_close"]);
  assert.deepEqual(environment!.busyAtClose, [false]);
});

Deno.test("a VM ends under its open shells and running hooks, as the session VM did", async () => {
  for (const end of ["worker crash", "session close", "external stop"] as const) {
    const guest = gatedCommands();
    await using h = await harness({ command: guest.command });
    const publish = publisher();
    const session: Awaited<ReturnType<typeof h.launch>> = await h.launch("session", {
      executions: publish.executions,
      // The daemon's vmLifecycle.stop: close the session first.
      onStop: async () => {
        session.terminate("user_stop");
        await session.cleanup!();
      },
    });
    const [environment] = h.environments;
    const [executions] = publish.published;
    const client = new AbortController();
    executions!.open(shellRequest, client);
    const outcome = executions!.command("sleep 600", 60_000, new AbortController().signal).then(
      () => "completed",
      () => "cancelled",
    );
    if (end === "worker crash") h.children[0]!.exit(1);
    if (end === "session close") session.terminate("session_close");
    if (end === "external stop") await environment!.options.onStop!(() => true);
    await session.cleanup!();
    assert.equal(await outcome, "cancelled", end);
    // Every lease ended before the environment was stopped, once.
    assert.equal(environment!.closes.length, 1, end);
    assert.deepEqual(environment!.busyAtClose, [false], end);
    assert.equal(h.launcher.inspect("session").phase, "stopped", end);
    assert.throws(() => executions!.open(shellRequest, client), /not running/, end);
  }
});

Deno.test("a stale generation's executions never reach its replacement", async () => {
  await using h = await harness();
  const publish = publisher();
  const first = await h.launch("session", { executions: publish.executions });
  first.terminate("idle_suspension");
  await first.cleanup!();
  const second = await h.launch("session", { executions: publish.executions });
  const [old, current] = publish.published;
  assert.equal(publish.withdrawals(), 1);
  const client = new AbortController();
  assert.throws(() => old!.open(shellRequest, client), /not running/);
  await assert.rejects(old!.command("true", 1000, client.signal), /not running/);
  const shell = current!.open(shellRequest, client);
  assert.equal(shell.vm.env.HOME, join(h.environments[1]!.binding.state, "home"));
  current!.close(shell.token, client);
  second.terminate("session_close");
  await second.cleanup!();
});

/** Fixture credentials for each provider's real host-side owner, with injected renewal. */
const providers = {
  claude: {
    write: (profile: string, token: string, expiresAt: number) =>
      Deno.writeTextFile(
        join(profile, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: token,
            refreshToken: "host-only-refresh",
            expiresAt,
            scopes: ["user:inference"],
          },
        }),
      ),
    owner: (profile: string, refresh: () => Promise<void>) =>
      new ClaudeAuthOwner({ profile, cli: "unused", refresh, pollMs: 10 }),
    token: (value: SessionAuth) => value.claudeAiOauth?.accessToken,
  },
  codex: {
    write: (profile: string, token: string, expiresAt: number) =>
      Deno.writeTextFile(
        join(profile, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: `header.${btoa(JSON.stringify({ exp: expiresAt / 1000 }))}.${token}`,
            id_token: "identity",
            account_id: "account",
            refresh_token: "host-only-refresh",
          },
        }),
      ),
    owner: (profile: string, refresh: () => Promise<void>) =>
      new CodexAuthOwner({ profile, cli: "unused", refresh, pollMs: 10 }),
    token: (value: SessionAuth) => value.codexOauth?.accessToken.split(".")[2],
  },
};
for (const [kind, provider] of Object.entries(providers)) {
  Deno.test(`${kind} credentials renew into a running isolated session, and expiry ends it`, async () => {
    const profile = await Deno.makeTempDir();
    const hour = () => Date.now() + 3_600_000;
    await provider.write(profile, "initial", hour());
    let renewal: () => Promise<void> = () => provider.write(profile, "renewed", hour());
    const owner = provider.owner(profile, () => renewal());
    // What the runtime does for every VM launched with a credential owner: publish
    // snapshots into the VM's private credential file until the VM has gone.
    const delivered = new Map<FakeEnvironment, string[]>();
    await using h = await harness({
      launched: async (environment) => {
        const files: string[] = [];
        delivered.set(environment, files);
        const unsubscribe = await environment.options.authOwner!.subscribe(
          async (value) => {
            assert(!JSON.stringify(value).includes("host-only-refresh"));
            files.push(provider.token(value)!);
          },
          () => {
            environment.setStopReason("credential_expired");
            environment.crash();
          },
        );
        let done: Promise<void> | undefined;
        environment.teardown = () => (done ??= unsubscribe());
      },
    });
    const until = async (check: () => boolean, what: string) => {
      for (let i = 0; !check(); i++) {
        if (i > 500) throw new Error("Timed out: " + what);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      const worker = await h.launch("session", { authOwner: owner });
      const [environment] = h.environments;
      assert.equal(environment!.options.authOwner, owner);
      assert.equal(environment!.options.auth, undefined);
      assert.deepEqual(delivered.get(environment!), ["initial"]);
      // An early 401 forces renewal (refreshOnAuthFailure); the running VM receives
      // the new snapshot without restarting its worker.
      assert.equal(provider.token(await owner.current(true)), "renewed");
      await until(() => delivered.get(environment!)!.includes("renewed"), "renewal delivered");
      assert.deepEqual(h.children[0]!.kills, []);
      assert(h.launcher.leases.has("session"));
      assert.equal(h.environments.length, 1);
      // Renewal fails and the last delivered token expires: the VM ends, taking its
      // worker with it, and the session sees the credential reason.
      renewal = async () => {
        throw new Error("refresh unavailable");
      };
      await provider.write(profile, "expiring", Date.now() + 300);
      await until(() => delivered.get(environment!)!.includes("expiring"), "last token delivered");
      await worker.exited;
      const failure = await worker.failure!();
      assert(failure instanceof VmTerminationError, String(failure));
      assert.equal(failure.termination.hostReason, "credential_expired");
      assert.equal(h.launcher.leases.has("session"), false);
      assert.equal(h.launcher.inspect("session").phase, "stopped");
      assert.deepEqual(environment!.busyAtClose, [false]);
      // The ended VM's delivery stopped with it; a resumed session starts afresh from
      // the shared owner once the host credentials are valid again.
      const count = delivered.get(environment!)!.length;
      renewal = () => provider.write(profile, "renewed", hour());
      await provider.write(profile, "after-login", hour());
      const resumed = await h.launch("session", { authOwner: owner });
      const [, replacement] = h.environments;
      assert.deepEqual(delivered.get(replacement!), ["after-login"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(delivered.get(environment!)!.length, count);
      resumed.terminate("session_close");
      await resumed.cleanup!();
    } finally {
      await owner.close();
      await Deno.remove(profile, { recursive: true });
    }
  });
}
