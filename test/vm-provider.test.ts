// test-run: own-process — points XDG_STATE_HOME at its fixture for daemon code that reads Deno.env.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  stageSkills,
  withVmSessions,
  type SessionVmLauncher,
} from "../backend/daemon/src/daemon/vm-provider.ts";
import type { SessionVmOptions } from "../runtime/src/session-vm/launch.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { launchLocalWorker, mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { AgentProvider, CreateSessionOptions } from "../core/src/types.ts";
import {
  sessionGitIdentity,
  type SessionGitIdentity,
} from "../backend/daemon/src/config/git-identity.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const kind of ["claude", "codex", "aisdk"] as const) {
  Deno.test(`${kind} VM routing preserves create/resume, MCP remapping and failed-start cleanup`, async () => {
    const root = await Deno.makeTempDir();
    const previous = Deno.env.get("XDG_STATE_HOME");
    Deno.env.set("XDG_STATE_HOME", root);
    const previousConfig = Deno.env.get("XDG_CONFIG_HOME");
    Deno.env.set("XDG_CONFIG_HOME", root);
    const launches: SessionVmOptions[] = [];
    const guestPorts = [{ guest: 3000 }];
    const requests: string[] = [];
    const stopReasons: string[] = [];
    let cleaned = 0;
    const workers: Array<Awaited<ReturnType<SessionVmLauncher["launch"]>>> = [];
    const createLauncher = (): SessionVmLauncher => ({
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
          setStopReason(reason: string) {
            stopReasons.push(reason);
          },
          input: new WritableStream<Uint8Array>({
            async write(chunk) {
              requests.push(new TextDecoder().decode(chunk));
              await writer.write(chunk);
            },
            close: () => writer.close(),
          }),
          binding: { state: root },
          guestPorts: options.guestPorts?.length
            ? [{ guest: 3000, host: 40000 + launches.length }]
            : [],
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
            hostPorts: [{ host: 5037, guest: 15037 }],
            guestPorts,
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
    // A custom committer: the clone's config default keeps the daemon's author fallback.
    const gitIdentity = {
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    };
    const skill = "---\nname: pdf\ndescription: PDF tools\n---\npdf";
    await Deno.mkdir(join(root, "loom/skills/pdf/references"), { recursive: true });
    await Deno.writeTextFile(join(root, "loom/skills/pdf/SKILL.md"), skill);
    await Deno.writeTextFile(join(root, "loom/skills/pdf/references/notes.md"), "notes");
    const options: CreateSessionOptions & SessionGitIdentity = {
      projectDir: join(root, "shared-project-files"),
      [sessionGitIdentity]: gitIdentity,
      sessionId: "session",
      skills: ["pdf"],
      cwd: join(root, "workspace/checkout"),
      workspaceRoot: join(root, "workspace/checkout"),
      systemPromptAppend: "Work in " + join(root, "workspace/checkout"),
      agentPrompt: "Keep the original agent instructions.",
      initHooks: {
        hooks: [],
        env: { LOOM_REPO_ROOT: root, LOOM_WORKTREE: join(root, "workspace/checkout") },
      },
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
      await created.close("idle_suspension");
      const skillDirectory = join(sessionVmDirectory(root, "session"), "skills/pdf");
      assert.equal(await Deno.readTextFile(join(skillDirectory, "SKILL.md")), skill);
      assert.equal(await Deno.readTextFile(join(skillDirectory, "references/notes.md")), "notes");
      assert.deepEqual(stopReasons, ["idle_suspension"]);
      assert.deepEqual(launches[0]!.mcpRelays, [{ port: 4567, guestPort: 3130 }]);
      assert.deepEqual(launches[0]!.clone, {
        ...clone,
        identity: { name: "Loom (test)", email: "author@example.com" },
      });
      assert.deepEqual(launches[0]!.gitIdentity, gitIdentity);
      assert.equal(launches[0]!.projectDir, options.projectDir);
      assert.ok(!requests.join("").includes("committer@example.com"), "identity stays host-side");
      assert.deepEqual(launches[0]!.extraAllowedHosts, ["registry.npmjs.org"]);
      assert.deepEqual(launches[0]!.hostPorts, [{ host: 5037, guest: 15037 }]);
      assert.deepEqual(launches[0]!.guestPorts, [{ guest: 3000 }]);
      assert.equal(
        !!launches[0]!.authOwner,
        kind === "codex" ||
          (kind === "claude" &&
            !Deno.env.get("ANTHROPIC_API_KEY") &&
            !Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN")),
      );
      assert.deepEqual(
        launches[0]!.providerHosts,
        { claude: undefined, codex: ["chatgpt.com"], aisdk: ["api.openai.com"] }[kind],
      );
      const frames = requests
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (kind === "claude")
        assert.equal(
          frames.find((f) => f.method === "initialize").args[0].config.claudeAiConnectors,
          false,
        );
      assert.equal(
        frames.find((f) => f.method === "initialize").args[0].connector,
        `@loom/connector-${{ codex: "chatgpt", aisdk: "generic", claude: "claude" }[kind]}`,
      );
      assert.equal(
        frames.find((f) => f.method === "create").args[0].mcpServers[0].spec.url,
        "http://127.0.0.1:3130/mcp",
      );
      const guestOptions = frames.find((f) => f.method === "create").args[0];
      assert.equal(guestOptions.cwd, "/workspace/checkout");
      assert.equal(guestOptions.workspaceRoot, "/workspace/checkout");
      assert.equal(guestOptions.initHooks.env.LOOM_WORKTREE, "/workspace/checkout");
      assert.equal(guestOptions.initHooks.env.LOOM_REPO_ROOT, "/workspace/checkout");
      assert.equal(guestOptions.systemPromptAppend, "Work in /workspace/checkout");
      assert.match(guestOptions.agentPrompt, /Keep the original agent instructions/);
      assert.match(guestOptions.agentPrompt, /Guest 127\.0\.0\.1:3000.*host at 127\.0\.0\.1:40001/);
      assert.deepEqual(guestOptions.guestPorts, [{ guest: 3000, host: 40001 }]);
      assert(progress.some((p) => p.includes("127.0.0.1:40001")));
      assert.equal(launches[0]!.workspace, options.cwd);
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
      const resumedOptions = requests
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((frame) => frame.method === "resume").args[0];
      assert.match(resumedOptions.agentPrompt, /host at 127\.0\.0\.1:40002/);
      assert(!resumedOptions.agentPrompt.includes("40001"));
      assert.deepEqual(resumedOptions.guestPorts, [{ guest: 3000, host: 40002 }]);
      assert.equal(launches.length, 2);
      guestPorts.length = 0;
      // The generic fixture returns a mock provider ref; restore the native Codex fixture.
      if (kind === "codex") await Deno.writeTextFile(join(dir, "codex-ref"), ref);
      const revoked = await provider.resumeSession({ ...options, providerRef: ref });
      await revoked.close();
      const revokedOptions = requests
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((frame) => frame.method === "resume")
        .at(-1).args[0];
      assert.match(revokedOptions.agentPrompt, /No guest ports are published on the host/);
      assert(!revokedOptions.agentPrompt.includes("40002"));
      assert.equal(revokedOptions.guestPorts, undefined);
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
      assert.equal(launches.length, 4);
    } finally {
      await provider.close?.();
      if (previousConfig === undefined) Deno.env.delete("XDG_CONFIG_HOME");
      else Deno.env.set("XDG_CONFIG_HOME", previousConfig);
      if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", previous);
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("a Claude VM session with claude.ai connectors enabled may reach Anthropic's MCP proxy", async () => {
  // given
  const root = await Deno.makeTempDir();
  const launches: SessionVmOptions[] = [];
  const base: AgentProvider = new FakeProvider();
  const provider = await withVmSessions(
    base,
    {
      id: "claude",
      logger: makeLogger("vm-connectors-test"),
      config: {
        sessionVm: { repoRoot: root, artifact: root, smolvm: Deno.execPath() },
        configDir: root,
        claudeAiConnectors: true,
      },
    },
    "claude",
    () => ({
      launch: (options) => {
        launches.push(options);
        return Promise.reject(new Error("launch captured"));
      },
      close: async () => {},
    }),
  );
  try {
    // when
    await assert.rejects(
      provider.createSession({
        sessionId: "s",
        cwd: root,
        prompt: "",
        mode: "default",
        mcpServers: [],
      }),
      /launch captured/,
    );
    // then
    assert.deepEqual(launches[0]!.providerHosts, ["api.anthropic.com", "mcp-proxy.anthropic.com"]);
  } finally {
    await provider.close?.();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stageSkills copies shared skills without following a guest symlink", async () => {
  // given
  const root = await Deno.makeTempDir();
  const host = join(root, "host");
  const outside = join(root, "outside");
  const session = join(root, "session");
  for (const name of ["pdf", "docx"]) {
    await Deno.mkdir(join(host, name), { recursive: true });
    await Deno.writeTextFile(
      join(host, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: test\n---\n${name}`,
    );
  }
  await Deno.mkdir(outside);
  await Deno.mkdir(session, { recursive: true });
  await Deno.symlink(outside, join(session, "skills"));
  const input: CreateSessionOptions = {
    sessionId: "s",
    cwd: root,
    prompt: "",
    mode: "default",
    mcpServers: [],
  };
  try {
    // when
    await stageSkills(session, host, { ...input, skills: ["pdf"] });
    // then
    assert.equal(
      await Deno.readTextFile(join(session, "skills/pdf/SKILL.md")),
      "---\nname: pdf\ndescription: test\n---\npdf",
    );
    assert.equal((await Deno.lstat(join(session, "skills"))).isDirectory, true);
    assert.deepEqual([...Deno.readDirSync(join(session, "skills"))].length, 1);
    assert.deepEqual([...Deno.readDirSync(outside)], []);
    await stageSkills(session, host, input);
    assert.deepEqual(
      [...Deno.readDirSync(join(session, "skills"))].map((entry) => entry.name).sort(),
      ["docx", "pdf"],
    );
    await assert.rejects(
      stageSkills(session, host, { ...input, skills: ["coding-style"] }),
      /"coding-style" not found/,
    );
    await stageSkills(session, host, { ...input, skills: [] });
    assert.deepEqual([...Deno.readDirSync(join(session, "skills"))], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
