**Loom simplification review — 12 September 2026**

Loom can become substantially smaller while keeping its purpose: directing agents across providers with isolated execution. The largest opportunities come from reducing behavioral promises and removing duplicated ownership. Splitting large files into services would improve navigation but would not achieve this goal.

This review inspected the current working tree, including its in-progress runtime changes. No implementation was changed and no tests were run. The source inventory contains about 40,800 physical TypeScript/TSX lines across backend, core, runtime, client, frontend, aisdk, connectors, and cli; counts include comments and blank lines. The TUI alone is about 10,200 lines. Savings below are judgment estimates of net source deletion, not measured patches, and overlap between rows.

| Priority | Change                                                   | Estimated net lines removed | Main concession                                             |
| -------- | -------------------------------------------------------- | --------------------------: | ----------------------------------------------------------- |
| 1        | Stateless shell; smaller AI SDK tool suite               |                     400–700 | No implicit shell state; fewer builtin fallbacks            |
| 2        | Snapshot-first reconnect                                 |                     200–400 | Reconnect refreshes the view; transient notices may be lost |
| 3        | One VM session startup implementation                    |                     150–250 | None intended                                               |
| 4        | Remove automatic cache maintenance and agent nudges      |                     300–600 | More explicit user/agent actions                            |
| 5        | Continue conversations instead of exact rewind/hard fork |                     500–900 | No exact restoration of earlier conversation state          |
| 6        | Simplify TUI implementation and command contracts        |         Not yet established | Prefer preserving existing user features                    |
| 7        | Stop managing backend disk internals                     |            50–150 initially | Potentially slower VM startup                               |

Taken together, several thousand lines look plausible. I would not promise a percentage reduction before making the first patches.

