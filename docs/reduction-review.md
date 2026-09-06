# Robustness through reduction — review

Reviewed `loom/start-chatgpt-provider-plan-document` at `10ac15b`, in
`.loom/trees/68ed8df9`, including `docs/state-sync-plan.md`. Source references
below are relative to that worktree, not the root checkout's `main` branch.
This is a review, not an instruction to implement either plan automatically.

The project does not need a rewrite. Its basic seams are useful: connector
packages, normalized events, a daemon that owns sessions, pure editor/model
functions, and a React subscriber around a handle. The problem is that several
seams stop short of assigning ownership. Complexity then accumulates as flags,
inference, reconciliation and special cases between them.

The best reduction is already proposed in the state-sync plan. Use it as the
backbone, coordinate its interaction/settings contracts with provider phase 5,
and resist adding a separate architecture programme around it.

## Scale and scope

Static inventory of the reviewed branch:

| Area                                                                   |                            Size |
| ---------------------------------------------------------------------- | ------------------------------: |
| Production `src` TypeScript/TSX, including harness/mock infrastructure |         97 files / 28,539 lines |
| Test files                                                             |               37 / 19,076 lines |
| Literal `test(...)` calls                                              | 706; not an executed test count |
| TUI model tests                                                        |         115 calls / 3,154 lines |
| TUI render tests                                                       |          77 calls / 2,130 lines |
| `daemon.ts`                                                            |                     3,118 lines |
| `model.ts` / `fleet-handle.ts` / `components.tsx`                      |     2,904 / 2,773 / 1,977 lines |

These counts do not establish poor quality. The sampled tests mostly assert
real behavior. The costly pattern is testing a small behavior through a large
environment, and repeatedly maintaining invariants that should have one owner.
I inspected architecture and representative tests; this is not an exhaustive
audit of every test or a measured test-runtime profile.

## 1. State reconciliation is the largest removable subsystem

Evidence:

- `runtime/src/pending.ts:16`: adapters own parked permission/question/plan promises.
- `backend/daemon/src/daemon/session-manager.ts:78` and `:276`: the manager
  reconstructs outstanding request reasons from events.
- `frontend/tui/src/model.ts:348`: the TUI separately reconstructs request
  payloads; `focusedPending` at `:371` reconciles them with a status reason.
- `frontend/tui/src/fleet-handle.ts:583`: history fetching and live state share
  the same large controller, with special rules to keep history from reviving
  obsolete requests.

This is why there are tests for old plans hiding new permissions, replay
resurrecting requests, and cross-epoch state repair. Each patch is understandable;
the combined protocol makes clients infer facts the daemon already knows.

Follow the state-sync plan: complete replacement snapshots, complete typed
outstanding interactions, independent durable transcript pages, and a client
`Loadable`. Keep adapter continuations private; keep authoritative displayable
interactions in the manager; remove the TUI's inferred authoritative state.
This does not require merging every adapter implementation into one framework.

**Review of `docs/state-sync-plan.md`:** the direction is sound and appropriately
bounded. The accepted reconnect tradeoff buys real simplicity. Preserve its
explicit exclusions: no mutation retries, operation-status service, state replay,
delta protocol or generic replica abstraction. Local drafts, queues and selection
remain local as agreed.

Three details deserve explicit implementation acceptance criteria:

1. **A published snapshot must reflect a completed domain transition.**
   Currently `SessionManager.#drain` (`:205`) invokes several hooks before
   applying status; usage/background hooks can publish along the way. Building
   a snapshot synchronously is insufficient if it captures the middle of an
   event's handling. Apply the event's in-memory transition before publishing.
   This is consistency within one transition, not timed batching. Also avoid
   letting an earlier persistence/publication exception skip all later state
   updates, as the current shared `try` block can do.
2. **Claim an exact interaction before performing its effects.** In
   `daemon.ts:2447`, a cross-provider `implement_fresh` creates a session before
   `respondToPlan` checks the request ID. Static inspection shows that an obsolete
   or repeated request can reach creation before the resolve-once guard. Put
   claim/validation before creation and define failure cleanup. Similarly,
   manager response methods (`:569` onward) delete the request before awaiting
   the adapter; a rejection currently loses the retryable request. Distinguish
   an in-flight resolution from successful resolution locally. No distributed
   operation-tracking system is needed.
