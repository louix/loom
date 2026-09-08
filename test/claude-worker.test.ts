import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessEvent } from "../core/src/events.ts";
import type { AgentSession } from "../core/src/types.ts";
import { makeLogger } from "../core/src/logger.ts";
import {
  createClaudeWorkerProvider,
  claudeWorkerSpec,
} from "../backend/daemon/src/daemon/claude-worker.ts";
import { launchLocalWorker } from "../backend/daemon/src/daemon/worker-launch.ts";
import { RemoteWorkerSession } from "../backend/daemon/src/daemon/worker-provider.ts";
import { FrameWriter, readFrames } from "../runtime/src/worker/transport.ts";
import { decodeWorkerFrame } from "../core/src/worker.ts";

const fixture = async () => {
  const root = await Deno.makeTempDir({ prefix: "loom-claude-test-" });
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  await Deno.mkdir(workspace);
  await Deno.mkdir(profile);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Worker Test"],
    ["config", "user.email", "worker@example.test"],
    ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "initial"],
  ]) {
    const result = await new Deno.Command("git", {
      args: ["-C", workspace, ...args],
      stdout: "null",
      stderr: "piped",
    }).output();
    assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
  }
  const cliPath = join(root, "claude-fixture");
  const cli = fileURLToPath(new URL("fixtures/fake-claude-cli.ts", import.meta.url));
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await Deno.writeTextFile(
    cliPath,
    `#!/bin/sh\nexec ${quote(Deno.execPath())} run -A ${quote(cli)} "$@"\n`,
  );
  await Deno.chmod(cliPath, 0o755);
  const ctx = {
    id: "claude:test",
    config: { cliPath, configDir: profile },
    logger: makeLogger("test"),
  };
  const provider = await createClaudeWorkerProvider(ctx);
  return {
    root,
    workspace,
    profile,
    ctx,
    provider,
    async cleanup() {
      await Deno.remove(root, { recursive: true });
    },
  };
};
const reader = (s: AgentSession) => {
  const events: HarnessEvent[] = [];
  const done = (async () => {
    for await (const event of s.events()) events.push(event);
  })();
  void done.catch(() => {});
  const until = async <T extends HarnessEvent["type"]>(
    type: T,
  ): Promise<Extract<HarnessEvent, { type: T }>> => {
    for (let i = 0; i < 500; i++) {
      const index = events.findIndex((e) => e.type === type);
      if (index >= 0) return events.splice(index, 1)[0] as Extract<HarnessEvent, { type: T }>;
      await delay(10);
    }
    throw new Error(`missing ${type}: ${JSON.stringify(events)}`);
  };
  return { events, done, until };
};

