import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverMcpOAuth } from "../backend/daemon/src/daemon/mcp-oauth-discovery.ts";
import {
  OAuthDiscoveryError,
  parseOAuthChallenge,
} from "../backend/daemon/src/daemon/mcp-oauth-challenge.ts";
import {
  OAuthTransportError,
  prepareOAuthEndpoint,
} from "../backend/daemon/src/daemon/mcp-oauth-endpoint.ts";
import type { OAuthDiscoveryNetwork } from "../backend/daemon/src/daemon/mcp-oauth-network.ts";

const errorCode = (code: string) => (e: unknown) =>
  (e instanceof OAuthDiscoveryError || e instanceof OAuthTransportError) && e.code === code;

test("MCP challenges handle schemes, quoted commas/escapes and case-insensitive parameters", () => {
  assert.deepEqual(parseOAuthChallenge(null), {});
  assert.deepEqual(
    parseOAuthChallenge(
      'Basic realm="elsewhere", bEaReR realm="a,b", Resource_Metadata="https://resource.test/meta", SCOPE="read write", Digest realm="other"',
    ),
    {
      resourceMetadata: "https://resource.test/meta",
      scope: "read write",
    },
  );
  assert.deepEqual(parseOAuthChallenge('Negotiate abc==, Bearer scope="read"'), { scope: "read" });
  assert.deepEqual(parseOAuthChallenge('Bearer realm="a\\\"b", scope = "read"'), { scope: "read" });
  for (const value of [
    'Bearer scope="a", SCOPE="b"',
    'Bearer, Bearer scope="a"',
    'Bearer scope="unfinished',
    'Bearer scope="a" garbage',
    'scope="orphan"',
    'Bearer\n scope="a"',
    "x".repeat(16385),
  ])
    assert.throws(() => parseOAuthChallenge(value), errorCode("invalid_challenge"));
});

const resource = "https://resource.test/team/mcp";
const issuer = "https://issuer.test/tenant";
const metadataUrl = "https://resource.test/meta";
const asUrl = "https://issuer.test/.well-known/oauth-authorization-server/tenant";
const asMetadata = () => ({
  issuer,
  authorization_endpoint: "https://login.test/authorize",
  token_endpoint: "https://tokens.test/token",
  registration_endpoint: "https://registration.test/register",
  revocation_endpoint: "https://tokens.test/revoke",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["do-not-request-every-admin-scope"],
});
const fixture = () => {
  const documents = new Map<string, () => Response>([
    [
      resource,
      () =>
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer resource_metadata="' + metadataUrl + '", scope="read"',
          },
        }),
    ],
    [
      metadataUrl,
      () =>
        Response.json({
          resource,
          authorization_servers: [issuer],
          scopes_supported: ["fallback"],
        }),
    ],
    [asUrl, () => Response.json(asMetadata())],
  ]);
  const requested: string[] = [];
  const resolved: string[] = [];
  const network: OAuthDiscoveryNetwork = {
    resolve(url) {
      resolved.push(url);
      return Promise.resolve(prepareOAuthEndpoint({ url, addresses: ["8.8.8.8"] }));
    },
    get(plan) {
      requested.push(plan.url);
      return Promise.resolve(documents.get(plan.url)?.() ?? new Response(null, { status: 404 }));
    },
  };
  return { documents, requested, resolved, network };
};

test("MCP discovery binds resource/issuer, uses challenge scopes and validates cross-origin endpoints", async () => {
  const f = fixture();
  const result = await discoverMcpOAuth(resource, { network: f.network });
  assert.equal(result.resource, resource);
  assert.equal(result.issuer, issuer);
  assert.equal(result.resourceMetadataUrl, metadataUrl);
  assert.deepEqual(result.scopes, ["read"]);
  assert.deepEqual(f.requested, [resource, metadataUrl, asUrl]);
  assert.deepEqual(f.resolved.slice(3), [
    "https://login.test/authorize",
    "https://tokens.test/token",
    "https://registration.test/register",
    "https://tokens.test/revoke",
  ]);
  assert.deepEqual(result.endpoints.token.net, ["8.8.8.8:443"]);
  assert.deepEqual(
    (await discoverMcpOAuth(resource, { network: f.network, scopes: ["read", "extra", "read"] }))
      .scopes,
    ["read", "extra"],
  );
  await assert.rejects(
    discoverMcpOAuth(resource, { network: f.network, scopes: ["extra"] }),
    errorCode("scope_override_missing"),
  );
});

test("MCP discovery uses resource well-known fallbacks and all three issuer path rules", async () => {
  for (const asPath of [
    "/.well-known/oauth-authorization-server/tenant",
    "/.well-known/openid-configuration/tenant",
    "/tenant/.well-known/openid-configuration",
  ]) {
    const f = fixture();
    f.documents.set(resource, () => new Response(null, { status: 405 }));
    f.documents.delete(asUrl);
    f.documents.set(
      "https://resource.test/.well-known/oauth-protected-resource",
      f.documents.get(metadataUrl)!,
    );
    f.documents.set("https://issuer.test" + asPath, () => Response.json(asMetadata()));
    const result = await discoverMcpOAuth(resource, { network: f.network });
    assert.deepEqual(result.scopes, ["fallback"]);
    assert.deepEqual(f.requested.slice(0, 3), [
      resource,
      "https://resource.test/.well-known/oauth-protected-resource/team/mcp",
      "https://resource.test/.well-known/oauth-protected-resource",
    ]);
    assert.equal(f.requested.at(-1), "https://issuer.test" + asPath);
  }
});

