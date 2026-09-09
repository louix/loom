import type { TranscriptStore } from "../../../../core/src/transcript.ts";
import type { HarnessEvent } from "../../../../core/src/events.ts";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  PermissionDecision,
  PlanDecision,
  ProviderCapabilities,
  SessionMode,
  SessionRef,
  DiscoveredModel,
} from "../../../../core/src/types.ts";
import {
  decodeWorkerFrame,
  MAX_FRAME_BYTES,
  MAX_PENDING,
  WORKER_VERSION,
  type WorkerCommand,
  type WorkerFrame,
  type WorkerProfile,
  type WorkerRole,
} from "../../../../core/src/worker.ts";
import { FrameWriter, readFrames } from "../../../../runtime/src/worker/transport.ts";
import {
  launchLocalWorker,
  type WorkerLauncher,
  type WorkerLaunchSpec,
  type WorkerProcess,
} from "./worker-launch.ts";

const deferred = <T>() => {
  const d = Promise.withResolvers<T>();
  void d.promise.catch(() => {});
  return d;
};

/** A bounded single-consumer stream; overflow fails the worker, never drops events. */
class EventStream {
  #queue: Array<{ event: HarnessEvent; bytes: number }> = [];
  #bytes = 0;
  #changed = deferred<void>();
  #ended = false;
  #error: Error | undefined;
  #consumed = false;
  push(event: HarnessEvent) {
    if (this.#ended) throw new Error("event after stream end");
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (this.#bytes + bytes > 4 * MAX_FRAME_BYTES || this.#queue.length >= 10_000)
      throw new Error("worker event overflow");
    this.#queue.push({ event, bytes });
    this.#bytes += bytes;
    this.#changed.resolve();
  }
  end(error?: Error) {
    this.#ended = true;
    this.#error ??= error;
    this.#changed.resolve();
  }
  async *events(): AsyncGenerator<HarnessEvent> {
    if (this.#consumed) throw new Error("worker events already consumed");
    this.#consumed = true;
    try {
      for (;;) {
        const item = this.#queue.shift();
        if (item) {
          this.#bytes -= item.bytes;
          yield item.event;
          continue;
        }
        if (this.#error) throw this.#error;
        if (this.#ended) return;
        this.#changed = deferred<void>();
        await this.#changed.promise;
      }
    } finally {
      this.#consumed = false;
    }
  }
}

interface Pending {
  expected: WorkerFrame["kind"];
  resolve(frame: WorkerFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One connection owns one session identity; responses cannot select another session. */
export class RemoteWorkerSession implements AgentSession {
  readonly id: string;
  readonly pid: number;
  readonly #process: WorkerProcess;
  readonly #writer: FrameWriter;
  readonly #hello = deferred<void>();
  readonly #pending = new Map<number, Pending>();
  readonly #events = new EventStream();
  readonly #generation = crypto.randomUUID();
  readonly #timeoutMs: number;
  readonly #readDone: Promise<void>;
  readonly #readStop = new AbortController();
  #transcript: TranscriptStore | undefined;
  #snapshot: AdapterSnapshot | undefined;
  #seq = 0;
  #requestId = 0;
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;
  #stopping = false;
  #sawHello = false;
  #ready = false;
  #ended = false;

  private constructor(id: string, proc: WorkerProcess, timeoutMs: number) {
    this.id = id;
    this.pid = proc.pid;
    this.#process = proc;
    this.#writer = new FrameWriter(proc.input);
    this.#timeoutMs = timeoutMs;
    this.#readDone = this.#read().catch((e) => this.#fail(e));
    void proc.exited.then(
      () => {
        if (!this.#stopping) {
          // Reap descendants, but consume already-written final frames before
          // interpreting EOF as failure. Descendants may still own the pipes.
          proc.terminate();
          const timer = setTimeout(() => this.#readStop.abort(), 1000);
          void this.#readDone.finally(() => clearTimeout(timer));
        }
      },
      (e) => this.#fail(e),
    );
  }

  static async connect(
    id: string,
    providerId: string,
    spec: WorkerLaunchSpec,
    launch: WorkerLauncher = launchLocalWorker,
    timeoutMs = 10_000,
    profile: WorkerProfile = { connector: "@loom/connector-mock", config: {} },
    role: WorkerRole = "session",
  ): Promise<{ session: RemoteWorkerSession; capabilities: ProviderCapabilities }> {
    let process: WorkerProcess;
    try {
      process = launch(spec);
    } catch (e) {
      for (const path of spec.cleanupPaths ?? []) await Deno.remove(path, { recursive: true });
      throw e;
    }
    const s = new RemoteWorkerSession(id, process, timeoutMs);
    const timer = setTimeout(() => s.#fail(new Error("worker startup timed out")), timeoutMs);
    try {
      await s.#hello.promise;
      const ready = await s.#request({
        method: "initialize",
        args: [
          {
            generation: s.#generation,
            providerId,
            sessionId: id,
            ...profile,
            role,
          },
        ],
      });
      if (ready.kind !== "ready" || ready.generation !== s.#generation)
        throw new Error("invalid worker ready");
      return { session: s, capabilities: ready.capabilities };
    } catch (e) {
      s.#fail(e);
      await s.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async attachTranscript(store: TranscriptStore): Promise<void> {
    if (this.#snapshot || this.#transcript) throw new Error("transcript already attached");
    this.#transcript = store;
    for (const message of store.load(this.id))
      await this.#request({ method: "seedTranscript", args: [[message]] });
  }

  get providerRef(): string | null {
    return this.#snapshot?.providerRef ?? null;
  }
  snapshot(): AdapterSnapshot {
    if (!this.#snapshot) throw new Error("worker has no session state");
    return structuredClone(this.#snapshot);
  }
  events(): AsyncIterable<HarnessEvent> {
    return this.#events.events();
  }

  async start(command: Extract<WorkerCommand, { method: "create" | "resume" }>): Promise<void> {
    await this.#request(command);
    if (!this.#snapshot) {
      this.#fail(new Error("missing initial worker state"));
      throw this.#failure;
    }
  }
  async send(input: string): Promise<void> {
    await this.#request({ method: "send", args: [input] });
  }
  async compact(instructions?: string): Promise<void> {
    await this.#request(
      { method: "compact", args: instructions === undefined ? [] : [instructions] },
      30 * 60_000,
    );
  }
  async rewind(keep: number, at?: string): Promise<void> {
    await this.#request(
      { method: "rewind", args: at === undefined ? [keep] : [keep, at] },
      30 * 60_000,
    );
  }
  async setMode(mode: SessionMode): Promise<void> {
    await this.#request({ method: "setMode", args: [mode] });
  }
  async setModel(model: string): Promise<void> {
    await this.#request({ method: "setModel", args: [model] });
  }
  async setEffort(effort: EffortLevel): Promise<void> {
    await this.#request({ method: "setEffort", args: [effort] });
  }
  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    await this.#request({ method: "respondToPermission", args: [id, decision] });
  }
  async answerQuestion(id: string, text: string): Promise<void> {
    await this.#request({ method: "answerQuestion", args: [id, text] });
  }
  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    await this.#request({ method: "respondToPlan", args: [id, decision] });
  }
  async interrupt(): Promise<void> {
    await this.#request({ method: "interrupt", args: [] });
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const frame = await this.#request({ method: "listModels", args: [] }, 20_000);
    if (frame.kind !== "models") throw new Error("invalid discovery response");
    return frame.models;
  }
  async listPersistedSessions(): Promise<SessionRef[]> {
    const frame = await this.#request({ method: "listPersistedSessions", args: [] }, 20_000);
    if (frame.kind !== "sessions") throw new Error("invalid enumeration response");
    return frame.sessions;
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close().catch((error) => {
      this.#closing = undefined;
      throw error;
    }));
  }
  async #close(): Promise<void> {
    this.#stopping = true;
    try {
      if (!this.#failure && this.#ready) await this.#request({ method: "close", args: [] }, 5000);
    } catch {
      /* force termination below */
    } finally {
      this.#process.terminate();
      await this.#process.exited.catch(() => {});
      this.#readStop.abort();
      await this.#readDone;
      this.#rejectPending(new Error("worker closed"));
      this.#events.end();
      await this.#writer.close().catch(() => {});
      await this.#process.cleanup?.();
    }
  }
  #rejectPending(error: Error) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
  }
  #fail(error: unknown) {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error("worker connection failed");
    this.#hello.reject(this.#failure);
    this.#rejectPending(this.#failure);
    this.#events.end(this.#ended ? undefined : this.#failure);
    this.#process.terminate();
    void this.close().catch(() => {});
  }
  #request(command: WorkerCommand, timeoutMs = this.#timeoutMs): Promise<WorkerFrame> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#stopping && command.method !== "close")
      return Promise.reject(new Error("worker closing"));
    if (this.#pending.size >= MAX_PENDING)
      return Promise.reject(new Error("too many worker requests"));
    const id = ++this.#requestId;
    const d = deferred<WorkerFrame>();
    const timer = setTimeout(
      () => this.#fail(new Error(`worker ${command.method} timed out`)),
      timeoutMs,
    );
    const kinds: Partial<Record<WorkerCommand["method"], WorkerFrame["kind"]>> = {
      initialize: "ready",
      listModels: "models",
      listPersistedSessions: "sessions",
    };
    const expected = kinds[command.method] ?? "response";
    this.#pending.set(id, { resolve: d.resolve, reject: d.reject, timer, expected });
    void this.#writer.send({ kind: "request", id, ...command }).catch((e) => this.#fail(e));
    return d.promise;
  }
  async #read() {
    for await (const f of readFrames(
      this.#process.output,
      decodeWorkerFrame,
      this.#readStop.signal,
    )) {
      if (this.#failure) break;
      if (!this.#sawHello) {
        if (f.kind !== "hello" || f.version !== WORKER_VERSION)
          throw new Error("incompatible worker protocol");
        this.#sawHello = true;
        this.#hello.resolve();
        continue;
      }
      switch (f.kind) {
        case "transcript":
          if (
            !this.#ready ||
            !this.#transcript ||
            this.#ended ||
            f.from > this.#transcript.count(this.id)
          )
            throw new Error("invalid transcript mutation");
          this.#transcript.replaceFrom(this.id, f.from, f.messages);
          break;
        case "hello":
          throw new Error("duplicate worker hello");
        case "ready":
        case "models":
        case "sessions":
        case "response": {
          const p = this.#pending.get(f.id);
          if (!p) throw new Error("unexpected worker response");
          if (f.kind !== p.expected && !(f.kind === "response" && f.error))
            throw new Error("wrong worker response kind");
          if (f.kind === "ready") {
            if (this.#ready || f.id !== 1 || f.generation !== this.#generation)
              throw new Error("unexpected worker ready");
            this.#ready = true;
          } else if (!this.#ready && !(f.kind === "response" && f.error))
            throw new Error("worker not initialized");
          this.#pending.delete(f.id);
          clearTimeout(p.timer);
          if (f.kind === "response" && f.error) p.reject(new Error(f.error.message));
          else p.resolve(f);
          break;
        }
        case "state":
          if (!this.#ready) throw new Error("state before ready");
          this.#snapshot = f.snapshot;
          break;
        case "event":
          if (
            !this.#snapshot ||
            this.#ended ||
            f.seq !== ++this.#seq ||
            f.event.sessionId !== this.id
          )
            throw new Error("invalid worker event sequence or binding");
          if (!this.#stopping) this.#events.push(f.event);
          break;
        case "end":
          if (!this.#snapshot || this.#ended) throw new Error("unexpected worker stream end");
          this.#ended = true;
          this.#events.end();
          break;
      }
    }
    if (!this.#stopping && !this.#failure) throw new Error("worker connection ended");
  }
}

/** Profile-scoped facade; every session gets a fresh process and connection. */
export class WorkerProvider implements AgentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly spec: (cwd: string, role?: WorkerRole) => WorkerLaunchSpec;
  readonly profile: WorkerProfile;
  readonly launch: WorkerLauncher;
  private constructor(
    id: string,
    capabilities: ProviderCapabilities,
    spec: (cwd: string, role?: WorkerRole) => WorkerLaunchSpec,
    launch: WorkerLauncher,
    profile: WorkerProfile,
  ) {
    this.id = id;
    this.capabilities = capabilities;
    this.spec = spec;
    this.launch = launch;
    this.profile = profile;
  }
  static async create(
    id: string,
    spec: (cwd: string, role?: WorkerRole) => WorkerLaunchSpec,
    launch: WorkerLauncher = launchLocalWorker,
    profile: WorkerProfile = { connector: "@loom/connector-mock", config: {} },
  ): Promise<WorkerProvider> {
    const probe = await RemoteWorkerSession.connect(
      crypto.randomUUID(),
      id,
      spec(Deno.cwd(), "capabilities"),
      launch,
      10_000,
      profile,
      "capabilities",
    );
    await probe.session.close();
    return new WorkerProvider(id, probe.capabilities, spec, launch, profile);
  }
  async #start(
    command: Extract<WorkerCommand, { method: "create" | "resume" }>,
  ): Promise<AgentSession> {
    const opts = command.args[0];
    const role = command.method === "create" && command.args[0].oneShot ? "title" : "session";
    const spec = this.spec(opts.cwd, role);
    const { session } = await RemoteWorkerSession.connect(
      opts.sessionId,
      this.id,
      spec,
      this.launch,
      10_000,
      this.profile,
      role,
    );
    try {
      if (role === "title" && command.method === "create") {
        const {
          workspaceRoot: _workspace,
          repoInstructions: _instructions,
          subagents: _agents,
          ...title
        } = command.args[0];
        await session.start({
          method: "create",
          args: [
            { ...title, cwd: spec.cwd, mcpServers: [], loomServer: false, settingSources: [] },
          ],
        });
      } else await session.start(command);
      return session;
    } catch (e) {
      await session.close();
      throw e;
    }
  }
  createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    return this.#start({ method: "create", args: [opts] });
  }
  resumeSession(ref: SessionRef): Promise<AgentSession> {
    return this.#start({ method: "resume", args: [ref] });
  }
  async listPersistedSessions(): Promise<SessionRef[]> {
    return this.#utility("enumeration", (s) => s.listPersistedSessions());
  }
  async listModels(): Promise<DiscoveredModel[]> {
    return this.#utility("discovery", (s) => s.listModels());
  }
  async #utility<T>(
    role: WorkerRole,
    run: (session: RemoteWorkerSession) => Promise<T>,
  ): Promise<T> {
    const { session } = await RemoteWorkerSession.connect(
      crypto.randomUUID(),
      this.id,
      this.spec(Deno.cwd(), role),
      this.launch,
      10_000,
      this.profile,
      role,
    );
    try {
      return await run(session);
    } finally {
      await session.close();
    }
  }
}