test(
  "Claude real SDK runs in a worker: discovery, tools, controls, compaction and resume",
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    let session: AgentSession | undefined;
    try {
      assert.deepEqual(
        (await f.provider.listModels()).map((m) => m.id),
        ["fixture-model"],
      );
      assert.deepEqual(await f.provider.listPersistedSessions(), []);
      session = await f.provider.createSession({
        sessionId: "claude-worker",
        cwd: f.workspace,
        prompt: "details",
        mode: "default",
        mcpServers: [],
        loomServer: true,
      });
      const r = reader(session);
      const first = await r.until("assistant_text");
      const details = JSON.parse(first.text);
      assert.equal(details.cwd, f.workspace);
      assert.equal(details.profile, f.profile);
      assert.equal(details.inheritedSearchKey, null);
      assert.ok(JSON.stringify(details.initialization).includes("loom"), JSON.stringify(details));
      await r.until("result");
      assert.ok(session.providerRef);
      const ref = session.providerRef;
      assert.equal((await r.until("rate_limit")).utilization, 12);
      await session.send("question");
      const question = await r.until("question");
      await session.answerQuestion(question.id, "yes");
      await r.until("result");
      await session.send("write");
      const permission = await r.until("permission_request");
      await session.respondToPermission(permission.id, { behavior: "allow" });
      await r.until("result");
      assert.equal(await Deno.readTextFile(join(f.workspace, "worker-file.txt")), "approved\n");
      await session.send("status");
      const status = await r.until("result");
      assert.equal(status.kind, "ok");
      assert.match(JSON.stringify(status), /main/);
      await session.send("commit");
      const committed = await r.until("result");
      assert.equal(committed.kind, "ok");
      assert.match(JSON.stringify(committed), /committed/);
      for (const mode of ["default", "acceptEdits", "auto", "plan"] as const) {
        await session.setMode(mode);
        assert.equal(session.snapshot().mode, mode);
      }
      await session.setModel("fixture-2");
      assert.equal(session.snapshot().model, "fixture-2");
      await session.setEffort("high");
      assert.equal(session.snapshot().effort, "high");
      await session.send("plan");
      const plan = await r.until("plan_review");
      await session.respondToPlan(plan.id, { action: "implement", mode: "acceptEdits" });
      await r.until("result");
      await session.compact("summarize");
      await r.until("compact");
      await r.until("result");
      const compact = session.compact("wait");
      await delay(50);
      await session.interrupt();
      await compact;
      await session.close();
      await r.done;
      session = await f.provider.resumeSession({
        sessionId: "claude-worker",
        cwd: f.workspace,
        providerRef: ref!,
        mode: "default",
      });
      const resumed = reader(session);
      await session.send("again");
      assert.equal((await resumed.until("assistant_text")).text, "echo:again");
      assert.equal(session.providerRef, ref);
      await resumed.until("result");
      const forkPoint = session.snapshot().rewindRef;
      assert.ok(forkPoint);
      await session.rewind(0, forkPoint);
      await session.send("after rewind");
      assert.equal((await resumed.until("assistant_text")).text, "echo:after rewind");
      assert.notEqual(session.providerRef, ref);
      await session.close();
      await resumed.done;
    } finally {
      await session?.close();
      await f.cleanup();
    }
  },
);

test(
  "same-profile Claude workers remain independent when one closes",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const sessions: AgentSession[] = [];
    try {
      for (const id of ["peer-a", "peer-b"])
        sessions.push(
          await f.provider.createSession({
            sessionId: id,
            cwd: f.workspace,
            prompt: "details",
            mode: "default",
            mcpServers: [],
          }),
        );
      const a = reader(sessions[0]!);
      const b = reader(sessions[1]!);
      await a.until("result");
      await b.until("result");
      assert.notEqual(
        (sessions[0] as RemoteWorkerSession).pid,
        (sessions[1] as RemoteWorkerSession).pid,
      );
      await sessions[0]!.close();
      await a.done;
      b.events.length = 0;
      await sessions[1]!.send("peer survives");
      assert.equal((await b.until("assistant_text")).text, "echo:peer survives");
      await sessions[1]!.close();
      await b.done;
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
      await f.cleanup();
    }
  },
);

test(
  "Claude title runs in a private cwd and leaves profile/workspace intact",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    let s: AgentSession | undefined;
    try {
      s = await f.provider.createSession({
        sessionId: "title",
        cwd: f.workspace,
        prompt: "details",
        mode: "default",
        mcpServers: [{ name: "forbidden", spec: { transport: "stdio", command: "false" } }],
        loomServer: true,
        oneShot: true,
        settingSources: ["project"],
      });
      const r = reader(s);
      const details = JSON.parse((await r.until("assistant_text")).text);
      await r.until("result");
      assert.notEqual(details.cwd, f.workspace);
      assert.equal(details.profile, f.profile);
      assert.equal(JSON.stringify(details.initialization).includes('"loom"'), false);
      assert.ok(details.argv.includes("--tools"));
      await s.close();
      await r.done;
      await assert.rejects(Deno.stat(details.cwd), Deno.errors.NotFound);
      assert.ok(await Deno.stat(f.workspace));
      assert.ok(await Deno.stat(f.profile));
    } finally {
      await s?.close();
      await f.cleanup();
    }
  },
);

