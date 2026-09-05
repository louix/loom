/**
 * Finds which currently-configured Claude profile owns an orphaned session.
 *
 * A Claude provider's id is derived from its `[[claude_profiles]]` `name`
 * (`claudeProfileId` in `../config/config.ts`), so renaming a profile changes
 * the id every session on it has persisted (`sessions.provider`) — even
 * though the profile's `CLAUDE_CONFIG_DIR` (`dir`) never moved. Claude Code
 * writes each session's transcript to `<dir>/projects/<projectKey>/<sessionId>.jsonl`,
 * keyed by session id in the filename regardless of any Loom-side naming, so
 * checking disk across all configured profiles tells us which one actually
 * has the session — a direct fs check, not the SDK's `listSessions()`, to
 * avoid mutating the global `process.env.CLAUDE_CONFIG_DIR` (the hazard noted
 * for `ClaudeAdapter#forkTruncated`).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeProfile } from "../config/config.ts";

/** Every configured profile whose `dir` has a transcript for `sessionRef`. */
export const findClaudeOwner = (profiles: ClaudeProfile[], sessionRef: string): ClaudeProfile[] =>
  profiles.filter((p) => {
    const projectsDir = join(p.dir, "projects");
    if (!existsSync(projectsDir)) return false;
    return readdirSync(projectsDir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && existsSync(join(projectsDir, e.name, `${sessionRef}.jsonl`)),
    );
  });
