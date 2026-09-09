# AISDK session VMs

Configure a Linux guest artifact for OpenAI-compatible, native Anthropic and
Google AISDK profiles. Codex/ChatGPT uses a different native connector and is
not enabled by this setting.

```sh
nix build .#aisdk-session-runtime --out-link /tmp/loom-aisdk-runtime
```

```toml
# ~/.config/loom/config.toml; also valid under [repo.isolation.aisdk]
[isolation.aisdk]
artifact = "/absolute/path/to/loom-aisdk-runtime"
smolvm = "/absolute/path/to/smolvm"
```

`enabled = false` disables an inherited policy. Restart the daemon after changing
it. Each session gets a separate VM with its worktree and only its resolved API
credential. Its HTTPS endpoint hostname is allowed on port 443; additional
worktree destinations use `isolation.extra_allowed_hosts`. HTTP/custom-port model
endpoints are rejected. Legacy built-in search credentials require migration to
HTTP MCP mounts. No fallback to host session execution occurs after a VM error.

The daemon owns durable conversation history. Before starting a worker it sends
that session's history to a private in-memory mirror. Guest append/replace/clear
operations are ordered on the worker transport and applied to the bound host
transcript before subsequent events and command acknowledgements. The guest
cannot select another session id or fork host history. Oversized frames or a
failed store write fail the worker; history is never silently truncated. The
current private protocol has a 1 MiB frame limit and a 4 MiB pending-write limit.

Changing isolation makes existing sessions read-only; fork to continue under the
new policy. Native Claude history is separate from this Loom-owned history.
Title and catalog utilities still use their existing host path; removing those
remaining daemon-side connector imports is follow-up work.

## Verification

`test/worker-transcript.test.ts` covers scope, mutation ordering and malformed
frames. The opt-in live check creates two VMs in turn and verifies that the second
recalls the first one's conversation from the host transcript. It uses a temporary
Git fixture and makes two short billable requests:

```sh
deno run -A scripts/test-aisdk-session-vm.ts ARTIFACT SMOLVM PROVIDER_ID MODEL_ID
```

Verified with the OpenAI-compatible Sference endpoint. Google and native Anthropic
share the launch/persistence path but have not had a live VM smoke test here.
