# Connector workers: first implementation plan

## Agreed scope

Move connector execution out of the daemon into one worker process per active
session. Start with local Deno processes and explicit permissions; introduce
smolvm later behind the same launch and communication contracts.

Connectors retain access to session code, their own provider credentials/state,
and selected network hosts. Filesystem tools and package installation remain
available. Native subprocess confinement is deferred: Deno permissions on the
worker do not constrain the authority of its native children.

The rollout order is connector workers, external MCP isolation, then removal of
network permission from the daemon and TUI. This supersedes the immediate
sequencing and filesystem assumptions in `isolation-plan.md`; that document's
stricter credential/workspace separation is a possible later stage.

This is a planning document, not an implemented isolation guarantee.

## Ownership and topology

- The daemon owns session metadata, Loom's durable event log and transcript
  storage, user interactions, configuration resolution and worker supervision.
- A session worker loads exactly one connector and serves exactly one session.
  The daemon may cache a provider proxy per profile, but that proxy does not
  represent a shared connector process.
- A worker survives idle turns and pauses while its session remains active.
  Interrupt stops a turn; close releases the worker. Resume after close starts a
  fresh worker using the stored provider reference and current launch policy.
- Native CLI processes belong to the session worker's supervised process tree.
  Provider thread replacement must not destroy its workspace or durable state.
- Discovery, persisted-session enumeration and titling use short-lived workers
  scoped to one provider profile. Titling runs a tool-free one-shot session in a
  private cwd, with no workspace grant. These jobs cannot require a configured
  default model merely to discover which models are available.
- Provider login/state locations retain current semantics initially. Sessions
  using the same profile may share provider-managed state; separate worker PIDs
  do not imply isolated accounts. Avoid disposable credential copies. Confirm
  supported concurrent refresh/state access during each provider migration.

## Execution contract

Introduce a daemon-owned `WorkerLaunchSpec` with:

- connector package/entrypoint selected from a trusted static manifest;
- role (`session`, `discovery`, `enumeration`, `title`), provider profile,
  session binding where applicable, and a fresh worker generation;
- executable/runtime artifact, arguments, explicit cwd and environment;
- session workspace and provider state locations, keeping logical workspace
  paths separate from runtime paths for later guest mapping;
- explicit read/write roots, allowed network hosts/ports, allowed environment
  names, and subprocess/FFI policy;
- startup, request and shutdown limits.

The local launcher returns a transport, an exit notification and termination
operations. Keep Deno process handles and future VM handles out of the protocol
and connector API. Future launchers map the same logical requirements into guest
paths, mounts and networking rules; policies may need backend-specific validation.

Use explicit Deno grants and disabled permission prompts, with no blanket `-A`.
Allow native process launch only where required; report that its descendants are
not confined by these grants. Code/dependency reads and writable caches must be
accounted for explicitly. Resolve runtime dependencies ahead of execution rather
than granting arbitrary runtime downloads. Agent package installation is a
separate, intentionally retained capability.

Host allowances come from resolved operator configuration, not worker requests.
Use actual required endpoint sets: API, authentication and package registry
traffic may use different hosts. Do not silently add hosts after a denied call.
Do not inherit the daemon's entire environment. Supply secrets through private
initialization/configuration channels, not command-line arguments or logs.

## Worker protocol v1

Use bidirectional, newline-delimited JSON over the child's stdin/stdout initially.
Reserve stdout for protocol frames; diagnostics go to bounded stderr or log
frames. Keep framing independent of stdio so a VM transport can replace it.

Define a dedicated discriminated union and runtime decoders in core. Reuse
domain payloads such as `HarnessEvent`, capabilities and snapshots, but do not
reuse the TUI administrative dispatcher or expose arbitrary method names.

| Frame | Purpose |
| --- | --- |
| `hello` / `initialize` / `ready` | Verify protocol version; bind role, profile and generation; initialize config; report capabilities |
| `request` | ID, explicit method and typed parameters |
| `response` | Matching ID and typed result or structured error |
| `event` | Ordered normalized session event with worker-local sequence |
| `state` | Adapter snapshot and current provider reference |
| `log` | Bounded, sanitized diagnostic record |

Exact field names can be finalized in the protocol PR. Required semantics:

- One initialization and at most one session creation/resume per session worker.
  Methods are restricted by role. Reject version mismatches and invalid states.
- Daemon-to-worker session methods cover create/resume, send, compact, rewind,
  mode/model/effort changes, permission/question/plan responses, interrupt and
  close. Utility roles expose only their discovery/enumeration/one-shot methods.
- Worker-to-daemon requests initially cover session-scoped transcript persistence
  for AI SDK connectors. Interaction requests remain normalized events answered
  through the existing session methods. No general host execution/admin RPC.
- Binding comes from the supervised connection. Reject mismatched event/session
  identities; never select authority from a worker-supplied session ID or path.
