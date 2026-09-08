import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decodeWorkerRequest, decodeWorkerFrame, MAX_FRAME_BYTES } from "../core/src/worker.ts";
import { readFrames, FrameWriter } from "../runtime/src/worker/transport.ts";
import {
  WorkerProvider,
  RemoteWorkerSession,
} from "../backend/daemon/src/daemon/worker-provider.ts";
import {
  mockLaunchSpec,
  launchLocalWorker,
  type WorkerProcess,
} from "../backend/daemon/src/daemon/worker-launch.ts";
import type { CreateSessionOptions } from "../core/src/types.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const opts = (sessionId: string): CreateSessionOptions => ({
  sessionId,
  cwd,
  prompt: "hello",
  mode: "default",
  mcpServers: [],
});
const scripted = () => ({
  ...mockLaunchSpec(cwd),
  entrypoint: fileURLToPath(new URL("fixtures/connector-worker.ts", import.meta.url)),
});
const next = async <T>(iterator: AsyncIterator<T>): Promise<T> => {
  const result = await iterator.next();
  assert.equal(result.done, false);
  return result.value;
};

test("worker decoders reject admin methods, malformed arguments and payloads", () => {
  assert.throws(() =>
    decodeWorkerRequest({ kind: "request", id: 1, method: "session.delete", args: ["peer"] }),
  );
  assert.throws(() =>
    decodeWorkerRequest({ kind: "request", id: 1, method: "setMode", args: ["unrestricted"] }),
  );
  assert.throws(() =>
    decodeWorkerRequest({
      kind: "request",
      id: 1,
      method: "create",
      args: [{ ...opts("x"), mcpServers: [{}] }],
    }),
  );
  assert.throws(() => decodeWorkerFrame({ kind: "state", snapshot: {} }));
  assert.throws(() =>
    decodeWorkerFrame({
      kind: "event",
      seq: 1,
      event: { type: "question", sessionId: "s", ts: 0 },
    }),
  );
  assert.equal(
    decodeWorkerRequest({ kind: "request", id: 1, method: "setMode", args: ["plan"] }).method,
    "setMode",
  );
});

test("framing handles split Unicode and coalesced frames; rejects truncated and oversized input", async () => {
  const encode = new TextEncoder();
  const bytes = encode.encode('{"text":"λ"}\n{"n":2}\n');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(Uint8Array.of(b));
      c.close();
    },
  });
  assert.deepEqual(await Array.fromAsync(readFrames(stream, (x) => x)), [{ text: "λ" }, { n: 2 }]);
  for (const value of [
    encode.encode('{"n":1}'),
    new Uint8Array(MAX_FRAME_BYTES + 1).fill(32),
    Uint8Array.of(255, 10),
  ]) {
    await assert.rejects(
      Array.fromAsync(
        readFrames(
          new ReadableStream({
            start(c) {
              c.enqueue(value);
              c.close();
            },
          }),
          (x) => x,
        ),
      ),
    );
  }
  const writer = new FrameWriter(new WritableStream({ write() {} }));
  await assert.rejects(writer.send("x".repeat(MAX_FRAME_BYTES)), /overflow/);
  await writer.close();
});

test(
  "actual mock child supports initial events, cached settings and resume",
  { timeout: 15_000 },
  async () => {
    const provider = await WorkerProvider.create("fake", mockLaunchSpec);
    assert.equal(provider.capabilities.rewind, true);
    const session = await provider.createSession({ ...opts("one"), oneShot: true });
    try {
      const events = await Array.fromAsync(session.events());
      assert.deepEqual(
        events.map((e) => e.type),
        ["assistant_text", "result"],
      );
      assert.equal(session.providerRef, "fake-one");
      await session.setMode("plan");
      await session.setModel("fake-2");
      await session.setEffort("high");
      assert.equal(session.snapshot().mode, "plan");
      assert.equal(session.snapshot().model, "fake-2");
      assert.equal(session.snapshot().effort, "high");
      const copy = session.snapshot();
      copy.usage.input = 999;
      assert.equal(session.snapshot().usage.input, 0);
    } finally {
      await session.close();
    }
    const resumed = await provider.resumeSession({
      sessionId: "one",
      cwd,
      providerRef: "fake-one",
      mode: "plan",
    });
    try {
      assert.notEqual((resumed as RemoteWorkerSession).pid, (session as RemoteWorkerSession).pid);
      assert.equal(resumed.providerRef, "fake-one");
      await resumed.rewind(0);
      assert.equal(resumed.snapshot().status.kind, "idle");
    } finally {
      await resumed.close();
    }
  },
);

