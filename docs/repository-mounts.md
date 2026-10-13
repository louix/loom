# Repository mounts and Git

This section describes `session.defaults.workspace: "worktree"` VM sessions. For private
clone sessions and prepared workspaces, see [Session environments](session-environments.md).

Each agent session retains its own VM and worktree. Loom mounts the selected
worktree and the repository's Git common directory (usually `<repo>/.git`) at
their original absolute paths, so linked worktree pointers remain valid. The main
checkout's files are not mounted: smolvm watches every mount recursively with
host inotify, and each session watching the checkout's `node_modules` again
exhausted the user's watch limit. Preparation uses the same layout with a
disposable worktree.

Session worktrees default to `$XDG_DATA_HOME/loom/worktrees/<repo>-<hash>/<id>`
(`~/.local/share` when unset). Only the selected external worktree is mounted,
so sibling session worktrees are not exposed.
The `session.worktree_dir` config setting overrides
the directory, including a location on another drive.

Each worktree or clone session gets its own branch, `loom/<id>` (the first eight
characters of the session id) until its title is generated, then
`loom/<title-slug>`, with a short hex suffix if that name is taken.
`session.branch_prefix` replaces `loom`: `"me/loom"` nests deeper, and `""` drops
the prefix and its slash (`<id>`, then `<title-slug>`). The value is checked like
a Git ref: slash-separated components, no leading or trailing slash, and nothing
`git check-ref-format` rejects. It can be set per `repos[]` entry and applies to
new sessions without a restart. Existing sessions keep their branch names, and a
session still on its `<prefix>/<id>` branch keeps that prefix when it is renamed.
Loom tells its sessions' branches apart by the session rows, never by the prefix,
so deleting a branch (`session.remove` with `deleteBranch`, or a failed fork's
cleanup) only touches a branch a session row records as its own. With `""`,
`session.clone.visible_refs` cannot list anything under `refs/heads/`, since
any branch could be a session's.

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

This trusts agents with the mounted Git directory: shared hooks/config and all
repository history are accessible. Changes to hooks/config can execute code when Git later
runs on the host. Files and secrets in the worktree are not isolated from agents;
untracked files in the main checkout are not mounted.
Unmounted home directories, provider profiles and private VM state remain outside
the repo mount. Network allowlists and per-session VM lifetimes are unchanged.

Validate with test/workspace-mounts.test.ts and scripts/test-real-git-vm.ts.

## Clone mode

Everything above describes `session.defaults.workspace = "worktree"`, the
default. With `"clone"`, a new VM session mounts none of this. It works in a
private clone whose only remote is a host relay that advertises its base
branch and its own branch and accepts pushes to its own branch only, so hooks and config the
agent writes never reach host Git. The session branch in your repository is
updated by automatic publication at turn end; take published commits from it
with ordinary Git. Publication failures are reported in the conversation.
Repository history must be considered readable regardless of advertised refs.

```jsonc
{ "session": { "defaults": { "workspace": "clone" } } }
```

Existing sessions keep the mode they were created with. Auto-rebase, the `r`
key, dirty flags and commit reminders run Git through the existing VM shell
execution path. `check` hooks run in that same VM with its activated environment;
notification hooks stay on the host. Manual rebase resumes a sleeping session,
and refuses to run while the agent, background work, checks or open shells are
active. Git state is last-observed while a VM is stopped; before the first
successful guest probe it is unknown. Undo's worktree restore remains unavailable
for clones. Forks start from the parent's published tip and do not carry over
uncommitted clone work. The `commit` tool commits locally; automatic publication
runs at turn end. Archiving retains clone files unless forced.
See [private prepared workspaces](session-environments.md#private-prepared-workspaces)
for storage and lifecycle. Validate with test/git-relay.test.ts,
test/guest-checkout.test.ts, test/clone-session.test.ts, test/clone-git.test.ts,
test/clone-features.test.ts, scripts/test-guest-checkout-vm.ts and
scripts/test-clone-git-vm.ts.
