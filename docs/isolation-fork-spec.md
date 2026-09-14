# Isolation-only fork

Status: proposed design, not implemented. Working CLI name: `isolate`.

## Product

A local sandbox launcher for arbitrary agent programs. Run Loom, Codex, Claude,
or any other guest-compatible command against the actual host checkout, with
explicit filesystem, network, credential, and MCP capabilities.

The launcher owns confinement and process lifecycle. The program owns its UI,
conversation, tools, models, permission prompts, and agent orchestration.

```sh
isolate run --profile claude --repo . -- claude
isolate run --profile codex --repo . -- codex
isolate run --profile loom --repo . -- loom
isolate run --profile dev --repo . -- bash
```

Commands execute inside a prepared Linux guest, with the checkout as their cwd.
“Arbitrary” means any executable installed in that guest, not automatic execution
of host binaries or compatibility with every agent's integration protocol.

## Scope

Keep VM isolation, prepared environments, bounded egress, credential delivery,
MCP isolation and relays, crash cleanup, and diagnostics. Start with the existing
smolvm backend and Deno host tooling; do not introduce a backend abstraction until
a second backend is needed.

Remove the provider/session abstraction, conversation database, fleet TUI, model
catalogs, transcript normalization, agent tool permission gate, worktree manager,
Git bridge, auto-rebase, commit reminders, branch lifecycle, undo and hard fork.
No host-execution fallback when isolation cannot start.

## Boundaries

```text
Host: launcher + policy supervisor + credential broker
  |
  +-- agent VM: arbitrary command, private HOME, /workspace = real checkout
  |      +-- egress relay -> explicitly permitted HTTPS authorities
  |      +-- MCP relay -> per-run MCP gateway
  |
  +-- MCP VM(s): command servers, individual mounts and network policy
  |
  +-- MCP gateway -> configured remote MCP endpoints
  |
  +-- web gateway -> policy-checked fetch/search backends
```

All guest processes, including agent shells and descendants, are untrusted.
The guest has no direct external IP connectivity; proxy environment variables
provide compatibility, while VM networking enforces the boundary. Programs that
ignore the proxy fail to connect. Guests receive only their assigned relay
sockets, never the host daemon socket or a general host connection service.

Trusted components are the host launcher, VM backend, policy gateways and
credential broker. Command MCPs run in separate VMs by default, with separate
identities and grants. A remote MCP's internal execution is outside this local
boundary; allowing its tools delegates their advertised authority to that service.

## Checkout and process semantics

- Mount the canonical host directory read/write at `/workspace`, including its
  normal `.git` directory. Changes are immediately visible on both sides. Do not
  clone, synchronize, create branches, or copy the checkout into a guest disk.
- Git runs normally inside the guest. No host Git RPC, command shim, injected Git
  identity, hook installation, or restrictions on branch operations. Its network
  operations still need egress grants. Guest hooks execute inside the guest.
- Direct checkout access deliberately grants modification of Git metadata and
  hooks. Later host tools may execute guest-modified repo content. This protects
  the host outside granted mounts during guest execution; it does not make the
  shared repository safe to execute on the host.
- Do not automatically expose paths referenced by symlinks, linked-worktree
  `.git` files, external Git object stores, or submodule configuration. A normal
  checkout works directly; external dependencies require explicit mounts or an
  actionable startup error where detectable. This is not a worktree manager.
- Additional mounts are explicit and read-only by default. Mount confinement must
  prevent traversal or symlink resolution from exposing ungranted host files.
  Host sockets and device nodes inside a mount must not become usable host
  capabilities; verify backend behavior before claiming this boundary.
- Private guest HOME, temporary storage, and optional persistent per-profile
  caches. No ambient host HOME, SSH agent, Docker socket, environment, or secrets.
  Export the caller's file ownership correctly; do not leave root-owned files.
- Forward stdin/stdout/stderr, terminal resize, signals, and exit status. A stopped
  foreground run stops its descendants and MCPs. No transcript interpretation.
- Default to one writable run per canonical checkout, enforced by a launcher
  lock outside the repo. `--share-repo` explicitly permits concurrent runs.
  Host editors remain usable; the lock does not serialize host edits or Git.
- Loom can run inside the guest with its own in-place configuration. The launcher
  does not rewrite Loom settings or prevent a program from creating worktrees
  itself. Nested virtualization is not a requirement for this mode.

## Network policy: distinguish destinations from operations

Three independently configured capabilities:

| Capability         | Enforcement                   | What it grants                                                       |
| ------------------ | ----------------------------- | -------------------------------------------------------------------- |
| Agent HTTPS egress | Per-VM CONNECT proxy          | Every process in that VM can connect to listed host:port authorities |
| Web fetch/query    | Structured gateway operations | Bounded fetch/search requests under URL and tool policy              |
| MCP access         | MCP protocol gateway          | Listed tools on fixed configured servers                             |

