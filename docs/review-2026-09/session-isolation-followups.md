# Session isolation follow-up review — 2026-09-09

Bounded source/docs review after package-owned session runtimes and persistent
startup/send errors. Existing September reports remain historical records.

## Fixed in this pass

- Startup feedback docs now describe composer dismissal, session error events,
  pre-acceptance draft recovery and Up-arrow recall from loaded transcript pages.
- Removed obsolete Node/oxnode/pnpm packaging instructions from the task backlog;
  distinguished implemented provider profiles/mode memory from future settings.
- Updated bundled-runtime instructions and the validation backlog. Codex controlled
  refresh/401/expiry validation is complete; natural live OAuth expiry is not.
- Shared runtime compatibility errors no longer tell every provider to rebuild
  Claude (`backend/daemon/src/daemon/session-vm-worker.ts`).

## Follow-ups

1. **Pre-session failures still lack a chat row.** `Daemon.#startSession` creates
   the worktree before the registry row; `session.create` also validates provider
   availability/model first. Those errors still use draft recovery/status feedback.
   Moving row creation earlier needs deliberate cleanup/retry semantics. Every
   failure living on a chat is not fully implemented. Source:
   `backend/daemon/src/daemon/daemon.ts`.
2. **Recall is bounded and global.** Composer history contains at most 50 distinct
   texts, restored as transcript pages load. A long tool burst can leave the latest
   user message outside the first 500-event page; reconnect-and-Up will not find
   it until its page loads. Restoring another chat preserves the existing local
   order rather than putting that chat's newest message first. Decide whether
   recall should be per-session; if so, use a user-message query rather than
   walking every tool event. Sources: `frontend/tui/src/fleet-handle.ts`,
   `model.ts`, `composer.ts`.
3. **Startup timing lacks stage measurements.** Cached worker readiness was
   measured at ~0.7s versus ~9.6s cold, excluding native provider initialization
   and API latency. Logs cannot attribute the observed ~31s first reply versus
   ~10s next invocation. Add monotonic worker-ready, provider-ready and first-response
   timestamps only when this becomes worth investigating.
4. **Broader validation and network isolation remain open.** Google/native
   Anthropic AISDK VM smoke tests, daemon-side utility network removal and macOS
   execution are deferred. Claude's early API 401 is not wired to forced host
   refresh; normal proactive renewal is implemented. See the provider VM docs
   and `docs/isolation-plan.md` for validated boundaries.
5. **Two auto-rebase tests need investigation.** During the preceding error-history
   change, clean-idle notice and conflict-nudge assertions failed against both
   edited and unchanged daemon code. They use fixed 40/120ms waits; timing is a
   hypothesis, not an established cause. Reproduce with
   `deno test -A --filter auto_rebase test/daemon.test.ts` before changing behavior.

## Review limits

No new live API calls, VM lifecycle changes, daemon restarts or profile upgrades
were performed. Documentation corrections do not establish new platform/provider
validation. Follow-up items are intentionally left open for separate work.
