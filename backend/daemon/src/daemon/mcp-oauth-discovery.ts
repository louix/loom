import * as oauth from "oauth4webapi";
import { isIP } from "node:net";
import { OAuthDiscoveryError, parseOAuthChallenge } from "./mcp-oauth-challenge.ts";
import {
  OAuthTransportError,
  validateOAuthUrl,
  prepareOAuthEndpoint,
  type OAuthEndpoint,
} from "./mcp-oauth-endpoint.ts";
import { createOAuthDiscoveryNetwork, type OAuthDiscoveryNetwork } from "./mcp-oauth-network.ts";

export interface McpOAuthDiscovery {
  resource: string;
  resourceMetadataUrl: string;
  issuer: string;
  authorizationServer: oauth.AuthorizationServer;
  scopes: string[] | undefined;
  endpoints: {
    authorization: OAuthEndpoint;
    token: OAuthEndpoint;
    registration?: OAuthEndpoint;
    revocation?: OAuthEndpoint;
  };
}

interface DiscoveryOptions {
  scopes?: readonly string[];
  signal?: AbortSignal;
  /** Trusted test/host transport; must enforce the same endpoint and response bounds. */
  network?: OAuthDiscoveryNetwork;
}

const invalid = (): never => {
  throw new OAuthDiscoveryError("invalid_metadata");
};
const strings = (value: unknown, limit = 128): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    !value.every((s) => typeof s === "string" && s.length > 0 && s.length <= 8192)
  )
    invalid();
  return value as string[];
};
const scopes = (value: unknown): string[] => {
  const result = strings(value);
  if (result.join(" ").length > 8192 || result.some((s) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)))
    invalid();
  return [...new Set(result)];
};
const wellKnown = (url: URL, name: string): string[] => {
  const path = url.pathname === "/" ? "" : url.pathname;
  return [
    ...new Set([url.origin + "/.well-known/" + name + path, url.origin + "/.well-known/" + name]),
  ];
};

