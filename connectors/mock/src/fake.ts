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
import { stateError, stateIdle, stateRunning, stateStarting } from "@loom/core/session-state";
import { AsyncChannel } from "@loom/core/channel";
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
  UserInput,
} from "@loom/core/types";

const CAPS: ProviderCapabilities = {
  liveModeSwitch: true,
  liveModelSwitch: true,
  forking: false,
  rewind: true,
  subagents: false,
  compaction: true,
  compactionInstructions: true,
  ownsTranscript: false,
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

  /** Opt-in async gates so a test can hold `compact()` / `rewind()` open and
   *  drive `interrupt()` / `send()` against a mid-restructure session. Null
   *  (the default) keeps both synchronous, so existing tests are unchanged. */
  #compactGate: Promise<void> | null = null;
  #rewindGate: Promise<void> | null = null;
  /** Set by `interrupt()` while a gated `compact()` is parked → it emits a
   *  non-fatal "cancelled" error instead of the `compact` boundary (the real
   *  adapters' A2 behaviour). */
  #compactInterrupted = false;

  constructor(id: string, opts: { model?: string; mode: SessionMode }, resumed = false) {
    this.id = id;
    this.providerRef = `fake-${id}`;
    this.resumed = resumed;
    this.#snap = {
      status: stateStarting,
      providerRef: this.providerRef,
      model: opts.model ?? "fake-1",
      effort: null,
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
      /** The prompt-cache TTL the "provider" wrote at, in minutes. */
      cacheTtlMinutes?: number;
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
    // A stand-in fork point so the daemon's non-aisdk rewind path (which reads
    // `rewindRef`, not a message count) is testable against the fake.
    this.#snap.rewindRef = `fake-turn-${this.#snap.turns}`;
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
      ...(opts.cacheTtlMinutes ? { cacheTtlMinutes: opts.cacheTtlMinutes } : {}),
    });
    this.emit({ type: "result", kind: "ok", ...(opts.summary ? { summary: opts.summary } : {}) });
    this.#snap.status = stateIdle;
  }

  /** Emit a fatal error. */
  fail(message: string): void {
    this.emit({ type: "error", message, fatal: true });
    this.#snap.status = stateError(message);
  }

  /** End the event stream (the adapter's `events()` loop finishes). */
  endStream(): void {
    this.#channel.close();
  }

  /** Park the next `compact()` until the returned fn is called. */
  blockCompact(): () => void {
    let release!: () => void;
    this.#compactGate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      this.#compactGate = null;
      release();
    };
  }

  /** Park the next `rewind()` until the returned fn is called. */
  blockRewind(): () => void {
    let release!: () => void;
    this.#rewindGate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      this.#rewindGate = null;
      release();
    };
  }

  // --- AgentSession -----------------------------------------------------

  events(): AsyncIterable<HarnessEvent> {
    return this.#channel;
  }

  async send(input: UserInput): Promise<void> {
    this.sends.push(input);
    this.#snap.status = stateRunning;
  }

  async compact(instructions?: string): Promise<void> {
    this.compacts.push(instructions);
    if (this.#compactGate) {
      this.#compactInterrupted = false;
      await this.#compactGate;
    }
    if (this.#compactInterrupted) {
      this.#compactInterrupted = false;
      this.emit({
        type: "error",
        message: "compaction was cancelled — the transcript was left as-is",
        fatal: false,
      });
      return;
    }
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
    this.#snap.status = stateRunning;
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    // A gated compact in flight → tell it to abandon the boundary.
    if (this.#compactGate) this.#compactInterrupted = true;
  }

  readonly rewinds: Array<{ keep: number; at?: string }> = [];
  async rewind(keep: number, at?: string): Promise<void> {
    if (this.#rewindGate) await this.#rewindGate;
    this.rewinds.push(at === undefined ? { keep } : { keep, at });
    this.#snap.status = stateIdle;
  }

  /** Park *only the next* `setMode()` until the returned fn is called — later
   *  calls run straight through, so a test can tell a serialized command
   *  (queued before the adapter) from one that sailed past the parked call. */
  #modeGate: Promise<void> | null = null;
  blockMode(): () => void {
    let release!: () => void;
    this.#modeGate = new Promise<void>((r) => {
      release = r;
    });
    return release;
  }

  async setMode(mode: SessionMode): Promise<void> {
    const gate = this.#modeGate;
    if (gate) {
      this.#modeGate = null;
      await gate;
    }
    this.modeChanges.push(mode);
    this.#snap.mode = mode;
  }

  async setModel(model: string): Promise<void> {
    this.modelChanges.push(model);
    this.#snap.model = model;
  }

  readonly effortChanges: string[] = [];
  async setEffort(effort: EffortLevel): Promise<void> {
    this.effortChanges.push(effort);
    this.#snap.effort = effort;
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

  /** Park the next `createSession()` until the returned fn is called — a test
   *  holds creation open to drive RPCs against the not-yet-attached session
   *  (the registry row exists from the moment the daemon starts the create).
   *  Null (the default) keeps create synchronous. */
  #createGate: Promise<void> | null = null;
  blockCreate(): () => void {
    let release!: () => void;
    this.#createGate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      this.#createGate = null;
      release();
    };
  }

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
        s.emit({ type: "result", kind: "ok", summary: reply });
        s.endStream();
      }, 0);
      return s;
    }
    this.#sessions.set(s.id, s);
    if (this.#createGate) await this.#createGate;
    return s;
  }

  /** Park the next `resumeSession()` until the returned fn is called — a test
   *  holds a revive open to drive RPCs against a session whose adapter is
   *  being rebuilt from its registry row. */
  #resumeGate: Promise<void> | null = null;
  blockResume(): () => void {
    let release!: () => void;
    this.#resumeGate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      this.#resumeGate = null;
      release();
    };
  }

  async resumeSession(ref: SessionRef): Promise<AgentSession> {
    if (this.#resumeGate) await this.#resumeGate;
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
export const fakeSessionId = (): string => {
  return randomUUID();
};
