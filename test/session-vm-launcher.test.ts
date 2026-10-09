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
import type { AgentProvider, CreateSessionOptions, SessionRef } from "../core/src/types.ts";
import type { SessionExecutions } from "../core/src/connector.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createIsolatedWorkerLauncher } from "../backend/daemon/src/daemon/isolated-worker.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import type { EnvironmentVmOptions } from "../runtime/src/session-vm/environment-launch.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { ClaudeAuthOwner } from "../backend/daemon/src/daemon/claude-auth.ts";
import { CodexAuthOwner } from "../backend/daemon/src/daemon/codex-auth.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const kind of ["claude", "codex", "aisdk"] as const) {
  Deno.test(`${kind} sessions on the isolation launcher keep their credentials, egress, MCP mapping and executions`, async () => {
    const state = await Deno.makeTempDir();
    const previous = Deno.env.get("XDG_STATE_HOME");
    Deno.env.set("XDG_STATE_HOME", state);
    const workspace = await Deno.realPath(await Deno.makeTempDir());
    const environments: Array<{ options: EnvironmentVmOptions; closed: boolean }> = [];
    const published: SessionExecutions[] = [];
    let withdrawn = 0;
    const provider = await withVmSessions(
      new FakeProvider(),
      {
        id: kind,
        logger: makeLogger("isolation-parity-test"),
        config: {
          sessionVm: {
            repoRoot: state,
            artifact: state,
            smolvm: Deno.execPath(),
            launcher: "isolation",
          },
          configDir: state,
          codexCliPath: Deno.execPath(),
        },
        transcript: new WorkerTranscript("session", () => {}),
        vmLifecycle: {
          stop: async () => {},
          activity: () => "running",
          executions: (_id, executions) => {
            published.push(executions);
            return () => void withdrawn++;
          },
        },
      },
      kind,
      (vm) =>
        createIsolatedWorkerLauncher(vm.repoRoot, {
          // A ready environment; the scripted connector worker stands in for its guest worker.
          async launch(options) {
            const exited = Promise.withResolvers<void>();
            const record = { options, closed: false };
            environments.push(record);
            await Deno.mkdir(options.sessionDirectory!, { recursive: true });
            return {
              binding: { workspace, smolvm: "/fake/smolvm", state } as VmBinding,
              pid: 1,
              ready: Promise.resolve(),
              exited: exited.promise,
              status: async () => ({ phase: "running", network: [] }),
              async close() {
                record.closed = true;
                exited.resolve();
              },
            };
          },
          workerArgv: async () => ["/fake/guest-worker"],
          spawn: () =>
            new Deno.Command(Deno.execPath(), {
              args: [
                "run",
                "-A",
                "--quiet",
                "--config=" + join(root, "deno.json"),
                join(root, "test/fixtures/connector-worker.ts"),
              ],
              stdin: "piped",
              stdout: "piped",
              stderr: "piped",
            }).spawn(),
        }),
    );
    const options: CreateSessionOptions = {
      sessionId: "session",
      cwd: workspace,
      prompt: "",
      mode: "default",
      mcpServers: [
        { name: "tools", spec: { transport: "http", url: "http://127.0.0.1:4567/mcp" } },
      ],
    };
    try {
      const created = await provider.createSession(options);
      const [environment] = environments;
      const launched = environment!.options;
      // The same trusted composition as the session VM path.
      const owner = launched.authOwner;
      if (kind === "codex") assert(owner instanceof CodexAuthOwner);
      else if (
        kind === "claude" &&
        !Deno.env.get("ANTHROPIC_API_KEY") &&
        !Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN")
      )
        assert(owner instanceof ClaudeAuthOwner);
      else assert.equal(owner, undefined);
      if (owner) assert.equal(launched.auth, undefined);
      assert.deepEqual(launched.providerHosts, [
        { claude: "api.anthropic.com", codex: "chatgpt.com", aisdk: "api.openai.com" }[kind],
      ]);
      assert.deepEqual(launched.mcpRelays, [{ port: 4567, guestPort: 3130 }]);
      assert.equal(launched.sessionDirectory, sessionVmDirectory(state, "session"));
      // The running environment's executions are published for shells, hooks and inspection.
      assert.equal(published.length, 1);
      assert.equal(published[0]!.workspace, workspace);
      await created.send("hello");
      for await (const event of created.events()) if (event.type === "assistant_text") break;
      await created.close("idle_suspension");
      assert.equal(withdrawn, 1);
      assert.equal(environment!.closed, true);
      // A resume boots a fresh environment from saved history.
      const ref = "12345678-1234-1234-1234-123456789abc";
      const dir = sessionVmDirectory(state, "session");
      if (kind === "claude") {
        await Deno.mkdir(join(dir, "profile/projects/loom-session"), { recursive: true });
        await Deno.writeTextFile(join(dir, `profile/projects/loom-session/${ref}.jsonl`), "{}");
      } else if (kind === "codex") {
        await Deno.mkdir(join(dir, "profile/sessions"), { recursive: true });
        await Deno.writeTextFile(join(dir, "codex-ref"), ref);
      }
      const resumed = await provider.resumeSession({ ...options, providerRef: ref } as SessionRef);
      assert.equal(environments.length, 2);
      assert.equal(environments[1]!.options.authOwner, owner, "one owner per provider");
      assert.equal(published.length, 2);
      await resumed.close();
      assert.equal(withdrawn, 2);
      // A failed create stops its environment again.
      await assert.rejects(
        provider.createSession({ ...options, prompt: "fail-create" }),
        /worker create failed/,
      );
      assert.equal(environments[2]!.closed, true);
      assert.equal(withdrawn, 3);
    } finally {
      await (provider as AgentProvider).close?.();
      if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", previous);
      await Deno.remove(state, { recursive: true });
      await Deno.remove(workspace, { recursive: true });
    }
  });
}

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
