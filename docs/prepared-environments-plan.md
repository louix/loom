# Warm repo bases and persistent session VMs

Status: implemented and verified on Linux. Apple Silicon disk validation and
runtime hash regeneration remain pending. See [session environments](session-environments.md)
for commands and current behavior.

## Scope

Keep one warm base per repo and an independent persistent disk per session.
Always activate the environment and rerun the repeatable `prepare` command on
session creation/resume, using warm stores and caches. Avoid trying to predict
when setup is necessary until measurements show that warm setup is too costly.

Keep worktrees on the host and mount them into the guest. Edits, commits,
`node_modules`, and other workspace outputs remain immediately visible on the
host. Run all repo setup inside the VM. Do not share the host's live Nix store
or expose its Nix daemon.

The main win is reusing the expensive environment and package downloads. A repo
that takes 30 minutes to enter its shell should pay that cold cost during
explicit base preparation, with incremental work for subsequent sessions.

## Prepare or refresh the repo base

Command: `loom environment prepare`.

1. Create a disposable host worktree from the repo's HEAD. Report that revision;
   preparation does not include uncommitted changes from the active checkout.
2. Boot a private clone of the existing compatible base, or the generic runtime
   if this is the first preparation.
3. Mount the disposable worktree, apply the repo's current network policy, enter
   its configured environment, and run its arbitrary `prepare` command.
4. Stop the VM cleanly and save its disk state. Publish it as the repo's new
   immutable base only after the whole operation succeeds.
5. Remove the disposable worktree and temporary launch state.

The same command refreshes the base, reusing its previous Nix store and package
caches. No separate update command or automatic invalidation is needed.
A failed or cancelled refresh leaves the old base usable. Use a per-repo lock
and report an already-running preparation instead of introducing a job queue.

The base contains filesystem state, not running processes. Do not attach
provider credentials, provider profiles, or session MCPs during preparation.
Do not preserve sockets, temporary workspace bindings, or services in the base.
Never promote an agent-modified session disk into the shared base automatically.

## Show preparation in the CLI

Visibility is part of the first implementation. A long setup should not be a
silent spinner followed by a generic failure.

- Show the repo/revision and whether preparation starts from a warm base or a
  generic runtime.
- Show clear phases: creating worktree, starting VM, entering environment,
  running repo setup, and saving base. Include elapsed time; do not invent a
  percentage for arbitrary commands.
- Stream environment/setup stdout and stderr as they arrive, so users can see
  Nix downloads/builds, package installation, and errors. Keep this output
  separate from the worker control protocol, with bounded buffering.
- Print success with total elapsed time. On failure, preserve the useful command
  output in the terminal, return a nonzero exit code, and state that the previous
  base remains available.
- Ctrl-C cancels the preparation, stops its VM, and cleans up temporary state.
  It must never publish a partial base.

Use ordinary foreground CLI execution. No detached job service, persistent log
browser, or status subscription framework in this version. Do not dump host
configuration, environment variables, credentials, or worker protocol frames
into the progress stream. The displayed output is the configured commands'
output, not an assertion that arbitrary setup scripts cannot print secrets.

The existing timeout remains configurable. A 30-minute shell plus several
minutes of installation needs more than the current 15-minute default; the
existing one-hour limit covers that example. Apply this budget to preparation,
without extending normal provider request deadlines.

## TUI leader-menu action

Add **Prepare repo environment** to the existing `Space` command palette. The
label/help should explain that rerunning it refreshes the base for future
sessions. It is a repo action and does not require a selected session.

For the first implementation, use the existing terminal-suspension mechanism:

1. Suspend the TUI and run the same `loom environment prepare` command for the
   current repo, with inherited terminal input/output and the same config.
2. Show the same live phases and command output as a direct CLI invocation.
3. Leave the completion/error visible until the user returns to the TUI. Ctrl-C
   cancels the child preparation and returns to the TUI after cleanup.
4. Restore the TUI and show a short success, failure, or cancellation notice.

This keeps one preparation implementation and one output path. No dedicated
progress overlay or separate TUI job manager is needed. Active sessions keep
running on their own disks and are not restarted when the base is refreshed.

## New and resumed sessions

For a new session, create its host worktree, clone the repo's warm base, mount
that worktree, then activate the environment and run `prepare` before reporting
readiness. If no base exists, retain the generic-runtime fallback and explain
that this is a cold start. The actual worktree's source/configuration governs
setup; do not overwrite its files with source from the base.

On daemon shutdown or session stop, revoke credentials and close launch-time
endpoints, but retain the private session disk. On resume, boot that disk with
fresh capabilities and the current network policy, reactivate the environment,
and rerun setup. Dirty source files and workspace outputs already survive in
the host worktree. Added guest packages and caches now survive too.

Preserve the existing archive/worktree cleanup rules and dirty-file safeguards.
Retain the session disk on archive; if its worktree is recreated later, rerunning
setup materializes dependencies from warm caches. Delete the private disk when
the session is deleted. Initially, conversation forks get a disk cloned from the
repo base, rather than attempting to snapshot a live parent VM.

## What must persist

The writable Nix store, its database and roots, and application package caches
must live on the guest's persistent ext4 storage. Current cache settings under
`/tmp`, including `DENO_DIR`, need to move or map there. Make cache locations
configurable through a small guest-environment setting where necessary, applied
consistently to activation, setup, and subsequent commands. Do not hardcode a
package manager or installation command.

