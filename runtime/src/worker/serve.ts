import {
  decodeWorkerRequest,
  MAX_PENDING,
  WORKER_VERSION,
  type WorkerBinding,
  type WorkerRequest,
} from "../../../core/src/worker.ts";
import type { AgentProvider, AgentSession } from "../../../core/src/types.ts";
import { FrameWriter, readFrames } from "./transport.ts";

/** Connector code lives on this side only. The injected loader is also a test seam. */
export const serveWorker = async (
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  load: (binding: WorkerBinding) => Promise<AgentProvider>,
): Promise<void> => {
  const writer = new FrameWriter(output);
  const stop = new AbortController();
  let binding: WorkerBinding | undefined;
  let provider: AgentProvider | undefined;
  let session: AgentSession | undefined;
  let initialized = false;
  let started = false;
  let closing = false;
  let lastId = 0;
  let seq = 0;
  let failure: unknown;
  const active = new Set<Promise<void>>();
  const fail = (error: unknown) => {
    failure ??= error;
    closing = true;
    stop.abort();
  };
  const publish = async () => {
    if (session && !closing) await writer.send({ kind: "state", snapshot: session.snapshot() });
  };
  const pump = async (s: AgentSession) => {
    for await (const event of s.events()) {
      if (closing) break;
      if (event.sessionId !== binding?.sessionId)
        throw new Error("connector emitted wrong session");
      await publish();
      if (!closing) await writer.send({ kind: "event", seq: ++seq, event });
    }
    if (!closing) await writer.send({ kind: "end" });
  };
  const handle = async (r: WorkerRequest) => {
    if (r.method === "initialize") {
      if (initialized) throw new Error("worker already initialized");
      initialized = true;
      binding = r.args[0];
      provider = await load(binding);
      await writer.send({
        kind: "ready",
        id: r.id,
        generation: binding.generation,
        capabilities: provider.capabilities,
      });
      return;
    }
    if (!provider || !binding) throw new Error("worker not ready");
    if (r.method === "create" || r.method === "resume") {
      if (started || r.args[0].sessionId !== binding.sessionId)
        throw new Error("invalid session binding");
      started = true;
      session =
        r.method === "create"
          ? await provider.createSession(r.args[0])
          : await provider.resumeSession(r.args[0]);
      if (closing) {
        await session.close();
        return;
      }
      if (session.id !== binding.sessionId) throw new Error("connector returned wrong session");
      await publish();
      await writer.send({ kind: "response", id: r.id });
      void pump(session).catch(fail);
      return;
    }
    if (r.method === "close") {
      closing = true;
      await session?.close();
      await writer.send({ kind: "response", id: r.id });
      stop.abort();
      return;
    }
    if (!session) throw new Error("session not started");
    switch (r.method) {
      case "send":
        await session.send(...r.args);
        break;
      case "compact":
        await session.compact(...r.args);
        break;
      case "rewind":
        await session.rewind(...r.args);
        break;
      case "setMode":
        await session.setMode(...r.args);
        break;
      case "setModel":
        await session.setModel(...r.args);
        break;
      case "setEffort":
        await session.setEffort(...r.args);
        break;
      case "respondToPermission":
        await session.respondToPermission(...r.args);
        break;
      case "answerQuestion":
        await session.answerQuestion(...r.args);
        break;
      case "respondToPlan":
        await session.respondToPlan(...r.args);
        break;
      case "interrupt":
        await session.interrupt();
        break;
    }
    await publish();
    if (!closing) await writer.send({ kind: "response", id: r.id });
  };
  await writer.send({ kind: "hello", version: WORKER_VERSION });
  try {
    for await (const request of readFrames(input, decodeWorkerRequest, stop.signal)) {
      if (closing) break;
      if (request.id <= lastId || active.size >= MAX_PENDING)
        throw new Error("invalid request sequence or request overflow");
      lastId = request.id;
      const task = handle(request).catch(async () => {
        // Connector exceptions can contain credentials; keep wire errors generic.
        if (!closing)
          await writer.send({
            kind: "response",
            id: request.id,
            error: { code: "operation_failed", message: `worker ${request.method} failed` },
          });
      });
      active.add(task);
      void task.finally(() => active.delete(task)).catch(fail);
    }
  } finally {
    closing = true;
    stop.abort();
    await session?.close();
  }
  if (failure) throw failure;
};
