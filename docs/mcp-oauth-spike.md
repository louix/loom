# MCP OAuth compatibility spike

Date: 2026-09-24. Environment: Linux x86_64, Deno 2.9.6,
`oauth4webapi` 3.8.8 (exact version and integrity in the spike lockfile).

**Result: proceed with oauth4webapi.** The protocol primitives and custom fetch
hook fit Loom's design. Address pinning is feasible through Deno's Node-compatible
HTTP/HTTPS APIs, but requires explicit resolved-IP permissions. This is an
experiment, not the production adapter or proof of complete MCP interoperability.

## Reproduce

From the repository root:

```sh
deno check --no-config --lock=scripts/spikes/mcp-oauth/deno.lock scripts/spikes/mcp-oauth/main.ts scripts/spikes/mcp-oauth/tls.ts
deno run --no-config --lock=scripts/spikes/mcp-oauth/deno.lock --allow-net=127.0.0.1,issuer.test scripts/spikes/mcp-oauth/main.ts
```

The first invocation may download the pinned package. Runtime protocol traffic
uses a local fake server and synthetic credentials. A separate optional,
credential-free probe connects to the public npm registry:

```sh
deno run --no-config --allow-net scripts/spikes/mcp-oauth/tls.ts
```

Broad network permission in this optional probe permits DNS and the changing
registry IP. It is not the proposed production permission policy. The main
application dependency configuration and lockfile are unchanged.

## Observed results

The local spike passed twelve grouped checks:

- Protected-resource and authorization-server discovery; rejection of mismatched
  resource and issuer metadata.
- Dynamic registration with native application metadata.
- Callback state and RFC 9207 issuer validation, including missing advertised
  issuer, wrong issuer and trailing-slash mismatch.
- S256 verifier/challenge generation and authorization-code exchange carrying
  the verifier, redirect URI and resource indicator.
- Refresh accepting the same access token and absent replacement refresh token
  or expiry. Preserving an old refresh token is Loom's responsibility.
- Both client-secret Basic and POST authentication.
- Rejection of malformed token responses and invalid_grant, with one HTTP request
  per attempted operation and no implicit retry.
- Revocation.
- Every exercised library network request passing through customFetch.
- Endpoint allowlisting, redirect rejection without contacting the redirect target,
  buffered response-size limits, timeout and cancellation.
- Connection lookup delivering a permitted address directly to the socket, and
  rejecting a changed address before any request reached the server.

The list above combines the two separate client-authentication checks. The code
prints each group individually. Type checking passed for both scripts.

The HTTPS probe passed a registry request using a pinned address with default
certificate verification and the original hostname/SNI. It also rejected checking
the returned certificate against a deliberately wrong hostname using Node's
checkServerIdentity. No certificate validation was disabled.

The protocol fixture synthesizes an authorization callback; it does not open a
browser, validate a real provider consent screen, or implement a full authorization
server's code issuance/replay protection. Its PKCE check verifies generation and
exchange plumbing, not an independent authorization-server conformance suite.
No real MCP account was accessed or registered.

## Transport finding and implementation consequence

A hostname-only `--allow-net=registry.npmjs.org` grant failed when the
Node-compatible HTTPS client attempted to connect to the lookup callback's
resolved address: Deno requested permission for that IP and port. The credential-free
probe passed with network permission allowing the address.

Use a credential-free DNS helper, validate its answers, then launch the token
helper with exact validated IP/port grants. Its lookup callback must return only
that address set; retain the original hostname for SNI, Host and certificate
verification. Do not resolve again after validation. The daemon remains
network-denied and credentials never enter the DNS helper.

The spike uses IPv4 and an exact fixture-address allowlist, with connection pooling
disabled. It does **not** supply a production address classifier. Implementation
still needs IPv6/IPv4-mapped handling, special-use range filtering, all-answer
validation, DNS timeouts, address fallback and tests of the two-helper launch
permissions. Reject literals through the same policy, since literals may bypass
a hostname lookup callback. Keep proxy behavior explicit.

The bounded custom fetch wrapper and socket pinning were tested separately.
Production work must combine them into a Fetch-compatible transport with bounded
request/response handling, cancellation, TLS verification and no redirects.
That adapter should be the first implementation slice. Ordinary fetch after a
separate DNS precheck is not an acceptable substitute.

## Authorization revision review

Reviewed the normative
[2025-11-25 authorization document](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
and the following 2026-07-28 documents directly:

- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Authorization server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- [Security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

Target the 2026-07-28 **authorization profile**, without changing the MCP transport
version negotiated by connectors. The updated design records:

| Finding                                                                                                       | Effect on Loom                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic registration is now deprecated; Client ID Metadata Documents are preferred.                           | Retain registration as a compatibility path, with pre-registered clients. Metadata-document hosting remains deferred explicitly; automatic setup will not cover every server.                                                                                    |
| Authorization-response issuer checks now have an explicit RFC 9207 matrix.                                    | Pin the issuer per attempt; compare exactly, reject absent iss when advertised, and validate errors before exposing them. The library handled the tested success-response cases; a separate direct probe also rejected a mismatched issuer on an error response. |
| Native registration must specify application_type.                                                            | Send native explicitly.                                                                                                                                                                                                                                          |
| Resource metadata scopes are the default when no challenge scope exists (also present in the older revision). | Correct the draft: challenge scopes, then protected-resource scopes, then omission. Never substitute the authorization server's whole scope list. Explicit config remains a user override.                                                                       |
| PKCE support must be advertised (also required previously).                                                   | Refuse missing metadata/S256 rather than merely sending a challenge optimistically.                                                                                                                                                                              |
| The new refresh-token section permits offline_access when advertised by the AS.                               | Keep it explicit in configured scopes; do not assume any server issues refresh tokens.                                                                                                                                                                           |
| Step-up guidance includes reauthorization/retry.                                                              | Document Loom's deliberate explicit-login/no-replay policy rather than adopting automatic tool retries.                                                                                                                                                          |

Discovery orchestration still belongs to Loom. The library's discoveryRequest
supports OAuth path insertion and OIDC path appending; its source does not
orchestrate MCP's intermediate OIDC path-insertion fallback. Implement that
documented URL construction in the adapter, still using the library's response
validation. Similarly, challenge-selected resource metadata URLs and root fallback
need Loom orchestration. The local spike covers the primary well-known paths,
not every fallback.

## Brief lifecycle investigation

Cross-process logout has an existing model to follow:
`runtime/src/session-vm/inventory.ts` registers an owner before launch, holds a
liveness lock, polls control files and publishes completion. OAuth needs its own
generation-aware owner records and acknowledgements, not VM records or just a
heartbeat. Serialize owner registration and logout enumeration with the credential
lock so an owner cannot read an old token and register after invalidation.
This was code review only; logout coordination has not been implemented/tested.

The existing Claude Keychain writer uses security -i for small payloads, but falls
back to secret-bearing argv beyond its input limit. Do not reuse that fallback.
A small host helper using Security.framework and a private input pipe is a
candidate for arbitrary-sized secret records. This Linux environment cannot
validate macOS Keychain behavior, packaging, or permissions; test that slice on
macOS before shipping it. No new npm Keychain dependency was selected.

## What remains before claiming interoperability

No additional product decision is needed to start the bounded transport adapter.
Run a live login/refresh against one real MCP server using a dedicated user account
before claiming provider support. A pre-registered confidential client should also
be tested. Those require account/client setup and are intentionally separate from
this credential-free spike.

Metadata-document support can be a later product decision about hosting a stable
Loom client identity and callback policy. It does not block the agreed first
release's explicitly limited registration scope.