test(
  "actual child streams interactions and interrupts a parked compaction without deadlock",
  { timeout: 15_000 },
  async () => {
    const provider = await WorkerProvider.create("fake", scripted);
    const s = await provider.createSession(opts("interactions"));
    const it = s.events()[Symbol.asyncIterator]();
    try {
      await s.send("question");
      assert.equal((await next(it)).type, "question");
      await s.answerQuestion("q", "yes");
      assert.deepEqual((await next(it)).type, "assistant_text");
      await s.send("permission");
      assert.equal((await next(it)).type, "permission_request");
      await s.respondToPermission("p", { behavior: "deny" });
      assert.equal((await next(it)).type, "assistant_text");
      await s.send("plan");
      assert.equal((await next(it)).type, "plan_review");
      await s.respondToPlan("r", { action: "implement", mode: "auto" });
      assert.equal(s.snapshot().mode, "auto");
      assert.equal((await next(it)).type, "assistant_text");
      const compact = s.compact("wait");
      assert.equal((await next(it)).type, "question");
      await s.interrupt();
      await compact;
      assert.equal((await next(it)).type, "status_changed");
    } finally {
      await s.close();
      await it.return?.();
    }
  },
);

test(
  "worker crash fails its session while its peer keeps running",
  { timeout: 15_000 },
  async () => {
    const provider = await WorkerProvider.create("fake", scripted);
    const a = await provider.createSession(opts("a"));
    const b = await provider.createSession(opts("b"));
    try {
      assert.notEqual((a as RemoteWorkerSession).pid, (b as RemoteWorkerSession).pid);
      await assert.rejects(a.send("crash"), /exited|ended/);
      await assert.rejects(Array.fromAsync(a.events()), /exited|ended/);
      await b.send("still alive");
      const it = b.events()[Symbol.asyncIterator]();
      assert.equal((await next(it)).type, "assistant_text");
      await it.return?.();
      await b.setMode("plan");
      assert.equal(b.snapshot().mode, "plan");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  },
);

test("wrong session events fail closed", { timeout: 15_000 }, async () => {
  const provider = await WorkerProvider.create("fake", scripted);
  const s = await provider.createSession(opts("owner"));
  try {
    await s.send("wrong-session").catch(() => {});
    await assert.rejects(Array.fromAsync(s.events()), /exited|ended/);
  } finally {
    await s.close();
  }
});

test(
  "failed startup and incompatible handshake terminate the child",
  { timeout: 15_000 },
  async () => {
    let child: WorkerProcess | undefined;
    const launch: typeof launchLocalWorker = (spec) => {
      child = launchLocalWorker(spec);
      return child;
    };
    await assert.rejects(
      RemoteWorkerSession.connect(
        "s",
        "fake",
        { ...mockLaunchSpec(cwd), entrypoint: `${cwd}/missing-worker.ts` },
        launch,
        1000,
      ),
    );
    assert.ok(child);
    await child.exited;
    const bad = await Deno.makeTempFile({ suffix: ".ts" });
    try {
      await Deno.writeTextFile(
        bad,
        'console.log(JSON.stringify({kind:"hello",version:999})); await new Promise(() => {});',
      );
      await assert.rejects(
        RemoteWorkerSession.connect(
          "s",
          "fake",
          { ...mockLaunchSpec(cwd), entrypoint: bad },
          launch,
          1000,
        ),
        /incompatible/,
      );
      await child.exited;
    } finally {
      await Deno.remove(bad);
    }
  },
);

test("parent EOF shuts down the mock worker", { timeout: 15_000 }, async () => {
  const child = launchLocalWorker(mockLaunchSpec(cwd));
  const read = Array.fromAsync(readFrames(child.output, decodeWorkerFrame));
  const writer = child.input.getWriter();
  await writer.close();
  await child.exited;
  assert.equal((await read)[0]?.kind, "hello");
});

test("close settles parked requests and is idempotent", { timeout: 15_000 }, async () => {
  const provider = await WorkerProvider.create("fake", scripted);
  const s = await provider.createSession(opts("closing"));
  const it = s.events()[Symbol.asyncIterator]();
  const compact = assert.rejects(s.compact("wait"), /closed/);
  try {
    assert.equal((await next(it)).type, "question");
    await Promise.all([s.close(), s.close()]);
    await compact;
    await assert.rejects(s.send("late"), /closing|closed/);
  } finally {
    await s.close();
    await it.return?.();
  }
});

test(
  "host rejects a forged session identity from an otherwise valid worker",
  { timeout: 15_000 },
  async () => {
    const launch: typeof launchLocalWorker = (spec) => {
      const child = launchLocalWorker(spec);
      const frames = readFrames(child.output, decodeWorkerFrame);
      return {
        ...child,
        output: ReadableStream.from(
          (async function* () {
            for await (const frame of frames) {
              if (frame.kind === "event") frame.event.sessionId = "someone-else";
              yield new TextEncoder().encode(JSON.stringify(frame) + "\n");
            }
          })(),
        ),
      };
    };
    const provider = await WorkerProvider.create("fake", scripted, launch);
    const s = await provider.createSession(opts("bound"));
    try {
      await s.send("question").catch(() => {});
      await assert.rejects(Array.fromAsync(s.events()), /binding/);
    } finally {
      await s.close();
    }
  },
);

test(
  "local worker denies network, writes, unrelated reads, environment and subprocesses",
  { timeout: 15_000 },
  async () => {
    const fixture = await Deno.makeTempFile({ suffix: ".ts" });
    const outside = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(
        fixture,
        `
      const denied = [];
      for (const attempt of [
        () => Deno.env.get("LOOM_WORKER_TEST_SECRET"),
        () => Deno.readTextFile(${JSON.stringify(outside)}),
        () => Deno.writeTextFile(${JSON.stringify(outside)}, "bad"),
        () => fetch("http://127.0.0.1:45873"),
        () => new Deno.Command(${JSON.stringify(Deno.execPath())}, { args: ["--version"] }).output(),
      ]) {
        try { await attempt(); denied.push(false); }
        catch (e) { denied.push(e instanceof Deno.errors.NotCapable); }
      }
      console.log(JSON.stringify(denied));
    `,
      );
      const child = launchLocalWorker({ ...mockLaunchSpec(cwd), entrypoint: fixture });
      const result = await Array.fromAsync(readFrames(child.output, (x) => x));
      await child.exited;
      await child.input.close();
      assert.deepEqual(result, [[true, true, true, true, true]]);
      assert.equal(await Deno.readTextFile(outside), "");
    } finally {
      await Deno.remove(fixture);
      await Deno.remove(outside);
    }
  },
);

