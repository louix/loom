import assert from "node:assert/strict";
import { EnvironmentCoordinator } from "@loom/isolation/coordinator";
import { createVmEnvironmentCoordinator } from "@loom/runtime/environment-coordinator";
import { directoryEnvironmentStorage } from "../runtime/src/session-vm/environment-storage.ts";
import type { EnvironmentStorage } from "@loom/isolation/storage";
import type { EnvironmentVmOptions } from "@loom/runtime/environment-vm";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";
import type { vmCommand } from "../runtime/src/session-vm/command.ts";
import { ExecutionLeases } from "@loom/isolation/execution-leases";

const options = {
  mode: "execution" as const,
  workspace: "/workspace",
  artifact: "/runtime",
  smolvm: "/smolvm",
};
const shellCommand = {
  argv: ["/bin/sh", "-c", 'exec "${SHELL:-/bin/sh}" -i'],
  stdin: true,
  tty: true,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fixture = (leases = new ExecutionLeases(), storage?: EnvironmentStorage) => {
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const launches: EnvironmentVmOptions[] = [];
  const stops: string[] = [];
  let failCleanup = false;
  let command: typeof vmCommand = async () => ({ code: 0, output: "", timedOut: false });
  const environment = {
    binding: {
      workspace: options.workspace,
      artifact: options.artifact,
      smolvm: options.smolvm,
      state: "/tmp/environment-test",
      token: "fixture",
      version: 1,
    } as VmBinding,
    pid: 1,
    ready: ready.promise,
    exited: exited.promise,
    status: async () => ({ phase: "running", network: [] }),
    close: async (reason = "session_close") => {
      stops.push(reason);
      ready.reject(new Error("startup cancelled"));
      exited.resolve();
      if (failCleanup) throw new Error("reaping failed");
      await cleanup.promise;
    },
  };
  // Observe early cancellation even when the coordinator has not obtained the handle yet.
  void ready.promise.catch(() => {});
  const launchGate = Promise.withResolvers<void>();
  const backend = {
    launch: async (opts: EnvironmentVmOptions) => {
      launches.push(opts);
      await launchGate.promise;
      return environment;
    },
    command: (...args: Parameters<typeof vmCommand>) => command(...args),
  };
  const coordinator = createVmEnvironmentCoordinator(
    storage ?? {
      directory: (id) => "/state/" + id,
      withStopped: async (_id, action) => await action(),
    },
    backend,
    leases,
  );
  return {
    coordinator,
    ready,
    exited,
    cleanup,
    launchGate,
    launches,
    stops,
    setCommand: (run: typeof vmCommand) => {
      command = run;
    },
    failCleanup: (fail: boolean) => {
      failCleanup = fail;
    },
  };
};

Deno.test("coordinator deduplicates starts and blocks restart until cancellation cleanup finishes", async () => {
  const f = fixture();
  const first = f.coordinator.start("session", options);
  const second = f.coordinator.start("session", options);
  assert.equal(first, second);
  await tick();
  assert.equal(f.launches.length, 1);
  const stop = f.coordinator.stop("session");
  await assert.rejects(f.coordinator.start("session", options), /cleanup/);
  f.launchGate.resolve();
  await tick();
  assert.equal(f.stops.length, 1);
  assert.equal(f.coordinator.inspect("session").phase, "stopping");
  f.cleanup.resolve();
  await stop;
  await assert.rejects(first, /cancelled/);
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
  await f.coordinator.close();
});

Deno.test("command disconnect cancels execution but retains ownership until output settles", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  await f.coordinator.start("session", options);
  const owner = new AbortController();
  const drained = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  f.setCommand(async (_binding, _command, _timeout, stop) => {
    signal = stop;
    await drained.promise;
    return { code: 7, output: "unchanged\n", timedOut: false };
  });
  const command = f.coordinator.command("session", "exit 7", 1000, owner);
  assert.equal(f.coordinator.inspect("session").busy, true);
  assert.throws(() => f.coordinator.stop("session"), /active commands/);
  owner.abort();
  assert.equal(signal?.aborted, true);
  assert.equal(f.coordinator.inspect("session").busy, true);
  assert.throws(() => f.coordinator.stop("session"), /active commands/);
  drained.resolve();
  assert.deepEqual(await command, { code: 7, output: "unchanged\n", timedOut: false });
  assert.equal(f.coordinator.inspect("session").busy, false);
  f.cleanup.resolve();
  await f.coordinator.stop("session");
});

