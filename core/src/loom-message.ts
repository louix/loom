/**
 * The messages Loom writes itself to a supervising agent — a child's report,
 * the archive reminder. One value yields both the text the model reads and
 * what a client shows in its place, so a client never reads the text back.
 */
import { z } from "zod";
import { absurd } from "./absurd.ts";

export const agentReportEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finished") }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("interrupted"), reason: z.string() }),
]);
export type AgentReportEvent = z.infer<typeof agentReportEventSchema>;

export const loomMessageSchema = z.discriminatedUnion("kind", [
  /** A child's turn ended; `workspace` and `summary.text` are as shown to the model. */
  z.object({
    kind: z.literal("agent_report"),
    child: z.object({ id: z.string(), title: z.string().nullable(), profile: z.string() }),
    event: agentReportEventSchema,
    workspace: z.string().nullable(),
    summary: z.object({ text: z.string(), cut: z.boolean() }).nullable(),
  }),
  /** Finished children not yet archived; `about` is their state and workspace as shown. */
  z.object({
    kind: z.literal("archive_reminder"),
    children: z.array(
      z.object({ id: z.string(), title: z.string().nullable(), about: z.string() }),
    ),
  }),
]);
export type LoomMessage = z.infer<typeof loomMessageSchema>;

const showAgentReportEvent = (e: AgentReportEvent): string => {
  switch (e.kind) {
    case "finished":
      return "finished a turn";
    case "failed":
      return `failed: ${e.message}`;
    case "interrupted":
      return `was interrupted (${e.reason})`;
    default:
      return absurd(e);
  }
};

/** The text of a Loom message, as the supervisor's model reads it. */
export const showLoomMessage = (m: LoomMessage): string => {
  switch (m.kind) {
    case "agent_report":
      return [
        `[from your sub-agent ${m.child.id.slice(0, 8)} "${m.child.title ?? ""}" (profile ${m.child.profile})] It ${showAgentReportEvent(m.event)}.`,
        ...(m.workspace === null ? [] : [`Its workspace: ${m.workspace}.`]),
        ...(m.summary === null
          ? []
          : [`Summary${m.summary.cut ? " (truncated)" : ""}: ${m.summary.text}`]),
        `For full details: run \`agent_read\` with id \`${m.child.id}\``,
      ].join("\n");
    case "archive_reminder": {
      const n = m.children.length;
      const named = m.children.map((c) => `${c.id.slice(0, 8)} "${c.title ?? ""}" (${c.about})`);
      return (
        `[loom] You have ${n} ${n === 1 ? "sub-agent that has" : "sub-agents that have"} finished and ${n === 1 ? "is" : "are"} not archived: ` +
        `${named.join("; ")}. Archive each with agent_stop once its work is merged or no longer ` +
        "needed, or keep it if you will message it again. You won't be reminded about these again."
      );
    }
    default:
      return absurd(m);
  }
};
