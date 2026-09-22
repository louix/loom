# Repository mounts and Git

This section describes legacy `checkout.mode: "mount"` sessions. For private
clone sessions and prepared workspaces, see [Session environments](session-environments.md).

Each agent session retains its own VM and worktree. Loom mounts the full host
repository and the selected worktree at their original absolute paths. External
Git common directories are mounted too, so linked worktree pointers remain valid.
Preparation uses the same layout with a disposable worktree.

Session worktrees default to `$XDG_DATA_HOME/loom/worktrees/<repo>-<hash>/<id>`
(`~/.local/share` when unset). Only the selected external worktree is mounted,
so the repository mount no longer exposes sibling session worktrees.
Existing worktrees under `.loom/trees` remain visible through that repository mount
until those sessions are archived. The `worktree_dir` config setting overrides
the directory, including a location on another drive.

External worktrees require another mount. Older x86 Linux VM configurations
have exhausted virtual-device IRQs with additional mounts and a persistent
provider profile. Host Git and mount-layout tests cover external paths; a real
VM run is still needed to verify the device limit on a given backend.

Real Git runs inside the VM for agents, setup scripts and packaged MCP tools.
There is no Git shim, host Git worker or command allowlist. Commits and edits are
immediately visible on the host. The old isolation.git.allow_repo_programs option
is obsolete and can be removed.

Use native Git hooks for commit checks. Loom's worktree hooks forward `pre-commit`,
`prepare-commit-msg`, `commit-msg` and `post-commit` to the repository's hooks;
its `pre-push` hook blocks session pushes. In VM sessions these hooks execute
inside the guest and their commands must be available there. A rejecting
`pre-commit` hook fails the Git command and returns its output to the agent.
Loom's `workspace_start` hook runs on worker creation and resume in both VM and host sessions.

This trusts agents with the mounted repository: shared hooks/config and any
worktrees still nested inside it are accessible. Changes to hooks/config can execute code when Git later
runs on the host. Files and secrets inside the repo are not isolated from agents.
Unmounted home directories, provider profiles and private VM state remain outside
the repo mount. Network allowlists and per-session VM lifetimes are unchanged.

Stop the old daemon before upgrading and rebuild runtime artifacts. Old prepared
disks require a compatible runtime; this change invalidates the old artifact.

Validate with test/workspace-mounts.test.ts and scripts/test-real-git-vm.ts.

## Clone mode

Everything above describes `session.isolation.checkout.mode = "mount"`, the
default. With `"clone"`, a new VM session mounts none of this. It works in a
private clone whose only remote is a host relay that lets it read its base
branch and its own branch and push its own branch only, so hooks and config the
agent writes never reach host Git. The session branch in your repository is
kept current at every turn end; take commits from it with ordinary Git.

```jsonc
{ "session": { "isolation": { "checkout": { "mode": "clone" } } } }
```

Existing sessions keep the mode they were created with. Auto-rebase, the `r`
key, dirty flags and commit reminders run Git through the existing VM shell
execution path. `check` hooks run in that same VM with its activated environment;
notification hooks stay on the host. Manual rebase resumes a sleeping session,
and refuses to run while the agent, background work, checks or open shells are
active. Git state is last-observed while a VM is stopped; before the first
successful guest probe it is unknown. Undo's worktree restore remains unavailable
for clones. See [guest checkouts](guest-checkout-plan.md) for the design and
the current status. Validate with test/git-relay.test.ts,
test/guest-checkout.test.ts, test/clone-session.test.ts, test/clone-git.test.ts,
test/clone-features.test.ts, scripts/test-guest-checkout-vm.ts and
scripts/test-clone-git-vm.ts.
