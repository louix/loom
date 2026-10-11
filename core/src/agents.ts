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
 *  or one of the sessions `child` already supervises, however deep? */
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