3. **Define what applied settings mean across both plans.** Provider phase 5
   explicitly separates immediate host policy from native policy acknowledged
   at a boundary. State-sync step 3 says failed changes cannot be published as
   applied. Use one contract for that distinction; do not let a new UI chip
   accidentally claim that native restrictions are already active. Preserve
   interrupt/approval preemption and avoid a queue held across a turn waiting
   for its own approval.

The plan correctly separates raw `loom tail` replay from state synchronization.
Deleting the latter is not a reason to delete the former.

## 2. Phase 5 should replace permission guessing, not add exceptions to it

`runtime/src/policy.ts:27` classifies authority from underscore-delimited name
fragments. At `:53`, the policy can return only `allow` or `ask`; it cannot
express a prohibited operation. AI SDK additionally hides mutating tools at
mount time, while `aisdk/src/gate.ts:57` checks policy before awaiting approval
and then executes without rechecking it.

Small direct probes against the current code returned:

```text
policy("plan", "get_and_execute")                 -> allow
policy("acceptEdits", "delete_database")           -> allow
```

These demonstrate classification behavior with illustrative names, not that
these particular tools are installed. An increasingly clever verb regex cannot
establish read-only execution or distinguish workspace edits from other effects.

For Loom-owned tools, define their effect explicitly alongside their schema and
implementation. Keep external tool classification and trust decisions at their
adapter/configuration boundary; an arbitrary tool's name is not authority.
Resolve policy to `allow | ask | deny`, and enforce the current policy at
execution time, including after a parked approval. Keep native policy mapping
inside the connector.

This is already aligned with provider phase 5. The temporary Codex refusal to
ask for brokered-tool approvals is documented unfinished work, not a surprise
regression to fix separately. The useful change is to avoid copying the existing
heuristics into a third implementation.

## 3. Small primitives currently have weaker contracts than their callers need

**Control events cannot share a silently lossy queue contract.**
`core/src/channel.ts:56` drops the oldest entry on overflow. Adapters use it for
`HarnessEvent`, including approvals, results and usage. No production consumer
of this channel checks its `dropped` counter in the inspected source.

A capacity-two probe enqueued a permission followed by two text events; the
consumer received only the text events. The daemon therefore cannot always
build an authoritative snapshot from that stream. State sync will not repair
facts lost before they reach the authority.

Keep the bound, but make overflow an explicit session failure/recovery condition,
or use backpressure where the producer can actually await. A synchronous callback
must not throw into an SDK without an owner handling that failure. Latest-value
replacement is suitable for complete snapshots; dropping arbitrary events is
not equivalent. Do not build a universal stream library to solve this.

**Duplicate pending IDs strand promises.** `runtime/src/pending.ts:20` uses
`Map.set` without checking whether a request already exists. A direct probe
registered two questions under one ID and called `failAll`; only the second
settled. Reject duplicate registration explicitly, or deliberately reuse the
same pending request. Also make close/cancellation prevent newly parked work
from surviving teardown. Keep a focused runtime regression: vendor IDs and
async teardown cannot be proven safe by a TypeScript union.

These are examples of tests protecting an insufficient contract, not an argument
against testing small functions.

## 4. Local UI shapes encode correlations as comments

`model.ts:150` defines `PromptState` as a kind plus many optional fields.
Comments say session ID is null only for `new`, question fields belong only to
`answerQuestion`, and request IDs belong to particular prompts. The constructor
accepts the same loose combinations. The handle consequently repeats checks
such as `kind === "answerQuestion" && qaAll && sessionId && requestId`.

At `model.ts:450`, `mode` lives beside nullable prompt/confirm/plan/picker
payloads. `app.tsx:111` must check for a confirm payload even in the confirm
view. The picker context (`model.ts:235`) uses optional flags to encode where
a wizard came from and what it should do on completion.

