# Session forks and undo

Loom supports undo/rewind where the provider advertises it, and forks into a new
worktree. Native history forks retain provider identity when supported.
Continuation forks start a fresh provider session with bounded saved context
when the original provider is unavailable, isolation changed, or the user selects
a different provider. The original session remains readable.

A continuation fork uses the source session's actual HEAD and copies staged,
unstaged and nonignored untracked work separately. Git operations in progress and
submodule changes are rejected. Forking does not rewrite the original worktree.

There is no interactive conversation-tree navigator. The earlier design proposal
is retained in Git history. Controls are described in [keybindings](keybindings.md);
VM history boundaries are documented with each provider runtime.
