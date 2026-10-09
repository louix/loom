import assert from "node:assert/strict";
import { createVmEnvironmentCoordinator } from "@loom/runtime/environment-coordinator";
import {
  configuredEnvironment,
  type ConfigureEnvironment,
} from "../runtime/src/session-vm/configured-environment.ts";
import type { EnvironmentVmOptions, launchEnvironmentVm } from "@loom/runtime/environment-vm";
import type { vmCommand } from "../runtime/src/session-vm/command.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";

const base = {
  mode: "inspection" as const,
  workspace: "/workspace/checkout",
  repoRoot: "/repo",
  artifact: "/runtime",
  smolvm: "/smolvm",
  clone: { branch: "work", base: "main", identity: { name: "User", email: "user@example.com" } },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fixture = () => {
  const events: string[] = [];
  const secondLaunch = Promise.withResolvers<void>();
  const secondReady = Promise.withResolvers<void>();
  const capabilityFailed = Promise.withResolvers<unknown>();
  let launched = 0;
  let failClose = false;
  let capabilityCloses = 0;
  const launch: typeof launchEnvironmentVm = async (options: EnvironmentVmOptions) => {
    const index = ++launched;
    events.push("launch" + index);
    assert.equal(options.sessionDirectory, "/state/id");
    assert.equal(options.sessionId, "id");
    if (index === 2) await secondLaunch.promise;
    const ended = Promise.withResolvers<void>();
    const ready = index === 1 ? Promise.resolve() : secondReady.promise;
    return {
      binding: { ...options, state: "/state/" + index, token: String(index) } as VmBinding,
      pid: index,
      ready,
      exited: ended.promise,
      status: async () => ({ phase: "running", network: [] }),
      close: async () => {
        events.push("close" + index);
        if (failClose) throw new Error("cleanup failed");
        if (index === 2) secondReady.reject(new Error("stopped"));
        ended.resolve();
      },
    };
  };
  void secondReady.promise.catch(() => {});
  const command: typeof vmCommand = async (binding, source) => {
    events.push("command" + binding.token + ":" + source);
    return { code: 0, output: "intent", timedOut: false };
  };
  const coordinator = createVmEnvironmentCoordinator(
    {
      directory: () => "/state/id",
      withStopped: async (_id, fn) => await fn(),
    },
    { launch, command },
  );
  const capabilities = {
    failed: capabilityFailed.promise,
    close: async () => {
      capabilityCloses++;
    },
  };
  return {
    coordinator,
    backend: { launch, command },
    events,
    secondLaunch,
    secondReady,
    capabilityFailed,
    capabilities,
    get capabilityCloses() {
      return capabilityCloses;
    },
    failClose(value: boolean) {
      failClose = value;
    },
  };
};

Deno.test("clone configuration and hooks complete before execution; replacement follows full cleanup", async () => {
  const f = fixture();
  f.secondLaunch.resolve();
  f.secondReady.resolve();
  try {
    await f.coordinator.start("id", {
      ...base,
      configure: async (command: Parameters<ConfigureEnvironment>[0]) => {
        assert.equal(f.coordinator.inspect("id").phase, "starting");
        await assert.rejects(
          f.coordinator.command("id", "too early", 100, new AbortController()),
          /not ready/,
        );
        assert.equal((await command("inspect", 100)).output, "intent");
        return {
          ...base,
          capabilities: f.capabilities,
          startHooks: [{ name: "ready", run: "hook", timeoutMs: 100 }],
        };
      },
    });
    assert.deepEqual(f.events, [
      "launch1",
      "command1:inspect",
      "close1",
      "launch2",
      "command2:hook",
    ]);
    await f.coordinator.command("id", "work", 100, new AbortController());
    assert.equal(f.events.at(-1), "command2:work");
    f.capabilityFailed.resolve("MCP died");
    await tick();
    assert.equal(f.coordinator.inspect("id").phase, "stopped");
    assert.equal(f.capabilityCloses, 1);
    assert.equal(f.events.at(-1), "close2");
  } finally {
    await f.coordinator.close();
  }
});

for (const phase of ["configure", "launch", "ready"] as const) {
  Deno.test("clone cancellation drains " + phase + " before releasing ownership", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const configured = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const started = f.coordinator.start("id", {
      ...base,
      configure: async (_command: Parameters<ConfigureEnvironment>[0], stop: AbortSignal) => {
        signal = stop;
        entered.resolve(stop);
        await configured.promise;
        return { ...base, capabilities: f.capabilities };
      },
    });
    void started.catch(() => {});
    await entered.promise;
    if (phase !== "configure") {
      configured.resolve();
      await tick();
    }
    if (phase === "ready") {
      f.secondLaunch.resolve();
      await tick();
    }
    let stopped = false;
    const stopping = f.coordinator.stop("id").then(() => {
      stopped = true;
    });
    assert(signal?.aborted);
    if (phase !== "ready") {
      await tick();
      assert.equal(stopped, false);
      assert.equal(f.coordinator.inspect("id").phase, "stopping");
    }
    configured.resolve();
    f.secondLaunch.resolve();
    await stopping;
    await assert.rejects(started);
    assert.equal(f.coordinator.inspect("id").phase, "stopped");
    assert.equal(f.capabilityCloses, 1);
    assert.equal(f.events.includes("launch2"), phase !== "configure");
    if (phase !== "configure") assert(f.events.includes("close2"));
    await f.coordinator.close();
  });
}

