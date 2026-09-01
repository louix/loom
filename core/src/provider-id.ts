/**
 * Provider-id predicates shared by the daemon and the TUI. A Claude profile
 * (`[[claude_profiles]]` in config) is served by the same connector as the base
 * `claude` provider but under a distinct id, `claude:<slug>` — so the "is this a
 * Claude session?" checks scattered across both packages have to match the
 * family, not the literal.
 */

/** The base `claude` id and every `claude:<profile>` id. */
export const isClaudeId = (id: string): boolean => id === "claude" || id.startsWith("claude:");