1. **Replace the persistent Bash protocol with one process per command.**

   [BashShell](../aisdk/src/tools/bash.ts) is 282 lines. It maintains a shell, inserts output sentinels, pre-parses unfinished quotes/heredocs, rejects dangling shell operators, polls for output, and repairs shell state after termination. These problems mostly disappear when a command is an actual process: `bash --noprofile --norc -c <command>`, with explicit cwd and environment.

   Keep timeout, output limits, cancellation, and descendant cleanup. Platform process exit supplies the exit code; Bash supplies its own syntax errors. The tradeoff is explicit: `cd` and `export` do not survive into the next tool call. The prepared session environment can still seed every command.

   Deno already supplies subprocess execution and streams through [Deno.Command](https://docs.deno.com/api/deno/subprocess/). The existing Node compatibility layer also provides [spawn/execFile](https://nodejs.org/api/child_process.html). Neither automatically solves every descendant-cleanup case; do not delete that responsibility while simplifying framing.

   Also reduce [background.ts](../aisdk/src/tools/background.ts) (374 lines) to a small process registry with output files and offsets if background execution is needed. Disk-backed logs remove much of the unread-buffer accounting; retain a size limit and cleanup. This is a follow-up, not a prerequisite for stateless Bash.

   [edit.ts](../aisdk/src/tools/edit.ts), [grep.ts](../aisdk/src/tools/grep.ts), and [search.ts](../aisdk/src/tools/search.ts) add another 472 lines. Loom already defaults to tilth and fff in [config.ts](../backend/daemon/src/config/config.ts). Choose one supported editing/search path per runtime: configured MCP tools, plus Bash as the escape hatch. If a builtin editor remains, exact unique replacement is enough; delete fuzzy matching. Web search can be a configured MCP capability instead of maintaining Brave and Tavily clients. Verify packaged tool availability first; today these builtins serve as fallbacks.

   Validate: normal/nonzero command exit, malformed shell input, excessive output, timeout/interrupt with descendants, and a real AI SDK turn using the chosen editing tool.

2. **Make reconnect a fresh view, not a repaired event stream.**

   [client.ts](../client/src/client.ts) is 890 lines. The reconnect path manages sequence gaps, daemon epochs, a pre-hello queue, replay, and resync. [EventLog](../backend/daemon/src/daemon/event-log.ts) retains a separate in-memory history solely for reconnects.

   The replacement is already mostly available: the daemon's `#hHello` sends a full state snapshot, and [SessionEventStore](../backend/daemon/src/store/session-events.ts) persists transcript entries with durable IDs. On reconnect, replace fleet state and reload the selected transcript's newest page; subscribe to live updates for the new connection. Keep transcript IDs for merging concurrent history/live arrivals. Preserve atomic snapshot/subscription ordering.

   Delete transport-history replay and gap repair. Keep the Unix socket and current request/response framing initially; switching to HTTP/WebSockets at the same time would add migration work without being necessary for this saving. Retain bounded queues, protocol-version checks, and explicit failure of requests whose outcome became uncertain. Never automatically retry a send that may already have executed.

   The TUI already reloads the selected transcript and resets its scroll on reconnect (`effectStart` in `fleet-handle.ts`); fleet state already comes from authoritative snapshots. This recommendation therefore removes redundant transport recovery beneath that behavior, rather than introducing a new TUI architecture. Transient notices may be lost. Current permission/question state remains recoverable from the snapshot. Validate reconnect during output, a daemon restart, a pending question, and a history fetch racing live output.

3. **Consolidate VM session startup without creating a plugin framework.**

   [claude-vm-provider.ts](../backend/daemon/src/daemon/claude-vm-provider.ts), [codex-vm-provider.ts](../backend/daemon/src/daemon/codex-vm-provider.ts), and [aisdk-vm-provider.ts](../backend/daemon/src/daemon/aisdk-vm-provider.ts) repeat executable lookup, MCP loopback validation/remapping, startup deadlines, worker connection, progress reporting, cleanup, and provider proxying.

   Use one concrete startup function. Provider-specific inputs are connector/config, credentials, allowed hosts, and resume validation/persistence. Keep those differences in small functions; avoid a lifecycle-hook registry or inheritance tree. One-shot host utility workers still have a different role and need not be forced into this path.

   This is the best behavior-preserving cleanup. Validate create/resume/failure teardown for all three VM routes, not just the shared function.

4. **Remove automation that keeps restarting supposedly finished work.**

   Start with `keepWarmMove` and `#sweepKeepWarm` in [daemon.ts](../backend/daemon/src/daemon/daemon.ts), plus keep-warm state in [session-manager.ts](../backend/daemon/src/daemon/session-manager.ts). These turn cache estimates into timers, injected turns, counters, and UI controls. Keep measured token/cost totals; let the provider manage caching. Losing keep-warm can affect latency and spend, but it removes a whole reason for idle sessions to run again.

   Next consider dropping automatic rebase and commit reminders (`#maybeAutoRebase`, `#maybeCommitNudge`). Keep explicit Git actions and put commit expectations in repo instructions. Their current interaction with status hooks illustrates the coupling: turn end may trigger a message, which changes status before notifications are issued.

   Separately, [HookRunner](../backend/daemon/src/daemon/hooks.ts) is 426 lines and tracks tool-call paths, successful results, per-turn files, feedback deduplication, and feedback-loop limits. A smaller contract is init plus explicit turn-end checks and notifications. Per-file checks can live in the chosen tool or project workflow. Dropping the richer hook contract offers additional savings beyond the table estimate.

   Validate that turn completion remains idle and that token/cost accounting and pending questions still work. Existing stored columns can remain inert initially; do not rewrite historical migrations just to reduce line count.

5. **Standardize on continuation forks; make exact undo optional or remove it.**

   `session.rewind` and `session.fork` occupy roughly 335 lines of [daemon.ts](../backend/daemon/src/daemon/daemon.ts), before checkpoint storage, adapter methods, controls, and UI are counted. [Claude's adapter](../connectors/claude/src/adapter.ts) rebuilds a query from a truncated SDK fork and coordinates cleanup with rewind flags. AI SDK uses transcript counts; the Codex adapter explicitly rejects rewind. This is expensive partial parity.

   Loom already has the simpler alternative in [fork-context.ts](../backend/daemon/src/daemon/fork-context.ts): create a fresh session with saved conversation context and a separate worktree. Make that the common fork operation. Keep ordinary provider-native resume for reopening the same session. For code rollback, use explicit Git operations rather than coupling filesystem restoration to transcript restoration.

   This gives up exact historical tool state, native conversation branching, and potential cache continuity. It retains the useful cross-provider operation: “continue this work using that agent.” Current continuation context is bounded and can omit earlier material; expose that honestly rather than claiming a lossless transfer. Validate copied worktree changes, context limits, and cleanup after failed creation.

6. **Simplify the TUI implementation while preserving its modest feature set.**

   Follow-up: [measured TUI line-cost audit](tui-line-cost-2026-09-12.md) breaks down the source by responsibility and identifies concrete duplication. It supersedes the initial feature-surface assessment.

   [fleet-handle.ts](../frontend/tui/src/fleet-handle.ts) is 2,578 lines, [components.tsx](../frontend/tui/src/components.tsx) 1,835, [model.ts](../frontend/tui/src/model.ts) 1,517, and [transcript.ts](../frontend/tui/src/transcript.ts) 1,418. These files combine rich transcript rendering, multiple layouts, hit testing, editors, pickers, queues, and plan retargeting/implementation workflows.

   Correction after follow-up inspection: line count does not establish feature bloat. The TUI largely is a daemon client: it receives authoritative fleet snapshots and issues RPCs, including delegating plan implementation/forking to `session.respondPlan`. Fleet, conversation, composer, model selection, and pending decisions are a reasonable interface for this product. The earlier 1,000–2,000-line estimate depended on removing features and is withdrawn as an implementation-simplification estimate.

   More concrete candidates are the client-side message scheduler in [composer.ts](../frontend/tui/src/composer.ts), mode-change debouncing and next-target tracking in [mode-control.ts](../frontend/tui/src/mode-control.ts), and provider/tool-specific transcript formatting. Accepted queued messages could become daemon-owned, allowing all clients to observe the same queue and eliminating client turn-boundary scheduling. This requires a real command-contract change and is only a net simplification if it replaces existing logic rather than copying it into the daemon. Unsubmitted drafts and uncertain submissions remain client responsibilities. Mode selection could use one explicit choice and a pending indicator instead of scheduling intermediate changes. Generic tool previews are a presentation simplification, independent of feature removal.

   Keep Ink and the existing small external store unless a measured problem requires change. Replacing them with a new UI stack would be a separate rewrite. Terminal layout, wrapping, scrolling, input, and request feedback account for legitimate client code. Verify normal fleet navigation, long transcripts, small terminals, and answering every interaction kind. Net savings need a more detailed implementation audit.

7. **Let smolvm own its internals; accept a slower path where appropriate.**

   In [disks.ts](../runtime/src/session-vm/disks.ts), `createSessionDisks` searches relative to the smolvm binary for `libkrun.so`, loads it with `Deno.dlopen`, and invokes `krun_create_disk_overlay`. Loom also handles raw versus qcow2 disks, backing hard links, and backend filenames. This is a strong ownership mismatch even though the code itself is not enormous.

   The immediate simpler option is already implemented as `copyDisk`: sparse/reflink copies on Linux and clone copies on macOS. Use that path for every launch, accepting that filesystems without reflink may copy populated disk data. Measure startup cost before removing the faster path. Keep publication/locking and never share writable disk bytes between sessions.

   [disk-templates.ts](../runtime/src/packaged/disk-templates.ts) is another 63-line optimization that reaches into smolvm's template cache. It explicitly treats cache failure as only a performance penalty. Removing it is a small, direct simplification worth benchmarking.

   Longer term, request a supported prepared-disk cloning interface in smolvm rather than retaining FFI in Loom. The adjacent smolvm source advertises live machine branching, but that is not evidence of a drop-in equivalent for Loom's stopped prepared disks and per-session capability mounts.

**Things I would keep, and lower-priority candidates**

Isolation, credential ownership, VM reaping, bounded transports, the session command queue, SQLite persistence, and provider event adapters earn their complexity. VM isolation does not replace user-facing tool approval or restrictions on host MCP capabilities.

The adjacent smolvm source supports hostname/DNS/CIDR egress filtering. That is not automatically equivalent to Loom's host-side HTTPS CONNECT policy with a fixed destination port. Removing [egress.ts](../runtime/src/session-vm/egress.ts) needs an explicit comparison of the two contracts; it is not a behavior-preserving deletion established by this review.

[config.ts](../backend/daemon/src/config/config.ts) is 1,158 lines. Remove retired features and legacy input spellings first, then consider one schema with inferred types using the existing Zod dependency. Rewriting validation before narrowing the config could merely express the same complexity differently.

[stdio-http.ts](../runtime/src/mcp/stdio-http.ts) implements 222 lines of MCP request correlation, cancellation, initialization, and HTTP/event handling. The [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) provides client/server transports, so an SDK-based tool facade is worth a small comparison. It is not a guaranteed deletion: generic proxying and preserving upstream tool behavior still require glue.

The existing isolation-only proposal in [isolation-fork-spec.md](isolation-fork-spec.md) would remove far more code by making the guest program own conversations and orchestration. That is a different product from the cross-provider director described here, so its savings are not included.

I would implement the shared VM startup and stateless Bash changes first, then snapshot-first reconnect. After that, make explicit decisions about keep-warm, exact undo, and the TUI workflow before deleting their implementation. Keep these as separate reviewable patches; use existing relevant tests and targeted behavioral checks, then the workspace checks for code changes.
