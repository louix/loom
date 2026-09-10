# Product backlog

These are proposals, not a claim that existing features are missing. See
[the latest isolation review](review-2026-09/session-isolation-followups.md) for
current findings. Mode/provider/model memory and per-project provider restrictions
already exist; further settings work should build on them.

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

The Nix package runs Deno with pinned, cached dependencies. On Linux and Apple Silicon it bundles
Tilth, Claude, Codex and AISDK VM runtimes, individually optional through package
overrides. See [packaged runtimes](packaged-runtimes.md) for configuration and
upgrade behavior. The former Node/oxnode and fetchPnpmDeps packaging is gone.

Remaining ideas:

- Complete the remaining [macOS validation](review-2026-09/macos.md).
- Measure package size before choosing dependency pruning or bundling work.
- Consider a standalone distribution, Nix overlay/channel or Guix package as
  separate efforts. Native provider executables and VM artifacts still need
  an explicit distribution story; compiling the CLI alone does not replace them.

# 2) Claude profile details

We automatically pick up ~/.claude and load stuff from there. When we have the Claude provider in use in a chat, I think we should show some details we have available, so the user knows which profile is in use. I've seen Claude Code show:

- Organization: "The Company"
- Login method: "Claude Enterprise account"
- Email: "user@example.com"
  If we can surface any of these, that may be useful to disambiguate between their personal and work profiles.

# 3) Claude profiles — implemented

Named Claude profiles appear as separate providers through `[[claude_profiles]]`.
The remaining identity-display proposal is above; symlink switching is unnecessary.

# 4) Plan mode improvements

Implementation modes and continuation into another provider already exist. The
original UX ideas below are context for further refinement, not missing features.

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