Preparing the base must run the application setup as well as enter Nix. That
warms Deno's dependency cache or pnpm's package store. Configuring pnpm's package
store is different from configuring its executable/shim directory.

The disposable preparation worktree's `node_modules` is not in the base disk.
Each new worktree still needs its dependencies materialized, ideally from cached
packages. Support copying across the guest-cache/host-worktree filesystem
boundary; do not assume hard links or reflinks work there. Small dependency
changes should usually fetch only missing packages. Arbitrary install scripts
may still do network work, and large toolchain changes can still be expensive.

Keep Loom's immutable runtime closure mount. Record the runtime/backend format
and guest architecture required by saved disks, and retain the exact runtime
lower layer they depend on. An incompatible runtime requires an explicit base
rebuild. Do not silently attach an incompatible lower layer to a saved session;
report that it needs an explicit reset/recreation, preserving its host worktree
and history. Runtime upgrades must not silently delete dirty state.

## Minimal implementation sequence

1. Verify clean stop, disk cloning, independent writes, restart, and rebinding a
   different host worktree using the pinned smolvm backend on Linux and Apple
   Silicon. Existing generic disk-template caching does not prove arbitrary
   prepared-disk cloning works. Prefer supported backend operations.
2. Put stores/caches on persistent storage. Implement foreground base preparation
   and atomic replacement, with CLI phases, streamed output, and cancellation.
3. Clone the base for new sessions and retain session disks across stop/resume.
   Extend the existing ownership/recovery cleanup paths rather than introducing
   a second lifecycle manager.
4. Add the TUI palette action by invoking the same CLI through terminal suspension.

Keep one current base, rather than a user-facing generation catalogue. Prefer
independent reflink copies when supported. If the backend's clones depend on
parent disk files, retain those backing files until no session references them;
“one current base” must not delete data still needed by an existing session.

### Storage spike results (smolvm 1.8.1)

The Linux check is executable:

```sh
deno run -A scripts/test-session-disk-vm.ts /path/to/pinned/smolvm
```

It verifies clean stop/restart, sparse copies of both disks into fresh machines,
independent writes while both clones run, deletion of the source before starting
clones, and mounting a different host workspace. It also verifies that workspace
edits are immediately visible on the host and survive a guest restart. The full
check took about eight seconds on the development Linux host; this is a storage
test, not a measurement of Nix or dependency installation. Apple Silicon remains
to be tested; the script uses APFS cloning there.

Backend details that affect implementation:

- Default-size Linux disks are qcow2 overlays over templates. Copying their files
  does not remove the backing-file dependency. The test explicitly selects
  non-default sizes (32 GiB storage, 8 GiB root overlay) to exercise smolvm's raw
  disk path. Production sizing remains a separate decision.
- Independent raw copies preserve sparseness and use reflinks where supported.
  Copy both `storage.raw` and `overlay.raw`, along with their `.formatted`
  markers, only while the machine is stopped. A fresh machine's data directory
  is allocated lazily. Recreate machine configuration so mounts and socket
  capabilities come from the new launch, not the source VM.
- `pack create --from-vm` is **not suitable on this pin**: a separate export/import
  experiment lost the file written to `/storage`. Inspection of the pinned
  `src/pack_export.rs` confirms that bare-VM export collects the root overlay but
  not the existing storage disk. Export also took roughly two minutes for an
  almost-empty VM. The passing acceptance script therefore uses raw copies
  rather than this export path.

Disk ownership and runtime compatibility are integrated with session locking,
recovery, and deletion. Persistent disk files live outside disposable launch
state; smolvm attaches them through launch-local links. New sessions make
independent copies of the current compatible repo base. The CLI and TUI action
share the same foreground preparation path.

Linux acceptance measured this repo at 188 seconds cold and 4.7 seconds on
relaunch, rerunning Nix activation and Deno installation. A separate tiny Deno
fixture verifies cached installation with no network into a new worktree,
live CLI stdout/stderr, failed and cancelled refresh, successful replacement,
and preservation of an existing session disk. TUI tests cover the repo-scoped
palette action and terminal suspension/restoration for all exit outcomes.

## Checks before shipping

- Prepare the slow repo once, then measure a warm new-session setup and a small
  dependency change. Track download traffic separately from workspace copying.
- Use fully cached locked Deno and pnpm fixtures to demonstrate installation
  without dependency downloads into a fresh host worktree.
- Stop/restart the daemon and verify dirty files, `node_modules`, guest packages,
  and caches survive. Resume still executes the configured setup successfully.
- Refresh the base without changing existing sessions. Failure/cancellation and
  interrupted publication preserve the previous usable base.
- Check independent session writes, compatible runtime retention, crash recovery,
  and deletion of stopped disks without removing unrelated worktrees/state.
- Confirm CLI output arrives during both activation and setup, including a
  useful error from a failing command; Ctrl-C cleans up without publication.
- Exercise the TUI palette action, visible output, cancellation, and terminal
  restoration on success/failure. Verify it does not affect active sessions.

## Deferred

Input globs and automatic invalidation, background preparation, skipping setup
with success markers, multiple-base selection, custom GC/status commands, and
special handling of workspace outputs. Add these only when measured warm setup
cost or actual usage justifies them.
