# Repository mounts and Git

Each agent session retains its own VM and worktree. Loom mounts the full host
repository and the selected worktree at their original absolute paths. External
Git common directories are mounted too, so linked worktree pointers remain valid.
Preparation uses the same layout with a disposable worktree.

Keep session worktrees inside the repository (the default `.loom/trees` layout).
External worktrees need another mount; the current x86 Linux backend can exhaust
its virtual-device IRQs when combined with a persistent provider profile.

Real Git runs inside the VM for agents, setup scripts and packaged MCP tools.
There is no Git shim, host Git worker or command allowlist. Commits and edits are
immediately visible on the host. The old isolation.git.allow_repo_programs option
is obsolete and can be removed.

Use native Git hooks for commit checks. Loom's worktree hooks forward `pre-commit`,
`prepare-commit-msg`, `commit-msg` and `post-commit` to the repository's hooks;
its `pre-push` hook blocks session pushes. In VM sessions these hooks execute
inside the guest and their commands must be available there. A rejecting
`pre-commit` hook fails the Git command and returns its output to the agent.
Loom's `init` hook handles initial session setup in both VM and host sessions.

This trusts agents with the mounted repository: shared hooks/config and sibling
worktrees are accessible. Changes to hooks/config can execute code when Git later
runs on the host. Files and secrets inside the repo are not isolated from agents.
Unmounted home directories, provider profiles and private VM state remain outside
the repo mount. Network allowlists and per-session VM lifetimes are unchanged.

Stop the old daemon before upgrading and rebuild runtime artifacts. Old prepared
disks require a compatible runtime; this change invalidates the old artifact.

Validate with test/workspace-mounts.test.ts and scripts/test-real-git-vm.ts.
