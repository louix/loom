/**
 * A scriptable provider that implements the seam without any vendor SDK. It
 * stands in for the Claude adapter in tests (and manual play via
 * `loom run --provider fake`), so the daemon's session manager, status
 * derivation and usage rollups can be exercised end to end offline.
 *
 * Tests reach a live session with `provider.session(id)` and drive it:
 * `emit(...)`, `finishTurn()`, `fail(...)`, `endStream()`.
 */
import { randomUUID } from "node:crypto";
import type { HarnessEvent, TokenUsage } from "@loom/core/events";
import { AsyncChannel } from "@loom/core/channel";
import type {
  AdapterSnapshot,
  AgentProvider,
  AgentSession,
  CreateSessionOptions,
  PermissionDecision,
  PlanDecision,
  ProviderCapabilities,
  SessionMode,
  SessionRef,
  UserInput,
} from "@loom/core/types";

const CAPS: ProviderCapabilities = {
  liveModeSwitch: true,
  forking: false,
  rewind: true,
  subagents: false,
  compaction: true,
  oneShot: true,
  partialTokens: false,
  permissionModes: ["default", "plan", "acceptEdits", "auto"],
  models: ["fake-1"],
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PartialEvent = DistributiveOmit<HarnessEvent, "sessionId" | "ts"> & { ts?: number };

export class FakeSession implements AgentSession {
  readonly id: string;
  readonly providerRef: string;

  readonly #channel = new AsyncChannel<HarnessEvent>();
  #snap: AdapterSnapshot;

  // recorded for test assertions
  readonly sends: string[] = [];
  readonly compacts: Array<string | undefined> = [];
  readonly permissionResponses: Array<{ id: string; decision: PermissionDecision }> = [];
  readonly questionAnswers: Array<{ id: string; text: string }> = [];
  readonly planResponses: Array<{ id: string; decision: PlanDecision }> = [];
  readonly modeChanges: SessionMode[] = [];
  readonly modelChanges: string[] = [];
  interruptCount = 0;
  closed = false;
  readonly resumed: boolean;

  constructor(id: string, opts: { model?: string; mode: SessionMode }, resumed = false) {
    this.id = id;
    this.providerRef = `fake-${id}`;
    this.resumed = resumed;
    this.#snap = {
      status: "starting",
      providerRef: this.providerRef,
      model: opts.model ?? "fake-1",
      mode: opts.mode,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextUsed: 0,
      contextLimit: 100_000,
      costUsd: 0,
      turns: 0,
    };
  }

  // --- test driver surface ------------------------------------------------

  /** Push a normalized event onto the stream. `sessionId` / `ts` are filled in. */
  emit(ev: PartialEvent): void {
    this.#channel.push({ sessionId: this.id, ts: ev.ts ?? Date.now(), ...ev } as HarnessEvent);
  }

  /** A tidy end-of-turn: a usage delta then a successful `result`. */
  finishTurn(
    opts: {
      summary?: string;
      usage?: Partial<TokenUsage>;
      costUsd?: number;
      contextUsed?: number;
    } = {},
  ): void {
    const u = opts.usage ?? {};
    const tokens: TokenUsage = {
      input: u.input ?? 100,
      output: u.output ?? 20,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
    };
    this.#snap.turns += 1;
    this.#snap.usage = {
      input: this.#snap.usage.input + tokens.input,
      output: this.#snap.usage.output + tokens.output,
      cacheRead: this.#snap.usage.cacheRead + tokens.cacheRead,
      cacheWrite: this.#snap.usage.cacheWrite + tokens.cacheWrite,
    };
    this.#snap.costUsd += opts.costUsd ?? 0.001;
    this.#snap.contextUsed = opts.contextUsed ?? tokens.input;
    this.emit({
      type: "usage",
      tokens,
      contextUsed: this.#snap.contextUsed,
      contextLimit: this.#snap.contextLimit,
      ...(opts.costUsd ? { costDeltaUsd: opts.costUsd } : { costDeltaUsd: 0.001 }),
    });
    this.emit({ type: "result", ok: true, ...(opts.summary ? { summary: opts.summary } : {}) });
    this.#snap.status = "idle";
  }

  /** Emit a fatal error. */
  fail(message: string): void {
    this.emit({ type: "error", message, fatal: true });
    this.#snap.status = "error";
  }

  /** End the event stream (the adapter's `events()` loop finishes). */
  endStream(): void {
    this.#channel.close();
  }

  // --- AgentSession -----------------------------------------------------

  events(): AsyncIterable<HarnessEvent> {
    return this.#channel;
  }

  async send(input: UserInput): Promise<void> {
    this.sends.push(input);
    this.#snap.status = "running";
  }

  async compact(instructions?: string): Promise<void> {
    this.compacts.push(instructions);
    const before = this.#snap.contextUsed || 100_000;
    const after = Math.round(before * 0.3);
    this.#snap.contextUsed = after;
    this.emit({ type: "compact", trigger: "manual", before, after });
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    this.permissionResponses.push({ id, decision });
  }

  async answerQuestion(id: string, text: string): Promise<void> {
    this.questionAnswers.push({ id, text });
  }

  async respondToPlan(id: string, decision: PlanDecision): Promise<void> {
    this.planResponses.push({ id, decision });
    this.#snap.status = "running";
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  readonly rewinds: number[] = [];
  async rewind(keep: number): Promise<void> {
    this.rewinds.push(keep);
    this.#snap.status = "idle";
  }

  async setMode(mode: SessionMode): Promise<void> {
    this.modeChanges.push(mode);
    this.#snap.mode = mode;
  }

  async setModel(model: string): Promise<void> {
    this.modelChanges.push(model);
    this.#snap.model = model;
  }

  snapshot(): AdapterSnapshot {
    return { ...this.#snap, usage: { ...this.#snap.usage } };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#channel.close();
  }
}

export class FakeProvider implements AgentProvider {
  readonly id = "fake";
  readonly capabilities = CAPS;

  /** What a `oneShot` session answers with (used to exercise the auto-titler). */
  titleReply = "a concise fake title";

  #sessions = new Map<string, FakeSession>();

  async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
    const s = new FakeSession(opts.sessionId, {
      mode: opts.mode,
      ...(opts.model ? { model: opts.model } : {}),
    });
    if (opts.oneShot) {
      // Throwaway: answer once and finish, without joining the tracked set.
      const reply = this.titleReply;
      setTimeout(() => {
        s.emit({ type: "assistant_text", text: reply });
        s.emit({ type: "result", ok: true, summary: reply });
        s.endStream();
      }, 0);
      return s;
    }
    this.#sessions.set(s.id, s);
    return s;
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    const s = new FakeSession(
      ref.sessionId,
      { mode: ref.mode ?? "default", ...(ref.model ? { model: ref.model } : {}) },
      true,
    );
    this.#sessions.set(s.id, s);
    return s;
  }

  async listPersistedSessions(): Promise<SessionRef[]> {
    return [];
  }

  /** Test surface: the live session by Loom id. */
  session(id: string): FakeSession | undefined {
    return this.#sessions.get(id);
  }
}

/** Handy for tests that want a unique id without a daemon. */
export function fakeSessionId(): string {
  return randomUUID();
}