test(
  "Claude group cleanup kills native children after worker crash and parent EOF",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    let s: AgentSession | undefined;
    const dead = async (pid: number) => {
      for (let i = 0; i < 100; i++) {
        try {
          const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
          if (stat.split(") ")[1]?.startsWith("Z")) return;
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) return;
          throw e;
        }
        await delay(10);
      }
      throw new Error(`native child ${pid} survived`);
    };
    try {
      s = await f.provider.createSession({
        sessionId: "crash",
        cwd: f.workspace,
        prompt: "details",
        mode: "default",
        mcpServers: [],
      });
      const r = reader(s);
      await r.until("assistant_text");
      const pids = (await Deno.readTextFile(join(f.profile, "pids")))
        .trim()
        .split(/\s+/)
        .map(Number);
      Deno.kill((s as RemoteWorkerSession).pid, "SIGKILL");
      await assert.rejects(r.done);
      await s.close();
      for (const pid of pids) await dead(pid);
      // Closing the parent's private input pipe models abrupt daemon death.
      const spec = claudeWorkerSpec(f.ctx, f.workspace, "session");
      const process = launchLocalWorker(spec);
      const input = new FrameWriter(process.input);
      const frames = readFrames(process.output, decodeWorkerFrame);
      assert.equal((await frames.next()).value?.kind, "hello");
      await input.send({
        kind: "request",
        id: 1,
        method: "initialize",
        args: [
          {
            generation: "eof",
            providerId: f.ctx.id,
            sessionId: "eof",
            role: "session",
            connector: "@loom/connector-claude",
            config: f.ctx.config,
          },
        ],
      });
      assert.equal((await frames.next()).value?.kind, "ready");
      await input.send({
        kind: "request",
        id: 2,
        method: "create",
        args: [
          {
            sessionId: "eof",
            cwd: f.workspace,
            prompt: "details",
            mode: "default",
            mcpServers: [],
          },
        ],
      });
      for (;;) {
        const next = await frames.next();
        if (next.done) throw new Error("worker exited before starting native fixture");
        if (next.value.kind === "event" && next.value.event.type === "assistant_text") break;
      }
      const allPids = (await Deno.readTextFile(join(f.profile, "pids")))
        .trim()
        .split(/\s+/)
        .map(Number);
      await input.close();
      await process.exited;
      await frames.return(undefined);
      await process.cleanup?.();
      for (const pid of allPids) await dead(pid);
    } finally {
      await s?.close();
      await f.cleanup();
    }
  },
);

test(
  "Claude launch grants are profile-scoped and failed launch removes scratch",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const previous = Deno.env.get("KAGI_API_KEY");
    Deno.env.set("KAGI_API_KEY", "dummy-unrelated-search-key");
    try {
      const spec = claudeWorkerSpec(
        { ...f.ctx, config: { ...f.ctx.config, workerAllowedHosts: ["localhost:9876"] } },
        f.workspace,
        "title",
      );
      assert.deepEqual(spec.permissions.net, ["localhost:9876"]);
      assert.equal(spec.env.KAGI_API_KEY, undefined);
      assert.equal(spec.permissions.read.includes(f.workspace), false);
      assert.equal(spec.permissions.write.includes(f.workspace), false);
      assert.equal(spec.permissions.read.includes(join(spec.env.HOME!, ".claude.json")), false);
      assert.equal(spec.env.CLAUDE_CONFIG_DIR, f.profile);
      await assert.rejects(
        RemoteWorkerSession.connect("missing", f.ctx.id, { ...spec, executable: "/missing/deno" }),
      );
      await assert.rejects(Deno.stat(spec.cwd), Deno.errors.NotFound);
    } finally {
      if (previous === undefined) Deno.env.delete("KAGI_API_KEY");
      else Deno.env.set("KAGI_API_KEY", previous);
      await f.cleanup();
    }
  },
);
