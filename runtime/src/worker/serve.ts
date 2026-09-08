import {
  decodeWorkerRequest,
  MAX_PENDING,
  WORKER_VERSION,
  WorkerDiagnostic,
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
  onShutdown: () => void = () => {},
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
  let poll: ReturnType<typeof setInterval> | undefined;
  let lastState = "";
  const fail = (error: unknown) => {
    failure ??= error;
    closing = true;
    stop.abort();
  };
  const publish = async () => {
    if (!session || closing) return;
    const snapshot = session.snapshot();
    const state = JSON.stringify(snapshot);
    if (state !== lastState) {
      lastState = state;
      await writer.send({ kind: "state", snapshot });
    }
  };
  const pump = async (s: AgentSession) => {
    const stream = s.events();
    for await (const event of stream) {
      if (closing) break;
      if ("dropped" in stream && stream.dropped !== 0) throw new Error("connector event overflow");
      if (event.sessionId !== binding?.sessionId)
        throw new Error("connector emitted wrong session");
      await publish();
      if (!closing) await writer.send({ kind: "event", seq: ++seq, event });
    }
    if (!closing) {
      await writer.send({ kind: "end" });
      if (binding?.connector === "@loom/connector-claude") {
        closing = true;
        stop.abort();
      }
    }
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
      if (binding.role !== "session" && binding.role !== "title")
        throw new Error("worker role cannot create a session");
      if (
        binding.role === "title" &&
        (r.method !== "create" ||
          !r.args[0].oneShot ||
          r.args[0].mcpServers.length ||
          r.args[0].loomServer)
      )
        throw new Error("invalid title session");
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
      poll = setInterval(() => {
        void publish().catch(fail);
      }, 100);
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
    if (r.method === "listModels" || r.method === "listPersistedSessions") {
      if (started || binding.role !== (r.method === "listModels" ? "discovery" : "enumeration"))
        throw new Error("invalid utility worker role");
      started = true;
      if (r.method === "listModels") {
        const models = (await provider.listModels?.()) ?? [];
        if (!closing) await writer.send({ kind: "models", id: r.id, models });
      } else {
        const sessions = await provider.listPersistedSessions();
        if (!closing) await writer.send({ kind: "sessions", id: r.id, sessions });
      }
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
      const task = handle(request).catch(async (error: unknown) => {
        // Connector exceptions can contain credentials; keep wire errors generic.
        if (!closing)
          await writer.send({
            kind: "response",
            id: request.id,
            error: {
              code: "operation_failed",
              message:
                error instanceof WorkerDiagnostic
                  ? error.message
                  : `worker ${request.method} failed`,
            },
          });
      });
      active.add(task);
      void task.finally(() => active.delete(task)).catch(fail);
    }
  } finally {
    closing = true;
    onShutdown();
    clearInterval(poll);
    stop.abort();
    await session?.close();
  }
  if (failure) throw failure;
};
