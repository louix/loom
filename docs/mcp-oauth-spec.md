# OAuth for HTTP MCP servers

Status: implementation started. Bounded transport, restricted discovery/POST
helpers, Linux credential storage and the host login engine are implemented and
tested. Public config/CLI wiring, macOS Keychain storage, runtime refresh ownership
and relay rotation remain to be built. Existing bearer authentication and local
MCP execution remain supported.

## Purpose and scope

Users can authorize a hosted MCP server once on the host, then use it across
selected repositories and sessions without exposing its credentials to an agent VM.
Loom owns login, storage, refresh, expiry and logout. An agent can report an
authentication failure but has no Loom tool or RPC that initiates browser login.

The first release supports authorization-code flow with S256 PKCE, MCP discovery,
dynamic client registration where available, and pre-registered public or
client-secret clients. It includes refresh and live credential replacement.
Device flow, service accounts, arbitrary OAuth parameter overrides, provider-specific
authentication adapters, automatic scope escalation, client ID metadata documents,
and batch login are deferred. Servers requiring those features get an explicit
unsupported-configuration error. In the 2026-07-28 authorization revision, dynamic
registration is deprecated in favor of Client ID Metadata Documents. Keeping it
as a compatibility path while deferring metadata-document hosting is a deliberate
first-release limitation, not a claim of universal automatic registration.

This is a capability for standards-compatible HTTP MCPs, not a guarantee that
Atlassian, Slack, Vanta or AWS endpoints work. Real provider compatibility must be
verified independently before documenting examples as supported.

## OAuth implementation dependency

