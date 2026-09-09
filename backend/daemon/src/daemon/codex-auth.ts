/** Host-only renewal. Guests receive access/id tokens, never refresh tokens. */
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { CodexRpcClient } from "../../../../connectors/chatgpt/src/rpc.ts";
import { CredentialOwner, CredentialAuthError } from "./credential-owner.ts";
import type { CodexAccess } from "../../../../runtime/src/session-vm/auth.ts";

export const readCodexAccess = async (profile: string): Promise<CodexAccess> => {
  try {
    const value = JSON.parse(await Deno.readTextFile(join(profile, "auth.json")));
    const tokens = value.tokens;
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"),
    );
    const accountId =
      tokens.account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.id_token !== "string" ||
      !tokens.id_token ||
      typeof accountId !== "string" ||
      !accountId ||
      !Number.isFinite(claims.exp)
    )
      throw new Error();
    return {
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      accountId,
      expiresAt: claims.exp * 1000,
    };
  } catch {
    throw new CredentialAuthError("needs_login");
  }
};
const refresh = async (profile: string, cli: string, _value: CodexAccess, signal: AbortSignal) => {
  signal.throwIfAborted();
  const proc = spawn(
    cli,
    ["app-server", "-c", 'cli_auth_credentials_store="file"', "-c", "mcp_servers={}"],
    {
      cwd: profile,
      env: {
        HOME: homedir(),
        CODEX_HOME: profile,
        PATH: Deno.env.get("PATH") ?? "",
        ...(Deno.env.get("SSL_CERT_FILE") ? { SSL_CERT_FILE: Deno.env.get("SSL_CERT_FILE") } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const rpc = new CodexRpcClient(proc);
  const kill = () => rpc.close();
  signal.addEventListener("abort", kill, { once: true });
  try {
    await rpc.requestStartup("initialize", { clientInfo: { name: "loom-auth", version: "1" } });
    rpc.notify("initialized", {});
    await rpc.request("account/read", { refreshToken: true });
  } catch (error) {
    const rejected =
      error instanceof Error &&
      /refresh_token_reused|invalid_grant|refresh token.*(?:revoked|expired|reused)/i.test(
        error.message,
      );
    throw new CredentialAuthError(rejected ? "needs_login" : "refresh_failed");
  } finally {
    signal.removeEventListener("abort", kill);
    rpc.close();
  }
};
export interface CodexAuthSnapshot {
  codexOauth: CodexAccess;
}
export class CodexAuthOwner extends CredentialOwner<CodexAccess, CodexAuthSnapshot> {
  constructor(options: {
    profile: string;
    cli: string;
    report?: (code: CredentialAuthError["code"] | "publish_failed") => void;
    refresh?: typeof refresh;
    pollMs?: number;
    refreshAheadMs?: number;
  }) {
    super({
      ...options,
      read: readCodexAccess,
      snapshot: (codexOauth) => ({ codexOauth }),
      expiresAt: (s) => s.codexOauth.expiresAt,
      refresh: options.refresh ?? refresh,
    });
  }
}
