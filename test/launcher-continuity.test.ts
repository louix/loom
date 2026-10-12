// test-run: own-process — points XDG_STATE_HOME at its fixture for daemon code that reads Deno.env.
/**
 * Old-session continuity after the legacy session VM launcher's removal. A VM session
 * created and suspended by that launcher (or the isolation launcher, its successor)
 * resumes on the isolation launcher across a provider shutdown, as at a daemon
 * restart: the same environment ID, the same state directory, its saved provider
 * history, and any interrupted cleanup the previous owner left.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { canonicalHostPath } from "../core/src/host-path.ts";
import {
  withVmSessions,
  type SessionVmLauncher,
} from "../backend/daemon/src/daemon/vm-provider.ts";
import { createIsolatedWorkerLauncher } from "../backend/daemon/src/daemon/isolated-worker.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { launchLocalWorker, mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { defaultProviderHosts, type SessionVmOptions } from "../runtime/src/session-vm/launch.ts";
import type { VmBinding } from "../runtime/src/packaged/vm.ts";
import { WorkerTranscript } from "../runtime/src/worker/transcript.ts";
import { FakeProvider } from "../connectors/mock/src/fake.ts";
import { makeLogger } from "../core/src/logger.ts";
import type { AgentProvider, CreateSessionOptions, SessionRef } from "../core/src/types.ts";

type Launcher = "legacy" | "isolation";
const root = fileURLToPath(new URL("../", import.meta.url));
const ref = "12345678-1234-1234-1234-123456789abc";

/** Records the worker protocol frames the host sends, then forwards them. */
const tap = (
  input: WritableStream<Uint8Array>,
  frames: Array<{ method?: string; args?: unknown[] }>,
) => {
  const writer = input.getWriter();
  let buffered = "";
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      buffered += new TextDecoder().decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
      await writer.write(chunk);
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });
};
const fixtureWorker = () =>
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
  }).spawn();

/** Everything one launch saw, whichever launcher made it. */
interface Launch {
  launcher: Launcher;
  options: SessionVmOptions;
  frames: Array<{ method?: string; args?: unknown[] }>;
}

/**
 * The removed legacy launcher's contract, as older Loom versions kept it: the VM is
 * the worker. It booted a supervisor; the scripted worker stands in for it.
 */
const legacyLauncher = (launches: Launch[]): SessionVmLauncher => {
  const live = new Set<ReturnType<typeof launchLocalWorker>>();
  return {
    async launch(options) {
      const frames: Launch["frames"] = [];
      launches.push({ launcher: "legacy", options, frames });
      await Deno.mkdir(options.sessionDirectory!, { recursive: true });
      const proc = launchLocalWorker({
        ...mockLaunchSpec(root),
        entrypoint: join(root, "test/fixtures/connector-worker.ts"),
      });
      live.add(proc);
      return {
        ...proc,
        input: tap(proc.input, frames),
        binding: { state: options.sessionDirectory! },
        async cleanup() {
          await proc.exited;
          live.delete(proc);
        },
      };
    },
    async close() {
      for (const proc of live) {
        proc.terminate();
        await proc.exited;
      }
    },
  };
};

/** The real isolation adapter over a fake environment backend. */
const isolationLauncher = (
  repoRoot: string,
  workspace: string,
  launches: Launch[],
  adapters: Array<ReturnType<typeof createIsolatedWorkerLauncher>>,
) => {
  let current: Launch | undefined;
  const adapter = createIsolatedWorkerLauncher(repoRoot, {
    async launch(options) {
      current = { launcher: "isolation", options, frames: [] };
      launches.push(current);
      await Deno.mkdir(options.sessionDirectory!, { recursive: true });
      const exited = Promise.withResolvers<void>();
      return {
        binding: {
          workspace,
          smolvm: "/fake/smolvm",
          state: options.sessionDirectory!,
        } as VmBinding,
        pid: 1,
        ready: Promise.resolve(),
        exited: exited.promise,
        status: async () => ({ phase: "running", network: [] }),
        async close() {
          exited.resolve();
        },
      };
    },
    workerArgv: async () => ["/fake/guest-worker"],
    spawn: () => {
      const child = fixtureWorker();
      return {
        stdin: tap(child.stdin, current!.frames),
        stdout: child.stdout,
        stderr: child.stderr,
        pid: child.pid,
        status: child.status,
        kill: (signal) => child.kill(signal),
      };
    },
  });
  adapters.push(adapter);
  return adapter;
};

/** What the guest leaves in the session's mounted profile for a later resume. */
const saveHistory = async (kind: string, dir: string) => {
  if (kind === "claude") {
    await Deno.mkdir(join(dir, "profile/projects/loom-session"), { recursive: true });
    await Deno.writeTextFile(join(dir, `profile/projects/loom-session/${ref}.jsonl`), "{}\n");
  } else if (kind === "codex") {
    await Deno.mkdir(join(dir, "profile/sessions"), { recursive: true });
    // The scripted worker's thread is not a UUID; record the one a real thread would have.
    await Deno.writeTextFile(join(dir, "codex-ref"), ref);
  }
};