Default deny. A model API grant is separate from a web grant. Allowing a provider
API origin does not grant direct access to websites referenced in its responses.
Likewise, granting a web MCP access to websites does not give the agent VM that
network policy. Shell code can invoke an exposed gateway, but only with the same
bounded operations; there is no claim to distinguish a legitimate tool caller
from other code in the same VM.

### HTTPS authority grants

Reuse the CONNECT approach for programs needing normal HTTPS clients. Accept
exact normalized hostnames and explicit ports, with 443 as the default. Do not
accept path rules here: encrypted tunnels do not expose HTTP paths, methods, or
tool names. Reject URL-shaped input with an explanation instead of silently
reducing it to a hostname. No arbitrary TCP, UDP, DNS, or proxy chaining.

The proxy resolves names itself, rejects loopback/private/link-local/metadata
destinations by default, checks all candidate IPv4/IPv6 addresses, and connects
to a validated address without a second resolution. Explicit private-service
exceptions bind an exact service and port. This address validation is additional
work beyond the current Loom proxy. An allowed tunnel is broad authority to that
endpoint, not an application-level guarantee about what happens through it.

### Web-only mode

Interpret “only use web fetch/query” as: arbitrary site access is available
through a structured web service; ordinary shell networking to those sites stays
blocked. Support a first-party web MCP exposing `web_fetch` and `web_query`, or a
configured remote web MCP narrowed to an explicit tool allowlist.

The first-party gateway validates fetch URL scheme, hostname, port, path and
resolved IP; revalidates every redirect; limits response size, duration and
concurrency; and returns content rather than a tunnel. Only HTTP GET semantics
are exposed for fetch. No caller-supplied authorization headers or cookies.
URL policy uses normalized, segment-aware path prefixes, rejects ambiguous
encodings, and excludes fragments. Query parameters are data, not policy syntax.
Search sends bounded queries to a fixed configured backend; its credentials
remain outside the agent VM. Search results do not authorize subsequent fetches.
URL policy governs fetched targets; search query/output restrictions are separate.

For a remote web MCP, local tool filtering can constrain tool names and validated
arguments, but cannot enforce where that remote service actually fetches or how
it follows redirects. Strict per-target fetch guarantees require the first-party
gateway, or a backend whose enforcement is explicitly trusted.

Native agent web tools are an optional integration, not the enforcement boundary.
Adapters may configure an agent to use the gateway and disable native web tools.
If a native tool fetches locally, its requests face normal egress policy. If it
fetches on the provider's servers over an already-allowed model API, a CONNECT
proxy cannot identify or disable it. Strict native-tool restrictions need a
provider-aware request broker with a supported protocol that rejects prohibited
tool declarations/operations, or a trusted provider-side restriction. A mutable
agent setting alone is not sufficient. Unsupported strict combinations fail at
startup; the launcher must never label them enforced.

## MCPs and credentials

Command MCPs use a prepared runtime, argv, a minimal environment, explicit mounts,
and their own HTTPS allowlist. Offline is the default. A filesystem MCP can share
`/workspace`; a web MCP ordinarily has no checkout mount. Do not run configured
commands on the host or install packages automatically at launch.

Remote MCPs use an exact endpoint, host-held authentication, explicit redirect
policy, and a per-run relay. The gateway enforces allowed tool names on both
discovery and invocation, validates requests and bounds outputs. Reject unknown
tools and tools added after discovery unless policy authorizes them. Non-tool
MCP capabilities, including resources, prompts, sampling and server-initiated
requests, are denied unless explicitly supported and granted. Filtering discovery
alone is insufficient.

An adapter writes native MCP configuration into the private guest profile, or
provides a guest stdio-to-gateway shim. Generic commands receive endpoint metadata
and may integrate it themselves. Adapters translate configuration only; they are
not model SDK connectors. Keep a tested compatibility matrix per agent version.

Credentials use named references in trusted host config. Prefer gateway-side
injection into fixed upstream destinations. Where a native client requires a
credential, deliver an explicit access token or isolated credential file to that
guest, never the host's entire credential directory. Such credentials are readable
by guest code. Reuse host-side refresh where supported; generic clients need an
explicit credential strategy. Clear ephemeral credentials and revoke relays at
teardown. Never log tokens, request bodies, or credential-bearing query strings.

## Proposed configuration

User-owned `$XDG_CONFIG_HOME/isolate/config.toml` is authoritative. Repository
files cannot expand policy. CLI flags select profiles and narrow grants; broader
persistent grants require an explicit host configuration change. Profiles resolve
to complete policies rather than additive inheritance with surprising permissions.
The syntax below is a proposed contract, not existing Loom configuration.

