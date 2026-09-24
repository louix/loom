# Remaining work

This is the single backlog for documentation purposes. Proposals below are not
claims that existing features are missing. Check current code before reviving a
historical finding; completed plans and investigation reports remain in Git history.

## Validation

- Live Google and native Anthropic VM checks, plus natural live Codex OAuth
  expiry. Controlled Codex rotation, 401 recovery and expiry fixtures exist.
- Apple Silicon live Claude response/MCP/resume and live Codex account checks.
  Native packaging, VM lifecycle, recovery and synthetic provider checks have
  been exercised; Intel macOS is unsupported.
- HTTP MCP OAuth: native macOS Keychain behavior (including locked/unavailable
  storage), live IPv6 connections, and real dynamic-registration and confidential
  clients. Do not advertise named service compatibility before testing it.
  See [OAuth](mcp-oauth.md).
- After guest source changes, regenerate Apple Silicon runtime hashes on a Mac
  with Nix; see [packaging](packaged-runtimes.md).

## Product proposals

- Settings UI for persistent verbosity, an explicit default permission mode,
  branch-deletion preference and provider selection. Explicit defaults should
  stay pinned when a session changes. Provider/model/mode memory and configured
  provider restrictions already exist.
- A branch-only working mode alongside existing in-place and worktree modes.
- Account identity details to distinguish personal and work Claude profiles.
- Provider/model defaults for titles, summaries and plan implementation.
- A named `check` tool with bounded output for configured project checks.
- Measure package size before dependency-pruning or standalone-distribution work.
- Consider a standalone isolation launcher as a separate product.

## Engineering follow-ups

- Review stale/concurrent plan resolution, cancellation of parked interactions,
  control-event overflow and duplicate runtime registration.
- Reduce initial private-workspace copy cost on filesystems without reflinks.
  Idle VM shutdown preserves workspace data; automatic cache eviction needs a
  separate policy.
- Evaluate macOS disk-template caching and broader MCP reconnect behavior.