Use [`oauth4webapi`](https://github.com/panva/oauth4webapi) as the single direct
OAuth protocol dependency, behind a small Loom-owned adapter. It supports Deno
and ESM and currently has no runtime dependencies. The
[compatibility spike](mcp-oauth-spike.md) tested 3.8.8 on Deno 2.9.6; use that
version as the initial implementation candidate and pin it in the application
lockfile when integrating. The spike has its own lockfile.

Delegate authorization-server and resource metadata discovery primitives,
PKCE generation, authorization-response validation, code exchange, client
authentication, dynamic registration, refresh and revocation to the library.
Use its request and response-processing APIs together so protocol validation is
not bypassed. Do not duplicate supported OAuth protocol routines in Loom.

Loom retains MCP challenge handling and discovery orchestration, issuer/resource
binding, scope policy, endpoint restrictions, browser and callback lifecycle,
secret resolution, storage, locking, refresh scheduling, failure classification,
logout and relay publication. The library performs protocol operations when
called; Loom decides when those operations are authorized. Library support for
additional grants or features does not expand this spec's scope.

Import the adapter only in host login and OAuth network helpers. Do not add it
to the HTTP relay or guest runtime. The daemon continues to coordinate credentials
without network access. No higher-level OAuth client or MCP SDK authentication
orchestration is required for this feature.

All library network operations must use Loom's controlled fetch implementation,
with the endpoint, redirect, timeout, response-size and connection-time address
restrictions described below. A custom fetch hook alone does not establish those
guarantees. Verify the selected release's hooks and behavior in Deno before
integrating it; do not relax network boundaries to accommodate library defaults.
Keep MCP request forwarding outside the library so authentication handling cannot
replay tool calls.

## Configuration

OAuth is available only under trusted `mcp_servers` HTTP definitions:

```jsonc
{
  "mcp_servers": {
    "work": {
      "source": { "kind": "http", "url": "https://mcp.example.com/mcp" },
      "auth": { "oauth": {} },
    },
    "registered": {
      "source": { "kind": "http", "url": "https://tools.example.org/mcp" },
      "auth": {
        "oauth": {
          "client_id": "loom-desktop",
          "client_secret_command": ["op", "read", "op://Work/MCP/client-secret"],
          "redirect_port": 8990,
          "scopes": ["documents:read"],
        },
      },
    },
  },
  "session": { "mcp_servers": ["work"] },
}
```

| Field                   | Behavior                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oauth: {}`             | Discover metadata; attempt dynamic registration; use challenge scopes, then protected-resource scopes, otherwise omit scope; allocate a loopback port. |
| `client_id`             | Use an existing registration instead of registering a client.                                                                                          |
| `client_secret_env`     | Read the named host environment variable during explicit login.                                                                                        |
| `client_secret_command` | Run a nonempty argv array during explicit login, without a shell.                                                                                      |
| `redirect_port`         | Fixed callback port, integer 1–65535. Omitted means an OS-assigned port.                                                                               |
| `scopes`                | Explicit, case-sensitive scope strings; duplicates removed. Omitted differs from an explicit empty list.                                               |

The two secret sources are mutually exclusive and require `client_id`. Inline
client secrets are unsupported. OAuth cannot coexist with either bearer field.
Preserve existing precedence between inline and environment bearer tokens for
non-OAuth definitions. Unknown OAuth fields fail validation. Legacy
`remote_tools` do not gain OAuth; migrate such a definition to `mcp_servers`.

OAuth resource URLs must use HTTPS. HTTP is allowed only for literal loopback
addresses for development. Callback URLs are always
`http://127.0.0.1:<port>/callback`; arbitrary callback hosts, paths and URLs are
unsupported. A pre-registered app must permit that callback, including its port.
No automatic switch to a different fixed port when binding fails.

Secret commands inherit the invoking user's environment and run from the user's
home directory, not the repository. Capture stdout, remove one trailing LF or
CRLF, reject empty output, and impose a 60-second timeout and 64 KiB output limit.
Do not print stdout, stderr or environment values in diagnostics. Nonzero exit
fails login. Never run these commands from the daemon, preflight or status.

**Secret persistence is intentional:** login stores the resolved client secret
alongside tokens so refresh and revocation can authenticate the client without
rerunning the command. Changing its external value requires explicit login again.

## Commands and user-visible behavior

```sh
loom mcp login work
loom mcp login registered --no-browser
loom mcp status
loom mcp status work --json
loom mcp logout work
```

All commands use existing `--repo` resolution. A supplied name addresses a
definition even if unselected. Status without a name reports selected unified
definitions, matching today's behavior. Login and logout require a name;
`login --all` is deferred.

Login always starts an explicit authorization attempt, even if a usable credential
exists, allowing account changes. Print the resource, authorization-server origin
and requested scopes before opening the browser. Browser-opening failure prints
the URL and continues waiting; `--no-browser` only prints it. The callback still
runs on the host executing Loom; this flag does not provide a remote-host callback
tunnel. Ctrl-C, denial, timeout or exchange failure preserve the old credential.
A successful login replaces it and notifies active owners.

Status is read-only: no discovery, network probe, refresh, secret command or
browser launch. It reports locally observed state, not proof of upstream acceptance.
Keep existing artifact/status fields; add structured authentication fields:

```json
{
  "name": "work",
  "auth": {
    "kind": "oauth",
    "state": "ready",
    "expiresAt": "2026-09-24T14:00:00Z",
    "refreshable": true,
    "reason": null
  }
}
```

States are `ready`, `refresh_required`, `refresh_failed`, `login_required`,
`config_changed`, and `storage_unavailable`. Unknown expiry is represented as
null, never fabricated. Live daemon observations may enrich status, but their
absence is not an error. Session counts are optional diagnostics, not required
for this feature. Status JSON, status text and logs never include tokens, secrets,
authorization codes, PKCE verifiers or authorization URLs containing login state.
Only the explicit login command prints the authorization URL when needed.

All selected servers remain required. Preflight checks local credential identity
and availability. An expired but refreshable credential passes the local check;
session launch must successfully refresh it before connecting. Missing,
invalidated or unrefreshable expired credentials fail with:

```text
work: login required — run loom mcp login work
```

A temporary refresh failure with no usable token reports a retryable authentication
failure, not a demand to log in. The session TUI shows the same sanitized reason.
Unselected definitions are syntax-validated but require no credential.

## Discovery and authorization

Target the MCP **2026-07-28 authorization profile**, including its linked discovery,
registration and security requirements:
[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
This does not change the MCP wire version negotiated by existing connectors.
Retain compatibility with 2025-11-25 servers within the supported feature subset.
Referenced standards include RFC 9728, RFC 8414, RFC 7591, RFC 7636, RFC 8707,
RFC 8252, RFC 9207 and RFC 7009. Keep fixtures for supported discovery paths;
do not infer endpoints by appending provider-specific strings. Loom's explicit
login/no-replay policy deliberately does not implement automatic step-up and
request retry; report insufficient scope for user-driven reauthorization.

1. Probe the configured resource without credentials, using a safe discovery
   request; never execute an MCP tool to discover authentication.
2. Follow the resource's standards-defined metadata challenge and well-known
   discovery rules. Validate its resource identifier against the configured
   resource according to MCP rules. If several authorization servers are listed,
   select the first supported one in advertised order and pin its issuer for
   this login. Do not try another issuer after a token exchange fails.
3. Discover authorization-server metadata using the specified OAuth/OIDC
   discovery rules and require issuer consistency. Validate authorization,
   token, registration and revocation URLs independently. Different origins are
   allowed; no credential is sent during metadata discovery.
4. Use the configured client or a compatible saved dynamic registration.
   Otherwise register with `application_type: "native"`, the actual callback URI,
   authorization code grant and refresh grant where supported. No registration endpoint means
   an actionable request to configure `client_id`, not guessed credentials.
5. Bind the callback listener before opening the browser. Generate cryptographically
   random, single-use state and PKCE verifier. Require metadata to advertise S256;
   absent `code_challenge_methods_supported` or missing S256 fails before login.
   Include the resource indicator in authorization and token requests, including refresh.
6. Use configured scopes when present. Otherwise use the resource challenge's
   scope; if absent, use `scopes_supported` from protected-resource metadata;
   if that is absent, omit scope. Do not substitute the authorization server's
   `scopes_supported` list. Show the resulting scope set during explicit login.
   An explicit override that omits challenged scopes must produce an actionable
   diagnostic rather than silently adding scopes. Do not automatically add
   `offline_access`; users can configure it where needed for refresh issuance.
   Later permission failures require user-driven configuration/login.
7. Accept a single valid callback within ten minutes. Validate host, path, state,
   unique query parameters and authorization-response issuer. Compare `iss`
   exactly to the issuer saved for that authorization attempt, without URL
   normalization. Require it when metadata advertises
   `authorization_response_iss_parameter_supported: true`; validate it whenever
   present, including error responses, before exposing any remote error.
   Ignore invalid callbacks without consuming the login attempt. Accept either
   an error or a code, never both. Return a minimal no-store browser response
   without third-party resources or reflected credentials.
8. Exchange the code with the exact redirect URI and PKCE verifier. Support
   `none`, `client_secret_basic` and `client_secret_post`; choose an advertised
   compatible method, preferring basic for confidential clients. Honor the
   standard default when metadata omits supported methods. Reject unsupported
   methods rather than downgrading client authentication.
9. Validate and persist the token response, granted scopes and selected
   registration before publishing success.

Token type must be Bearer (case-insensitive). Validate access/refresh token values,
response size, and finite positive expiry values. Missing `expires_in` means
unknown expiry: the token can be used, but Loom cannot proactively refresh it.
Missing refresh tokens are supported; once the access token expires or is rejected,
login is required. Preserve an existing refresh token when a successful refresh
omits a replacement.

A dynamically registered client may restrict the callback to an exact port. Save
its callback and reuse that port on subsequent login. If unavailable, report the
conflict; do not silently create repeated registrations. Logout deletes the
registration with its credential; future login may register anew. Remote client
deregistration is outside the first release.

## Endpoint and process boundaries

Treat discovery responses as untrusted input. Require HTTPS except literal
loopback development endpoints; reject credentials and fragments in endpoint
URLs. Bound response bodies, discovery depth, request durations and metadata
fan-out. Reject redirects in discovery, registration, exchange, refresh,
revocation and MCP forwarding; report unsupported redirected endpoints clearly.
Reject metadata-directed private, link-local and loopback destinations unless the
configured resource itself is loopback. Validate resolved addresses at connection
time; do not rely on a DNS precheck that can be bypassed by rebinding.

The interactive host CLI may perform discovery and browser setup. The daemon
retains `--deny-net`. Refresh runs in a child with network permission only for
validated token endpoint addresses/port, no arbitrary subprocess or secret-command
permission, and a cleared, explicitly constructed environment. Resolve DNS in a
separate credential-free helper, validate its returned addresses, then launch
the token helper with exact IP/port grants and a socket lookup callback that
returns only those addresses. Preserve the original hostname for TLS SNI and
certificate verification. Do not perform a second DNS lookup in the token helper
or grant it unrestricted network access. Address selection/fallback must remain
within the validated set, with no unchecked pooled sockets.
Pass secrets over a private pipe, never command-line arguments. The token helper
has no credential-store access and returns a bounded result for host persistence.
The adapter is implemented in `mcp-oauth-transport.ts`, with endpoint and address
validation in `mcp-oauth-endpoint.ts`. `mcp-oauth-network.ts` runs DNS, GET and
POST workers through the existing restricted worker launcher, using bounded
private pipes, cancellation and process deadlines. The DNS worker receives only a
hostname. The parent validates all answers before granting exact IP/port
permissions to the HTTP worker. Each HTTP call uses the first validated address
with no fallback/retry and a new socket. The POST worker accepts credential-bearing
headers/body only over stdin and has no environment, filesystem or subprocess
grants. Registration and code exchange use this worker; refresh ownership remains
to be built.

`mcp-oauth-discovery.ts` implements challenge/well-known resource discovery,
OAuth/OIDC issuer discovery, exact issuer consistency, scope selection and S256
validation. It permits at most eight advertised issuers and forty endpoint
resolutions within a sixty-second overall deadline. Metadata-location fallback
occurs only for HTTP 404/410; malformed metadata, mismatched identity, redirects,
network failures and denied destinations fail the attempt. Multiple Bearer
challenges are rejected as ambiguous. Every returned endpoint is independently
resolved and validated; endpoint plans are specific to the current attempt and
must be resolved again for subsequent token operations.

Tests cover library GET/POST hooks, private/mixed address rejection, bounded
bodies and helper output, TLS identity/trust failures, exact IP/port child
permissions, and complete discovery from a network-denied parent. IPv6 address
policy is tested; live IPv6 connection behavior still needs validation.

Deno network permissions constrain host/port, not URL paths. The helper must also
enforce the exact pinned endpoint and reject redirects in code. Refresh does not
rediscover metadata or accept endpoints from a 401. Endpoint changes require a
new explicit login.

The HTTP relay receives only the current access token. Refresh tokens, client
secrets and registration credentials never enter a relay, connector configuration,
guest mount or session event. Guest agents see only the relay capability token.
This is not a promise to hide host files from an unsandboxed host process running
as the same user.

## Credential identity, storage and concurrency

There is one active credential per server name per Loom user-state namespace.
Different accounts require different names. Bind the record to:

- Server name and canonical configured resource URL, retaining path and query.
- A fingerprint of OAuth configuration, including client ID, secret source
  descriptor, callback policy and normalized scope selection.
- Discovered resource identifier, issuer, pinned endpoints, client registration,
  authentication method and actual callback URI.

Canonicalize with URL serialization; do not erase path or query distinctions.
Tokens are opaque; Loom does not infer their audience by decoding them.
The protocol resource indicator and local identity binding enforce intended use.

A changed definition cannot consume the old record. Report `config_changed`
and require login; do not automatically delete the old record or send it to the
new destination. Existing sessions retain their immutable definitions under the
current config-reload contract. Credential replacement or logout explicitly
invalidates owners using the previous identity. A config edit alone does not
retroactively retarget a running relay.

Use `$XDG_STATE_HOME/loom/mcp-auth/<id>/` (the usual user-state fallback when
unset), with `id` a full hash of the server name. Never interpolate a raw name
into a path. Directories are 0700; Linux credential files and lock files are 0600.
Use atomic replacement, reject symlinks and insecure ownership/permissions, and
validate record versions and identity on read. Corrupt stores fail closed.

The Linux implementation in `mcp-oauth-store.ts` uses a persistent OS-locked
file, atomic credential/tombstone replacement, and file/directory sync. Login
captures a generation before discovery and publishes with a compare-and-swap
under that lock. Store reads currently initialize the private namespace/lock;
a separate non-mutating status path is still needed. The current implementation
returns `storage_unavailable` on macOS until its Keychain backend is available.

On macOS store the secret record in a dedicated Loom Keychain item keyed by
namespace and ID. Files contain only locks and nonsecret generation metadata.
Use a Keychain API/helper that keeps secret payloads out of argv, including large
payloads. Keychain unavailable/locked is `storage_unavailable`; do not silently
fall back to plaintext. Do not reuse Claude's service names or inherit its
large-payload argv fallback.

A record includes tokens, optional expiry, grant scopes, client credentials,
registration data, identity, and a monotonically changing generation. All writes
coordinate through a per-name cross-process lock. Login performs browser work
outside the lock and commits only if the generation captured at start still
matches; a concurrent logout or another login prevents stale publication.
Refresh holds the lock through exchange and persistence, then releases it before
subscriber delivery. Reread after acquiring the lock to avoid rotating an already
replaced refresh token.

Keep a nonsecret tombstone/generation after logout. A helper result cannot
resurrect a deleted credential. Atomic storage cannot make a remote token rotation
transactional: if the server rotates a refresh token and the process crashes
before persistence, recovery may require login. Report that honestly.

The host engine in `mcp-oauth-login.ts` implements dynamic registration/reuse,
pre-registered public/confidential clients, explicit secret resolution, loopback
callback validation, PKCE exchange and conditional persistence. Its URL presenter
is supplied by the invoking host UI. The engine requires loopback listen permission;
it is not called by the network-denied daemon or exposed as a CLI command yet.
A CLI entrypoint with the appropriate host callback boundary, browser opening,
auth diagnostics and config integration remains to be implemented.

## Runtime owner and relay protocol

Reuse the architecture of `CredentialOwner`, but do not inherit assumptions that
every token has an expiry or that every successful refresh changes the access-token
string. Add narrowly scoped shared hooks, or an MCP-specific owner where needed.
Keep existing Claude/Codex behavior and tests intact.

Owners are keyed by server identity, shared across sessions within a daemon and
coordinated across processes by the store lock. Subscribe before initial
publication. Check for store generation changes at least once per second while
there are subscribers. Deduplicate notifications by auth state and generation.

Version the private MCP worker protocol. Bootstrap binds destination, non-auth
headers, guest capability and initial auth state exactly once. Subsequent
daemon-to-relay messages can only:

- Replace OAuth access token, generation and optional expiry.
- Clear upstream authorization and mark the relay unavailable.

Use strictly validated frames and monotonically increasing generations; ignore
stale updates. Acknowledge applied generations. Never permit these messages to
change URL, arbitrary headers, guest token, or network authority. Keep static
bearer handling unchanged.

The relay checks credential availability/expiry before each upstream request.
An unavailable OAuth relay returns a sanitized 503 and does not send an
unauthenticated upstream request. Each request captures its credential generation.
Token rotation affects new requests, leaving already-started requests/streams
alone. Logout explicitly clears auth and aborts active upstream work; aborting
cannot undo side effects already accepted upstream.

## Refresh, failures and session recovery

Refresh ahead of known expiry by `min(5 minutes, 10% of issued lifetime)`, with
bounded jitter and backoff. Unknown expiry refreshes only after an authentication
failure. No refresh token means no proactive refresh attempt. Enforce known
expiry independently in the relay even if the owner/helper is stalled.

The relay reports the first successful authenticated response for each generation
to reset the owner's recovery guard. On upstream 401, return the response to the
caller and report the request's credential generation to the owner. Do not expose
upstream challenges as an agent-driven login mechanism. Never replay the failed
request. The owner ignores
401s for superseded generations and coalesces concurrent failures. Allow at most
one forced refresh per generation, with at least a 30-second cooldown per owner.
If the replacement token is rejected before any successful authenticated response,
stop that recovery chain and require explicit login. A successful response resets
this recovery guard, so a later independent expiry can refresh again. Treat
403/insufficient scope as a permission failure, not an expired token.

A rejected access-token generation is blocked pending refresh. Successful refresh
atomically persists the complete result before publishing it to all relays.
A terminal `invalid_grant` or `invalid_client` requires login. Network errors,
429 and server errors are retryable with bounded exponential backoff and
Retry-After handling. On proactive transient failure, keep an unexpired,
unrejected access token usable. Expired or rejected tokens must not be used.

Authentication loss leaves the relay alive but unavailable and emits a nonfatal,
deduplicated session notice. It does not silently remove a selected server.
Fresh credentials can restore forwarding without a Loom-initiated restart, but
an upstream may invalidate its MCP session; in that case explain that the user
must resume/reconnect. Do not promise uninterrupted upstream sessions or replay
initialization/tool requests automatically.

## Logout

Logout must work for stored names whose configuration has been removed.

Under the per-name lock, capture the old record for best-effort revocation,
write a new tombstone generation, and delete locally usable secrets. Notify
active daemons and wait for relay clear acknowledgements, closing a relay if it
cannot acknowledge. Other owners observe the tombstone through polling.
Return success only after known live owners acknowledge invalidation or are
confirmed stopped; otherwise report local deletion plus incomplete live
invalidation with a nonzero exit. An implementation needs owner registration/
liveness tracking to make this guarantee across daemon processes.

Attempt revocation using the captured pinned endpoint and client authentication,
with a bounded timeout, after local invalidation. Revoke the refresh token and
access token where supported. Missing revocation support or remote failure never
restores local credentials; report local logout separately from remote revocation.
Do not claim that logout retracts credentials already delivered to the server or
undoes earlier requests. Logout of an already absent credential is successful.

## Integration and implementation stages

1. **Schema and storage:** extend trusted HTTP auth schema and generated config
   schema; preserve OAuth descriptors in config normalization/tool selection.
   Implement identity, storage, generation/locking and read-only auth status.
2. **Protocol adapter and interactive login:** pin and integrate `oauth4webapi`.
   First verify controlled fetch and protocol operations against the fake server
   in Deno, then add CLI parsing, discovery orchestration, callback lifecycle and
   secret resolution. Keep incomplete support clearly marked until runtime
   refresh and invalidation are present.
3. **Runtime ownership:** integrate local checks in `tool-preflight.ts`, acquire
   credentials at session launch in `mcp-provider.ts`, add refresh helper and
   shared owners. Keep access credentials out of connector-facing handles.
4. **Worker protocol:** update `core/src/mcp-worker.ts`,
   `backend/daemon/src/daemon/mcp-worker.ts` and `runtime/src/mcp/main.ts` for
   rotation, expiry, acknowledgements and generation-tagged 401 reports.
5. **Lifecycle and diagnostics:** implement cross-process invalidation, logout,
   TUI notices, status JSON and recovery. Update `docs/tools.md`, CLI help and
   config examples only once behavior exists.
6. **Compatibility validation:** exercise a real dynamically registered server
   and a real pre-registered confidential client before claiming support.

No migration is required for existing bearer or local definitions. Defining an
OAuth server does not select it or initiate any network access.

## Acceptance criteria

Use a local fake resource/authorization server for deterministic integration tests:

- The pinned `oauth4webapi` release works in Deno through the adapter for
  discovery, registration, code exchange, refresh and revocation. Tests exercise
  real library response validation and the controlled fetch boundary, including
  redirects, timeouts and oversized responses. No library path bypasses network
  restrictions or triggers login/request replay implicitly.
- Configuration rejects mixed auth, invalid secret sources, non-HTTP OAuth and
  invalid callbacks; existing bearer precedence and selections remain unchanged.
- Discovery covers challenge and well-known paths, issuer/resource mismatch,
  multiple issuers, invalid endpoints, redirects and DNS-rebinding defenses.
- Login verifies S256, state, resource indicators, callback-port behavior,
  registration reuse, scope selection and client authentication methods.
- Cancelled/failed login preserves prior credentials; concurrent login/logout
  cannot publish stale results; command output and secrets are absent from logs.
- Storage enforces isolation, permissions, atomic writes, corruption handling,
  macOS Keychain failures, and no secret-bearing argv.
- Concurrent sessions/processes cause a single refresh exchange; rotation is
  persisted before publication; missing expiry/refresh token and unchanged
  access-token responses are supported.
- Relay tokens rotate without destination/capability changes; stale updates and
  stale 401s are harmless; expiry works even with a stalled daemon.
- A failed tool request is sent exactly once, even during 401 refresh. Retryable
  failures preserve eligible tokens; terminal failures produce actionable notices.
- Logout aborts active forwarding, clears every live relay and cannot be undone
  by an in-flight login/refresh. Unsupported/failed revocation is reported accurately.
- Agent VM files, process environments, connector handles and session events
  contain no upstream credentials. Daemon remains network-denied.
- Existing MCP, Claude and Codex authentication tests pass.

Live compatibility tests are opt-in and use dedicated accounts. Record provider,
date, discovery/registration behavior, callback constraints, scopes, token lifetime,
refresh and revocation results; do not commit credentials or authorization URLs.