```toml
version = 1

[profiles.claude]
runtime = "agents-linux"       # immutable prepared artifact selection
adapter = "claude"            # optional config/auth integration
workspace = "read-write"
mcp = ["web", "files"]
env = { LANG = "C.UTF-8" }

[profiles.claude.network]
https_authorities = ["api.anthropic.com:443"]
# Every guest process can use this authority. No general website access.

[profiles.claude.credentials]
strategy = "guest-access-token"
source = "claude-account"     # named host credential reference

[mcps.web]
kind = "builtin-web"
tools = ["web_fetch", "web_query"]
search_backend = "configured-search"
fetch_allow = ["https://docs.example.com/reference/"]
max_response_bytes = 2000000
timeout_seconds = 30

[mcps.files]
kind = "command"
runtime = "file-tools-linux"
argv = ["file-tools", "--mcp"]
workspace = "read-write"
tools = ["read_file", "edit_file"] # exact server-advertised names
https_authorities = []

[mcps.team_docs]
kind = "remote"
url = "https://mcp.example.com/mcp"
credential = "team-docs-token"
tools = ["search", "fetch"]
```

Here `team_docs` is configured but not exposed until selected in a profile.
Provider authorities and tool names are illustrative; adapters must validate
their actual version-specific requirements. No automatic domain additions after
a denied request. Config is read from outside the mounted checkout and frozen
for each run. Changes apply to new runs; stopping a run revokes existing access.

## CLI and lifecycle

`isolate prepare <runtime>` explicitly prepares/downloads immutable artifacts.
Preparation has its own network policy; repo-provided setup commands execute
inside a guest. Launch does not run repository hooks on the host.

`isolate policy --profile NAME --repo PATH` prints the resolved mounts,
authorities, web URL rules, MCP tools, credential delivery and enforcement limits.
`isolate doctor` checks backend availability and artifacts.
`isolate run ... -- COMMAND ARG...` attaches to the program without shell
reinterpretation. `isolate ps`, `isolate stop ID`, and `isolate logs ID` expose
only process and isolation state. An optional `--read-only` narrows the workspace.

Startup validates config, acquires the repo lock, prepares private run state,
starts constrained gateways/MCPs, mounts the checkout, and executes argv. Any
partial failure tears down the resources already created. State and control
sockets live outside the checkout under user-owned XDG directories.

Log run identity, artifact/policy digest, lifecycle and bounded allow/deny events,
without recording agent conversations. Supervisor death closes capabilities and
terminates guests; restart recovery reaps orphaned guests before clearing locks.
Never delete a checkout or roll back its changes as part of cleanup.

## Fork implementation plan

1. Extract artifact preparation and VM lifecycle from `runtime/src/packaged/`
   and `runtime/src/session-vm/{supervisor,disks,persistence,cleanup}.ts`.
   Replace provider worker bootstrap with an argv/PTY runner. Keep only utilities
   required for confinement; no dependency on the Loom daemon or agent engine.
2. Replace linked-worktree validation/private Git views with direct directory
   mounts. Remove `runtime/src/git-bridge/` from the fork. Verify mount and Git
   behavior on disposable main checkouts before wiring agent presets.
3. Refactor `session-vm/{egress,network-policy,mcp-relay,guest-relay}.ts` into
   per-principal capabilities. Add destination-address checks and policy parsing.
   Existing MCP relay code is transport only; build actual MCP tool filtering.
4. Add isolated command MCPs, remote MCP credentials, and the structured web
   gateway. Define and enforce URL matching before advertising URL allowlists.
5. Add optional Claude, Codex and Loom launch adapters using existing auth and
   environment code where applicable. Document generic integration and test
   native web behavior separately from ordinary API connectivity.
6. Package a standalone CLI and runtimes; remove unused connectors, AISDK,
   session database and UI packages. Validate Linux first; retain macOS support
   only once direct mounts, ownership, PTY and confinement pass there too.

MVP includes generic commands, a real checkout mount, private HOME, deny-by-default
networking, HTTPS authority grants, isolated MCPs, web fetch/query through the
gateway, and lifecycle cleanup. Provider-aware native-tool request filtering is
a later feature; MVP explicitly rejects requests for that stricter guarantee.

## Acceptance criteria

- A shell and each supported agent run interactively, preserve exit codes, and
  edit the same files visible to a host editor. Native guest Git status, commit
  and branch changes appear on the host. No worktree or Git bridge is created.
- Unmounted host files, sockets and services are inaccessible, including via
  symlinks, crafted paths, raw sockets, alternate DNS, IPv6 and ignored proxies.
- Allowed model connections work. Direct fetches to web-only destinations fail;
  the same permitted URLs succeed through the web gateway. Blocked URLs,
  redirects to private addresses, DNS rebinding and oversized responses fail.
- An MCP can use its own network grants without lending them to the agent or
  another MCP. Disallowed tool calls fail even when sent directly, without
  discovery. Remote MCP redirects cannot leak credentials or expand endpoints.
- Strict native web-tool enforcement cannot be requested successfully for an
  unsupported agent/protocol. Compatibility docs distinguish tested behavior
  from a security guarantee.
- Repo config edits cannot grant capabilities. A second writer is refused unless
  sharing was explicitly selected. Read-only runs cannot modify the checkout.
- Interrupts, failed startup, gateway death, supervisor death and restart cleanup
  leave no active capabilities or orphaned guests and never remove repo content.

Use offline fixtures and disposable repositories for enforcement tests; add live
agent smoke tests for compatibility, not as proof of the confinement boundary.
