/**
 * The `loom-agents` tools (docs/loom-agents.md): how a session starts and
 * manages its children. Like `./loom-tools.ts`, only the SDK-agnostic surface
 * lives here — names, descriptions and input shapes — mounted by the Claude
 * adapter (an in-process MCP server), aisdk sessions (plain `tool()`s) and
 * Codex (dynamic tools). None of them can act on the fleet: every call is
 * parked here and handed to the daemon as an `agent_call` event, which answers
 * it through `AgentSession.respondToAgentCall`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentCallResult } from "@loom/core/types";

export const AGENT_TOOL_NAMES = [
  "agents_profiles",
  "agent_start",
  "agent_message",
  "agent_status",
  "agent_read",
  "agent_interrupt",
  "agent_stop",
  "agent_wait",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const isAgentTool = (name: string): name is AgentToolName =>
  (AGENT_TOOL_NAMES as readonly string[]).includes(name);

/** Tools that only look: never gated, and offered in plan mode. */
export const READONLY_AGENT_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "agents_profiles",
  "agent_status",
  "agent_read",
  "agent_wait",
]);

const id = z.string().describe("The child's session id, as agent_start returned it.");

/** Bare zod field objects, as `./loom-tools.ts` keeps them (see there). */
export const AGENT_TOOLS = {
  agents_profiles: {
    description:
      "List the agent profiles you can start a child with: each one's name, what it is for, and " +
      "what it runs (provider, model, effort, mode). `self` is always there: your own settings.",
    shape: {},
  },
  agent_start: {
    description:
      "Start a child session — a Loom sub-agent — on a profile, with a task. It works in its own " +
      "worktree from your last commit (uncommitted changes do not carry over: commit first), " +
      "runs on its own, and the user can see and steer it. Returns its id at once; you are " +
      "notified when it finishes a turn, waits for input, fails or is interrupted, so the usual " +
      "pattern is to start children and end your turn.",
    shape: {
      profile: z.string().describe("A profile name from agents_profiles; `self` for your own."),
      task: z
        .string()
        .describe(
          "The complete, self-contained task: what to do, how to verify it, what to report back.",
        ),
      title: z.string().describe("A short title for the child, as the fleet shows it."),
      task_id: z
        .string()
        .optional()
        .describe("Your id for the task, shared by every run on it (e.g. implementer, verifier)."),
    },
  },
  agent_message: {
    description:
      "Send one of your children a message through its queue, labelled as coming from you. " +
      "`next_boundary` reaches it at its next tool boundary (or starts a turn when it is idle); " +
      "`end_of_turn` waits until it has finished.",
    shape: {
      id,
      text: z.string().describe("The message."),
      delivery: z
        .enum(["next_boundary", "end_of_turn"])
        .optional()
        .describe("When it reaches the child; defaults to next_boundary."),
    },
  },
  agent_status: {
    description:
      "Your children's status: state, profile, branch, diff stats against their base, cost and " +
      "the start of their last message. Give an id for one child; omit it for all.",
    shape: { id: id.optional() },
  },
  agent_read: {
    description:
      "Read a child's transcript, bounded. Without `since`: its last final message whole. With " +
      "`since` (the cursor an earlier read returned): what happened after it, oldest first, up " +
      "to a size limit, with the cursor to continue from.",
    shape: {
      id,
      since: z.number().int().nonnegative().optional().describe("A cursor from an earlier read."),
    },
  },
  agent_interrupt: {
    description: "Stop a child's current turn. It stays available for further messages.",
    shape: { id },
  },
  agent_stop: {
    description:
      "Stop a child for good and archive it; its branch and transcript are kept. A child with " +
      "uncommitted changes is refused unless `discard` is set.",
    shape: {
      id,
      discard: z
        .boolean()
        .optional()
        .describe("Archive even with uncommitted changes, losing them."),
    },
  },
  agent_wait: {
    description:
      "Block until children settle (finish their turn, wait for input, fail or stop), or the " +
      "timeout passes. Prefer ending your turn — you are woken when they report — and keep waits short.",
    shape: {
      ids: z.array(z.string()).min(1).describe("Child session ids."),
      until: z
        .enum(["any", "all"])
        .optional()
        .describe("Return when any of them settles, or all (the default)."),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Seconds to wait at most; default 60, at most 600."),
    },
  },
} as const satisfies Record<
  AgentToolName,
  { description: string; shape: Record<string, z.ZodType> }
>;

/** A tool's input as a JSON schema, for providers that take one (Codex). */
export const agentToolJsonSchema = (name: AgentToolName): Record<string, unknown> => {
  const schema = z.toJSONSchema(z.object(AGENT_TOOLS[name].shape), { target: "draft-07" });
  delete (schema as Record<string, unknown>)["$schema"];
  return schema as Record<string, unknown>;
};

/**
 * Agent tool calls parked until the daemon answers them — the
 * `PendingInteractions` pattern for `agent_call`. An adapter mints the event
 * through `emit`; interrupt and close drain whatever is still parked.
 */
export class AgentCalls {
  readonly #calls = new Map<string, (result: AgentCallResult) => void>();

  call(emit: (id: string) => void): Promise<AgentCallResult> {
    const callId = randomUUID();
    const answer = new Promise<AgentCallResult>((resolve) => this.#calls.set(callId, resolve));
    emit(callId);
    return answer;
  }

  /** Settles one call; false when it is unknown or already settled. */
  resolve(callId: string, result: AgentCallResult): boolean {
    const settle = this.#calls.get(callId);
    if (!settle) return false;
    this.#calls.delete(callId);
    settle(result);
    return true;
  }

  failAll(reason: string): void {
    for (const settle of this.#calls.values()) settle({ ok: false, text: reason });
    this.#calls.clear();
  }
}