Deno.test("shell leases share ownership checks and shutdown cancels all executions", async () => {
  const leases = new ExecutionLeases();
  const f = fixture(leases);
  f.launchGate.resolve();
  f.ready.resolve();
  await f.coordinator.start("session", options);
  const owner = new AbortController();
  const shell = f.coordinator.openExecution("session", shellCommand, owner);
  assert("vm" in shell);
  assert.equal(shell.vm.executable, options.smolvm);
  assert(shell.vm.args.includes("-t"));
  assert.deepEqual(shell.vm.args.slice(-3), shellCommand.argv);
  assert.throws(() => leases.close(shell.token, new AbortController()), /another connection/);
  assert.throws(() => f.coordinator.stop("session"), /open shells/);
  owner.abort();
  assert.equal(leases.has("session"), false);
  f.coordinator.openExecution("session", shellCommand, new AbortController());
  const commandEnded = Promise.withResolvers<void>();
  f.setCommand(async (_binding, _command, _timeout, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await commandEnded.promise;
    return { code: 1, output: "", timedOut: false };
  });
  const command = f.coordinator.command("session", "sleep 100", 1000, new AbortController());
  let closed = false;
  const close = f.coordinator.close().then(() => {
    closed = true;
  });
  f.cleanup.resolve();
  await tick();
  assert.equal(closed, false, "shutdown waits for the command's output");
  assert.equal(leases.has("session"), true);
  commandEnded.resolve();
  await command;
  await close;
  assert.equal(leases.has("session"), false);
  await assert.rejects(f.coordinator.start("new", options), /shutting down/);
});

Deno.test("failed cleanup stays visible and blocks replacement until stop is retried", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  await f.coordinator.start("session", options);
  f.failCleanup(true);
  await assert.rejects(f.coordinator.stop("session"), /reaping failed/);
  assert.equal(f.coordinator.inspect("session").phase, "failed");
  await assert.rejects(f.coordinator.start("session", options), /cleanup/);
  f.failCleanup(false);
  f.cleanup.resolve();
  await f.coordinator.stop("session");
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
});

Deno.test("unexpected VM exit cancels owned commands and completes cleanup", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  await f.coordinator.start("session", options);
  f.setCommand(async (_binding, _command, _timeout, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw new Error("transport closed");
  });
  const command = f.coordinator.command("session", "sleep 100", 1000, new AbortController());
  f.exited.resolve();
  await assert.rejects(command, /transport closed/);
  await tick();
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
});