- Distinguish method completion from turn completion. A successful `send`
  response has the existing adapter's acceptance semantics; the result event
  completes the turn. Keep control frames serviceable while generation,
  compaction or a user interaction is pending, so interrupt cannot deadlock.
- Publish updated state before acknowledging state-changing methods. The remote
  session proxy maintains a synchronous `snapshot()` cache and `providerRef`;
  creation/resume does not resolve until its initial state is available.
- Preserve ordered events and validate bounded frame sizes, pending-request
  counts and buffered bytes. Do not use a queue that silently drops old events.
  Apply backpressure where possible; terminate a stalled/overflowing connection
  explicitly rather than presenting incomplete history as successful.
- Pending user interaction waits are not ordinary short RPC deadlines. Bound
  startup/control operations separately; long operations remain cancellable.
- Worker generation identifies stale callbacks after replacement. Worker event
  sequence numbers are separate from daemon-owned durable event sequence numbers.
- Redact secrets from errors/diagnostics. Unknown or malformed frames produce
  explicit failure, not silent skipping or in-process fallback.

## Persistence and failure behavior

Keep native conversation history in provider-managed durable state and Loom
metadata/events in the daemon. Persist provider references as they become known,
not only on successful turn completion.

The current `TranscriptStore` is synchronous and accepts arbitrary session IDs;
it cannot cross a process boundary unchanged. For AI SDK migration, introduce an
async connector-facing, session-bound persistence interface and update its users
to await writes. Keep cross-session copy/fork coordination in the daemon. A
mutation is acknowledged only after the daemon's storage operation completes;
worker close must drain acknowledged work before reporting success. Connection
loss can still leave an uncertain last operation: do not blindly retry writes.

On worker exit, reject pending calls, settle pending UI interactions, terminate
the event stream and mark the session interrupted/failed as appropriate. Preserve
its worktree, history and provider state. Do not replay prompts or mutating tool
calls automatically. Recovery uses an explicit resume with a new generation.

Close first requests graceful shutdown, then terminates the supervised process
tree after a deadline. After close returns, no further session event or storage
write may be admitted. On daemon EOF, the worker shuts down its session and
children. Verify both normal shutdown and abrupt parent death on the supported
local platform; document any descendant-cleanup limitation before rollout.

## Incremental delivery

### PR 1: Protocol, supervisor and mock worker

- Add protocol types/decoders, framed transport and lifecycle tests.
- Add local launcher and worker entrypoint with a static connector manifest.
- Add remote provider/session proxies. Separate daemon manifest metadata from
  worker-only imports; daemon startup must not evaluate vendor modules.
- Exercise create/resume, streaming, interactions, state synchronization,
  interruption and close through the actual mock child process.
- Keep direct mock construction available for existing unit tests.

Acceptance: two sessions have distinct workers; killing one does not stop its
peer or daemon; blocked interactions can be cancelled; invalid frames and startup
failure settle cleanly; no successful path silently loses events.

### PR 2: Claude through the worker boundary

- Load the Claude adapter and SDK only in its worker and supervise CLI children.
- Preserve filesystem tools, configured local MCPs and current Git behavior in
  the worker. A comprehensive daemon tool broker is not a prerequisite here.
- Apply explicit launch permissions/environment and retain profile state paths.
- Route Claude discovery, enumeration and titling through utility workers.
- Test current permission modes, follow-up turns, resume, settings, compaction
  and supported rewind behavior through the remote proxy.

Acceptance: existing Claude workflows work with one worker per session; daemon
does not import the Claude SDK; title jobs do not receive the worktree; closing
one session leaves peers and durable profile state usable. Use deterministic SDK
fixtures plus a separately reported real-CLI smoke test when available.

### PR 3: Remaining connectors and persistence

- Introduce the async scoped transcript adapter and migrate AI SDK connectors.
- Move ChatGPT connector execution and native launches into workers.
- Move network-dependent catalog fetching out of daemon model discovery,
  including pre-provider model auto-detection. Return model/context/pricing
  metadata for the daemon to merge with configured overrides.
- Route all provider-backed titling/discovery through the same launch policy.
- Remove production in-process connector loading after all providers migrate.

Acceptance: all production connectors run outside the daemon; resume and
transcript edits survive process replacement; discovery works before a model is
configured; architecture tests catch daemon imports of connector/vendor modules.

## Handoff to subsequent steps

External MCP transport and search credentials may remain inside session workers
during this first step. Record these grants explicitly as transitional. The next
step moves external MCPs into managed processes/containers and introduces their
broker access, removing those credentials and direct connections from connectors.

After that, audit all daemon/TUI outbound paths and remove their Deno network
grants. Neither network-free host processes nor native process confinement is an
acceptance claim of the initial mock/Claude worker PRs.

Update `docs/connectors.md` as each migration lands. Before smolvm integration,
validate packaging, path translation, persistent profile state and descendant
cleanup against the launcher contract; filesystem/npm access stays enabled until
a separately agreed stricter policy changes it.