Deno.test("inspection rejects credentials before launch and preserves failed cleanup for retry", async () => {
  const f = fixture();
  const configure = async () => ({ ...base, capabilities: f.capabilities });
  await assert.rejects(
    Reflect.apply(f.coordinator.start, f.coordinator, ["id", { ...base, configure, auth: {} }]),
    /credential-free/,
  );
  assert.equal(f.events.length, 0);
  f.failClose(true);
  await assert.rejects(f.coordinator.start("id", { ...base, configure }), /cleanup failed/);
  assert.equal(f.coordinator.inspect("id").phase, "failed");
  assert(!f.events.includes("launch2"));
  assert.equal(f.capabilityCloses, 1);
  f.failClose(false);
  await f.coordinator.stop("id");
  assert.equal(f.coordinator.inspect("id").phase, "stopped");
  assert.equal(f.capabilityCloses, 1, "retry does not dispose released capabilities again");
  await f.coordinator.close();
});

Deno.test("configured cleanup shares concurrent attempts and retries only failed capability disposal", async () => {
  const f = fixture();
  f.secondLaunch.resolve();
  f.secondReady.resolve();
  const initial = await f.backend.launch({
    ...base,
    sessionId: "id",
    sessionDirectory: "/state/id",
  });
  const disposal = Promise.withResolvers<void>();
  const failure = new Error("capability cleanup failed");
  let attempts = 0;
  const environment = configuredEnvironment(
    initial,
    async () => ({
      ...base,
      sessionId: "id",
      sessionDirectory: "/state/id",
      capabilities: {
        failed: new Promise(() => {}),
        close: async () => {
          if (++attempts === 1) await disposal.promise;
        },
      },
    }),
    {
      ...f.backend,
      launch: (options) =>
        f.backend.launch({ ...options, sessionId: "id", sessionDirectory: "/state/id" }),
    },
  );
  await environment.initialize(new AbortController().signal);
  const closing = environment.close("session_close");
  assert.equal(environment.close("session_close"), closing);
  await tick();
  assert.equal(attempts, 1);
  const rejected = assert.rejects(closing, (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  disposal.reject(failure);
  await rejected;
  assert.deepEqual(f.events, ["launch1", "close1", "launch2", "close2"]);
  const retry = environment.close("session_close");
  assert.equal(environment.close("session_close"), retry);
  await retry;
  await environment.close("session_close");
  assert.equal(attempts, 2);
  assert.deepEqual(f.events, ["launch1", "close1", "launch2", "close2"]);
});

Deno.test("failed VM cleanup still drains late configuration and consumes its capabilities", async () => {
  const f = fixture();
  const initial = await f.backend.launch({
    ...base,
    sessionId: "id",
    sessionDirectory: "/state/id",
  });
  const configured = Promise.withResolvers<void>();
  const environment = configuredEnvironment(
    initial,
    async () => {
      await configured.promise;
      return { ...base, capabilities: f.capabilities };
    },
    {
      ...f.backend,
      launch: (options) =>
        f.backend.launch({ ...options, sessionId: "id", sessionDirectory: "/state/id" }),
    },
  );
  const initialized = environment.initialize(new AbortController().signal);
  const cancelled = assert.rejects(initialized);
  f.failClose(true);
  let settled = false;
  const closing = environment.close("session_close");
  const rejected = assert.rejects(closing, /cleanup failed/).then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "failed VM disposal does not abandon pending acquisition");
  configured.resolve();
  await Promise.all([rejected, cancelled]);
  assert.equal(f.capabilityCloses, 1);
  assert.deepEqual(f.events, ["launch1", "close1"]);
  f.failClose(false);
  await environment.close("session_close");
  assert.equal(f.capabilityCloses, 1);
  assert.deepEqual(f.events, ["launch1", "close1", "close1"]);
});
