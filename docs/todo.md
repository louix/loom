# 0) Settings
Persisted to .db.

## Default verbosity selection
`v` key default on launch

## Default mode
auto/acceptEdits/etc.

## Git Working Behavior
Choose if loom should work on:
- currently selected branch (no worktree)
- new branch (no worktree)
- new branch (worktree -- current behavior)

## Delete branch when deleting session
Choose which should be the default option when deleting the session:
- delete branch checked (current behavior)
- delete branch unchecked

## Enabled/Disabled connector plugins
Should be able to enable/disable connector plugins via settings. Perhaps they all start disabled by default.

# 1) Packaging
I want a guix or nix package, so you can do `nix profile install <someting>` or add a channel and `nix-shell -p loom --run loom` or something.

I also want to able to build and distribute a binary for Linux. (these may be mutually exclusive goals)
- Should we use scriptc? https://github.com/vercel-labs/scriptc
- tsm?
- something else?

# 2) Claude profile details
We automatically pick up ~/.claude and load stuff from there. When we have the Claude provider in use in a chat, I think we should show some details we have available, so the user knows which profile is in use. I've seen Claude Code show:
- Organization: "The Company"
- Login method: "Claude Enterprise account"
- Email: "user@example.com"
If we can surface any of these, that may be useful to disambiguate between their personal and work profiles.

# 3) Claude profile switcher?
Following on from the above, perhaps we should have a way to "switch profiles" (though likely unsupported for Claude officially).
Imagine this scenario:
- User has `~/.claude-personal`
- User has `~/.claude-work`
- User symlinks `~/.claude` to `~/.claude-personal`/`~/.claude-work`

I'm thinking in config.toml you can override the claudeDirectories (defaults to `["~/.claude"]`), so this user could put: `["~/.claude-personal", "~/.claude-work"]`
Then, we show both as providers (we'd need to make the provider names distinct somehow).
Perhaps you can think about this a bit, how we can improve it.

# 4) Plan mode improvements
When reviewing a plan, I think the options should be something like (just an idea, I forgot the current naming):
- Implement [$MODE] <-- toggle mode keybind toggles this instead of session out of plan mode (not possible at that point anyway)
- Implement in a clean session $PROVIDER_SLUG $MODEL $THINKING_LEVEL [$MODE] <-- alt+p to change the first few (usual provider/model/thinking switch prompt), normal keybind to switch mode?
- ...existing options
That new "clean" session should probably become a nested session on fleet view, wdyt? it gives you the ability to implement the plan using smaller models (though, tbh since you have the cache I'm not actually sure it's worth it)

# 5) Default model/provider selection setting
Select default provider/models for:
 - title/branch names generation
 - compaction/summaries
 - plan implemention
 
Should be able to choose [default] (the base model) or a specific provider/model/etc.
