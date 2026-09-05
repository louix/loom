/**
 * Confirms a spawned `codex app-server` actually authenticated with a ChatGPT
 * subscription account — not an API key, not some other account type —
 * regardless of what `cli_auth_credentials_store` and the process's Codex home
 * happen to resolve to at runtime. Called once per process, right after
 * `initialize`, before any thread/model call that would otherwise run against
 * the wrong credentials.
 */
import type { CodexRpcClient } from "./rpc.ts";

interface AccountReadResult {
  account?: { type?: string; email?: string } | null;
  requiresOpenaiAuth?: boolean;
}

/**
 * Throws with an actionable message if the authenticated account isn't a
 * ChatGPT subscription (`account.type !== "chatgpt"` — null, `apiKey`, or any
 * other type). `refreshToken: false` reads the account Codex already has
 * without forcing a token refresh; Codex stays responsible for normal
 * renewal. Deliberately never sets `forced_login_method` — that setting logs
 * the user out and exits on a mismatch, which is exactly the destructive
 * shortcut this check exists to avoid.
 */
export const verifyChatGptAccount = async (rpc: CodexRpcClient): Promise<void> => {
  const result = (await rpc.requestStartup("account/read", {
    refreshToken: false,
  })) as AccountReadResult;
  const type = result.account?.type;
  if (type !== "chatgpt") {
    throw new Error(
      `Codex is not authenticated with a ChatGPT subscription account (found ${JSON.stringify(type ?? null)}). ` +
        "Run `codex login` with a ChatGPT account, then retry.",
    );
  }
};
