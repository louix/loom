# Session Git bridge

Packaged MCP runtimes now automatically get a controlled Git bridge when their
workspace is a supported linked worktree. The guest uses an ordinary `git`
command, supplied by the runtime artifact. Host commits and rebases remain
immediately visible, preserving the existing host Git/lazygit workflow.

## Use

The Linux Nix package includes a compatible runtime. Upgrade it with
`nix profile upgrade loom`. In a source checkout, rebuild development runtimes with:

```sh
deno task runtime:update
```

Then start or resume a session using the VM runtime:

```toml
[[command-mcp]]
name = "tilth"
runtime = "tilth"
isolation = "vm"
default_for = ["read", "write", "edit", "find", "grep"]
```

No socket path or Git bridge configuration is needed. Old prepared artifacts
produce an actionable update error for Git worktrees. This applies to VM-backed
MCPs; host connectors and host command MCPs keep their existing Git behavior.
Directories without `.git` can still run file tools without a Git endpoint.
A main checkout with a `.git` directory is rejected: enable session worktrees
instead of exposing the repository metadata to a VM.

## Supported commands

Run commands at the session worktree root (`git -C ROOT ...` also works):

- `git status`, including short/porcelain and branch forms.
- `git diff`, `git diff HEAD`, `git diff --staged`, simple refs/ranges, selected
  output flags and literal relative paths after `--`.
- `git log`, with a bounded count and the short formats used by Tilth.
- `git show REF:path` and `git show :path` for text blobs.
- `git branch --show-current`; `git rev-parse --short HEAD`, `--show-toplevel`
  and `--is-inside-work-tree`.

Tilth's uncommitted/staged/ref diff and log operations use the shim. A small
packaging patch makes Git failures surface as tool errors instead of looking
like an empty diff. `git diff --no-index` is rejected because it would read
arbitrary host files; Tilth can still read guest files directly.

Writes support `git add` (including `-A`/`-u`), `git restore --staged`,
`git commit -m` (including amend), `git rebase REF`, `git rebase --onto NEW OLD`,
and rebase `--continue`, `--skip`, `--abort`. Only the branch attached when the
bridge starts can be changed. Rebase targets supply history; their branches are
not moved. Conflict state lives in real host metadata and survives session close.
Resume the session to continue a bridge-owned rebase, or finish it using host Git.
Interactive rebases, checkout, config, remote operations, arbitrary config
flags and Git aliases are rejected. The sole accepted config flag is Tilth's
`-c core.quotePath=false`. Other working directories are rejected rather than
silently returning results for the wrong location. Bridge operations serialize per worktree; ordinary host tools do not take this
bridge lock, so avoid simultaneous host and guest Git mutations.

## Isolation and lifecycle

```text
guest git shim -> /run/loom/git.sock -> smolvm vsock
  -> private host Unix socket -> per-session Deno Git worker -> constrained host Git
```

The installed smolvm 1.8.1 already supports the required forwarding through
`machine create --mount-socket`; it is absent from `machine run`. Git sessions
therefore use create/start/exec and explicit stop/delete. IP networking remains
disabled. The guest socket sits outside shared volumes, avoiding the shared-path
collision described in [smolvm issue 864](https://github.com/smol-machines/smolvm/issues/864).

The daemon prepares a private metadata view and starts a separate Git worker.
It checks the host worktree backlink and common-directory relationship before
binding the endpoint. Guest requests cannot select a host repository or session.
Production bridge operations use the real host metadata, so commits, reflogs and
rebase state are immediately available to host Git and lazygit. A private read-only
view remains available for the original bridge tests. Native Git is not sandboxed
by Deno; its restricted command policy is the host boundary.

By default, each invocation disables hooks and fsmonitor, and configuration with
includes, executable filters or merge drivers is rejected with an actionable error.
The bridge checks this policy again before operations. To trust repository programs:

```toml
[isolation.git]
allow_repo_programs = true
```

This permits configured hooks, filters, merge drivers and fsmonitor to execute on
the **host**, outside the VM. Bridge requests still enforce the command and
session-branch restrictions; programs themselves run as trusted host code without
those restrictions. Signing, editors, automatic maintenance and rebase updates to
other refs remain disabled in either mode. Global/system Git config and ambient
environment are excluded; configure required identity and integrations locally.
The program opt-in preserves host PATH. Without local user.name/user.email, new
commits use `Loom <loom@localhost>`; rebases preserve the original author.
These overrides never rewrite repository configuration or affect normal host Git.
The option applies when a provider is created; restart the daemon after changing it.
Configuration is trusted host state, not protected against concurrent host edits.

Parent EOF closes each worker, including during initialization. The VM supervisor
kills its in-flight smolvm CLI before reaping, preventing a startup race. The
daemon also kills worker process groups and reaps after supervisor death. A Git
worker death closes the VM session as well. Cleanup failures retain VM state and
surface an error; state is deleted only after reaping. After daemon death, the
surviving supervisors reap the VM and revoke the endpoint; empty state directories
can remain for later housekeeping. Simultaneous loss of the daemon and its VM
supervisor still needs an external/restart janitor.

The real Git metadata is outside the guest mount. The worktree's small `.git`
pointer file remains writable through the shared filesystem: replacing it cannot
retarget an already-bound bridge, but can break ordinary host Git or a later
resume. This does not yet provide a filesystem-level read-only `.git` pointer.
Host tools still need to treat guest-written files as untrusted.

## Validation and limits

Supported repositories use SHA-1, file refs (loose or packed), linked worktrees
and a normal index (versions 2–4). Startup validates repository format and index
framing. SHA-256, reftable, split/sparse indexes and unknown extensions fail with
an explanation. The usual `extensions.worktreeConfig` setting is supported;
execution validates its configuration. Submodule status is ignored, and LFS/filter
semantics require the repository-program opt-in and installed host helpers.
The production bridge revalidates configuration and index framing before operations.

The socket accepts one version-1 JSON line per connection. Structured status,
diff and log requests remain available; the shim sends `{version:1,op:"git",
args:[...],cwd:"..."}`. Every argument is validated again on the host. Execution
returns `{version:1,ok:true,code,stdout,stderr}`; Git's nonzero exit codes are
preserved. Policy and limit failures return `ok:false`. Output is UTF-8 text.

Bounds: 4 KiB requests, 64 KiB combined Git output, eight active requests,
65 seconds per connection/execution, and at most 50 log entries. Larger diffs
fail visibly; they are not truncated and presented as complete.

## Verification

```sh
deno test -A test/git-bridge.test.ts test/git-bridge-integration.test.ts test/git-bridge-writes.test.ts
# Requires a freshly prepared tilth runtime and KVM:
deno run -A scripts/test-session-git-vm.ts tilth
# Existing non-Git VM acceptance checks:
deno run -A scripts/test-runtime-vm.ts tilth
```

The tests use disposable repositories. Session acceptance exercises Tilth diffs,
the native shim, host commits/rebase, inaccessible host metadata, guest staging/commits/rebase, rejected commands,
normal close, parent EOF, both worker crashes, startup EOF and parent SIGKILL.
Earlier `test-git-bridge-vm.ts` checks concurrent endpoint routing and vsock with
IP blocked against a positive control. `test-guest-bridge.ts` preserves the
original transport experiment, whose SSH relay targets only a dummy endpoint.
