import * as oauth from "oauth4webapi";
import { createOAuthDiscoveryNetwork } from "./mcp-oauth-network.ts";
import { prepareOAuthEndpoint, OAuthTransportError } from "./mcp-oauth-endpoint.ts";
import {
  mcpOAuthCredentialSchema,
  McpOAuthError,
  sameOAuthIdentity,
  type McpOAuthCredential,
  type McpOAuthIdentity,
} from "./mcp-oauth-model.ts";
import type { McpOAuthStore } from "./mcp-oauth-store.ts";

export const oauthUsable = (c: McpOAuthCredential | undefined, now = Date.now()): boolean =>
  !!c && !c.rejected && (c.expiresAt === undefined || c.expiresAt > now);

export const oauthTokenOptions = async (
  c: McpOAuthCredential,
  endpoint: string,
  signal?: AbortSignal,
) => {
  let allowLoopback = false;
  const hostname = new URL(c.identity.resource).hostname.replace(/^\[|\]$/g, "");
  try {
    prepareOAuthEndpoint({ url: c.identity.resource, addresses: [hostname] }, true);
    try {
      prepareOAuthEndpoint({ url: c.identity.resource, addresses: [hostname] });
    } catch {
      allowLoopback = true;
    }
  } catch {
    /* DNS hostnames cannot opt into loopback. */
  }
  const network = createOAuthDiscoveryNetwork({ allowLoopback, timeoutMs: 10000 });
  const plan = await network.resolve(endpoint, signal);
  return {
    [oauth.allowInsecureRequests]: allowLoopback,
    ...(signal ? { signal } : {}),
    [oauth.customFetch]: async (
      url: string,
      init: Omit<RequestInit, "body"> & { body?: BodyInit | null | undefined },
    ) => {
      if (
        new URL(url).href !== plan.url ||
        init.method !== "POST" ||
        !(typeof init.body === "string" || init.body instanceof URLSearchParams)
      )
        throw new OAuthTransportError("endpoint_denied");
      return await network.post(
        plan,
        { headers: [...new Headers(init.headers)], body: init.body.toString() },
        signal,
      );
    },
  };
};
export const oauthClientAuth = (c: McpOAuthCredential) => {
  if (c.client.authMethod === "client_secret_basic")
    return oauth.ClientSecretBasic(c.client.secret!);
  if (c.client.authMethod === "client_secret_post") return oauth.ClientSecretPost(c.client.secret!);
  return oauth.None();
};
export const refreshMcpOAuth = async (
  store: McpOAuthStore,
  identity: McpOAuthIdentity,
  signal?: AbortSignal,
) =>
  await store.transact(async (state) => {
    const c = state.credential;
    if (!c || !sameOAuthIdentity(c.identity, identity) || !c.refreshToken) return;
    const now = Date.now();
    const lead = Math.min(300000, Math.max(0, ((c.expiresAt ?? now) - (c.issuedAt ?? now)) * 0.1));
    if (!c.rejected && (c.expiresAt === undefined || c.expiresAt - lead > now)) return;
    if ((c.retryAt ?? 0) > now || (c.rejected && (c.lastForcedAt ?? 0) + 30000 > now)) return;
    let retryAfter = 0;
    try {
      const as = { issuer: c.issuer, token_endpoint: c.endpoints.token };
      const client = { client_id: c.client.id };
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        oauthClientAuth(c),
        c.refreshToken,
        {
          ...(await oauthTokenOptions(c, c.endpoints.token, signal)),
          additionalParameters: { resource: c.identity.resource },
        },
      );
      const retry = response.headers.get("retry-after");
      if (retry) retryAfter = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
      const tokens = await oauth.processRefreshTokenResponse(as, client, response);
      if (
        tokens.token_type.toLowerCase() !== "bearer" ||
        (tokens.expires_in !== undefined &&
          (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))
      )
        throw new McpOAuthError("refresh_failed");
      const { expiresAt: _expiry, retryAt: _retry, refreshFailures: _failures, ...previous } = c;
      const parsed = mcpOAuthCredentialSchema.safeParse({
        ...previous,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? c.refreshToken,
        issuedAt: Date.now(),
        rejected: false,
        recoveryPending: c.rejected === true,
        ...(c.rejected ? { lastForcedAt: now } : {}),
        ...(tokens.expires_in === undefined
          ? {}
          : { expiresAt: Date.now() + tokens.expires_in * 1000 }),
        ...(tokens.scope === undefined ? {} : { scopes: tokens.scope.split(" ") }),
      });
      if (!parsed.success) throw new McpOAuthError("refresh_failed");
      return { credential: parsed.data };
    } catch (error) {
      if (signal?.aborted) throw new McpOAuthError("cancelled");
      if (
        error instanceof oauth.ResponseBodyError &&
        ["invalid_grant", "invalid_client"].includes(error.error)
      )
        return {};
      const failures = Math.min(8, (c.refreshFailures ?? 0) + 1);
      const backoff = Math.min(
        300000,
        Math.max(1000 * 2 ** failures, Number.isFinite(retryAfter) ? retryAfter : 0),
      );
      return {
        credential: {
          ...c,
          retryAt: now + backoff + Math.floor(Math.random() * 1000),
          refreshFailures: failures,
          ...(c.rejected ? { lastForcedAt: now } : {}),
        },
      };
    }
  }, signal);

/** Invalidations persist before refresh, so another process cannot reuse a rejected generation. */
export const rejectMcpOAuth = (
  store: McpOAuthStore,
  identity: McpOAuthIdentity,
  generation: number,
) =>
  store.transact(async (state) => {
    const c = state.credential;
    if (state.generation !== generation || !c || !sameOAuthIdentity(c.identity, identity)) return;
    if (c.recoveryPending || !c.refreshToken) return {};
    return { credential: { ...c, rejected: true } };
  });
export const acceptMcpOAuth = (
  store: McpOAuthStore,
  identity: McpOAuthIdentity,
  generation: number,
) =>
  store.transact(async (state) => {
    const c = state.credential;
    if (
      state.generation !== generation ||
      !c ||
      !sameOAuthIdentity(c.identity, identity) ||
      !c.recoveryPending
    )
      return;
    return { credential: { ...c, recoveryPending: false } };
  });

export const revokeMcpOAuth = async (
  c: McpOAuthCredential,
): Promise<"revoked" | "unsupported" | "failed"> => {
  if (!c.endpoints.revocation) return "unsupported";
  try {
    const as = { issuer: c.issuer, revocation_endpoint: c.endpoints.revocation };
    for (const token of new Set([c.refreshToken, c.accessToken].filter((t): t is string => !!t))) {
      await oauth.processRevocationResponse(
        await oauth.revocationRequest(
          as,
          { client_id: c.client.id },
          oauthClientAuth(c),
          token,
          await oauthTokenOptions(c, c.endpoints.revocation),
        ),
      );
    }
    return "revoked";
  } catch {
    return "failed";
  }
};
