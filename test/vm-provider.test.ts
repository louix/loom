import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withVmSessions } from "../backend/daemon/src/daemon/vm-provider.ts";
import {
  type createSessionVmLauncher,
  type SessionVmOptions,
} from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { launchLocalWorker, mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { AgentProvider, CreateSessionOptions } from "../core/src/types.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const kind of ["claude", "codex", "aisdk"] as const) {
  Deno.test(`${kind} VM routing preserves create/resume, MCP remapping and failed-start cleanup`, async () => {
    const root = await Deno.makeTempDir();
    const previous = Deno.env.get("XDG_STATE_HOME");
    Deno.env.set("XDG_STATE_HOME", root);
    const launches: SessionVmOptions[] = [];
    const requests: string[] = [];
    let cleaned = 0;
    const workers: Array<
      Awaited<ReturnType<ReturnType<typeof createSessionVmLauncher>["launch"]>>
    > = [];
    const createLauncher: typeof createSessionVmLauncher = () => ({
      async launch(options) {
        launches.push(options);
        options.onProgress?.("booting fixture");
        await Deno.mkdir(options.sessionDirectory!, { recursive: true });
        await Deno.writeTextFile(join(root, "base-generation"), "generation-1");
        const proc = launchLocalWorker({
          ...mockLaunchSpec(cwd),
          entrypoint: join(cwd, "test/fixtures/connector-worker.ts"),
        });
        const writer = proc.input.getWriter();
        let done = false;
        const worker = {
          ...proc,
          input: new WritableStream<Uint8Array>({
            async write(chunk) {
              requests.push(new TextDecoder().decode(chunk));
              await writer.write(chunk);
            },
            close: () => writer.close(),
          }),
          binding: { state: root },
          exitCode: proc.exited.then(() => 0),
          status: async () => ({ phase: "ready", network: [] }),
          async cleanup() {
            if (!done) {
              cleaned++;
              done = true;
            }
            await proc.exited;
          },
        } as unknown as (typeof workers)[number];
        workers.push(worker);
        return worker;
      },
      async close() {
        for (const worker of workers) {
          worker.terminate();
          await worker.cleanup?.();
        }
      },
    });
    const progress: string[] = [];
    const generations: string[] = [];
    const base: AgentProvider = new FakeProvider();
    const clone = {
      branch: "loom/session",
      base: "main",
      identity: { name: "Loom (test)", email: "loom+test@localhost" },
    };
    const provider = await withVmSessions(
      base,
      {
        id: kind,
        logger: makeLogger("vm-routing-test"),
        config: {
          sessionVm: {
            repoRoot: root,
            artifact: root,
            smolvm: Deno.execPath(),
            extraAllowedHosts: ["registry.npmjs.org"],
          },
          cliPath: Deno.execPath(),
          codexCliPath: Deno.execPath(),
          configDir: root,
        },
        transcript: new WorkerTranscript("session", () => {}),
        onStartupProgress: (_, message) => progress.push(message),
        onVmStarted: (_, generation) => generations.push(generation),
        vmLifecycle: {
          stop: async () => {},
          activity: () => "running",
          // Only the daemon knows which sessions work in a clone.
          clone: (id) => (id === "session" ? clone : undefined),
        },
      },
      kind,
      createLauncher,
    );
    const options: CreateSessionOptions = {
      sessionId: "session",
      cwd,
      prompt: "hello",
      mode: "default",
      mcpServers: [
        {
          name: "tools",
          spec: {
            transport: "http",
            url: "http://127.0.0.1:4567/mcp",
            headers: { Authorization: "Bearer fixture" },
          },
        },
      ],
    };
    try {
      const utility = await provider.createSession({
        ...options,
        sessionId: "utility",
        oneShot: true,
      });
      await utility.close();
      assert.equal(launches.length, 0);
      const created = await provider.createSession(options);
      await created.close();
      assert.deepEqual(launches[0]!.mcpRelays, [{ port: 4567, guestPort: 3130 }]);
      assert.deepEqual(launches[0]!.clone, clone);
      assert.deepEqual(launches[0]!.extraAllowedHosts, ["registry.npmjs.org"]);
      assert.equal(
        !!launches[0]!.authOwner,
        kind === "codex" ||
          (kind === "claude" &&
            !Deno.env.get("ANTHROPIC_API_KEY") &&
            !Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN")),
      );
      if (kind !== "claude")
        assert.deepEqual(launches[0]!.providerHosts, [
          kind === "codex" ? "chatgpt.com" : "api.openai.com",
        ]);
      const frames = requests
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        frames.find((f) => f.method === "initialize").args[0].connector,
        `@loom/connector-${{ codex: "chatgpt", aisdk: "generic", claude: "claude" }[kind]}`,
      );
      assert.equal(
        frames.find((f) => f.method === "create").args[0].mcpServers[0].spec.url,
        "http://127.0.0.1:3130/mcp",
      );
      assert(progress.includes("booting fixture") && progress.includes("Session ready."));
      assert.deepEqual(generations, ["generation-1"]);
      const dir = sessionVmDirectory(root, "session");
      const ref = "12345678-1234-1234-1234-123456789abc";
      if (kind !== "aisdk") {
        await assert.rejects(
          provider.resumeSession({ ...options, providerRef: ref }),
          /No saved VM history/,
        );
        assert.equal(launches.length, 1);
      }
      if (kind === "claude") {
        await Deno.mkdir(join(dir, "profile/projects/loom-session"), { recursive: true });
        await Deno.writeTextFile(
          join(dir, `profile/projects/loom-session/${ref}.jsonl`),
          "history",
        );
      } else if (kind === "codex") {
        await Deno.mkdir(join(dir, "profile/sessions"), { recursive: true });
        await Deno.writeTextFile(join(dir, "codex-ref"), ref);
      }
      const resumed = await provider.resumeSession({ ...options, providerRef: ref });
      await resumed.close();
      assert.equal(launches.length, 2);
      const before = cleaned;
      await assert.rejects(
        provider.createSession({ ...options, prompt: "fail-create" }),
        /worker create failed/,
      );
      assert.equal(cleaned, before + 1);
      await assert.rejects(
        provider.createSession({
          ...options,
          mcpServers: [
            { name: "bad", spec: { transport: "http", url: "https://external.invalid/mcp" } },
          ],
        }),
        /loopback/,
      );
      assert.equal(launches.length, 3);
    } finally {
      await provider.close?.();
      if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", previous);
      await Deno.remove(root, { recursive: true });
    }
  });
}
