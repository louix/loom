import * as oauth from "oauth4webapi";
import { discoverMcpOAuth } from "./mcp-oauth-discovery.ts";
import { listenOAuthCallback } from "./mcp-oauth-callback.ts";
import { createOAuthDiscoveryNetwork } from "./mcp-oauth-network.ts";
import { createMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.ts";
import { resolveOAuthClientSecret } from "./mcp-oauth-secret.ts";
import {
  McpOAuthError,
  mcpOAuthIdentity,
  parseMcpOAuthConfig,
  sameOAuthIdentity,
  mcpOAuthCredentialSchema,
  type McpOAuthCredential,
} from "./mcp-oauth-model.ts";
import {
  prepareOAuthEndpoint,
  OAuthTransportError,
  type OAuthEndpoint,
} from "./mcp-oauth-endpoint.ts";
import type { OAuthFetch } from "./mcp-oauth-transport.ts";

/** Host login engine. Caller presents/opens the URL; never invoke from agent/session startup. */
export const loginMcpOAuth = async (input: {
  name: string;
  resource: string;
  config: unknown;
  present: (authorizationUrl: string, scopes: readonly string[] | undefined) => Promise<void>;
  store?: McpOAuthStore;
  signal?: AbortSignal;
  callbackTimeoutMs?: number;
}): Promise<{ generation: number; expiresAt?: number }> => {
  const config = parseMcpOAuthConfig(input.config);
  const identity = mcpOAuthIdentity(input.name, input.resource, config);
  const store = input.store ?? createMcpOAuthStore(input.name);
  const before = await store.read(input.signal);
  const discovery = await discoverMcpOAuth(identity.resource, {
    ...(config.scopes === undefined ? {} : { scopes: config.scopes }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const as = discovery.authorizationServer;
  // Only literal-loopback configured resources permit loopback metadata/POSTs.
  const hostname = new URL(identity.resource).hostname.replace(/^\[|\]$/g, "");
  let allowLoopback = false;
  try {
    prepareOAuthEndpoint({ url: identity.resource, addresses: [hostname] }, true);
    try {
      prepareOAuthEndpoint({ url: identity.resource, addresses: [hostname] });
    } catch {
      allowLoopback = true;
    }
  } catch {
    /* public hostname */
  }
  const network = createOAuthDiscoveryNetwork({ allowLoopback });
  const forEndpoint =
    (endpoint: OAuthEndpoint): OAuthFetch =>
    async (url, init) => {
      if (String(url) !== endpoint.url || init?.method !== "POST")
        throw new OAuthTransportError("endpoint_denied");
      if (!(typeof init.body === "string" || init.body instanceof URLSearchParams))
        throw new OAuthTransportError("invalid_request");
      return await network.post(
        endpoint,
        {
          headers: [...new Headers(init.headers)],
          body: init.body.toString(),
        },
        input.signal,
      );
    };
  const options = (endpoint: OAuthEndpoint) => ({
    [oauth.customFetch]: forEndpoint(endpoint),
    [oauth.allowInsecureRequests]: allowLoopback,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const methods = as.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  const choose = (secret: boolean): McpOAuthCredential["client"]["authMethod"] => {
    const method = (secret ? ["client_secret_basic", "client_secret_post"] : ["none"]).find((m) =>
      methods.includes(m),
    );
    if (!method) throw new McpOAuthError("client_auth_unsupported");
    return method as McpOAuthCredential["client"]["authMethod"];
  };
  const saved = before.credential;
  const reusable =
    saved &&
    saved.client.dynamic &&
    !config.client_id &&
    sameOAuthIdentity(saved.identity, identity) &&
    saved.issuer === discovery.issuer &&
    saved.endpoints.registration === discovery.endpoints.registration?.url
      ? saved.client
      : undefined;
  const state = oauth.generateRandomState();
  const port = reusable ? Number(new URL(reusable.redirectUri).port) : config.redirect_port;
  const listener = listenOAuthCallback({
    issuer: discovery.issuer,
    state,
    requireIssuer: as.authorization_response_iss_parameter_supported === true,
    ...(port === undefined ? {} : { port }),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.callbackTimeoutMs === undefined ? {} : { timeoutMs: input.callbackTimeoutMs }),
  });
  try {
    let client: McpOAuthCredential["client"];
    if (reusable) {
      if (!methods.includes(reusable.authMethod))
        throw new McpOAuthError("client_auth_unsupported");
      client = reusable;
    } else if (config.client_id) {
      const secret = await resolveOAuthClientSecret(config, input.signal);
      client = {
        id: config.client_id,
        ...(secret === undefined ? {} : { secret }),
        authMethod: choose(secret !== undefined),
        dynamic: false,
        redirectUri: listener.redirectUri,
      };
    } else {
      const endpoint = discovery.endpoints.registration;
      if (!endpoint) throw new McpOAuthError("registration_required");
      const authMethod = methods.includes("none") ? choose(false) : choose(true);
      try {
        const registration = await oauth.processDynamicClientRegistrationResponse(
          await oauth.dynamicClientRegistrationRequest(
            as,
            {
              client_name: "Loom",
              application_type: "native",
              redirect_uris: [listener.redirectUri],
              response_types: ["code"],
              grant_types:
                as.grant_types_supported && !as.grant_types_supported.includes("refresh_token")
                  ? ["authorization_code"]
                  : ["authorization_code", "refresh_token"],
              token_endpoint_auth_method: authMethod,
            },
            options(endpoint),
          ),
        );
        const secret = registration.client_secret;
        if (secret !== undefined && typeof secret !== "string")
          throw new McpOAuthError("registration_failed");
        if (
          !Array.isArray(registration.redirect_uris) ||
          registration.redirect_uris.length !== 1 ||
          registration.redirect_uris[0] !== listener.redirectUri ||
          (registration.token_endpoint_auth_method ?? "client_secret_basic") !== authMethod ||
          (authMethod !== "none" && !registration.client_secret) ||
          (authMethod === "none" && registration.client_secret !== undefined)
        )
          throw new McpOAuthError("registration_failed");
        client = {
          id: registration.client_id,
          dynamic: true,
          redirectUri: listener.redirectUri,
          authMethod,
          ...(secret === undefined ? {} : { secret }),
        };
      } catch {
        throw new McpOAuthError("registration_failed");
      }
    }
    if (!mcpOAuthCredentialSchema.shape.client.safeParse(client).success)
      throw new McpOAuthError("registration_failed");
    const verifier = oauth.generateRandomCodeVerifier();
    const authorization = new URL(discovery.endpoints.authorization.url);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: client.id,
      redirect_uri: listener.redirectUri,
      state,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      resource: identity.resource,
    }))
      authorization.searchParams.set(key, value);
    authorization.searchParams.delete("scope");
    if (discovery.scopes?.length)
      authorization.searchParams.set("scope", discovery.scopes.join(" "));
    const presentation = input.present(authorization.href, discovery.scopes);
    const params = await Promise.race([listener.result, presentation.then(() => listener.result)]);
    let tokens: oauth.TokenEndpointResponse;
    try {
      const oauthClient = { client_id: client.id };
      const callback = oauth.validateAuthResponse(as, oauthClient, params, state);
      let auth = oauth.None();
      if (client.authMethod === "client_secret_basic")
        auth = oauth.ClientSecretBasic(client.secret!);
      else if (client.authMethod === "client_secret_post")
        auth = oauth.ClientSecretPost(client.secret!);
      tokens = await oauth.processAuthorizationCodeResponse(
        as,
        oauthClient,
        await oauth.authorizationCodeGrantRequest(
          as,
          oauthClient,
          auth,
          callback,
          listener.redirectUri,
          verifier,
          {
            ...options(discovery.endpoints.token),
            additionalParameters: { resource: identity.resource },
          },
        ),
      );
      if (
        tokens.token_type.toLowerCase() !== "bearer" ||
        (tokens.expires_in !== undefined &&
          (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))
      )
        throw new McpOAuthError("exchange_failed");
    } catch {
      throw new McpOAuthError("exchange_failed");
    }
    const grantedScopes = tokens.scope === undefined ? discovery.scopes : tokens.scope.split(" ");
    const credential = mcpOAuthCredentialSchema.safeParse({
      identity,
      issuer: discovery.issuer,
      client,
      endpoints: {
        authorization: discovery.endpoints.authorization.url,
        token: discovery.endpoints.token.url,
        ...(discovery.endpoints.registration
          ? { registration: discovery.endpoints.registration.url }
          : {}),
        ...(discovery.endpoints.revocation
          ? { revocation: discovery.endpoints.revocation.url }
          : {}),
      },
      accessToken: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      ...(tokens.expires_in === undefined
        ? {}
        : { expiresAt: Date.now() + tokens.expires_in * 1000 }),
      ...(grantedScopes === undefined ? {} : { scopes: grantedScopes }),
    });
    if (!credential.success) throw new McpOAuthError("exchange_failed");
    if (input.signal?.aborted) throw new McpOAuthError("cancelled");
    const committed = await store.commit(before.generation, credential.data, input.signal);
    return {
      generation: committed.generation,
      ...(credential.data.expiresAt === undefined ? {} : { expiresAt: credential.data.expiresAt }),
    };
  } catch (e) {
    if (input.signal?.aborted) throw new McpOAuthError("cancelled");
    throw e;
  } finally {
    await listener.close();
  }
};
