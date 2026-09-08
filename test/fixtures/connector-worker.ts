import { FakeProvider, FakeSession } from "../../connectors/mock/src/fake.ts";
import type {
  CreateSessionOptions,
  PermissionDecision,
  PlanDecision,
} from "../../core/src/types.ts";
import { serveWorker } from "../../runtime/src/worker/serve.ts";

class ScriptedSession extends FakeSession {
  #release: (() => void) | undefined;
  override async send(input: string) {
    await super.send(input);
    if (input === "crash") Deno.exit(17);
    if (input === "wrong-session") {
      // Deliberately bypass FakeSession's normal binding for an adversarial probe.
      const event = { type: "assistant_text" as const, text: "bad", sessionId: "peer" };
      this.emit(event);
    } else if (input === "flood") {
      for (let i = 0; i < 12; i++) this.emit({ type: "assistant_text", text: "x".repeat(600_000) });
    } else if (input === "question") {
      this.emit({ type: "question", id: "q", question: "Continue?" });
    } else if (input === "permission") {
      this.emit({ type: "permission_request", id: "p", tool: "write", input: {} });
    } else if (input === "plan") {
      this.emit({ type: "plan_review", id: "r", plan: "Do the work" });
    } else {
      this.emit({ type: "assistant_text", text: input });
      this.finishTurn();
    }
  }
  override async compact(instructions?: string) {
    if (instructions === "wait") {
      const gate = Promise.withResolvers<void>();
      this.#release = gate.resolve;
      this.emit({ type: "question", id: "compact", question: "Waiting" });
      await gate.promise;
    } else await super.compact(instructions);
  }
  override async interrupt() {
    await super.interrupt();
    this.#release?.();
    this.emit({ type: "status_changed", status: { kind: "interrupted", by: "user" } });
  }
  override async answerQuestion(id: string, text: string) {
    await super.answerQuestion(id, text);
    this.emit({ type: "assistant_text", text });
  }
  override async respondToPermission(id: string, decision: PermissionDecision) {
    await super.respondToPermission(id, decision);
    this.emit({ type: "assistant_text", text: decision.behavior });
  }
  override async respondToPlan(id: string, decision: PlanDecision) {
    await super.respondToPlan(id, decision);
    this.emit({ type: "assistant_text", text: decision.action });
  }
  override async close() {
    this.#release?.();
    await super.close();
  }
}
class ScriptedProvider extends FakeProvider {
  override async createSession(opts: CreateSessionOptions) {
    return new ScriptedSession(opts.sessionId, opts);
  }
}
await serveWorker(
  Deno.stdin.readable,
  Deno.stdout.writable,
  async () => new ScriptedProvider(),
).catch(() => Deno.exit(1));
Deno.exit(0);