test("MCP discovery omits absent scopes, supports an explicit empty set, and requires S256/code", async () => {
  const f = fixture();
  f.documents.set(resource, () => new Response(null, { status: 401 }));
  f.documents.set("https://resource.test/.well-known/oauth-protected-resource/team/mcp", () =>
    Response.json({ resource, authorization_servers: [issuer] }),
  );
  assert.equal((await discoverMcpOAuth(resource, { network: f.network })).scopes, undefined);
  assert.deepEqual(
    (await discoverMcpOAuth(resource, { network: f.network, scopes: [] })).scopes,
    [],
  );
  for (const fields of [
    { code_challenge_methods_supported: undefined },
    { code_challenge_methods_supported: ["plain"] },
    { response_types_supported: ["token"] },
  ]) {
    f.documents.set(asUrl, () => Response.json({ ...asMetadata(), ...fields }));
    await assert.rejects(
      discoverMcpOAuth(resource, { network: f.network }),
      errorCode("unsupported_authorization_server"),
    );
  }
});

test("MCP discovery selects the first supported issuer but never hides mismatches or unsafe metadata", async () => {
  const f = fixture();
  const second = "https://second.test";
  f.documents.set(metadataUrl, () =>
    Response.json({ resource, authorization_servers: [issuer, second] }),
  );
  f.documents.set(asUrl, () =>
    Response.json({ ...asMetadata(), code_challenge_methods_supported: ["plain"] }),
  );
  f.documents.set(second + "/.well-known/oauth-authorization-server", () =>
    Response.json({ ...asMetadata(), issuer: second }),
  );
  assert.equal((await discoverMcpOAuth(resource, { network: f.network })).issuer, second);
  f.documents.set(asUrl, () => Response.json({ ...asMetadata(), issuer: issuer + "/" }));
  await assert.rejects(
    discoverMcpOAuth(resource, { network: f.network }),
    errorCode("issuer_mismatch"),
  );
  f.documents.set(asUrl, () =>
    Response.json({ ...asMetadata(), token_endpoint: "http://169.254.169.254/secret" }),
  );
  await assert.rejects(
    discoverMcpOAuth(resource, { network: f.network }),
    errorCode("endpoint_denied"),
  );
  f.documents.set(asUrl, () => Response.json({ ...asMetadata(), token_endpoint: 123 }));
  await assert.rejects(
    discoverMcpOAuth(resource, { network: f.network }),
    errorCode("invalid_metadata"),
  );
});

test("MCP discovery rejects normalized issuer equivalence, bad resource, redirects and malformed metadata", async () => {
  for (const [where, response, expected] of [
    [
      asUrl,
      () => Response.json({ ...asMetadata(), issuer: "https://ISSUER.test/tenant" }),
      "issuer_mismatch",
    ],
    [
      metadataUrl,
      () => Response.json({ resource: "https://other.test", authorization_servers: [issuer] }),
      "invalid_metadata",
    ],
    [asUrl, () => new Response("not json"), "invalid_metadata"],
    [
      metadataUrl,
      () => new Response(null, { status: 302, headers: { location: "https://other.test" } }),
      "redirect_denied",
    ],
    [asUrl, () => new Response(null, { status: 500 }), "metadata_unavailable"],
    [
      metadataUrl,
      () => Response.json({ resource, authorization_servers: Array(9).fill(issuer) }),
      "invalid_metadata",
    ],
  ] as const) {
    const f = fixture();
    f.documents.set(where, response);
    await assert.rejects(discoverMcpOAuth(resource, { network: f.network }), errorCode(expected));
    assert.equal(f.requested.at(-1), where);
  }
  const f = fixture();
  await assert.rejects(
    discoverMcpOAuth(resource, { network: f.network, signal: AbortSignal.abort() }),
    errorCode("aborted"),
  );
  assert.deepEqual(f.requested, []);
});

test("MCP discovery rejects metadata DNS answers that rebind to private or loopback addresses", async () => {
  for (const destination of [metadataUrl, asUrl, "https://tokens.test/token"]) {
    const f = fixture();
    const original = f.network.resolve;
    f.network.resolve = (url) =>
      url === destination
        ? Promise.resolve(prepareOAuthEndpoint({ url, addresses: ["8.8.8.8", "127.0.0.1"] }))
        : original(url);
    await assert.rejects(
      discoverMcpOAuth(resource, { network: f.network }),
      errorCode("address_denied"),
    );
    assert(!f.requested.includes(destination));
  }
});
