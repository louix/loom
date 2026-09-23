# Claude VM authentication investigation — 2026-09-23

## Finding

A reproducible VM shared-filesystem failure can make valid credentials temporarily
unreadable during a large dependency bootstrap. The libkrun backend exhausts its
**host** open-file limit, and unrelated guest reads then return EMFILE, including
Claude's credential file. The guest application's own descriptor use can remain
very low.

This is a strong explanation for the investigated mid-session authentication
failures, distinct from access-token expiry and renewal. We reproduced credential
read failures under the actual bootstrap and independently without Claude. We did
**not** reproduce Claude's exact `authentication_failed` result in the controlled
live runs, so attribution of every original session remains an inference.

No host-profile login, token refresh, or credential edit was performed during
these experiments. Live probes used isolated access-token-only snapshots.

## Original evidence

All three reported gridshare-edge sessions used Claude auto mode in VMs:

| Session                              | Relationship to renewal change | Observed behavior                                    |
| ------------------------------------ | ------------------------------ | ---------------------------------------------------- |
| cc5b89fa-b3ad-454a-8b00-5f6596829548 | After                          | Text and tools succeeded, then authentication_failed |
| 8cd644ce-2a10-43a7-a987-c7c8f005a7a6 | Before                         | Text and tools succeeded, then authentication_failed |
| e70f1ab8-8db3-4477-94f7-90d915925aa9 | Before                         | Repeated failures; preserved classifier diagnostic   |

The last session's native `auto-mode-classifier-error.txt` records a local SDK
error at 10:36:39.576 UTC:

> Could not resolve authentication method. Expected one of apiKey, authToken,
> credentials, config, or profile to be set.

It names the side-query classifier model and a tilth tool call. This is missing
local authentication configuration, not evidence of a server rejecting an expired
token. A later attempt also recorded a shell snapshot failing to load the Claude
binary with `Stale file handle`.

All three logs contained a blocked request to `mcp-proxy.anthropic.com`. The same
block occurred in successful controls, so it does not independently explain the
failure.

## Controlled experiments

Native Claude version: 2.1.268. Loom runtime: d58712e. Backend: smolvm 1.16.2 with
the libkrun revision pinned in `flake.nix`.

The following combinations completed classifier calls successfully:

- Host process with an isolated disk credential snapshot and an MCP marker tool.
- VM with an access-only disk snapshot.
- Atomic republication of the same snapshot after VM boot.
- Prepared repository base, then full Nix activation.
- Credential-owner initial publication.
- Actual tilth MCP relay, Opus main model, and auto-mode classifier.
- The same setup with a harmless asynchronous startup hook.

Adding the repository's actual asynchronous `pnpm -w workspace--bootstrap`
hook, with its required network presets, repeatedly produced EMFILE and ESTALE
failures in ordinary commands and shared-library loads. A separate persistent
guest process polling the credential paths every 100 ms observed EMFILE from
both `/run/loom/private/auth.json` and the profile's `.credentials.json` symlink.
Successful reads resumed without any credential replacement or token change.

Claude debug output independently reported EMFILE while scanning its settings
directory and creating its session environment directory.

## Minimal reproduction

`scripts/spike-vm-fd-pressure.ts` starts a disposable VM with the mock connector
and a fake token. It stats distinct files on a shared mount, reads the fake
credential file, reports guest descriptor use, and then drops **only the disposable
guest's** dentry/inode caches to test recovery. It removes the fixture afterwards.

Use a compatible session runtime artifact and the pinned smolvm executable:

```sh
deno run -A scripts/spike-vm-fd-pressure.ts "$artifact" "$smolvm" 120000
```

A smaller reproduction lowers the limit only in a subshell and its descendants:

```sh
(
  ulimit -n 4096 || exit
  exec deno run -A scripts/spike-vm-fd-pressure.ts "$artifact" "$smolvm" 6000
)
```

Observed results:

| Host backend hard limit | Files requested | First failing file index | Guest process open descriptors | Credential after pressure | After guest cache drop |
| ----------------------- | --------------- | ------------------------ | ------------------------------ | ------------------------- | ---------------------- |
| 100000                  | 120000          | 99408                    | 18                             | EMFILE                    | Readable               |
| 4096                    | 6000            | 3503                     | 18                             | EMFILE                    | Readable               |
| 100000                  | 6000            | None                     | 18                             | Readable                  | Readable               |

The guest process reported a limit of 1048576 in all three cases. Looking only at
guest `ulimit` or guest-wide file counts therefore misses the exhausted host
backend. Host `FDSize` grew to 131072 and 4096 respectively; this is descriptor
table capacity, not an exact open-file count.

## Mechanism and next steps

The pinned Linux libkrun passthrough filesystem opens an O_PATH descriptor for
each looked-up inode and retains it until the guest releases the inode. Guest
dentry caching can keep many such descriptors alive. All shared mounts consume
the same backend process's descriptor budget, so repository/package-cache
activity can prevent reads from the separate credential and runtime mounts.

Source: [libkrun lookup and inode release](https://github.com/smol-machines/libkrun/blob/d2b7c30f83382849b17c47df87862b56322c2bd4/src/devices/src/virtio/fs/linux/passthrough.rs).
Smolvm raises its soft limit to the inherited hard limit; it cannot raise that
hard limit without the necessary host privilege.

The practical mitigation to validate on the full workload is to raise the
**host hard nofile limit inherited by the Loom daemon and VM backend**, for
example to 1048576, then restart the affected processes and retry the bootstrap.
Increasing only the guest limit does not help. This remains a mitigation for a
bounded workload, not a solution to unbounded backend descriptor retention.

An upstream solution should bound descriptor retention or coordinate cache
reclamation before exhaustion. Periodic guest cache dropping is a diagnostic
recovery technique here, not a production fix. A fresh VM also starts with a
fresh descriptor budget; re-login does not address that budget.

The earlier OAuth renewal fixes should remain separate. These experiments do
not establish the cause of the original roughly eight-hour host-profile expiry
symptom and do not justify changing renewal behavior again.

## Error reporting

Loom now adds a file-limit explanation to explicit EMFILE failures in VM provider
errors/results, failed tool results, and noninteractive VM commands. Tool payloads
and command exit codes are preserved; repeated failed tools produce one nonfatal
warning per mounted session. Successful output mentioning EMFILE is not diagnosed.

Backend stderr is reduced to a fixed file-limit category, including fragmented
or long diagnostics, without exposing raw vendor output. This category is also
available when reporting startup/connection failure.

The wording identifies descriptor exhaustion while leaving its location open:
the limit may belong to a guest process or the host backend. Generic authentication
failures, ESTALE, and bare numeric exit codes are not sufficient evidence. Errors
swallowed entirely by a provider remain undetectable through these paths.