test("startup deadline kills a worker that never says hello", { timeout: 15_000 }, async () => {
  const fixture = await Deno.makeTempFile({ suffix: ".ts" });
  let child: WorkerProcess | undefined;
  try {
    await Deno.writeTextFile(fixture, "setInterval(() => {}, 1000);");
    await assert.rejects(
      RemoteWorkerSession.connect(
        "s",
        "fake",
        { ...mockLaunchSpec(cwd), entrypoint: fixture },
        (spec) => {
          child = launchLocalWorker(spec);
          return child;
        },
        500,
      ),
      /startup timed out/,
    );
    assert.ok(child);
    await child.exited;
  } finally {
    await Deno.remove(fixture);
  }
});

test(
  "unconsumed event overflow fails explicitly instead of dropping history",
  { timeout: 15_000 },
  async () => {
    let child: WorkerProcess | undefined;
    const provider = await WorkerProvider.create("fake", scripted, (spec) => {
      child = launchLocalWorker(spec);
      return child;
    });
    const s = await provider.createSession(opts("overflow"));
    try {
      await s.send("flood").catch(() => {});
      assert.ok(child);
      await child.exited; // no event consumer: supervisor must enforce its byte bound
      await assert.rejects(Array.fromAsync(s.events()), /overflow/);
    } finally {
      await s.close();
    }
  },
);

test(
  "worker rejects cross-session creation and a second session on its connection",
  { timeout: 15_000 },
  async () => {
    const child = launchLocalWorker(mockLaunchSpec(cwd));
    const writer = new FrameWriter(child.input);
    const frames = readFrames(child.output, decodeWorkerFrame);
    const response = async (id: number) => {
      for (;;) {
        const frame = await next(frames);
        if (frame.kind === "response" && frame.id === id) return frame;
      }
    };
    try {
      assert.equal((await next(frames)).kind, "hello");
      await writer.send({
        kind: "request",
        id: 1,
        method: "initialize",
        args: [
          {
            generation: "test",
            role: "session",
            providerId: "fake",
            sessionId: "bound",
            connector: "@loom/connector-mock",
            config: {},
          },
        ],
      });
      assert.equal((await next(frames)).kind, "ready");
      await writer.send({ kind: "request", id: 2, method: "create", args: [opts("peer")] });
      assert.ok((await response(2)).error);
      await writer.send({ kind: "request", id: 3, method: "create", args: [opts("bound")] });
      assert.equal((await response(3)).error, undefined);
      await writer.send({ kind: "request", id: 4, method: "create", args: [opts("bound")] });
      assert.ok((await response(4)).error);
      await writer.send({ kind: "request", id: 5, method: "close", args: [] });
      assert.equal((await response(5)).error, undefined);
    } finally {
      child.terminate();
      await child.exited;
      await writer.close().catch(() => {});
      await frames.return(undefined);
    }
  },
);
