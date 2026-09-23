/** OAuth renewal only: no login, logout, profile reset, or model invocation. */
import { readClaudeCredentialStore, writeClaudeCredentialStore } from "./claude-credentials.ts";
import { withClaudeRefreshLock } from "./claude-refresh-lock.ts";
import { CredentialAuthError } from "./credential-owner.ts";

export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const oauth = (v: unknown) => record(record(v).claudeAiOauth);
const valid = (v: Record<string, unknown>) =>
  typeof v.accessToken === "string" &&
  !!v.accessToken &&
  typeof v.expiresAt === "number" &&
  Number.isFinite(v.expiresAt) &&
  v.expiresAt > Date.now();

export const refreshClaudeProfile = async (
  profile: string,
  expectedAccessToken: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<void> => {
  await withClaudeRefreshLock(profile, signal, async (guarded, verify) => {
    const store = await readClaudeCredentialStore(profile);
    const before = oauth(store.value);
    // A native Claude process may have renewed while we waited for its lock.
    if (before.accessToken !== expectedAccessToken) {
      if (valid(before)) return;
      throw new CredentialAuthError("refresh_failed", "Credentials changed while waiting");
    }
    if (typeof before.refreshToken !== "string" || !before.refreshToken)
      throw new CredentialAuthError("needs_login");
    if (!Array.isArray(before.scopes) || !before.scopes.every((v) => typeof v === "string"))
      throw new CredentialAuthError("needs_login");
    const scopes = before.scopes.includes("user:inference")
      ? [...new Set([...SCOPES, ...before.scopes])]
      : before.scopes;
    const timeout = AbortSignal.timeout(15_000);
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await request(CLAUDE_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: before.refreshToken,
          client_id: CLIENT_ID,
          scope: scopes.join(" "),
        }),
        signal: AbortSignal.any([guarded, timeout]),
      });
      body = record(await response.json().catch(() => ({})));
      guarded.throwIfAborted();
      timeout.throwIfAborted();
    } catch {
      guarded.throwIfAborted();
      throw new CredentialAuthError(
        timeout.aborted ? "refresh_timeout" : "refresh_failed",
        "Token request failed",
      );
    }
    if (!response.ok) {
      // Only structured token-endpoint rejection establishes an invalid grant.
      // Never copy error_description (or other remote text) into logs.
      const category = [
        "invalid_grant",
        "invalid_scope",
        "invalid_client",
        "unauthorized_client",
      ].find((code) => body.error === code);
      throw new CredentialAuthError(
        (response.status === 400 || response.status === 401) && category === "invalid_grant"
          ? "needs_login"
          : "refresh_failed",
        ["HTTP " + response.status, ...(category ? [category] : [])].join(", "),
      );
    }
    if (
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.expires_in !== "number" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0 ||
      typeof body.scope !== "string" ||
      !body.scope.trim() ||
      (body.refresh_token !== undefined &&
        (typeof body.refresh_token !== "string" || !body.refresh_token))
    ) {
      throw new CredentialAuthError("refresh_failed", "Invalid token response");
    }
    const expiresAt = Date.now() + body.expires_in * 1000;
    if (!Number.isFinite(expiresAt))
      throw new CredentialAuthError("refresh_failed", "Invalid token expiry");
    guarded.throwIfAborted();
    // Preserve unrelated credentials updated during the exchange. A concurrent
    // explicit login/logout must not be overwritten with the old account.
    const latest = await readClaudeCredentialStore(profile);
    const current = oauth(latest.value);
    if (
      current.accessToken !== expectedAccessToken ||
      current.refreshToken !== before.refreshToken
    ) {
      if (valid(current)) return;
      throw new CredentialAuthError("refresh_failed", "Credentials changed during refresh");
    }
    await verify();
    try {
      await writeClaudeCredentialStore(profile, latest, {
        ...record(latest.value),
        claudeAiOauth: {
          ...current,
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? before.refreshToken,
          expiresAt,
          scopes: body.scope.split(/\s+/).filter(Boolean),
        },
      });
    } catch {
      throw new CredentialAuthError("refresh_failed", "Credential persistence failed");
    }
  });
};
