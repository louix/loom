import assert from "node:assert/strict";
import {
  selectSessionVmLauncher,
  withVmSessions,
  type SessionVmLauncher,
} from "../backend/daemon/src/daemon/vm-provider.ts";
import { startupSignal } from "../backend/daemon/src/daemon/startup.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";
import type { SessionVmOptions } from "../runtime/src/session-vm/launch.ts";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { AgentProvider, CreateSessionOptions } from "../core/src/types.ts";

Deno.test("the launcher switch selects the isolation adapter only when configured", async () => {
  assert.equal(normalizeConfig({}).isolation.launcher, "legacy");
  assert.equal(
    normalizeConfig({ session: { isolation: { launcher: "isolation" } } }).isolation.launcher,
    "isolation",
  );
  assert.throws(() => normalizeConfig({ session: { isolation: { launcher: "remote" } } }));
  const policy = { artifact: "/fake", smolvm: "/fake", repoRoot: "/fake" };
  const legacy = selectSessionVmLauncher(policy);
  const isolated = selectSessionVmLauncher({ ...policy, launcher: "isolation" });
  assert(!("inspect" in legacy));
  assert("inspect" in isolated);
  await Promise.all([legacy.close(), isolated.close()]);
  // Only the isolation adapter receives the startup signal; it owns the whole boot.
  for (const launcher of ["legacy", "isolation"] as const) {
    const state = await Deno.makeTempDir();
    const previous = Deno.env.get("XDG_STATE_HOME");
    Deno.env.set("XDG_STATE_HOME", state);
    try {
      const seen: Array<SessionVmOptions & { signal?: AbortSignal }> = [];
      const fake = (): SessionVmLauncher => ({
        async launch(options) {
          seen.push(options);
          throw new Error("fixture launch failure");
        },
        async close() {},
      });
      const provider = await withVmSessions(
        new FakeProvider(),
        {
          id: "aisdk",
          logger: makeLogger("session-vm-launcher-test"),
          config: {
            sessionVm: { ...policy, repoRoot: state, smolvm: Deno.execPath(), launcher },
            baseUrl: "https://api.openai.com",
          },
          transcript: { load: () => [], count: () => 0, replaceFrom: () => {} } as never,
        },
        "aisdk",
        (vm) => {
          assert.equal(vm.launcher, launcher);
          return fake();
        },
      );
      const signal = new AbortController().signal;
      await assert.rejects(
        provider.createSession({
          sessionId: "session",
          cwd: state,
          prompt: "",
          mode: "default",
          mcpServers: [],
          [startupSignal]: signal,
        } as CreateSessionOptions),
        /fixture launch failure/,
      );
      assert.equal(seen[0]!.signal, launcher === "isolation" ? signal : undefined);
      await (provider as AgentProvider).close?.();
    } finally {
      if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", previous);
      await Deno.remove(state, { recursive: true });
    }
  }
});