/** Credential-free GET discovery; returned endpoint plans are for this attempt only. */
export const discoverMcpOAuth = async (
  input: string,
  options: DiscoveryOptions = {},
): Promise<McpOAuthDiscovery> => {
  const resource = validateOAuthUrl(input, true);
  const hostname = resource.hostname.replace(/^\[|\]$/g, "");
  // Permit metadata loopback only if the configured resource is a literal loopback.
  let allowLoopback = false;
  if (isIP(hostname)) {
    prepareOAuthEndpoint({ url: resource.href, addresses: [hostname] }, true);
    try {
      prepareOAuthEndpoint({ url: resource.href, addresses: [hostname] });
    } catch {
      allowLoopback = true;
    }
  }
  const network = options.network ?? createOAuthDiscoveryNetwork({ allowLoopback });
  const configuredScopes = options.scopes === undefined ? undefined : scopes(options.scopes);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, 60000);
  let operations = 0;
  const resolve = async (url: string): Promise<OAuthEndpoint> => {
    if (controller.signal.aborted) throw new OAuthTransportError(expired ? "timeout" : "aborted");
    if (++operations > 40) throw new OAuthDiscoveryError("discovery_limit");
    validateOAuthUrl(url, allowLoopback);
    return await network.resolve(url, controller.signal);
  };
  const get = async (url: string): Promise<Response> => {
    const response = await network.get(await resolve(url), controller.signal);
    if (response.status >= 300 && response.status < 400)
      throw new OAuthTransportError("redirect_denied");
    return response;
  };
  // Fallback only when a metadata document is absent, never after malformed
  // metadata, an issuer mismatch, a redirect or a network-policy violation.
  const firstDocument = async (
    urls: string[],
  ): Promise<{ url: string; response: Response } | undefined> => {
    for (const url of urls) {
      const response = await get(url);
      if (response.status === 404 || response.status === 410) continue;
      if (response.status !== 200) throw new OAuthDiscoveryError("metadata_unavailable");
      return { url, response };
    }
    return undefined;
  };
  try {
    const probe = await get(resource.href);
    const challenge = parseOAuthChallenge(probe.headers.get("www-authenticate"));
    const challengedScopes =
      challenge.scope === undefined ? undefined : scopes(challenge.scope.split(" "));
    if (configuredScopes && challengedScopes?.some((s) => !configuredScopes.includes(s)))
      throw new OAuthDiscoveryError("scope_override_missing");
    const document = await firstDocument(
      challenge.resourceMetadata === undefined
        ? wellKnown(resource, "oauth-protected-resource")
        : [challenge.resourceMetadata],
    );
    if (!document) throw new OAuthDiscoveryError("metadata_unavailable");
    let metadata: Awaited<ReturnType<typeof oauth.processResourceDiscoveryResponse>>;
    try {
      metadata = await oauth.processResourceDiscoveryResponse(resource, document.response);
    } catch {
      throw new OAuthDiscoveryError("invalid_metadata");
    }
    const issuers = strings(metadata.authorization_servers, 8);
    if (!issuers.length) invalid();
    const selectedScopes =
      configuredScopes ??
      challengedScopes ??
      (metadata.scopes_supported === undefined ? undefined : scopes(metadata.scopes_supported));
    for (const issuer of issuers) {
      const issuerUrl = validateOAuthUrl(issuer, allowLoopback);
      if (issuerUrl.search) invalid();
      const path = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
      const asDocument = await firstDocument([
        ...new Set([
          issuerUrl.origin + "/.well-known/oauth-authorization-server" + path,
          issuerUrl.origin + "/.well-known/openid-configuration" + path,
          issuerUrl.origin + path + "/.well-known/openid-configuration",
        ]),
      ]);
      if (!asDocument) continue;
      let as: oauth.AuthorizationServer;
      // The library normalizes URLs for comparison. Check the original string too.
      const body: unknown = await asDocument.response
        .clone()
        .json()
        .catch(() => invalid());
      if (!body || typeof body !== "object" || !("issuer" in body) || body.issuer !== issuer)
        throw new OAuthDiscoveryError("issuer_mismatch");
      try {
        as = await oauth.processDiscoveryResponse(issuerUrl, asDocument.response);
      } catch {
        throw new OAuthDiscoveryError("invalid_metadata");
      }
      for (const field of [
        "response_types_supported",
        "grant_types_supported",
        "code_challenge_methods_supported",
        "token_endpoint_auth_methods_supported",
      ] as const)
        if (as[field] !== undefined) strings(as[field]);
      if (
        as.authorization_response_iss_parameter_supported !== undefined &&
        typeof as.authorization_response_iss_parameter_supported !== "boolean"
      )
        invalid();
      for (const field of [
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
        "revocation_endpoint",
      ] as const) {
        const value = as[field];
        if (value !== undefined) {
          if (typeof value !== "string" || !value) invalid();
          validateOAuthUrl(value, allowLoopback);
        }
      }
      if (
        !as.code_challenge_methods_supported?.includes("S256") ||
        !as.response_types_supported?.includes("code") ||
        (as.grant_types_supported && !as.grant_types_supported.includes("authorization_code"))
      )
        continue;
      if (!as.authorization_endpoint || !as.token_endpoint) continue;
      const endpoint = async (value: unknown) => {
        if (typeof value !== "string") invalid();
        return await resolve(value as string);
      };
      const endpoints: McpOAuthDiscovery["endpoints"] = {
        authorization: await endpoint(as.authorization_endpoint),
        token: await endpoint(as.token_endpoint),
      };
      if (as.registration_endpoint !== undefined)
        endpoints.registration = await endpoint(as.registration_endpoint);
      if (as.revocation_endpoint !== undefined)
        endpoints.revocation = await endpoint(as.revocation_endpoint);
      return {
        resource: resource.href,
        resourceMetadataUrl: document.url,
        issuer,
        authorizationServer: as,
        scopes: selectedScopes,
        endpoints,
      };
    }
    throw new OAuthDiscoveryError("unsupported_authorization_server");
  } catch (error) {
    if (expired) throw new OAuthTransportError("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
};
