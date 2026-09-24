# HTTP MCP OAuth internals

For configuration and login commands, see [Tools](tools.md#oauth-for-hosted-servers).
This guide describes the host authentication boundary and runtime lifecycle.

## Supported protocol

Loom uses `oauth4webapi` behind its own transport adapter for authorization-code
flow with S256 PKCE, MCP resource/issuer discovery, dynamic registration,
pre-registered public or confidential clients, refresh and revocation.
The target is the MCP
[2026-07-28 authorization profile](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
with compatibility for 2025-11-25 servers within this subset.

Device flow, service accounts, automatic scope escalation, client ID metadata
documents, batch login and provider-specific authentication adapters are not
supported. Dynamic registration is a compatibility path, not universal automatic
registration. Real service compatibility remains unverified.

## Login and configuration identity

Login is an explicit host CLI action. No agent tool or daemon RPC opens a browser.
Discovery validates the configured resource and advertised issuer, requires S256,
and independently validates each endpoint. Metadata fallback is limited to
HTTP 404/410; malformed metadata, identity mismatch and redirects fail login.

Explicit scopes take precedence; otherwise Loom uses the resource challenge,
then protected-resource scopes, then omits scope. It never silently adds
`offline_access` or broadens scopes after an authorization failure.

The callback binds `127.0.0.1` at `/callback`, with an assigned or configured
port, before opening the browser. It validates single-use state, PKCE, issuer
and unique parameters within a ten-minute timeout. Invalid callbacks do not
consume the attempt. Saved dynamic registrations reuse their callback port;
a port conflict fails rather than silently registering another client.
`--no-browser` prints the URL but still requires the callback on this host.

Confidential clients support `client_secret_basic` and `client_secret_post`.
Secret commands execute only during explicit login, without a shell, with a
60-second timeout and 64 KiB output bound. The resolved client secret is stored
with tokens for refresh/revocation; changing it requires another login.
Failed or cancelled login preserves the previous credential.

Each server name has one credential per Loom user-state namespace. Different
accounts require different names. Records bind the server name, configured
resource URL (including path/query), OAuth configuration fingerprint, discovered
issuer/resource, endpoints, registration and callback. A changed definition
reports `config_changed` and requires login; it cannot reuse the old credential.

## Network boundary

Discovery, registration, exchange, refresh, revocation and MCP forwarding reject
redirects. Endpoints require HTTPS except literal loopback development resources.
Metadata-directed private, link-local and loopback addresses are rejected unless
the configured resource is loopback. Bodies, requests and discovery are bounded.

A credential-free helper resolves DNS. The parent validates every returned
address, then grants the HTTP child only the selected IP/port. Connections pin
that address while retaining the hostname for TLS verification; they do not
perform another DNS lookup or retry against unchecked addresses.
The HTTP helper also enforces the exact endpoint, since Deno grants do not
restrict URL paths. Credential-bearing input travels over private pipes.
The daemon coordinates credentials without direct HTTP permission.

Refresh uses saved endpoints, not new metadata or a challenge supplied by a 401.
Endpoint changes require explicit login. The HTTP relay receives only the access
token; refresh tokens, client secrets and registration credentials stay outside
relays and agent VMs. Guests receive a separate relay capability. Unsandboxed host
processes running as the same user remain trusted.

## Storage and concurrency

State lives under `$XDG_STATE_HOME/loom/mcp-auth/<id>/`, using the user-state
fallback when unset and a full hash of the server name for `id`.
Directories are private (0700); Linux credential and lock files are 0600.
Atomic replacement, ownership/permission checks and symlink rejection protect
records. Corrupt stores fail closed.

macOS stores the versioned secret record in a dedicated Loom Keychain item;
files contain locks and nonsecret generation metadata. Locked/unavailable
Keychain means `storage_unavailable`, with no plaintext fallback.

A per-name OS lock and generation checks coordinate processes. Login performs
browser work outside the lock and publishes only if its starting generation
still matches. Refresh holds the lock through exchange and persistence,
rereading before exchange to avoid rotating an already replaced token.
Logout leaves a tombstone generation so in-flight work cannot restore secrets.
A crash after remote refresh-token rotation but before persistence may require
another login.

## Runtime rotation and recovery

Owners share credentials across sessions within a daemon and use store locks
across processes. They poll generation changes while subscribed.
Relay bootstrap fixes the destination, non-auth headers and guest capability.
Later frames can only replace access credentials or clear authorization;
monotonic generations and acknowledgements prevent stale updates.

Known expiry is enforced by the relay even if the owner stalls. Proactive refresh
starts before expiry; unknown expiry refreshes only after authentication failure.
A successful refresh preserves the prior refresh token if no replacement is
returned, and persists the result before publishing it.

An upstream 401 reaches the caller unchanged and reports its generation to the
owner. Requests are never replayed. Stale 401s are ignored, concurrent failures
coalesce, and forced refresh is bounded by a cooldown and recovery guard.
A replacement token rejected before any authenticated success requires login.
403/insufficient scope is a permission failure, not an expiry signal.

Transient refresh failures use bounded backoff and retain an unexpired,
unrejected token. Terminal `invalid_grant`/`invalid_client` requires login.
Unavailable relays return sanitized 503s without unauthenticated forwarding and
emit a nonfatal session notice. Fresh credentials restore forwarding, though an
upstream MCP session may still require reconnect/resume. Rotation preserves
already-started streams; logout aborts them.

## Logout and diagnostics

Logout works even after removing a definition from config. It first tombstones
local credentials, then waits for live owners to acknowledge cleared relays or
confirm that those relays stopped. Incomplete invalidation exits nonzero.
Best-effort remote revocation follows local invalidation and is reported
separately; failures never restore local credentials.

Status is read-only: no network, refresh, secret command or browser.
States are `ready`, `refresh_required`, `refresh_failed`, `login_required`,
`config_changed` and `storage_unavailable`; unknown expiry stays null.
Diagnostics omit tokens, secrets, codes, verifiers and login-state URLs.

## Verification

The Linux fixture suite covers CLI login/status/logout, discovery, PKCE,
storage, refresh coalescing/backoff, relay expiry, 401 handling without replay,
cross-process invalidation and stream rotation/abort.
See `test/mcp-oauth-*.test.ts` and the
[TLS fixture](../test/fixtures/mcp-oauth-tls.md).
Native macOS Keychain, live IPv6 and real-provider checks remain in the
[roadmap](roadmap.md#validation).
