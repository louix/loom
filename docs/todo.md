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

## Nix package — done (`flake.nix` `packages.loom` / `.default`)
`nix profile install <repo>` / `nix run <repo>#loom` work. No bundler: the
package is `makeWrapper` around `node_modules/.bin/oxnode cli/src/{loom,loomd}.ts`,
same as `pnpm loom`. Version is `--set LOOM_BUILD_VER <self.shortRev>`, read by
`core/src/version.ts` (env → `git describe` → `"unknown-version"`).

Three workarounds baked into the derivation:
- nixpkgs `pnpm` is 11.22, repo floor is 11.23 → `pnpm_11.override` to 11.24.0
  (tarball hash pinned in the flake).
- `fetchPnpmDeps` fixupPhase `jq`-parses every `*.json` in the fetched store;
  many deps (`@ljharb/*`, `@anthropic-ai/sdk`) ship JSONC `tsconfig.json` →
  `overrideAttrs` makes the pass tolerate unparseable files.
- `pnpm-workspace.yaml` `virtualStoreType: global` points `node_modules` out of
  tree (for the repo's worktree sharing) → `postPatch` strips it.

### Rough edges
- Built and run on **x86_64-linux only**. The deps fetch is cross-platform
  (`--force`), so aarch64 / darwin are plausible but unverified.
- Closure is **~365M**. Root `package.json` keeps `ai` / `ink` / `react` /
  `zod` under `devDependencies`, so `pnpm install --prod` can't prune without
  dropping actual runtime deps. Splitting runtime vs tooling deps (or a
  bundler, below) would fix this.
- `@anthropic-ai/claude-agent-sdk` ships a bundled `claude` ELF that won't run
  under Nix. Users must set `providers.claude.cli_path` to a system `claude`.
  A wrapper `--set` of a default `cli_path`, or patchelf'ing the bundled
  binary, would remove the manual step.
- `nix flake update` bumped nixpkgs (d2f6794 → 34ab990) to get here; nothing
  else depends on the pin.

### Future steps
- Verify / fix the aarch64-linux + darwin builds.
- Trim the closure: separate runtime deps from lint/format/types tooling, or
  move to a bundle (see below) so `node_modules` isn't shipped at all.
- Channel / overlay so `nix-shell -p loom` works without the flake ref.
- Upstream or drop the `fetchPnpmDeps` JSONC workaround once nixpkgs handles it
  (the fixupPhase `replaceStrings` patch is brittle against nixpkgs bumps).
- Guix package (separate effort; same oxnode-wrapper shape should port).

## Standalone Linux binary
Still open, and mostly orthogonal to the Nix package. Goal: a single
distributable executable with no Node / `node_modules` needed.
- Needs a real build step (tsdown / esbuild / `--experimental-sea-config`).
  This is where a bundler earns its keep — it also shrinks the Nix closure.
- Edge cases to plan for: the Ink/React TUI, the `claude-agent-sdk`
  subprocess, any `.node` native addons (oxc parser).
- Candidates from before: scriptc (https://github.com/vercel-labs/scriptc),
  tsm, Node SEA, Bun `--compile`.

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
