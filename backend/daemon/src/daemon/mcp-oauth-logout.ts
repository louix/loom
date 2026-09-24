import { createMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.ts";
import { revokeMcpOAuth } from "./mcp-oauth-tokens.ts";
import { waitOAuthInvalidation } from "./mcp-oauth-lease.ts";
import type { McpOAuthCredential } from "./mcp-oauth-model.ts";

/** Local deletion wins even when remote revocation fails. Removed definitions can log out. */
export const logoutMcpOAuth = async (
  name: string,
  store: McpOAuthStore = createMcpOAuthStore(name),
) => {
  let credential: McpOAuthCredential | undefined;
  const cleared = await store.transact(async (state) => {
    credential = state.credential;
    return {};
  });
  const revocation = credential
    ? revokeMcpOAuth(credential)
    : Promise.resolve("unsupported" as const);
  let invalidated = true;
  try {
    await waitOAuthInvalidation(store, cleared.generation);
  } catch {
    invalidated = false;
  }
  return { name, cleared: true, invalidated, revocation: await revocation };
};