After state sync removes the authoritative-state portion, introduce a tagged
active screen with its required payload, and a prompt union with variant-specific
fields. Keep genuinely suspended state explicit: a plan may need to survive a
picker detour, and drafts survive closing. Do not discard that behavior simply
to force everything into one mutually exclusive union. Model the picker target
(new session, live session, plan retarget) and its actual return destination
instead of accumulating more `via...` flags.

An inexpensive additional fix is `ImplementationMode = Exclude<SessionMode,
"plan">` for implementing `PlanDecision` variants (`core/src/types.ts:153`).
The type currently permits what its documentation and RPC validation prohibit.
Keep external-input validation; narrow the internal type once input is decoded.

Do not require elaborate combinators around simple switches. Exhaustiveness is
valuable; indirection for its own sake is not.

## 5. Reduce responsibility before dividing files

`fleet-handle.ts` owns terminal input, geometry, history pagination, message
queues, mode debouncing, editor handoff, lifecycle, and multi-step wizards.
Its `dispatch` (`:711`) starts further effects based on reference comparisons.
This works, but makes interactions implicit. `model.ts` also mixes domain
transitions with display formatting; its purportedly pure paths read `Date.now`
and shared theme state.

After state sync, the useful boundaries are a transcript handle, an interaction/
prompt workflow, and the small fleet composition handle. Keep geometry pure and
separate from React so the handle does not import `components.tsx` for layout
calculations. Supply time to the transitions that need it. Expose narrow client
capabilities so handle tests do not require a concrete socket client.

The existing 33-line store is a reasonable subscription primitive. Keep it unless
an actual composition need justifies something else. For each async workflow,
state whether requests serialize, supersede earlier work, or run independently;
implement that rule in its owning handle. A wholesale RxJS migration is not a
prerequisite for reactive composition or robust cancellation.

Similarly, the daemon's problem is orchestration mixed with transport handlers,
not just 3,118 lines. Let RPC handlers decode and call cohesive operations;
let session lifecycle/settings operations own their validation, mutations and
publication. Avoid extracting handler files that all receive the entire daemon
or an equally large dependencies bag. Reuse existing worktree/store services.

## 6. The internal RPC API bypasses the type system

`client/src/client.ts:116` exposes
`request<T>(method: string, params?: unknown): Promise<T>`.
The caller chooses a response type independently of the method or arguments.
`backend/daemon/src/daemon/rpc.ts:30` registers untyped handlers independently.
Tests then carry part of the burden of keeping those pieces consistent.

Define a compact Loom RPC contract mapping method to parameters and result;
infer the client result and constrain handler registration from it. Keep raw
`unknown` at decoding boundaries and preserve malformed-input tests. Do not
build code generation or a generic RPC framework for this. Start with methods
already being changed by state sync and phase 5.

Likewise, `rewind(keep: number, at?: string)` and string-encoded checkpoint fork
points distinguish incompatible history operations only through capabilities
and conventions. When touching that code, use a discriminated history position
and validated persisted reference. Keep capability flags for discovery; boolean
metadata need not itself become a giant union. Phase 1/4's ownership checks and
backend discriminator are progress, not work to throw away.

## Tests: a concrete disposition