Deno.test("workspace mutation excludes starts and concurrent mutations until completion", async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const coordinator = createVmEnvironmentCoordinator(directoryEnvironmentStorage(directory));
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  try {
    const mutation = coordinator.withStopped("session", async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    await assert.rejects(coordinator.start("session", options), /workspace/);
    await assert.rejects(
      coordinator.withStopped("session", async () => {}),
      /already running/,
    );
    let closed = false;
    const close = coordinator.close().then(() => {
      closed = true;
    });
    await tick();
    assert.equal(closed, false);
    gate.resolve();
    await Promise.all([mutation, close]);
  } finally {
    gate.resolve();
    await coordinator.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("failed readiness waits for cleanup and never admits a command", async () => {
  const f = fixture();
  f.launchGate.resolve();
  const start = f.coordinator.start("session", options);
  f.ready.reject(new Error("activation failed"));
  await tick();
  await assert.rejects(
    f.coordinator.command("session", "true", 1000, new AbortController()),
    /not ready/,
  );
  let failed = false;
  const rejected = assert.rejects(start, /activation failed/).then(() => {
    failed = true;
  });
  assert.equal(f.coordinator.inspect("session").phase, "stopping");
  assert.equal(failed, false);
  f.cleanup.resolve();
  await rejected;
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
});

Deno.test("inventory stop honors execution leases before starting teardown", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  await f.coordinator.start("session", options);
  const owner = new AbortController();
  f.coordinator.openExecution("session", shellCommand, owner);
  const requestStop = f.launches[0]!.onStop!;
  await assert.rejects(
    requestStop(() => true),
    /open shells/,
  );
  assert.equal(f.coordinator.inspect("session").phase, "ready");
  owner.abort();
  await requestStop(() => true);
  assert.equal(f.coordinator.inspect("session").phase, "stopping");
  assert.throws(() => f.coordinator.openExecution("session", shellCommand, owner), /not ready/);
  f.cleanup.resolve();
  f.exited.resolve();
  await f.coordinator.close();
});

Deno.test("cancelling before launch begins does not create a VM", async () => {
  const f = fixture();
  const start = f.coordinator.start("session", options);
  await f.coordinator.stop("session");
  await assert.rejects(start, /cancelled/);
  assert.equal(f.launches.length, 0);
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
  await f.coordinator.close();
});

Deno.test("workspace hooks gate readiness and failed hooks retain no ready execution target", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.setCommand(async (_binding, _command, _timeout, _signal, env) => {
    assert.equal(env?.LOOM_SESSION_ID, "session");
    assert.equal(env?.LOOM_HOOK_EVENT, "workspace_start");
    entered.resolve();
    await finish.promise;
    return { code: 9, output: "setup failed", timedOut: false };
  });
  let capabilityCloses = 0;
  const started = f.coordinator.start("session", {
    ...options,
    capabilities: {
      failed: new Promise<never>(() => {}),
      close: async () => {
        capabilityCloses++;
      },
    },
    startHooks: [{ name: "setup", run: "setup", timeoutMs: 1000 }],
  });
  await entered.promise;
  assert.equal(f.coordinator.inspect("session").phase, "starting");
  assert.throws(
    () => f.coordinator.openExecution("session", shellCommand, new AbortController()),
    /not ready/,
  );
  finish.resolve();
  await assert.rejects(started, /setup.*exited 9/);
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
  assert.equal(capabilityCloses, 1);
});

Deno.test("stop cancels workspace hooks and waits for their process to settle", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  let reentrant: Promise<void> | undefined;
  f.setCommand(async (_binding, _command, _timeout, signal) => {
    signal.addEventListener(
      "abort",
      () => {
        reentrant = f.coordinator.stop("session");
      },
      { once: true },
    );
    entered.resolve(signal);
    await finish.promise;
    signal.throwIfAborted();
    return { code: 0, output: "", timedOut: false };
  });
  const started = f.coordinator.start("session", {
    ...options,
    startHooks: [{ name: "setup", run: "setup", timeoutMs: 1000 }],
  });
  const signal = await entered.promise;
  let stopped = false;
  const stop = f.coordinator.stop("session");
  void stop.then(() => {
    stopped = true;
  });
  assert.equal(reentrant, stop, "synchronous abort listeners share the published cleanup");
  assert(signal.aborted);
  await tick();
  assert.equal(stopped, false);
  finish.resolve();
  await stop;
  await assert.rejects(started);
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
  assert.equal(f.stops.length, 1);
});

Deno.test("native agents exclude each other while allowing ordinary commands", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  const owner = new AbortController();
  const command = { argv: ["claude"], stdin: true, tty: false };
  try {
    await f.coordinator.start("session", options);
    const agent = f.coordinator.openExecution("session", command, owner, "agent");
    assert.throws(
      () => f.coordinator.openExecution("session", command, new AbortController(), "agent"),
      /already running/,
    );
    const shell = f.coordinator.openExecution("session", shellCommand, owner);
    f.coordinator.closeExecution(shell.token, owner);
    assert.throws(() => f.coordinator.stop("session"), /active commands/);
    f.coordinator.closeExecution(agent.token, owner);
    const resumed = f.coordinator.openExecution("session", command, owner, "agent");
    f.coordinator.closeExecution(resumed.token, owner);
  } finally {
    owner.abort();
    await f.coordinator.close();
  }
});

