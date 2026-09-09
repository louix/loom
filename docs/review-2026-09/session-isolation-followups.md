# Session isolation follow-ups — 2026-09-09

## Implemented

- Valid create requests persist a chat and opening message before provider/model
  validation and worktree setup. Those failures appear on the error chat and can
  be recalled; malformed requests still fail before allocation.
- Reply history uses `session.messages`, a session-scoped query for the latest 50
  distinct user texts. Tool traffic, transcript pagination and other chats no
  longer displace the latest message. New-session prompts keep local history.
- Added monotonic `worker_ready`, `adapter_ready` and `first_output` durations,
  plus create/resume start markers. Session ids correlate the stages; no prompts
  or credentials are logged. See [timings](../claude-session-vm.md#startup-timing).
- Built-in generic/Gemini/Codex connectors now use host workers for non-VM sessions
  and utilities. Host transcript mutations still use the scoped worker channel.
  Catalog HTTP requests run in an endpoint-scoped worker; redirects cannot expand
  its grant. Standard daemon/TUI launches allow only their exact Unix socket.
- Early Claude authentication failures request one host refresh per mounted VM
  session without delaying the error or automatically replaying a turn.
- Replaced fixed 40/120ms waits in auto-rebase tests with observed running/notice/
  nudge conditions. They pass in the fresh worktree; no production Git defect was
  reproduced. Old composer-feedback tests now assert the current behavior.

## Remaining external validation

- Live Google/native Anthropic VM checks: neither provider nor API credentials are
  configured in this environment. The existing acceptance script remains usable
  once credentials are available. Claude subscription OAuth is not a substitute
  for an Anthropic API key in the native AISDK adapter.
- macOS execution: this environment is Linux/KVM. The previously deferred macOS
  backend still needs implementation and validation on a Mac. Linux guest
  packaging remains separated from host launch code.
- Natural live Codex OAuth expiry remains unobserved. Controlled native Codex/VM
  rotation, 401 recovery and failed-renewal expiry tests were completed earlier.

## Boundary limits

The daemon remains trusted with config, credentials, files, subprocesses and FFI.
Unix-only Deno grants remove direct TCP/HTTP access; they do not sandbox native
subprocesses or custom embedded callers that choose different permissions. VMs
remain the native-code isolation boundary. No user daemon/profile restart or
upgrade is part of this implementation pass.

## Validation

- Full `deno task test:silent`, type checking and lint pass.
- Local endpoint acceptance covers worker-backed catalog discovery and a provider
  turn while the daemon and CLI have no direct TCP/HTTP grant.
- `nix build .#loom` passes. The packaged CLI runs and reports Tilth, Claude,
  Codex and AISDK runtime artifacts ready. This checks packaging and discovery;
  it does not replace live provider VM acceptance.