| Test/group in reviewed worktree                                                                                             | Recommendation                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/tui-model.test.ts:2707`, `makePrompt carries provider + model...`                                                     | Immediate low-value deletion candidate: asserts two fields were copied. Constructor use in workflow tests can cover this.                                                    |
| `tui-model.test.ts:1940`, prompt open/edit/close; `:2166`, confirm open/close                                               | After the screen union, remove assertions that exist only to maintain mode/payload agreement. Preserve meaningful transitions, drafts and target behavior in workflow tests. |
| `tui-model.test.ts:1394`, `focusedPending`; `tui-render.test.ts:1073`, stale plan masking permission                        | Delete with the removed reconciliation helper. Replace the behavioral guarantee with complete-snapshot/two-client interaction coverage.                                      |
| `tui-model.test.ts:642`, epoch collision; `:818`, timestamp-sorted backfill                                                 | Replace the transcript implementation tests with durable-ID overlap/order tests. Preserve epoch/seq tests for raw replay where still used.                                   |
| `tui-render.test.ts:418`, restart confirmation; `:517`, palette selection; `:1013`, rename command; picker navigation cases | Move decision/command assertions to handle tests using supplied snapshots and a recording client. Keep actual Ink key decoding and geometry tests.                           |
| `test/aisdk-tools.test.ts:202` through name-classification cases                                                            | Delete when name-based authorization is removed. Replace with a compact explicit-effect policy table and execution-time enforcement cases.                                   |
| `test/channel.test.ts:66`, drop-oldest contract                                                                             | Change with the queue contract. Verify overflow cannot silently lose a control event; do not just remove the test.                                                           |
| `test/runtime.test.ts`                                                                                                      | Keep resolve-once/drain behavior; add the duplicate-registration regression. Small and valuable.                                                                             |
| `test/status-machine.test.ts`, editor, Git safety, store transactions, protocol parsing, shutdown/interrupt tests           | Keep behavior coverage. Pure functions and typed states do not prove correct transitions, parsing, filesystem effects or temporal ordering.                                  |

Most render integration tests construct a daemon, temporary Git repository,
socket client and Ink instance (`tui-render.test.ts:107`). Many then wait fixed
delays. The file already exercises a handle directly for pagination: extend that existing
approach rather than introducing another harness framework. Use controlled
promises for ordering tests. Retain a small representative end-to-end path and
terminal-specific tests; do not run the whole feature matrix through every layer.

Provider conformance tests in phase 7 should run a shared set of observable
workflow contracts against adapters, with vendor protocol fixtures tested
separately. Keep connector-specific regressions where semantics differ. Avoid
copying the whole daemon/TUI scenario suite once per provider.

There is no defensible percentage of tests to delete from this review. The
near-term win is fewer broad test environments and fewer obsolete invariants,
not a smaller test counter at any cost. Types eliminate invalid representations;
they do not prove that an allowed transition is the correct one.

## Sequence and reduction discipline

1. Align phase 5 and state-sync steps 1/3 around complete interactions and
   applied-settings semantics. Correct the small control-stream/pending contracts
   as necessary for that work. Avoid two competing serializers or interaction maps.
2. Implement the snapshot/transcript cutover from the existing plan. Finish its
   deletion step before adding UI architecture. Remove old paths and their
   representation-specific tests in the same change series.
3. Reshape the remaining local UI state and extract only cohesive workflows.
   Move appropriate tests down to handle boundaries as part of that extraction.
4. Complete provider phases 6/7 using those seams. Tighten RPC/history contracts
   incrementally where those changes already pass, instead of starting a rewrite.

For agent-driven changes, require a short explanation of what responsibility
now has one owner, what old code disappears, and which observable failure the
chosen tests protect. A useful constraint is: no new parallel map, flag or
fallback without identifying why existing state cannot express the distinction.
Prefer deleting superseded machinery in the same patch over leaving a future
cleanup task. Rewrite historical patch commentary into present-day invariants.

If further reduction is needed, feature scope is a legitimate lever. Automatic
keep-warm/re-drive behavior and cross-provider plan retargeting span many layers;
they are sensible candidates for a usage-based keep/remove discussion. This
review has no usage evidence and does not recommend silently removing them.

## Validation and limits

No production code or tests were changed. The review document is the only added
file. Three small probes ran against the actual branch modules with Node 24's
TypeScript support: duplicate pending registration, channel overflow, and tool
name classification. The interaction handoff/publication findings are based on
static control-flow inspection, not an executed daemon reproduction.

The Deno suite, lint and typecheck were not run for this review; `deno` is not on
the current shell's PATH. I did not bootstrap the development shell merely to
report a passing baseline unrelated to edits. Test speed conclusions are about
visible setup/wait structure, not measured timings. Provider phases 5–7 remain
intentionally unfinished and are not counted as newly discovered missing features.