Deno.test("capability death stops its VM and cleanup failure remains retryable", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  const failed = Promise.withResolvers<unknown>();
  let closes = 0;
  await f.coordinator.start("session", {
    ...options,
    capabilities: {
      failed: failed.promise,
      close: async () => {
        if (++closes === 1) throw new Error("tool cleanup failed");
      },
    },
  });
  failed.resolve("tool died");
  await tick();
  assert.equal(f.coordinator.inspect("session").phase, "failed");
  assert(f.stops.includes("worker_failure"));
  await f.coordinator.stop("session");
  assert.equal(f.coordinator.inspect("session").phase, "stopped");
  assert.equal(closes, 2);
});

Deno.test("explicit storage owns launch paths and gates stopped-state mutations without a repository", async () => {
  const directory = "/external-runtime/environments/opaque-id";
  const locked: string[] = [];
  let deny = true;
  let held = false;
  const f = fixture(new ExecutionLeases(), {
    directory: (id) => {
      assert.equal(id, "session");
      return directory;
    },
    withStopped: async (id, action) => {
      locked.push(id);
      if (deny) throw new Error("State is owned by another process");
      held = true;
      try {
        return await action();
      } finally {
        held = false;
      }
    },
  });
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  try {
    await f.coordinator.start("session", options);
    assert.equal(f.launches[0]!.sessionDirectory, directory);
    assert.equal(f.launches[0]!.repoRoot, undefined);
    let mutated = false;
    await assert.rejects(
      f.coordinator.withStopped("session", async () => {
        mutated = true;
      }),
      /another process/,
    );
    assert.equal(mutated, false);
    assert.equal(f.coordinator.inspect("session").phase, "stopped");
    deny = false;
    const result = await f.coordinator.withStopped("session", async () => {
      assert(held);
      await assert.rejects(f.coordinator.start("session", options), /workspace/);
      return "changed";
    });
    assert.equal(result, "changed");
    assert.equal(held, false);
    assert.deepEqual(locked, ["session", "session"]);
  } finally {
    await f.coordinator.close();
  }
});

Deno.test("exclusive workspace commands block new execution and retain ownership through cancellation", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  await f.coordinator.start("session", options);
  const owner = new AbortController();
  const shell = f.coordinator.openExecution("session", shellCommand, owner);
  await assert.rejects(
    f.coordinator.exclusiveCommand("session", "rebase", 1000, owner),
    /active commands/,
  );
  f.coordinator.closeExecution(shell.token, owner);
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  f.setCommand(async (_binding, _command, _timeout, signal) => {
    entered.resolve(signal);
    await finish.promise;
    signal.throwIfAborted();
    return { code: 0, output: "", timedOut: false };
  });
  const command = f.coordinator.exclusiveCommand("session", "rebase", 1000, owner);
  void command.catch(() => {});
  const signal = await entered.promise;
  assert.throws(
    () => f.coordinator.openExecution("session", shellCommand, new AbortController()),
    /not ready/,
  );
  await assert.rejects(
    f.coordinator.command("session", "inspect", 1000, new AbortController()),
    /not ready/,
  );
  await assert.rejects(f.coordinator.start("session", options), /workspace/);
  await assert.rejects(
    f.coordinator.withStopped("session", async () => {}),
    /lifecycle/,
  );
  assert.throws(() => f.coordinator.stop("session"), /active commands/);
  owner.abort();
  assert(signal.aborted);
  assert.equal(f.coordinator.inspect("session").busy, true);
  let closed = false;
  const closing = f.coordinator.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  finish.resolve();
  await assert.rejects(command);
  await closing;
  assert.equal(f.coordinator.inspect("session").busy, false);
});

