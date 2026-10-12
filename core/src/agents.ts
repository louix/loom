/**
 * Loom agents: sessions that supervise sessions (`docs/loom-agents.md`). The
 * names and wire shapes every layer agrees on — the daemon serves the tools,
 * connectors mount them, clients list the profiles.
 */
import { z } from "zod";
import { sessionModeSchema } from "./types.ts";

/** The MCP server (and tool group) through which a session manages its children. */
export const LOOM_AGENTS_SERVER = "loom-agents";

/** The built-in profile: the spawning session's own provider, model, effort and mode. */
export const SELF_PROFILE = "self";

/** `agents.max_depth` when the config does not say: a supervisor and its children. */
export const DEFAULT_MAX_DEPTH = 2;

/** The queue author of a notification a child sends its supervisor. */
export const agentAuthor = (childId: string): string => `agent:${childId}`;

/** Whether a queued message's author is a child's notification ({@link agentAuthor}). */
export const isAgentAuthor = (author: string | undefined): boolean =>
  author?.startsWith("agent:") ?? false;

/** What a child's report says happened to it. */
export type AgentReportEvent = "finished" | "failed" | "interrupted";

/** How a report words each event, after "It "; failed and interrupted add their cause. */
export const AGENT_REPORT_WORDING: Record<AgentReportEvent, string> = {
  finished: "finished a turn",
  failed: "failed",
  interrupted: "was interrupted",
};

/** A report's first line; `cause` is what follows the event's wording. */
export const showAgentReportHead = (
  child: { id: string; title: string | null; profile: string },
  event: AgentReportEvent,
  cause: string,
): string =>
  `[from your sub-agent ${child.id.slice(0, 8)} "${child.title ?? ""}" (profile ${child.profile})] It ${AGENT_REPORT_WORDING[event]}${cause}.`;

const AGENT_REPORT_HEAD = new RegExp(
  `^\\[from your sub-agent (\\S+) "(.*)" \\(profile [^)\\n]*\\)\\] It (${Object.values(AGENT_REPORT_WORDING).join("|")})`,
);

/** A report's child (short id, title) and event, read back from its first line; null for any other text. */
export const parseAgentReportHead = (
  text: string,
): { id: string; title: string; event: AgentReportEvent } | null => {
  const m = AGENT_REPORT_HEAD.exec(text);
  const [, id, title, wording] = m ?? [];
  const event = (Object.keys(AGENT_REPORT_WORDING) as AgentReportEvent[]).find(
    (e) => AGENT_REPORT_WORDING[e] === wording,
  );
  return id === undefined || title === undefined || event === undefined
    ? null
    : { id, title, event };
};

/** The author of the archive reminder, Loom's message to a supervisor about its finished children. */
export const ARCHIVE_REMINDER_AUTHOR = "loom:archive-reminder";

/** The reminder's opening words, up to the colon that introduces the children. */
export const showArchiveReminderLead = (count: number): string =>
  `[loom] You have ${count} ${count === 1 ? "sub-agent that has" : "sub-agents that have"} finished and ${count === 1 ? "is" : "are"} not archived`;

/** How many children a reminder names, read back from its lead; null for any other text. */
export const parseArchiveReminderCount = (text: string): number | null => {
  const m = /^\[loom\] You have (\d+) sub-agents? that ha(?:s|ve) finished and /.exec(text);
  return m?.[1] === undefined ? null : Number(m[1]);
};

/** A profile as clients see it — what choosing one sets, never its prompt. */
export const agentProfileInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  mode: sessionModeSchema.optional(),
});
export type AgentProfileInfo = z.infer<typeof agentProfileInfoSchema>;

/** A session as the supervision tree sees it. */
export interface Supervised {
  readonly id: string;
  readonly supervisorId?: string | undefined;
}

/**
 * How deep `id` sits in its supervision tree: 1 for a session nobody
 * supervises, 2 for its children, and so on. A chain that loops (which
 * {@link supervisionCycle} keeps from ever being written) stops counting where
 * it would repeat.
 */
export const supervisionDepth = (
  id: string,
  lookup: (id: string) => Supervised | undefined,
): number => {
  const seen = new Set<string>();
  let depth = 0;
  for (let at: string | undefined = id; at !== undefined && !seen.has(at); depth++) {
    seen.add(at);
    at = lookup(at)?.supervisorId;
  }
  return depth;
};

/** Would `supervisor` supervising `child` close a loop — is it `child` itself,
 *  or one of the sessions `child` already supervises, however deep? The
 *  daemon's session store refuses every such supervisor write. */
export const supervisionCycle = (
  child: string,
  supervisor: string,
  lookup: (id: string) => Supervised | undefined,
): boolean => {
  const seen = new Set<string>();
  for (let at: string | undefined = supervisor; at !== undefined;) {
    if (at === child) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    at = lookup(at)?.supervisorId;
  }
  return false;
};

/** What a supervisor does with its children when it is archived or deleted. */
export const childrenOnCloseSchema = z.enum(["stop", "detach"]);
export type ChildrenOnClose = z.infer<typeof childrenOnCloseSchema>;
