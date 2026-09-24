import {
  createMcpOAuthStore,
  matchingOAuthCredential,
  type McpOAuthStore,
} from "./mcp-oauth-store.ts";
import { McpOAuthError, mcpOAuthIdentity, type McpOAuthConfig } from "./mcp-oauth-model.ts";
import { oauthUsable } from "./mcp-oauth-tokens.ts";

export const mcpOAuthStatus = async (
  name: string,
  resource: string,
  config: McpOAuthConfig,
  store: McpOAuthStore = createMcpOAuthStore(name),
) => {
  try {
    const c = matchingOAuthCredential(await store.peek(), mcpOAuthIdentity(name, resource, config));
    let state = "login_required";
    if (oauthUsable(c)) state = "ready";
    else if (c?.refreshToken)
      state = (c.retryAt ?? 0) > Date.now() ? "refresh_failed" : "refresh_required";
    return {
      kind: "oauth" as const,
      state,
      expiresAt: c?.expiresAt ? new Date(c.expiresAt).toISOString() : null,
      refreshable: !!c?.refreshToken,
      reason: state === "ready" ? null : state,
    };
  } catch (error) {
    const state =
      error instanceof McpOAuthError && error.code === "config_changed"
        ? "config_changed"
        : "storage_unavailable";
    return { kind: "oauth" as const, state, expiresAt: null, refreshable: false, reason: state };
  }
};
export const mcpOAuthDiagnostic = (name: string, state: string): string => {
  if (state === "refresh_failed") return name + ": OAuth refresh failed; retry later";
  if (state === "storage_unavailable") return name + ": OAuth credential storage unavailable";
  return (
    name +
    ": " +
    (state === "config_changed" ? "OAuth configuration changed; " : "") +
    "login required — run loom mcp login " +
    name
  );
};