Deno.test("start owns per-attempt capabilities through reuse, rejection and backend cleanup retries", async () => {
  const f = fixture();
  f.launchGate.resolve();
  f.ready.resolve();
  f.cleanup.resolve();
  const resources = () => {
    let closes = 0;
    return {
      failed: new Promise<never>(() => {}),
      close: async () => {
        closes++;
      },
      get closes() {
        return closes;
      },
    };
  };
  const live = resources();
  const first = f.coordinator.start("session", { ...options, capabilities: live });
  assert.equal(f.coordinator.start("session", { ...options, capabilities: live }), first);
  const unused = resources();
  await f.coordinator.start("session", { ...options, capabilities: unused });
  assert.equal(unused.closes, 1);
  assert.equal(live.closes, 0);
  f.failCleanup(true);
  await assert.rejects(f.coordinator.stop("session"), /reaping failed/);
  assert.equal(live.closes, 1);
  const rejected = resources();
  await assert.rejects(
    f.coordinator.start("session", { ...options, capabilities: rejected }),
    /cleanup/,
  );
  assert.equal(rejected.closes, 1);
  f.failCleanup(false);
  await f.coordinator.stop("session");
  assert.equal(
    live.closes,
    1,
    "successful capability cleanup is not repeated after backend failure",
  );
  await f.coordinator.close();
  const closed = resources();
  await assert.rejects(
    f.coordinator.start("other", { ...options, capabilities: closed }),
    /shutting down/,
  );
  assert.equal(closed.closes, 1);
});

Deno.test("start disposes capabilities if storage admission or workspace ownership rejects", async () => {
  const f = fixture(new ExecutionLeases(), {
    directory() {
      throw new Error("directory unavailable");
    },
    withStopped: async (_id, action) => await action(),
  });
  let closes = 0;
  const capabilities = () => ({
    failed: new Promise<never>(() => {}),
    close: async () => {
      closes++;
    },
  });
  await assert.rejects(
    f.coordinator.start("session", { ...options, capabilities: capabilities() }),
    /directory unavailable/,
  );
  assert.equal(closes, 1);
  const cleanupFailure = new Error("capability cleanup failed");
  await assert.rejects(
    f.coordinator.start("session", {
      ...options,
      capabilities: {
        failed: new Promise<never>(() => {}),
        close: async () => {
          throw cleanupFailure;
        },
      },
    }),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.match(error.errors[0].message, /directory unavailable/);
      assert.equal(error.errors[1], cleanupFailure);
      return true;
    },
  );
  const gate = Promise.withResolvers<void>();
  const mutation = f.coordinator.withStopped("session", () => gate.promise);
  await assert.rejects(
    f.coordinator.start("session", { ...options, capabilities: capabilities() }),
    /workspace/,
  );
  assert.equal(closes, 2);
  gate.resolve();
  await mutation;
  await f.coordinator.close();
  assert.equal(f.launches.length, 0);
});

Deno.test("inventory cancellation during initialization cannot revive or stop a replacement generation", async () => {
  const callbacks: Array<(isCurrent: () => boolean) => Promise<void>> = [];
  const closes: number[] = [];
  const coordinator = new EnvironmentCoordinator(
    {
      directory: (id) => "/environments/" + id,
      withStopped: async (_id, action) => await action(),
    },
    async ({ onStop }) => {
      const generation = callbacks.length;
      callbacks.push(onStop);
      return {
        ready: Promise.resolve(),
        exited: new Promise<never>(() => {}),
        initialize() {
          // This callback executes before initialize returns its promise.
          return generation === 0 ? onStop(() => true) : Promise.resolve();
        },
        async close() {
          closes.push(generation);
        },
        async command() {
          return { code: 0, output: "", timedOut: false };
        },
        execution: () => ({}),
      };
    },
  );
  await assert.rejects(coordinator.start("session", {}), /cancelled/);
  assert.equal(coordinator.inspect("session").phase, "stopped");
  await coordinator.start("session", {});
  await callbacks[0]!(() => true);
  assert.equal(coordinator.inspect("session").phase, "ready");
  assert.deepEqual(closes, [0]);
  await coordinator.stop("session");
  assert.deepEqual(closes, [0, 1]);
});