/** A previous owner that died after reaping its VM but before removing its marker. */
const interruptedCleanup = async (dir: string) => {
  const token = crypto.randomUUID();
  await Deno.writeTextFile(
    join(dir, "active.json"),
    JSON.stringify({
      version: 1,
      token,
      // Runtime state lives directly in the host's canonical /tmp (/private/tmp on macOS).
      state: join(
        canonicalHostPath("/tmp"),
        "loom-session-vm-" + token.replaceAll("-", "").slice(0, 12),
      ),
      smolvm: "/nix/store/" + "a".repeat(32) + "-smolvm/bin/smolvm",
      sessionDirectory: dir,
      recovery: { version: 3, ready: true, reaped: true },
    }),
  );
};

const exists = async (path: string) => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

for (const kind of ["claude", "codex", "aisdk"] as const)
  for (const [from, to] of [
    ["legacy", "isolation"],
    ["isolation", "isolation"],
  ] as const)
    Deno.test(`a ${kind} VM session suspended on the ${from} launcher resumes on the ${to} launcher`, async () => {
      const state = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-continuity-" }));
      const previous = Deno.env.get("XDG_STATE_HOME");
      Deno.env.set("XDG_STATE_HOME", state);
      const workspace = join(state, "workspace");
      await Deno.mkdir(workspace);
      const launches: Launch[] = [];
      const adapters: Array<ReturnType<typeof createIsolatedWorkerLauncher>> = [];
      /** One provider per daemon lifetime. "legacy" stands in for an older Loom. */
      const open = (launcher: Launcher) =>
        withVmSessions(
          new FakeProvider(),
          {
            id: kind,
            logger: makeLogger("launcher-continuity-test"),
            config: {
              sessionVm: { repoRoot: state, artifact: state, smolvm: Deno.execPath() },
              configDir: state,
              codexCliPath: Deno.execPath(),
            },
            transcript: new WorkerTranscript("session", () => {}),
            vmLifecycle: { stop: async () => {}, activity: () => "running" },
          },
          kind,
          (repoRoot) =>
            launcher === "legacy"
              ? legacyLauncher(launches)
              : isolationLauncher(repoRoot, workspace, launches, adapters),
        );
      const options: CreateSessionOptions = {
        sessionId: "session",
        cwd: workspace,
        prompt: "",
        mode: "default",
        mcpServers: [],
      };
      const reply = async (
        session: Awaited<ReturnType<AgentProvider["createSession"]>>,
        text: string,
      ) => {
        await session.send(text);
        for await (const event of session.events())
          if (event.type === "assistant_text" && event.text === text) return;
      };
      const dir = sessionVmDirectory(state, "session");
      let first: AgentProvider | undefined;
      let second: AgentProvider | undefined;
      try {
        first = await open(from);
        const created = await first.createSession(options);
        await reply(created, "hello");
        await created.close("idle_suspension");
        // The daemon stops; its provider and launcher go with it.
        await first.close?.();
        first = undefined;
        if (kind === "aisdk") assert(await exists(join(dir, "aisdk")), "AISDK VM marker");
        await saveHistory(kind, dir);
        await interruptedCleanup(dir);

        second = await open(to);
        const resumed = await second.resumeSession({ ...options, providerRef: ref } as SessionRef);
        // The new owner finished the previous one's cleanup before booting.
        assert.equal(await exists(join(dir, "active.json")), false);
        // The scripted worker answers only created sessions; a send proves this one is live.
        await resumed.send("again");
        const [before, after] = launches;
        assert.equal(launches.length, 2);
        assert.deepEqual(
          launches.map((launch) => launch.launcher),
          [from, to],
        );
        // Same environment identity and state location on both launchers.
        for (const launch of [before!, after!]) {
          assert.equal(launch.options.sessionId, "session");
          assert.equal(launch.options.sessionDirectory, dir);
          assert.equal(launch.options.repoRoot, state);
          assert.equal(launch.options.workspace, workspace);
        }
        // The legacy launch defaulted absent provider hosts itself; the adapter fills them in.
        const hosts = (launch: Launch) => launch.options.providerHosts ?? defaultProviderHosts;
        assert.deepEqual(hosts(after!), hosts(before!));
        assert(before!.frames.some((frame) => frame.method === "create"));
        const resume = after!.frames.find((frame) => frame.method === "resume");
        assert.equal((resume?.args?.[0] as SessionRef | undefined)?.providerRef, ref);
        if (to === "isolation") {
          const adapter = adapters.at(-1)!;
          assert.equal(adapter.inspect("session").phase, "ready");
          assert(adapter.leases.has("session"), "the resumed worker holds the environment's lease");
        }
        await resumed.close("idle_suspension");
        if (to === "isolation") assert.equal(adapters.at(-1)!.inspect("session").phase, "stopped");
        // Saved history stays where both launchers look for it.
        if (kind === "claude")
          assert(await exists(join(dir, `profile/projects/loom-session/${ref}.jsonl`)));
        if (kind === "codex")
          assert.equal(await Deno.readTextFile(join(dir, "codex-ref")), "fake-session");
      } finally {
        await first?.close?.();
        await second?.close?.();
        if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
        else Deno.env.set("XDG_STATE_HOME", previous);
        await Deno.remove(state, { recursive: true });
      }
    });
